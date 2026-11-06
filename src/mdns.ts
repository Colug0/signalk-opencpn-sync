import { networkInterfaces } from 'node:os'
import makeMdns from 'multicast-dns'

/**
 * OpenCPN queries this name as it is, without the usual `_name._tcp.local`
 * form (model/src/mdns_query.cpp), so standard DNS-SD libraries can't answer it.
 */
export const OPENCPN_SERVICE = 'opencpn-object-control-service'

/** Port OpenCPN announces. Its clients ignore it and always connect to 8443. */
const ANNOUNCED_PORT = 8000
const TTL = 120
const MDNS_PORT = 5353

function localIpv4(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i!.address)
}

export interface DiscoveredPeer {
  /** Host name OpenCPN announces (its g_hostname). */
  name: string
  /** IPv4 address the answer came from; OpenCPN uses the same rule. */
  address: string
  /** Portable OpenCPN listens on 8444 instead of 8443. */
  port: number
  lastSeen: Date
}

export interface MdnsOptions {
  /** Answer OpenCPN's discovery under this name; undefined only listens. */
  announceAs?: string
  log: (msg: string) => void
}

/** OpenCPN peer discovery on mDNS, in both directions. */
export class MdnsService {
  private readonly mdns = makeMdns()
  private readonly peers = new Map<string, DiscoveredPeer>()

  constructor(private readonly opts: MdnsOptions) {
    this.mdns.on('error', (error: Error) => opts.log(`mDNS: ${error.message}`))
    this.mdns.on('query', (query, rinfo) => this.answer(query, rinfo))
    this.mdns.on('response', (response, rinfo) => {
      for (const a of [...response.answers, ...(response.additionals ?? [])]) {
        if (a.type !== 'PTR' || a.name.toLowerCase() !== OPENCPN_SERVICE || typeof a.data !== 'string') continue
        const name = a.data.split(`.${OPENCPN_SERVICE}`)[0]
        if (!name || name === opts.announceAs) continue
        if (rinfo.family !== 'IPv4') continue
        this.peers.set(rinfo.address, {
          name,
          address: rinfo.address,
          port: name.startsWith('Portable') ? 8444 : 8443,
          lastSeen: new Date()
        })
      }
    })
  }

  /** Ask the network for OpenCPN instances and collect answers for `waitMs`. */
  async scan(waitMs = 3000): Promise<DiscoveredPeer[]> {
    this.mdns.query({ questions: [{ name: OPENCPN_SERVICE, type: 'PTR' }] })
    await new Promise((resolve) => setTimeout(resolve, waitMs))
    return this.list()
  }

  /** Peers heard from in the last 30 minutes, newest first. */
  list(): DiscoveredPeer[] {
    const cutoff = Date.now() - 30 * 60_000
    return [...this.peers.values()]
      .filter((p) => p.lastSeen.getTime() >= cutoff)
      .sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime())
  }

  stop(): void {
    this.mdns.destroy()
  }

  /**
   * OpenCPN takes the peer's name from the PTR answer and its address from the
   * UDP sender, so a PTR record is all it needs; SRV and A records are added
   * for other tools.
   */
  private answer(query: { id?: number; questions: Array<{ name: string; type: string }> }, rinfo: { port: number; address: string }): void {
    const name = this.opts.announceAs
    if (!name) return
    const asked = query.questions.filter(
      (q) => q.name.toLowerCase() === OPENCPN_SERVICE && (q.type === 'PTR' || q.type === 'ANY')
    )
    if (asked.length === 0) return
    const instance = `${name}.${OPENCPN_SERVICE}`
    const target = `${name}.local`
    const legacy = rinfo.port !== MDNS_PORT
    const response = {
      // A query from a port other than 5353 is a one-shot "legacy" query that
      // expects a unicast answer echoing its id and question (RFC 6762 6.7).
      id: legacy ? (query.id ?? 0) : 0,
      questions: legacy ? asked : [],
      answers: [{ name: OPENCPN_SERVICE, type: 'PTR' as const, ttl: TTL, data: instance }],
      additionals: [
        { name: instance, type: 'SRV' as const, ttl: TTL, data: { port: ANNOUNCED_PORT, target, priority: 0, weight: 0 } },
        ...localIpv4().map((ip) => ({ name: target, type: 'A' as const, ttl: TTL, data: ip }))
      ]
    }
    if (legacy) this.mdns.respond(response as never, rinfo as never)
    else this.mdns.respond(response as never)
  }
}
