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

export interface MdnsAnnouncer {
  stop(): void
}

/**
 * Answer OpenCPN's peer discovery. OpenCPN takes the peer's name from the PTR
 * answer and its address from the UDP sender, so a PTR record is all it needs;
 * SRV and A records are added for other tools.
 */
export function announce(instanceName: string, log: (msg: string) => void): MdnsAnnouncer {
  const mdns = makeMdns()
  const instance = `${instanceName}.${OPENCPN_SERVICE}`
  const target = `${instanceName}.local`

  mdns.on('error', (error: Error) => log(`mDNS: ${error.message}`))
  mdns.on('query', (query, rinfo) => {
    const asked = query.questions.filter(
      (q) => q.name.toLowerCase() === OPENCPN_SERVICE && (q.type === 'PTR' || (q.type as string) === 'ANY')
    )
    if (asked.length === 0) return
    const response = {
      // A query from a port other than 5353 is a one-shot "legacy" query that
      // expects a unicast answer echoing its id and question (RFC 6762 6.7).
      id: rinfo.port === MDNS_PORT ? 0 : query.id,
      questions: rinfo.port === MDNS_PORT ? [] : asked,
      answers: [{ name: OPENCPN_SERVICE, type: 'PTR' as const, ttl: TTL, data: instance }],
      additionals: [
        { name: instance, type: 'SRV' as const, ttl: TTL, data: { port: ANNOUNCED_PORT, target, priority: 0, weight: 0 } },
        ...localIpv4().map((ip) => ({ name: target, type: 'A' as const, ttl: TTL, data: ip }))
      ]
    }
    if (rinfo.port === MDNS_PORT) mdns.respond(response)
    else mdns.respond(response, rinfo)
  })

  return {
    stop: () => mdns.destroy()
  }
}
