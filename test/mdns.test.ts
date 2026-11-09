import { describe, expect, it } from 'vitest'
import { OPENCPN_SERVICE, peersFromResponse } from '../src/mdns.js'

const now = new Date('2026-11-06T00:00:00Z')
const never = () => false
const ipv4 = (address: string) => ({ address, family: 'IPv4' })

function answer(name: string, port?: number) {
  const instance = `${name}.${OPENCPN_SERVICE}`
  return {
    answers: [{ name: OPENCPN_SERVICE, type: 'PTR', data: instance }],
    additionals: port === undefined ? [] : [{ name: instance, type: 'SRV', data: { port, target: `${name}.local` } }]
  }
}

describe('peersFromResponse', () => {
  it('reads an OpenCPN answer like OpenCPN does: name from PTR, address from the sender', () => {
    expect(peersFromResponse(answer('nav-pc', 8000), ipv4('192.0.2.28'), never, now)).toEqual([
      { name: 'nav-pc', address: '192.0.2.28', port: 8443, lastSeen: now }
    ])
  })

  it('uses 8444 for portable OpenCPN, whose announced 8001 says nothing', () => {
    expect(peersFromResponse(answer('Portable-nav', 8001), ipv4('192.0.2.5'), never, now)[0].port).toBe(8444)
  })

  it('takes the real port another instance of this plugin announces', () => {
    expect(peersFromResponse(answer('SignalK-Test', 18443), ipv4('192.0.2.28'), never, now)[0].port).toBe(18443)
  })

  it('ignores impossible announced ports', () => {
    for (const bad of [0, 70000, 80.5, Number.NaN]) {
      expect(peersFromResponse(answer('x', bad), ipv4('192.0.2.9'), never, now)[0].port).toBe(8443)
    }
  })

  it('falls back to 8443 without an SRV record', () => {
    expect(peersFromResponse(answer('nav-pc'), ipv4('192.0.2.28'), never, now)[0].port).toBe(8443)
  })

  it('skips our own answer and non-IPv4 senders', () => {
    const own = (name: string, address: string) => name === 'SignalK' && address === '192.0.2.111'
    expect(peersFromResponse(answer('SignalK', 8443), ipv4('192.0.2.111'), own, now)).toEqual([])
    expect(peersFromResponse(answer('SignalK', 8443), ipv4('192.0.2.112'), own, now)).toHaveLength(1)
    expect(peersFromResponse(answer('nav-pc', 8000), { address: 'fe80::1', family: 'IPv6' }, never, now)).toEqual([])
  })

  it('ignores records for other services', () => {
    const other = { answers: [{ name: '_http._tcp.local', type: 'PTR', data: 'x._http._tcp.local' }] }
    expect(peersFromResponse(other, ipv4('192.0.2.1'), never, now)).toEqual([])
  })
})
