import type { ActionResult } from '@signalk/server-api'
import { statusCodeOf, type Outbound, type SendRequest } from './outbound.js'

/** Paths for Signal K PUT requests: PUT /signalk/v1/api/vessels/self/opencpnSync/<action>. */
export const PUT_SEND_PATH = 'opencpnSync.send'
export const PUT_PAIR_PATH = 'opencpnSync.pair'

interface Req {
  body?: unknown
}
interface Res {
  status(code: number): Res
  json(value: unknown): void
}
type Handler = (req: Req, res: Res) => void

interface Registrar {
  get(path: string, handler: Handler): unknown
  post(path: string, handler: Handler): unknown
}

/** Minimal view of the server's plugin router; `access` exists from Signal K 2.35 on. */
export interface RouterLike extends Registrar {
  access?: (level: 'readwrite' | 'readonly') => Registrar
}

export interface ApiDeps {
  outbound: () => Outbound | undefined
  scan: () => Promise<void>
  peerName: () => string | undefined
}

function body(req: Req): Record<string, unknown> {
  return req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {}
}

/**
 * REST API for the webapp and other apps, mounted at /plugins/signalk-opencpn-sync.
 * Sending and pairing only need read/write access where the server supports
 * route access levels, so a chart plotter app can use them without admin rights.
 */
export function registerApi(router: RouterLike, deps: ApiDeps): void {
  const rw: Registrar = typeof router.access === 'function' ? router.access('readwrite') : router
  const ro: Registrar = typeof router.access === 'function' ? router.access('readonly') : router

  const running = (res: Res): Outbound | undefined => {
    const o = deps.outbound()
    if (!o) res.status(503).json({ status: 'error', code: 'notRunning', message: 'the plugin is not running' })
    return o
  }
  const reply = (res: Res, outcome: { status: string; code?: string }): void => {
    res.status(statusCodeOf(outcome)).json(outcome)
  }
  const guard =
    (fn: (req: Req, res: Res) => Promise<void>): Handler =>
    (req, res) => {
      fn(req, res).catch((error: unknown) =>
        res.status(500).json({ status: 'error', code: 'internal', message: String(error) })
      )
    }

  ro.get(
    '/api/peers',
    guard(async (_req, res) => {
      const o = running(res)
      if (o) res.json({ peerName: deps.peerName(), peers: o.peers() })
    })
  )

  rw.post(
    '/api/scan',
    guard(async (_req, res) => {
      const o = running(res)
      if (!o) return
      await deps.scan()
      res.json({ peerName: deps.peerName(), peers: o.peers() })
    })
  )

  rw.post(
    '/api/pair',
    guard(async (req, res) => {
      const o = running(res)
      if (!o) return
      const b = body(req)
      const peer = typeof b.peer === 'string' ? b.peer : undefined
      reply(res, typeof b.pin === 'string' && b.pin !== '' ? await o.pair(peer, b.pin) : await o.startPairing(peer))
    })
  )

  router.post(
    '/api/unpair',
    guard(async (req, res) => {
      const o = running(res)
      if (!o) return
      const b = body(req)
      if (typeof b.peer !== 'string') {
        res.status(400).json({ status: 'error', code: 'badRequest', message: '"peer" missing' })
        return
      }
      await o.unpair(b.peer)
      res.json({ status: 'unpaired', peer: b.peer })
    })
  )

  rw.post(
    '/api/send',
    guard(async (req, res) => {
      const o = running(res)
      if (o) reply(res, await o.send(toSendRequest(body(req))))
    })
  )
}

/** Accept `{items: [...]}` as well as a single `{type, id}`. */
export function toSendRequest(b: Record<string, unknown>): SendRequest {
  const items = Array.isArray(b.items)
    ? (b.items as SendRequest['items'])
    : typeof b.type === 'string' && typeof b.id === 'string'
      ? [{ type: b.type as 'routes' | 'waypoints', id: b.id }]
      : []
  return {
    peer: typeof b.peer === 'string' ? b.peer : undefined,
    items,
    force: b.force === true,
    activate: b.activate === true
  }
}

type PutRegistrar = (
  context: string,
  path: string,
  handler: (context: string, path: string, value: unknown, cb: (r: ActionResult) => void) => ActionResult,
  source?: string
) => void

/**
 * Signal K PUT handlers, for apps that already speak the PUT protocol.
 * They answer PENDING at once and COMPLETED with the outcome as JSON in
 * `message` when OpenCPN has replied.
 */
export function registerPutHandlers(register: PutRegistrar, deps: ApiDeps, source: string): void {
  const complete = (outcome: { status: string; code?: string }): ActionResult => ({
    state: 'COMPLETED',
    statusCode: statusCodeOf(outcome),
    message: JSON.stringify(outcome)
  })
  const pending = (work: () => Promise<{ status: string; code?: string }>, cb: (r: ActionResult) => void): ActionResult => {
    work()
      .then((outcome) => cb(complete(outcome)))
      .catch((error: unknown) => cb(complete({ status: 'error', code: 'internal', message: String(error) } as never)))
    return { state: 'PENDING' }
  }
  const notRunning: ActionResult = { state: 'COMPLETED', statusCode: 503, message: 'the plugin is not running' }
  const asObject = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

  register(
    'vessels.self',
    PUT_SEND_PATH,
    (_ctx, _path, value, cb) => {
      const o = deps.outbound()
      return o ? pending(() => o.send(toSendRequest(asObject(value))), cb) : notRunning
    },
    source
  )
  register(
    'vessels.self',
    PUT_PAIR_PATH,
    (_ctx, _path, value, cb) => {
      const o = deps.outbound()
      if (!o) return notRunning
      const v = asObject(value)
      const peer = typeof v.peer === 'string' ? v.peer : undefined
      return pending(() => (typeof v.pin === 'string' && v.pin !== '' ? o.pair(peer, v.pin) : o.startPairing(peer)), cb)
    },
    source
  )
}
