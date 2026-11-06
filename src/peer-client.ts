import { request } from 'node:https'
import { KeyStore } from './keystore.js'
import { pinCompatHash, pinHash } from './pincode.js'
import { Result } from './peer-server.js'

/** An OpenCPN instance to send to: host plus its REST port (8443, portable 8444). */
export interface PeerTarget {
  host: string
  port: number
}

export const DEFAULT_PEER_PORT = 8443

/** Parse "host", "host:port" or "[v6]:port". */
export function parsePeer(text: string): PeerTarget {
  const s = text.trim()
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(s)
  const plain = /^([^:\s/]+)(?::(\d+))?$/.exec(s)
  const m = v6 ?? plain
  if (!m) throw new PeerError('badRequest', `invalid peer address "${text}"`)
  const port = m[2] ? Number(m[2]) : DEFAULT_PEER_PORT
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new PeerError('badRequest', `invalid port in "${text}"`)
  }
  return { host: m[1], port }
}

export function peerKey(t: PeerTarget): string {
  return t.host.includes(':') ? `[${t.host}]:${t.port}` : `${t.host}:${t.port}`
}

export type PeerErrorCode =
  | 'badRequest'
  | 'unreachable'
  | 'needsPin'
  | 'badPin'
  | 'exists'
  | 'activateUnsupported'
  | 'rejected'
  | 'unconfirmed'
  | 'protocol'

export class PeerError extends Error {
  constructor(
    readonly code: PeerErrorCode,
    message: string,
    readonly detail?: unknown
  ) {
    super(message)
  }
}

/** RestServerResult::Void: OpenCPN's GUI did not answer within 10 s. */
const VOID = 100

/** What OpenCPN 5.9+ expects from a client that has no key yet (peer_client.cpp). */
const PROBE_KEY = '0123456789abc'

interface Reply {
  status: number
  json?: Record<string, unknown>
}

export interface PeerClientOptions {
  /** Sent as `source`; OpenCPN shows it in its PIN dialog and keys the pairing on it. */
  source: string
  keys: KeyStore
  timeoutMs?: number
}

export interface SendOptions {
  force?: boolean
  activate?: boolean
}

/**
 * Client side of OpenCPN's REST interface, doing what OpenCPN's own
 * "Send to Peer" does (model/src/peer_client.cpp).
 */
export class PeerClient {
  constructor(private readonly opts: PeerClientOptions) {}

  isPaired(t: PeerTarget): boolean {
    return this.opts.keys.get(peerKey(t)) !== undefined
  }

  async unpair(t: PeerTarget): Promise<void> {
    await this.opts.keys.delete(peerKey(t))
  }

  /** OpenCPN's version; servers without /api/get-version are 5.8. */
  async version(t: PeerTarget): Promise<[number, number]> {
    try {
      const r = await this.call(t, 'GET', '/api/get-version', {}, undefined, 4000)
      const m = /^(\d+)\.(\d+)/.exec(String(r.json?.version ?? ''))
      if (m) return [Number(m[1]), Number(m[2])]
    } catch (error) {
      if (error instanceof PeerError && error.code === 'unreachable') throw error
    }
    return [5, 8]
  }

  /**
   * Make sure we hold a key OpenCPN accepts. Without one, OpenCPN now shows a
   * PIN on its screen and this throws `needsPin`; pass that PIN to pair().
   */
  async ensurePaired(t: PeerTarget, version?: [number, number]): Promise<void> {
    const v = version ?? (await this.version(t))
    const stored = this.opts.keys.get(peerKey(t))
    const key = stored ?? (atLeast(v, 5, 9) ? PROBE_KEY : '1')
    const result = await this.ping(t, key)
    // OpenCPN 5.8 answers GenericError to a valid key.
    if (result === Result.NoError || (result === Result.GenericError && !atLeast(v, 5, 9))) {
      if (!stored) await this.opts.keys.set(peerKey(t), key)
      return
    }
    if (result === Result.NewPinRequested) {
      if (stored) await this.opts.keys.delete(peerKey(t))
      throw new PeerError('needsPin', `OpenCPN at ${peerKey(t)} shows a PIN; enter it to pair`)
    }
    throw new PeerError('protocol', `unexpected ping result ${String(result)} from ${peerKey(t)}`)
  }

  /** Confirm the PIN OpenCPN displays. */
  async pair(t: PeerTarget, pin: string): Promise<void> {
    if (!/^\d{1,4}$/.test(pin.trim())) throw new PeerError('badRequest', 'the PIN has four digits')
    const n = Number(pin.trim())
    const v = await this.version(t)
    const key = atLeast(v, 5, 9) ? pinHash(n) : pinCompatHash(n)
    const result = await this.ping(t, key)
    if (result === Result.NoError || (result === Result.GenericError && !atLeast(v, 5, 9))) {
      await this.opts.keys.set(peerKey(t), key)
      return
    }
    throw new PeerError('badPin', `OpenCPN at ${peerKey(t)} did not accept the PIN`)
  }

  /** GUIDs that already exist on the peer (only 5.9+ can tell). */
  async existing(t: PeerTarget, guids: string[], version?: [number, number]): Promise<string[]> {
    const v = version ?? (await this.version(t))
    if (!atLeast(v, 5, 9)) return []
    const apikey = this.requireKey(t)
    const found: string[] = []
    for (const guid of guids) {
      const r = await this.call(t, 'GET', '/api/writable', { source: this.opts.source, apikey, guid })
      const result = r.json?.result
      if (result === Result.DuplicateRejected) found.push(guid)
      else if (result === Result.NewPinRequested) throw this.lostPairing(t)
      else if (result !== Result.NoError) {
        throw new PeerError('protocol', `unexpected /api/writable result ${String(result)} for ${guid}`)
      }
    }
    return found
  }

  /** Pair check, duplicate check and transfer, as OpenCPN's own sender does it. */
  async send(t: PeerTarget, gpx: string, guids: string[], options: SendOptions = {}): Promise<void> {
    const v = await this.version(t)
    if (options.activate && !atLeast(v, 5, 9)) {
      throw new PeerError('activateUnsupported', `OpenCPN at ${peerKey(t)} is older than 5.9 and cannot activate routes`)
    }
    await this.ensurePaired(t, v)
    if (!options.force) {
      const existing = await this.existing(t, guids, v)
      if (existing.length > 0) {
        throw new PeerError('exists', `${existing.length} object(s) already exist on ${peerKey(t)}`, existing)
      }
    }
    const query: Record<string, string> = { source: this.opts.source, apikey: this.requireKey(t) }
    if (options.force) query.force = '1'
    if (options.activate) query.activate = '1'
    const r = await this.call(t, 'POST', '/api/rx_object', query, gpx, 25_000)
    const result = r.json?.result
    if (result === Result.NoError) return
    if (result === Result.NewPinRequested) throw this.lostPairing(t)
    if (result === Result.DuplicateRejected) {
      throw new PeerError('exists', `OpenCPN at ${peerKey(t)} kept its existing copy`, guids)
    }
    // OpenCPN gives up waiting for its GUI after 10 s and answers Void. The
    // usual cause is its "already exists, replace?" dialog: /api/writable
    // cannot warn us beforehand, because OpenCPN up to at least 5.15 checks an
    // empty GUID there and always answers "writable".
    if (result === VOID) {
      throw new PeerError(
        'unconfirmed',
        `OpenCPN at ${peerKey(t)} did not confirm in time. It may be asking on its screen whether to replace an existing object; answer there.`
      )
    }
    throw new PeerError('rejected', `OpenCPN at ${peerKey(t)} answered ${describe(result)}`, result)
  }

  private requireKey(t: PeerTarget): string {
    const key = this.opts.keys.get(peerKey(t))
    if (!key) throw new PeerError('needsPin', `not paired with ${peerKey(t)}`)
    return key
  }

  private lostPairing(t: PeerTarget): PeerError {
    void this.opts.keys.delete(peerKey(t))
    return new PeerError('needsPin', `OpenCPN at ${peerKey(t)} no longer accepts our key and shows a new PIN`)
  }

  private async ping(t: PeerTarget, apikey: string): Promise<unknown> {
    const r = await this.call(t, 'GET', '/api/ping', { source: this.opts.source, apikey })
    return r.json?.result
  }

  private call(
    t: PeerTarget,
    method: 'GET' | 'POST',
    path: string,
    query: Record<string, string>,
    body?: string,
    // OpenCPN holds a request for up to 10 s while its GUI thread handles it.
    timeoutMs = this.opts.timeoutMs ?? 12_000
  ): Promise<Reply> {
    const qs = new URLSearchParams(query).toString()
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: t.host,
          port: t.port,
          path: qs ? `${path}?${qs}` : path,
          method,
          // OpenCPN uses a self-signed certificate and does not verify ours either.
          rejectUnauthorized: false,
          // OpenCPN's server (mongoose) never answers a second request on a
          // kept-alive connection, so every request gets a connection of its own.
          agent: false,
          timeout: timeoutMs,
          headers:
            body === undefined
              ? { Connection: 'close' }
              : { Connection: 'close', 'Content-Type': 'application/xml', 'Content-Length': Buffer.byteLength(body) }
        },
        (res) => {
          let data = ''
          res.setEncoding('utf8')
          res.on('data', (c: string) => (data += c))
          res.on('end', () => {
            if ((res.statusCode ?? 0) !== 200) {
              reject(new PeerError('protocol', `${method} ${path} → HTTP ${res.statusCode ?? '?'}`))
              return
            }
            try {
              resolve({ status: 200, json: JSON.parse(data) as Record<string, unknown> })
            } catch {
              reject(new PeerError('protocol', `${method} ${path}: no JSON in reply`))
            }
          })
        }
      )
      req.on('timeout', () => req.destroy(new Error('timeout')))
      req.on('error', (error) =>
        reject(error instanceof PeerError ? error : new PeerError('unreachable', `${peerKey(t)}: ${error.message}`))
      )
      if (body !== undefined) req.write(body)
      req.end()
    })
  }
}

function atLeast([major, minor]: [number, number], wantMajor: number, wantMinor: number): boolean {
  return major > wantMajor || (major === wantMajor && minor >= wantMinor)
}

function describe(result: unknown): string {
  const names: Record<number, string> = {
    [Result.GenericError]: 'GenericError',
    [Result.ObjectRejected]: 'ObjectRejected',
    [Result.RouteInsertError]: 'RouteInsertError',
    [Result.ObjectParseError]: 'ObjectParseError'
  }
  return typeof result === 'number' ? `${names[result] ?? 'result'} (${result})` : 'no result'
}
