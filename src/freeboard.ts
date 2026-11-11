/**
 * Freeboard-SK integration through the Plotter Extensions API
 * (https://github.com/SignalK/freeboard-sk, docs/api/plotter-extensions-api.md).
 *
 * The plugin registers an extension manifest as a `plotterExtensions`
 * resource. Freeboard then loads a hidden background page in every open tab;
 * that page dials back over a WebSocket, and the plugin tells it which received
 * routes and waypoints to show on the chart (`resources.show`, or `route.show`
 * on Freeboard before 3.5). The manifest also adds "Send to OpenCPN" to the
 * menu of routes and waypoints.
 */

export const EXTENSION_ID = 'signalk-opencpn-sync'
/** Mounted by the server under /plugins/<plugin id>. */
export const BRIDGE_PATH = '/fb-bridge'
const ASSETS = '/signalk-opencpn-sync'

export function buildManifest(version: string): Record<string, unknown> {
  return {
    name: 'OpenCPN Sync',
    description: 'Shows routes and waypoints received from OpenCPN on the chart and sends them to OpenCPN.',
    version,
    apiVersion: '1',
    requires: ['background.iframe', 'panels.iframe'],
    optional: ['resources.display', 'routes', 'actions', 'windows'],
    background: [{ id: 'runtime', title: 'OpenCPN Sync', type: 'iframe', url: `${ASSETS}/fb-runtime.html` }],
    panels: [{ id: 'send', title: 'Send to OpenCPN', type: 'iframe', url: `${ASSETS}/fb-send.html` }],
    actions: [
      {
        id: 'send-to-opencpn',
        title: 'Send to OpenCPN',
        icon: 'send',
        targets: ['route', 'waypoint'],
        action: {
          type: 'openWindow',
          panel: 'send',
          title: 'Send to OpenCPN',
          geometry: { anchor: 'center', width: 360, height: 320 }
        }
      }
    ]
  }
}

/** The part of a ws WebSocket the bridge uses. */
export interface SocketLike {
  readyState: number
  send(data: string): void
  close(): void
  on(event: 'message', listener: (data: unknown) => void): unknown
  on(event: 'close', listener: () => void): unknown
}

export type ShowType = 'routes' | 'waypoints'

export interface ShowItem {
  type: ShowType
  id: string
  /** When the object arrived, ISO time; with `id` it tells a page what it has already shown. */
  at: string
}

const SINGULAR: Record<ShowType, string> = { routes: 'route', waypoints: 'waypoint' }

/** How long a received object is still offered to a Freeboard tab that connects later. */
const RECENT_MS = 24 * 3600_000
const MAX_RECENT = 50
const OPEN = 1

/**
 * Plugin side of the WebSocket the Freeboard background page opens. It only
 * pushes route and waypoint ids out; the page acknowledges what it showed.
 * Nothing a page sends can change anything, so the channel needs no
 * authentication of its own: the ids are readable through the resources API
 * anyway.
 */
export class FreeboardBridge {
  private readonly sockets = new Set<SocketLike>()
  private recent: ShowItem[] = []

  constructor(
    private readonly log: (msg: string) => void,
    private readonly now: () => Date = () => new Date()
  ) {}

  get connected(): number {
    return this.sockets.size
  }

  accept(ws: SocketLike): void {
    this.sockets.add(ws)
    ws.on('close', () => this.sockets.delete(ws))
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(String(data)) as { type?: string; resource?: string; id?: string; ok?: boolean; error?: string }
        if (msg.type === 'shown' && msg.ok === false) {
          const what = SINGULAR[msg.resource as ShowType] ?? 'route'
          this.log(`Freeboard could not show ${what} ${msg.id}: ${msg.error}`)
        }
      } catch {
        // not ours; ignore
      }
    })
    const items = this.pending()
    if (items.length) this.sendTo(ws, items)
  }

  /**
   * Objects arrived from OpenCPN: show them in every open Freeboard, and in
   * tabs opened later. One message per transfer, so a page can show them together.
   */
  announce(objects: Array<{ type: ShowType; id: string }>): void {
    if (objects.length === 0) return
    const at = this.now().toISOString()
    const items = objects.map(({ type, id }): ShowItem => ({ type, id, at }))
    const same = (a: ShowItem) => (b: ShowItem) => a.type === b.type && a.id === b.id
    this.recent = [...this.recent.filter((r) => !items.some(same(r))), ...items].slice(-MAX_RECENT)
    for (const ws of this.sockets) this.sendTo(ws, items)
  }

  close(): void {
    for (const ws of this.sockets) ws.close()
    this.sockets.clear()
  }

  private pending(): ShowItem[] {
    const cutoff = this.now().getTime() - RECENT_MS
    this.recent = this.recent.filter((r) => Date.parse(r.at) >= cutoff)
    return this.recent
  }

  private sendTo(ws: SocketLike, items: ShowItem[]): void {
    if (ws.readyState !== OPEN) return
    try {
      ws.send(JSON.stringify({ type: 'show', items }))
    } catch (error) {
      this.log(`Freeboard bridge send failed: ${String(error)}`)
    }
  }
}
