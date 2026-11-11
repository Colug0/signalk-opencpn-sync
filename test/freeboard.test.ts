import { describe, expect, it } from 'vitest'
import { buildManifest, FreeboardBridge, type SocketLike } from '../src/freeboard.js'

class FakeSocket implements SocketLike {
  readyState = 1
  sent: unknown[] = []
  closed = false
  private handlers: Record<string, Array<(d?: unknown) => void>> = {}
  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }
  close(): void {
    this.closed = true
    this.emit('close')
  }
  on(event: 'message' | 'close', listener: (data?: unknown) => void): this {
    ;(this.handlers[event] ??= []).push(listener)
    return this
  }
  emit(event: string, data?: unknown): void {
    for (const h of this.handlers[event] ?? []) h(data)
  }
}

describe('buildManifest', () => {
  it('declares a background runtime, a send panel and the menu action', () => {
    const m = buildManifest('1.2.3') as Record<string, any>
    expect(m.apiVersion).toBe('1')
    expect(m.version).toBe('1.2.3')
    expect(m.requires).toEqual(['background.iframe', 'panels.iframe'])
    expect(m.optional).toEqual(['resources.display', 'routes', 'actions', 'windows'])
    expect(m.background[0]).toMatchObject({ id: 'runtime', type: 'iframe', url: '/signalk-opencpn-sync/fb-runtime.html' })
    expect(m.panels[0]).toMatchObject({ id: 'send', type: 'iframe', url: '/signalk-opencpn-sync/fb-send.html' })
    expect(m.actions[0]).toMatchObject({ targets: ['route', 'waypoint'], action: { type: 'openWindow', panel: 'send' } })
  })
})

describe('FreeboardBridge', () => {
  let clock = new Date('2026-11-09T10:00:00Z')
  const now = () => clock

  it('pushes a received route to every connected page', () => {
    const b = new FreeboardBridge(() => {}, now)
    const a = new FakeSocket()
    const c = new FakeSocket()
    b.accept(a)
    b.accept(c)
    expect(b.connected).toBe(2)
    b.announce([{ type: 'routes', id: 'route-1' }])
    const msg = { type: 'show', items: [{ type: 'routes', id: 'route-1', at: '2026-11-09T10:00:00.000Z' }] }
    expect(a.sent).toEqual([msg])
    expect(c.sent).toEqual([msg])
  })

  it('offers recent routes to a page that connects later, once per route', () => {
    const b = new FreeboardBridge(() => {}, now)
    b.announce([{ type: 'routes', id: 'route-1' }])
    clock = new Date('2026-11-09T10:05:00Z')
    b.announce([{ type: 'routes', id: 'route-1' }]) // resent: newer time, still one entry
    b.announce([{ type: 'routes', id: 'route-2' }])
    const late = new FakeSocket()
    b.accept(late)
    expect(late.sent).toEqual([
      {
        type: 'show',
        items: [
          { type: 'routes', id: 'route-1', at: '2026-11-09T10:05:00.000Z' },
          { type: 'routes', id: 'route-2', at: '2026-11-09T10:05:00.000Z' }
        ]
      }
    ])
  })

  it('sends the routes and waypoints of one transfer in one message', () => {
    const b = new FreeboardBridge(() => {}, now)
    const s = new FakeSocket()
    b.accept(s)
    b.announce([])
    b.announce([
      { type: 'routes', id: 'x' },
      { type: 'waypoints', id: 'x' },
      { type: 'waypoints', id: 'w2' }
    ])
    const at = clock.toISOString()
    expect(s.sent).toEqual([
      {
        type: 'show',
        items: [
          { type: 'routes', id: 'x', at },
          { type: 'waypoints', id: 'x', at },
          { type: 'waypoints', id: 'w2', at }
        ]
      }
    ])
    // a route and a waypoint with the same id are separate entries for late pages
    const late = new FakeSocket()
    b.accept(late)
    expect((late.sent[0] as { items: unknown[] }).items).toHaveLength(3)
  })

  it('forgets routes after a day', () => {
    clock = new Date('2026-11-09T10:00:00Z')
    const b = new FreeboardBridge(() => {}, now)
    b.announce([{ type: 'routes', id: 'old' }])
    clock = new Date('2026-11-10T10:00:01Z')
    const s = new FakeSocket()
    b.accept(s)
    expect(s.sent).toEqual([])
  })

  it('drops closed sockets and skips ones not open', () => {
    const b = new FreeboardBridge(() => {}, now)
    const s = new FakeSocket()
    b.accept(s)
    s.emit('close')
    expect(b.connected).toBe(0)
    const opening = new FakeSocket()
    opening.readyState = 0
    b.accept(opening)
    b.announce([{ type: 'routes', id: 'r' }])
    expect(opening.sent).toEqual([])
  })

  it('logs routes a page could not show, and ignores junk', () => {
    const logs: string[] = []
    const b = new FreeboardBridge((m) => logs.push(m), now)
    const s = new FakeSocket()
    b.accept(s)
    s.emit('message', 'not json')
    s.emit('message', JSON.stringify({ type: 'shown', id: 'r', ok: true }))
    s.emit('message', JSON.stringify({ type: 'shown', id: 'r', ok: false, error: 'routes.badRef' }))
    s.emit('message', JSON.stringify({ type: 'shown', resource: 'waypoints', id: 'w', ok: false, error: 'resources.notSupported' }))
    expect(logs).toEqual([
      'Freeboard could not show route r: routes.badRef',
      'Freeboard could not show waypoint w: resources.notSupported'
    ])
  })

  it('closes every socket on close()', () => {
    const b = new FreeboardBridge(() => {}, now)
    const s = new FakeSocket()
    b.accept(s)
    b.close()
    expect(s.closed).toBe(true)
    expect(b.connected).toBe(0)
  })
})
