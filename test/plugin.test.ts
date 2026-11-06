import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Plugin, ServerAPI } from '@signalk/server-api'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import createPlugin from '../src/index.js'
import { resourceId } from '../src/gpx.js'
import { ROUTE_GPX, TRACK_ONLY_GPX, WAYPOINT_AND_TRACK_GPX } from './fixtures.js'
import { call, pair, q } from './opencpn-client.js'

interface FakeApp {
  app: ServerAPI
  store: Map<string, Record<string, unknown>>
  statuses: string[]
  errors: string[]
  deltas: unknown[]
  hasProvider: boolean
}

function fakeApp(dir: string): FakeApp {
  const f: Partial<FakeApp> = { store: new Map(), statuses: [], errors: [], deltas: [], hasProvider: true }
  const app = {
    getDataDirPath: () => dir,
    setPluginStatus: (m: string) => f.statuses!.push(m),
    setPluginError: (m: string) => f.errors!.push(m),
    error: (m: string) => f.errors!.push(m),
    debug: () => {},
    handleMessage: (_id: string, delta: unknown) => f.deltas!.push(delta),
    resourcesApi: {
      getResource: async (type: string, id: string) => {
        if (!f.hasProvider) throw new Error(`No provider for ${type}`)
        const v = f.store!.get(`${type}/${id}`)
        if (!v) throw new Error('not found')
        return v
      },
      setResource: async (type: string, id: string, data: Record<string, unknown>) => {
        if (!f.hasProvider) throw new Error(`No provider for ${type}`)
        f.store!.set(`${type}/${id}`, data)
      }
    }
  }
  f.app = app as unknown as ServerAPI
  return f as FakeApp
}

let dir: string
let fake: FakeApp
let plugin: Plugin
let port: number

async function startPlugin(config: Record<string, unknown> = {}): Promise<void> {
  plugin = createPlugin(fake.app)
  plugin.start({ port: 0, bindAddress: '127.0.0.1', announceMdns: false, ...config }, () => {})
  await vi.waitFor(
    () => {
      const s = fake.statuses.find((m) => m.startsWith('Listening on'))
      if (!s) throw new Error(fake.errors.join('; ') || 'not started')
      port = Number(/(?:port |:)(\d+) as/.exec(s)![1])
    },
    { timeout: 30_000 }
  )
}

function lastPin(): Promise<string> {
  const s = [...fake.statuses].reverse().find((m) => m.includes('Enter PIN'))!
  return Promise.resolve(/PIN (\d{4})/.exec(s)![1])
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'opencpn-sync-plugin-'))
  fake = fakeApp(dir)
})

afterEach(async () => {
  await plugin?.stop()
  await rm(dir, { recursive: true, force: true })
})

describe('plugin', () => {
  it('stores a received route as a Signal K route under its GUID', async () => {
    await startPlugin()
    const key = await pair(port, 'nav-pc', lastPin)
    const r = await call(port, `/api/rx_object?${q({ source: 'nav-pc', apikey: key })}`, ROUTE_GPX)
    expect(r.json).toEqual({ result: 0 })
    const route = fake.store.get('routes/3f2a1c4e-9b7d-4e21-a8c3-5d6e7f8a9b0c')
    expect(route?.name).toBe('Savusavu & back')
    expect(fake.store.size).toBe(1)
  }, 60_000)

  it('raises and clears the pairing notification', async () => {
    await startPlugin()
    await pair(port, 'nav-pc', lastPin)
    const values = fake.deltas.map((d) => (d as { updates: Array<{ values: Array<{ path: string; value: { state: string; message: string } }> }> }).updates[0].values[0])
    expect(values[0].path).toBe('notifications.opencpnSync.pairing')
    expect(values[0].value.state).toBe('alert')
    expect(values[0].value.message).toMatch(/nav-pc.*PIN \d{4}/)
    expect(values[values.length - 1].value.state).toBe('normal')
  }, 60_000)

  it('rejects a duplicate unless forced, then overwrites', async () => {
    await startPlugin()
    const key = await pair(port, 'nav-pc', lastPin)
    const base = { source: 'nav-pc', apikey: key }
    await call(port, `/api/rx_object?${q(base)}`, ROUTE_GPX)
    const writable = await call(port, `/api/writable?${q({ ...base, guid: '3f2a1c4e-9b7d-4e21-a8c3-5d6e7f8a9b0c' })}`)
    expect(writable.json).toEqual({ result: 3 })
    const dup = await call(port, `/api/rx_object?${q(base)}`, ROUTE_GPX.replace('Test route', 'Changed'))
    expect(dup.json).toEqual({ result: 3 })
    const forced = await call(port, `/api/rx_object?${q({ ...base, force: '1' })}`, ROUTE_GPX.replace('Test route', 'Changed'))
    expect(forced.json).toEqual({ result: 0 })
    expect(fake.store.get('routes/3f2a1c4e-9b7d-4e21-a8c3-5d6e7f8a9b0c')?.description).toBe('Changed')
  }, 60_000)

  it('stores waypoints and ignores tracks', async () => {
    await startPlugin({ requirePairing: false })
    const r = await call(port, `/api/rx_object?${q({ source: 'nav-pc', apikey: '1' })}`, WAYPOINT_AND_TRACK_GPX)
    expect(r.json).toEqual({ result: 0 })
    expect(fake.store.has(`waypoints/${resourceId('legacy-guid-0001')}`)).toBe(true)
    expect(fake.store.size).toBe(1)
  }, 60_000)

  it('answers ObjectRejected when nothing usable arrives', async () => {
    await startPlugin({ requirePairing: false })
    const r = await call(port, `/api/rx_object?${q({ source: 'nav-pc', apikey: '1' })}`, TRACK_ONLY_GPX)
    expect(r.json).toEqual({ result: 2 })
  }, 60_000)

  it('answers ObjectParseError for broken GPX', async () => {
    await startPlugin({ requirePairing: false })
    const r = await call(port, `/api/rx_object?${q({ source: 'nav-pc', apikey: '1' })}`, '<gpx><rte>')
    expect(r.json).toEqual({ result: 6 })
  }, 60_000)

  it('answers RouteInsertError without a resources provider', async () => {
    fake.hasProvider = false
    await startPlugin({ requirePairing: false })
    const r = await call(port, `/api/rx_object?${q({ source: 'nav-pc', apikey: '1' })}`, ROUTE_GPX)
    expect(r.json).toEqual({ result: 4 })
    expect(fake.errors.some((e) => e.includes('No provider'))).toBe(true)
  }, 60_000)

  it('does not require a bind address in the config schema', () => {
    const schema = createPlugin(fake.app).schema as () => { required?: string[] }
    expect(schema().required).not.toContain('bindAddress')
  })

  it.each([
    ['missing', {}],
    ['empty', { bindAddress: '' }],
    ['blank', { bindAddress: '  ' }]
  ])('listens on all interfaces when the bind address is %s', async (_label, config) => {
    plugin = createPlugin(fake.app)
    plugin.start({ port: 0, announceMdns: false, ...config }, () => {})
    await vi.waitFor(
      () => {
        const s = fake.statuses.find((m) => m.startsWith('Listening on'))
        if (!s) throw new Error(fake.errors.join('; ') || 'not started')
        expect(s).toMatch(/^Listening on port \d+ as/)
        port = Number(/port (\d+) as/.exec(s)![1])
      },
      { timeout: 30_000 }
    )
    const r = await call(port, '/api/get-version')
    expect(r.json).toEqual({ version: '5.14.0' })
  }, 60_000)

  it('stops the server on stop()', async () => {
    await startPlugin()
    await plugin.stop()
    await expect(call(port, '/api/get-version')).rejects.toThrow()
  }, 60_000)
})
