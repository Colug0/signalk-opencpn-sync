import { createServer, type Server } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { KeyStore } from './keystore.js'
import { apiKeyForPin, createPin, pinToString } from './pincode.js'

/** Wire values of OpenCPN's RestServerResult; they must not change. */
export const Result = {
  NoError: 0,
  GenericError: 1,
  ObjectRejected: 2,
  DuplicateRejected: 3,
  RouteInsertError: 4,
  NewPinRequested: 5,
  ObjectParseError: 6
} as const
export type ResultCode = (typeof Result)[keyof typeof Result]

export interface ReceiveRequest {
  source: string
  gpx: string
  /** The sender confirmed overwriting existing objects. */
  force: boolean
  activate: boolean
}

export interface PeerServerOptions {
  port: number
  host?: string
  tls: { key: string; cert: string }
  /** Reported by /api/get-version and /api/ping. Clients use 5.9+ features from it. */
  version: string
  keys: KeyStore
  requirePairing: boolean
  /** Called with a new PIN the user has to type into OpenCPN. */
  onPairingRequest: (source: string, pin: string) => void
  onPaired: (source: string) => void
  exists: (guid: string) => Promise<boolean>
  receive: (req: ReceiveRequest) => Promise<ResultCode>
  log: (msg: string) => void
}

const MAX_BODY_BYTES = 20 * 1024 * 1024
/** More failed authentications than this per window locks pairing for one window. */
const MAX_AUTH_FAILURES = 20
const AUTH_WINDOW_MS = 60_000

function sendJson(res: ServerResponse, body: Record<string, unknown>): void {
  const text = `${JSON.stringify(body)}\n`
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) })
  res.end(text)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * HTTPS server that answers like OpenCPN's REST server (model/src/rest_server.cpp),
 * so OpenCPN's "Send to Peer" can deliver routes and waypoints to it.
 */
export class PeerServer {
  private server?: Server
  private failures: number[] = []
  /** Key expected from a sender that was shown a PIN but has not answered yet. */
  private pending = new Map<string, string>()

  constructor(private readonly opts: PeerServerOptions) {}

  async start(): Promise<number> {
    const server = createServer({ key: this.opts.tls.key, cert: this.opts.tls.cert }, (req, res) => {
      this.handle(req, res).catch((error: unknown) => {
        this.opts.log(`request failed: ${String(error)}`)
        if (!res.headersSent) sendJson(res, { result: Result.GenericError })
        else res.end()
      })
    })
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.opts.port, this.opts.host, () => {
        server.off('error', reject)
        resolve()
      })
    })
    return (server.address() as AddressInfo).port
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = undefined
    if (!server) return
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'https://localhost')
    const q = url.searchParams
    const source = q.get('source') ?? ''
    const apiKey = q.get('apikey') ?? ''

    switch (url.pathname) {
      case '/api/get-version':
        return sendJson(res, { version: this.opts.version })

      case '/api/ping': {
        const result = source ? await this.authenticate(source, apiKey) : Result.GenericError
        return sendJson(res, { result, version: this.opts.version })
      }

      case '/api/writable': {
        const guid = q.get('guid') ?? ''
        let result: ResultCode = source ? await this.authenticate(source, apiKey) : Result.GenericError
        if (result === Result.NoError && !q.has('force') && guid && (await this.opts.exists(guid))) {
          result = Result.DuplicateRejected
        }
        return sendJson(res, { result })
      }

      case '/api/rx_object': {
        if (req.method !== 'POST') return sendJson(res, { result: Result.GenericError })
        const body = await readBody(req)
        let result: ResultCode = source ? await this.authenticate(source, apiKey) : Result.GenericError
        if (result === Result.NoError) {
          // OpenCPN tests force and activate for presence only.
          result = await this.opts.receive({
            source,
            gpx: body,
            force: q.has('force'),
            activate: q.has('activate')
          })
        }
        return sendJson(res, { result })
      }

      default:
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('url: not found')
    }
  }

  private async authenticate(source: string, apiKey: string): Promise<ResultCode> {
    if (!this.opts.requirePairing) return Result.NoError
    if (this.opts.keys.has(source, apiKey)) return Result.NoError
    if (apiKey && this.pending.get(source) === apiKey) {
      this.pending.delete(source)
      await this.opts.keys.set(source, apiKey)
      this.opts.onPaired(source)
      return Result.NoError
    }
    if (this.lockedOut()) {
      this.opts.log(`pairing locked for a minute after too many failed attempts (last from ${source})`)
      return Result.GenericError
    }
    // Like OpenCPN, each unknown key starts a new pairing with a fresh PIN.
    // Unlike OpenCPN, the key of an earlier pairing stays valid until the new
    // one completes, so a wrong key cannot unpair a sender.
    const pin = createPin()
    this.pending.set(source, apiKeyForPin(pin, apiKey))
    this.opts.onPairingRequest(source, pinToString(pin))
    return Result.NewPinRequested
  }

  private lockedOut(): boolean {
    const now = Date.now()
    this.failures = this.failures.filter((t) => now - t < AUTH_WINDOW_MS)
    this.failures.push(now)
    return this.failures.length > MAX_AUTH_FAILURES
  }
}
