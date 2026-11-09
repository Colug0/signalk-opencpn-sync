import { buildGpx, ExportError, type ExportItem, type SkResource } from './gpx-writer.js'
import { PeerClient, PeerError, parsePeer, peerKey, type PeerTarget } from './peer-client.js'
import type { DiscoveredPeer } from './mdns.js'

export type ResourceType = 'routes' | 'waypoints'

export interface SendItem {
  type: ResourceType
  id: string
}

export interface SendRequest {
  /** "host" or "host:port"; may be left out when exactly one peer is known. */
  peer?: string
  items: SendItem[]
  /** Replace objects that already exist in OpenCPN. */
  force?: boolean
  /** Activate the (single) route in OpenCPN after the transfer. */
  activate?: boolean
}

export type SendOutcome =
  | { status: 'sent'; peer: string; count: number }
  | { status: 'needsPin'; peer: string; message: string }
  | { status: 'exists'; peer: string; guids: string[]; message: string }
  | { status: 'error'; peer?: string; code: string; message: string }

export interface PeerInfo {
  address: string
  name?: string
  paired: boolean
  source: 'mdns' | 'config' | 'used'
}

export interface OutboundDeps {
  client: PeerClient
  getResource: (type: ResourceType, id: string) => Promise<SkResource>
  discovered: () => DiscoveredPeer[]
  configuredPeers: () => string[]
}

/** Sending Signal K routes and waypoints to OpenCPN, shared by the webapp API and the PUT handlers. */
export class Outbound {
  /** Peers addressed by hand, so they show up in the list afterwards. */
  private readonly used = new Set<string>()

  constructor(private readonly deps: OutboundDeps) {}

  peers(): PeerInfo[] {
    const out = new Map<string, PeerInfo>()
    const add = (address: string, source: PeerInfo['source'], name?: string): void => {
      const t = parsePeer(address)
      const key = peerKey(t)
      if (out.has(key)) return
      out.set(key, { address: key, name, paired: this.deps.client.isPaired(t), source })
    }
    for (const p of this.deps.discovered()) add(`${p.address}:${p.port}`, 'mdns', p.name)
    for (const a of this.deps.configuredPeers()) {
      try {
        add(a, 'config')
      } catch {
        // an invalid entry in the config is ignored here
      }
    }
    for (const a of this.used) add(a, 'used')
    return [...out.values()]
  }

  /** The peer a request means: the one named, or the only (paired) one known. */
  resolve(peer: string | undefined): PeerTarget {
    if (peer && peer.trim() !== '') {
      const t = parsePeer(peer)
      this.used.add(peerKey(t))
      return t
    }
    const all = this.peers()
    const paired = all.filter((p) => p.paired)
    const pick = paired.length === 1 ? paired[0] : all.length === 1 ? all[0] : undefined
    if (!pick) {
      throw new PeerError(
        'badRequest',
        all.length === 0 ? 'no OpenCPN peer known; give "peer" as host or host:port' : 'several OpenCPN peers known; give "peer"'
      )
    }
    return parsePeer(pick.address)
  }

  async pair(peer: string | undefined, pin: string): Promise<SendOutcome | { status: 'paired'; peer: string }> {
    let t: PeerTarget | undefined
    try {
      t = this.resolve(peer)
      await this.deps.client.pair(t, pin)
      return { status: 'paired', peer: peerKey(t) }
    } catch (error) {
      return failure(error, t)
    }
  }

  /** Ask OpenCPN for a PIN without sending anything. */
  async startPairing(peer: string | undefined): Promise<SendOutcome | { status: 'paired'; peer: string }> {
    let t: PeerTarget | undefined
    try {
      t = this.resolve(peer)
      await this.deps.client.ensurePaired(t)
      return { status: 'paired', peer: peerKey(t) }
    } catch (error) {
      return failure(error, t)
    }
  }

  async unpair(peer: string): Promise<void> {
    await this.deps.client.unpair(parsePeer(peer))
  }

  async send(req: SendRequest): Promise<SendOutcome> {
    let t: PeerTarget | undefined
    try {
      if (!Array.isArray(req.items) || req.items.length === 0) {
        throw new PeerError('badRequest', 'nothing to send: "items" is empty')
      }
      const items: ExportItem[] = []
      for (const item of req.items) {
        if ((item?.type !== 'routes' && item?.type !== 'waypoints') || typeof item.id !== 'string' || item.id === '') {
          throw new PeerError('badRequest', 'each item needs "type" (routes or waypoints) and "id"')
        }
        let resource: SkResource
        try {
          resource = await this.deps.getResource(item.type, item.id)
        } catch {
          throw new PeerError('badRequest', `${item.type} ${item.id} not found`)
        }
        items.push({ type: item.type, id: item.id, resource })
      }
      if (req.activate && items.filter((i) => i.type === 'routes').length !== 1) {
        throw new PeerError('badRequest', '"activate" needs exactly one route')
      }
      const gpx = buildGpx(items)
      t = this.resolve(req.peer)
      await this.deps.client.send(t, gpx.xml, gpx.guids, { force: req.force, activate: req.activate })
      return { status: 'sent', peer: peerKey(t), count: items.length }
    } catch (error) {
      if (error instanceof ExportError) return { status: 'error', code: 'badRequest', message: error.message }
      return failure(error, t)
    }
  }
}

function failure(error: unknown, t: PeerTarget | undefined): SendOutcome {
  const peer = t ? peerKey(t) : undefined
  if (error instanceof PeerError) {
    if (error.code === 'needsPin' && peer) return { status: 'needsPin', peer, message: error.message }
    if (error.code === 'exists' && peer) {
      return { status: 'exists', peer, guids: Array.isArray(error.detail) ? (error.detail as string[]) : [], message: error.message }
    }
    return { status: 'error', peer, code: error.code, message: error.message }
  }
  return { status: 'error', peer, code: 'internal', message: String(error) }
}

/** HTTP status for an outcome, used by the REST API and the PUT handlers. */
export function statusCodeOf(outcome: { status: string; code?: string }): number {
  switch (outcome.status) {
    case 'sent':
    case 'paired':
      return 200
    case 'needsPin':
      return 403
    case 'exists':
      return 409
    default:
      if (outcome.code === 'badRequest' || outcome.code === 'activateUnsupported') return 400
      if (outcome.code === 'badPin') return 403
      if (outcome.code === 'unreachable' || outcome.code === 'protocol' || outcome.code === 'rejected') return 502
      if (outcome.code === 'unconfirmed') return 504
      return 500
  }
}
