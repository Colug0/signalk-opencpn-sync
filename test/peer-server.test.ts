import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { loadOrCreateCertificate, type TlsFiles } from '../src/certificate.js'
import { KeyStore } from '../src/keystore.js'
import { PeerServer, Result, type ReceiveRequest, type ResultCode } from '../src/peer-server.js'
import { pinCompatHash, pinHash } from '../src/pincode.js'
import { ROUTE_GPX } from './fixtures.js'
import { call, pair, PROBE_KEY, q } from './opencpn-client.js'

let dir: string
let tls: TlsFiles

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'opencpn-sync-'))
  tls = await loadOrCreateCertificate(dir, 'test')
}, 60_000)

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

interface Harness {
  port: number
  pins: Array<{ source: string; pin: string }>
  paired: string[]
  received: ReceiveRequest[]
  existing: Set<string>
  keys: KeyStore
  server: PeerServer
}

let current: Harness | undefined

async function startServer(opts: { requirePairing?: boolean; receiveResult?: ResultCode; keyFile?: string } = {}): Promise<Harness> {
  const h: Partial<Harness> = { pins: [], paired: [], received: [], existing: new Set() }
  const keys = new KeyStore(opts.keyFile)
  await keys.load()
  const server = new PeerServer({
    port: 0,
    host: '127.0.0.1',
    tls,
    version: '5.14.0',
    keys,
    requirePairing: opts.requirePairing ?? true,
    onPairingRequest: (source, pin) => h.pins!.push({ source, pin }),
    onPaired: (source) => h.paired!.push(source),
    exists: async (guid) => h.existing!.has(guid),
    receive: async (req) => {
      h.received!.push(req)
      return opts.receiveResult ?? Result.NoError
    },
    log: () => {}
  })
  h.port = await server.start()
  h.keys = keys
  h.server = server
  current = h as Harness
  return current
}

afterEach(async () => {
  await current?.server.stop()
  current = undefined
})

const lastPin = (h: Harness) => async () => h.pins[h.pins.length - 1].pin

describe('PeerServer', () => {
  it('answers get-version without a key', async () => {
    const h = await startServer()
    const r = await call(h.port, '/api/get-version')
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ version: '5.14.0' })
  })

  it('pairs like OpenCPN 5.9+ and accepts the key afterwards', async () => {
    const h = await startServer()
    const key = await pair(h.port, 'nav-pc', lastPin(h))
    expect(h.pins).toHaveLength(1)
    expect(h.pins[0].source).toBe('nav-pc')
    expect(h.pins[0].pin).toMatch(/^\d{4}$/)
    expect(key).toBe(pinHash(Number(h.pins[0].pin)))
    expect(h.paired).toEqual(['nav-pc'])
    expect(h.keys.get('nav-pc')).toBe(key)

    const again = await call(h.port, `/api/ping?${q({ source: 'nav-pc', apikey: key })}`)
    expect(again.json).toEqual({ result: 0, version: '5.14.0' })
    expect(h.pins).toHaveLength(1)
  })

  it('uses the 5.8 compat key for short client keys', async () => {
    const h = await startServer()
    const first = await call(h.port, `/api/ping?${q({ source: 'old-pc', apikey: '1' })}`)
    expect(first.json?.result).toBe(Result.NewPinRequested)
    const key = pinCompatHash(Number(h.pins[0].pin))
    const second = await call(h.port, `/api/ping?${q({ source: 'old-pc', apikey: key })}`)
    expect(second.json?.result).toBe(Result.NoError)
  })

  it('keeps an existing pairing when a wrong key arrives', async () => {
    const h = await startServer()
    const key = await pair(h.port, 'nav-pc', lastPin(h))
    const wrong = await call(h.port, `/api/ping?${q({ source: 'nav-pc', apikey: 'ffffffffffff' })}`)
    expect(wrong.json?.result).toBe(Result.NewPinRequested)
    const ok = await call(h.port, `/api/ping?${q({ source: 'nav-pc', apikey: key })}`)
    expect(ok.json?.result).toBe(Result.NoError)
  })

  it('persists paired keys', async () => {
    const keyFile = join(dir, 'keys.json')
    const h = await startServer({ keyFile })
    const key = await pair(h.port, 'nav-pc', lastPin(h))
    await h.server.stop()
    current = undefined
    const h2 = await startServer({ keyFile })
    const r = await call(h2.port, `/api/ping?${q({ source: 'nav-pc', apikey: key })}`)
    expect(r.json?.result).toBe(Result.NoError)
    expect(h2.pins).toHaveLength(0)
  })

  it('answers GenericError to requests without source', async () => {
    const h = await startServer()
    const r = await call(h.port, `/api/ping?${q({ apikey: PROBE_KEY })}`)
    expect(r.json?.result).toBe(Result.GenericError)
    expect(h.pins).toHaveLength(0)
  })

  it('reports existing objects as not writable unless forced', async () => {
    const h = await startServer()
    const key = await pair(h.port, 'nav-pc', lastPin(h))
    h.existing.add('guid-1')
    const base = { source: 'nav-pc', apikey: key }
    expect((await call(h.port, `/api/writable?${q({ ...base, guid: 'guid-1' })}`)).json).toEqual({ result: 3 })
    expect((await call(h.port, `/api/writable?${q({ ...base, guid: 'guid-2' })}`)).json).toEqual({ result: 0 })
    expect((await call(h.port, `/api/writable?${q({ ...base, guid: 'guid-1', force: '1' })}`)).json).toEqual({ result: 0 })
  })

  it('does not reveal existing objects to unpaired senders', async () => {
    const h = await startServer()
    h.existing.add('guid-1')
    const r = await call(h.port, `/api/writable?${q({ source: 'x', apikey: PROBE_KEY, guid: 'guid-1' })}`)
    expect(r.json?.result).toBe(Result.NewPinRequested)
  })

  it('hands received GPX with force and activate flags to receive()', async () => {
    const h = await startServer()
    const key = await pair(h.port, 'nav-pc', lastPin(h))
    const r = await call(h.port, `/api/rx_object?${q({ source: 'nav-pc', apikey: key, force: '0', activate: '' })}`, ROUTE_GPX)
    expect(r.json).toEqual({ result: 0 })
    expect(h.received).toEqual([{ source: 'nav-pc', gpx: ROUTE_GPX, force: true, activate: true }])
  })

  it('passes the result of receive() through', async () => {
    const h = await startServer({ receiveResult: Result.ObjectParseError })
    const key = await pair(h.port, 'nav-pc', lastPin(h))
    const r = await call(h.port, `/api/rx_object?${q({ source: 'nav-pc', apikey: key })}`, '<x/>')
    expect(r.json).toEqual({ result: Result.ObjectParseError })
  })

  it('refuses objects from unpaired senders', async () => {
    const h = await startServer()
    const r = await call(h.port, `/api/rx_object?${q({ source: 'nav-pc', apikey: PROBE_KEY })}`, ROUTE_GPX)
    expect(r.json?.result).toBe(Result.NewPinRequested)
    expect(h.received).toHaveLength(0)
  })

  it('accepts anyone when pairing is off', async () => {
    const h = await startServer({ requirePairing: false })
    const r = await call(h.port, `/api/rx_object?${q({ source: 'nav-pc', apikey: '1' })}`, ROUTE_GPX)
    expect(r.json?.result).toBe(Result.NoError)
    expect(h.pins).toHaveLength(0)
  })

  it('locks pairing after too many failed attempts', async () => {
    const h = await startServer()
    for (let i = 0; i < 20; i++) {
      const r = await call(h.port, `/api/ping?${q({ source: `s${i}`, apikey: PROBE_KEY })}`)
      expect(r.json?.result).toBe(Result.NewPinRequested)
    }
    const r = await call(h.port, `/api/ping?${q({ source: 'late', apikey: PROBE_KEY })}`)
    expect(r.json?.result).toBe(Result.GenericError)
  })

  it('answers unknown paths with 404 like OpenCPN', async () => {
    const h = await startServer()
    const r = await call(h.port, '/api/list-routes')
    expect(r.status).toBe(404)
    expect(r.body).toBe('url: not found')
  })
})
