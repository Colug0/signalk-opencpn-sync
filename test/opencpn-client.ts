import { request } from 'node:https'
import { pinHash } from '../src/pincode.js'

/**
 * Minimal stand-in for OpenCPN's peer client (model/src/peer_client.cpp):
 * same URLs, query parameters and pairing steps, no certificate check.
 */
export interface Reply {
  status: number
  body: string
  json?: Record<string, unknown>
}

export function call(port: number, path: string, body?: string, host = '127.0.0.1'): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host,
        port,
        path,
        method: body === undefined ? 'GET' : 'POST',
        rejectUnauthorized: false,
        headers: body === undefined ? {} : { 'Content-Type': 'application/xml', 'Content-Length': Buffer.byteLength(body) }
      },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (c: string) => (data += c))
        res.on('end', () => {
          let json: Record<string, unknown> | undefined
          try {
            json = JSON.parse(data) as Record<string, unknown>
          } catch {
            json = undefined
          }
          resolve({ status: res.statusCode ?? 0, body: data, json })
        })
      }
    )
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

/** The probe key OpenCPN 5.9+ sends when it has no key for a server yet. */
export const PROBE_KEY = '0123456789abc'

export function q(params: Record<string, string>): string {
  return new URLSearchParams(params).toString()
}

/** Pair like OpenCPN: probe, read the PIN (here from a callback), confirm with its hash. */
export async function pair(port: number, source: string, readPin: () => Promise<string>, host?: string): Promise<string> {
  const first = await call(port, `/api/ping?${q({ source, apikey: PROBE_KEY })}`, undefined, host)
  if (first.json?.result !== 5) throw new Error(`expected NewPinRequested, got ${first.body}`)
  const key = pinHash(Number(await readPin()))
  const second = await call(port, `/api/ping?${q({ source, apikey: key })}`, undefined, host)
  if (second.json?.result !== 0) throw new Error(`pairing failed: ${second.body}`)
  return key
}
