import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { loadOrCreateCertificate, type TlsFiles } from '../src/certificate.js'
import { buildGpx } from '../src/gpx-writer.js'
import { KeyStore } from '../src/keystore.js'
import { PeerClient, PeerError, parsePeer, peerKey, type PeerTarget } from '../src/peer-client.js'
import { PeerServer, Result, type ReceiveRequest } from '../src/peer-server.js'

// The plugin's own receiver answers like OpenCPN, so it stands in for OpenCPN here.

let dir: string
let tls: TlsFiles

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'opencpn-sync-client-'))
  tls = await loadOrCreateCertificate(dir, 'test')
}, 60_000)

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

interface Peer {
  target: PeerTarget
  pins: string[]
  received: ReceiveRequest[]
  existing: Set<string>
  server: PeerServer
}

let peer: Peer | undefined

async function startPeer(version = '5.15.0'): Promise<Peer> {
  const p: Partial<Peer> = { pins: [], received: [], existing: new Set() }
  const server = new PeerServer({
    port: 0,
    host: '127.0.0.1',
    tls,
    version,
    keys: new KeyStore(),
    requirePairing: true,
    onPairingRequest: (_source, pin) => p.pins!.push(pin),
    onPaired: () => {},
    exists: async (guid) => p.existing!.has(guid),
    receive: async (req) => {
      p.received!.push(req)
      return Result.NoError
    },
    log: () => {}
  })
  const port = await server.start()
  p.server = server
  p.target = { host: '127.0.0.1', port }
  peer = p as Peer
  return peer
}

afterEach(async () => {
  await peer?.server.stop()
  peer = undefined
})

const client = (keys = new KeyStore()) => new PeerClient({ source: 'signalk-test', keys })

const ROUTE = {
  name: 'R',
  feature: { geometry: { type: 'LineString', coordinates: [[1, 2], [3, 4]] } }
}
const gpx = buildGpx([{ type: 'routes', id: '0b5e3a3c-1f2d-4c5b-9a8e-7f6d5c4b3a21', resource: ROUTE }])

async function paired(p: Peer, c = client()): Promise<PeerClient> {
  await expect(c.ensurePaired(p.target)).rejects.toMatchObject({ code: 'needsPin' })
  await c.pair(p.target, p.pins[p.pins.length - 1])
  return c
}

describe('parsePeer', () => {
  it('defaults to port 8443', () => {
    expect(parsePeer('192.0.2.5')).toEqual({ host: '192.0.2.5', port: 8443 })
    expect(parsePeer(' nav-pc.local:8444 ')).toEqual({ host: 'nav-pc.local', port: 8444 })
    expect(parsePeer('[fe80::1]:9000')).toEqual({ host: 'fe80::1', port: 9000 })
    expect(peerKey(parsePeer('[fe80::1]'))).toBe('[fe80::1]:8443')
  })

  it('rejects garbage', () => {
    expect(() => parsePeer('http://x/y')).toThrow(PeerError)
    expect(() => parsePeer('host:99999')).toThrow(PeerError)
    expect(() => parsePeer('')).toThrow(PeerError)
  })
})

describe('PeerClient', () => {
  it('reads the peer version', async () => {
    const p = await startPeer('5.15.0')
    expect(await client().version(p.target)).toEqual([5, 15])
  })

  it('pairs with the PIN the peer shows, and keeps the key', async () => {
    const p = await startPeer()
    const keys = new KeyStore()
    const c = await paired(p, client(keys))
    expect(c.isPaired(p.target)).toBe(true)
    expect(keys.get(peerKey(p.target))).toHaveLength(12)
    await c.ensurePaired(p.target)
    expect(p.pins).toHaveLength(1)
  })

  it('reports a wrong PIN', async () => {
    const p = await startPeer()
    const c = client()
    await expect(c.ensurePaired(p.target)).rejects.toMatchObject({ code: 'needsPin' })
    const wrong = p.pins[0] === '0001' ? '0002' : '0001'
    await expect(c.pair(p.target, wrong)).rejects.toMatchObject({ code: 'badPin' })
    expect(c.isPaired(p.target)).toBe(false)
  })

  it('sends GPX with the flags OpenCPN uses', async () => {
    const p = await startPeer()
    const c = await paired(p)
    await c.send(p.target, gpx.xml, gpx.guids, { activate: true })
    expect(p.received).toEqual([{ source: 'signalk-test', gpx: gpx.xml, force: false, activate: true }])
  })

  it('stops at existing objects unless forced', async () => {
    const p = await startPeer()
    const c = await paired(p)
    p.existing.add(gpx.guids[0])
    await expect(c.send(p.target, gpx.xml, gpx.guids)).rejects.toMatchObject({ code: 'exists', detail: gpx.guids })
    expect(p.received).toHaveLength(0)
    await c.send(p.target, gpx.xml, gpx.guids, { force: true })
    expect(p.received[0].force).toBe(true)
  })

  it('needs a PIN for a peer it has not paired with', async () => {
    const p = await startPeer()
    const c = await paired(p)
    await p.server.stop()
    const fresh = await startPeer() // new server, empty key store
    await expect(c.send(fresh.target, gpx.xml, gpx.guids)).rejects.toMatchObject({ code: 'needsPin' })
  })

  it('refuses to activate on peers older than 5.9', async () => {
    const p = await startPeer('5.8.4')
    await expect(client().send(p.target, gpx.xml, gpx.guids, { activate: true })).rejects.toMatchObject({
      code: 'activateUnsupported'
    })
  })

  it('reports an unreachable peer', async () => {
    const p = await startPeer()
    const target = p.target
    await p.server.stop()
    await expect(client().ensurePaired(target)).rejects.toMatchObject({ code: 'unreachable' })
  })
})
