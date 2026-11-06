import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ActionResult } from '@signalk/server-api'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { PUT_PAIR_PATH, PUT_SEND_PATH, registerApi, registerPutHandlers, toSendRequest, type ApiDeps } from '../src/api.js'
import { loadOrCreateCertificate, type TlsFiles } from '../src/certificate.js'
import { parseGpx } from '../src/gpx.js'
import { KeyStore } from '../src/keystore.js'
import { Outbound, statusCodeOf } from '../src/outbound.js'
import { PeerClient } from '../src/peer-client.js'
import { PeerServer, Result, type ReceiveRequest } from '../src/peer-server.js'

const ROUTE_ID = '0b5e3a3c-1f2d-4c5b-9a8e-7f6d5c4b3a21'
const resources: Record<string, Record<string, unknown>> = {
  [`routes/${ROUTE_ID}`]: {
    name: 'Test',
    feature: { type: 'Feature', geometry: { type: 'LineString', coordinates: [[1, 2], [3, 4]] } }
  }
}

let dir: string
let tls: TlsFiles
let server: PeerServer
let peer: string
const pins: string[] = []
const received: ReceiveRequest[] = []

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'opencpn-sync-out-'))
  tls = await loadOrCreateCertificate(dir, 'test')
  server = new PeerServer({
    port: 0,
    host: '127.0.0.1',
    tls,
    version: '5.15.0',
    keys: new KeyStore(),
    requirePairing: true,
    onPairingRequest: (_s, pin) => pins.push(pin),
    onPaired: () => {},
    exists: async () => false,
    receive: async (req) => {
      received.push(req)
      return Result.NoError
    },
    log: () => {}
  })
  peer = `127.0.0.1:${await server.start()}`
}, 60_000)

afterAll(async () => {
  await server.stop()
  await rm(dir, { recursive: true, force: true })
})

afterEach(() => {
  pins.length = 0
  received.length = 0
})

function outbound(configured: string[] = []): Outbound {
  return new Outbound({
    client: new PeerClient({ source: 'sk', keys: new KeyStore() }),
    getResource: async (type, id) => {
      const r = resources[`${type}/${id}`]
      if (!r) throw new Error('not found')
      return r
    },
    discovered: () => [],
    configuredPeers: () => configured
  })
}

describe('Outbound', () => {
  it('asks for a PIN, pairs, then sends', async () => {
    const o = outbound()
    const first = await o.send({ peer, items: [{ type: 'routes', id: ROUTE_ID }] })
    expect(first).toMatchObject({ status: 'needsPin', peer })
    expect(await o.pair(peer, pins[0])).toEqual({ status: 'paired', peer })
    const sent = await o.send({ peer, items: [{ type: 'routes', id: ROUTE_ID }] })
    expect(sent).toEqual({ status: 'sent', peer, count: 1 })
    expect(parseGpx(received[0].gpx).routes[0].guid).toBe(ROUTE_ID)
    expect(o.peers()).toEqual([{ address: peer, paired: true, source: 'used', name: undefined }])
  })

  it('uses the only known peer when none is given', async () => {
    const o = outbound([peer])
    expect(await o.send({ items: [{ type: 'routes', id: ROUTE_ID }] })).toMatchObject({ status: 'needsPin', peer })
  })

  it('needs a peer when none or several are known', async () => {
    expect(await outbound().send({ items: [{ type: 'routes', id: ROUTE_ID }] })).toMatchObject({
      status: 'error',
      code: 'badRequest'
    })
    expect(await outbound(['192.0.2.1', '192.0.2.2']).send({ items: [{ type: 'routes', id: ROUTE_ID }] })).toMatchObject({
      status: 'error',
      code: 'badRequest'
    })
  })

  it('reports unknown resources and bad requests', async () => {
    const o = outbound([peer])
    expect(await o.send({ items: [{ type: 'routes', id: 'nope' }] })).toMatchObject({ status: 'error', code: 'badRequest' })
    expect(await o.send({ items: [] })).toMatchObject({ status: 'error', code: 'badRequest' })
    expect(await o.send({ items: [{ type: 'notes' as never, id: ROUTE_ID }] })).toMatchObject({ code: 'badRequest' })
  })

  it('maps outcomes to HTTP status codes', () => {
    expect(statusCodeOf({ status: 'sent' })).toBe(200)
    expect(statusCodeOf({ status: 'needsPin' })).toBe(403)
    expect(statusCodeOf({ status: 'exists' })).toBe(409)
    expect(statusCodeOf({ status: 'error', code: 'badRequest' })).toBe(400)
    expect(statusCodeOf({ status: 'error', code: 'unreachable' })).toBe(502)
    expect(statusCodeOf({ status: 'error', code: 'unconfirmed' })).toBe(504)
    expect(statusCodeOf({ status: 'error', code: 'badPin' })).toBe(403)
  })
})

describe('toSendRequest', () => {
  it('accepts a single object or a list', () => {
    expect(toSendRequest({ type: 'routes', id: 'x', peer: 'p', activate: true })).toEqual({
      peer: 'p',
      items: [{ type: 'routes', id: 'x' }],
      force: false,
      activate: true
    })
    expect(toSendRequest({ items: [{ type: 'waypoints', id: 'y' }], force: true }).items).toEqual([
      { type: 'waypoints', id: 'y' }
    ])
    expect(toSendRequest({ force: 'yes' }).force).toBe(false)
  })
})

describe('PUT handlers', () => {
  it('answer PENDING and complete with the outcome', async () => {
    const o = outbound([peer])
    const handlers = new Map<string, (c: string, p: string, v: unknown, cb: (r: ActionResult) => void) => ActionResult>()
    const deps: ApiDeps = { outbound: () => o, scan: async () => {}, peerName: () => 'sk' }
    registerPutHandlers((_ctx, path, h) => handlers.set(path, h), deps, 'test')

    const call = (path: string, value: unknown) =>
      new Promise<ActionResult>((resolve) => {
        const first = handlers.get(path)!('vessels.self', path, value, resolve)
        expect(first.state).toBe('PENDING')
      })

    const needsPin = await call(PUT_SEND_PATH, { type: 'routes', id: ROUTE_ID })
    expect(needsPin).toMatchObject({ state: 'COMPLETED', statusCode: 403 })
    const pairedResult = await call(PUT_PAIR_PATH, { pin: pins[0] })
    expect(pairedResult.statusCode).toBe(200)
    const sent = await call(PUT_SEND_PATH, { type: 'routes', id: ROUTE_ID })
    expect(sent.statusCode).toBe(200)
    expect(JSON.parse(sent.message!)).toEqual({ status: 'sent', peer, count: 1 })
  })

  it('answer 503 while the plugin is stopped', () => {
    const handlers = new Map<string, (c: string, p: string, v: unknown, cb: (r: ActionResult) => void) => ActionResult>()
    registerPutHandlers((_c, path, h) => handlers.set(path, h), { outbound: () => undefined, scan: async () => {}, peerName: () => undefined }, 't')
    expect(handlers.get(PUT_SEND_PATH)!('vessels.self', PUT_SEND_PATH, {}, () => {})).toMatchObject({ statusCode: 503 })
  })
})

describe('REST API', () => {
  it('opens send and pair to read/write users where the server allows it', () => {
    const levels: Array<[string, string, string]> = []
    const direct: string[] = []
    const scoped = (level: string) => ({
      get: (p: string) => levels.push([level, 'GET', p]),
      post: (p: string) => levels.push([level, 'POST', p])
    })
    registerApi(
      {
        get: (p) => direct.push(`GET ${p}`),
        post: (p) => direct.push(`POST ${p}`),
        access: (level) => scoped(level)
      },
      { outbound: () => undefined, scan: async () => {}, peerName: () => undefined }
    )
    expect(levels).toEqual(
      expect.arrayContaining([
        ['readonly', 'GET', '/api/peers'],
        ['readwrite', 'POST', '/api/send'],
        ['readwrite', 'POST', '/api/pair'],
        ['readwrite', 'POST', '/api/scan']
      ])
    )
    // forgetting a pairing stays admin-only
    expect(direct).toEqual(['POST /api/unpair'])
  })

  it('answers 503 while the plugin is stopped', () => {
    const routes = new Map<string, (req: unknown, res: unknown) => void>()
    registerApi(
      { get: (p, h) => routes.set(`GET ${p}`, h as never), post: (p, h) => routes.set(`POST ${p}`, h as never) },
      { outbound: () => undefined, scan: async () => {}, peerName: () => undefined }
    )
    let status = 0
    const res = {
      status(c: number) {
        status = c
        return res
      },
      json() {}
    }
    routes.get('GET /api/peers')!({}, res)
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        expect(status).toBe(503)
        resolve()
      }, 10)
    )
  })
})
