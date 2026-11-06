import { join } from 'node:path'
import { Type, type Static } from 'typebox'
import type { Path, Plugin, ServerAPI } from '@signalk/server-api'
import { loadOrCreateCertificate } from './certificate.js'
import { GpxError, parseGpx, resourceId, toSignalKRoute, toSignalKWaypoint, type Origin } from './gpx.js'
import { KeyStore } from './keystore.js'
import { MdnsService } from './mdns.js'
import { PeerServer, Result, type ReceiveRequest, type ResultCode } from './peer-server.js'
import { PeerClient } from './peer-client.js'
import { Outbound } from './outbound.js'
import type { SkResource } from './gpx-writer.js'
import { registerApi, registerPutHandlers, type ApiDeps, type RouterLike } from './api.js'

const PLUGIN_ID = 'signalk-opencpn-sync'
const PAIRING_PATH = 'notifications.opencpnSync.pairing' as Path
/** The PIN notification is cleared after this; the PIN stays valid until the next pairing request. */
const PAIRING_NOTICE_MS = 5 * 60_000
/** Any version from 5.9 on makes OpenCPN use the current pairing and /api/writable. */
const EMULATED_VERSION = '5.14.0'

const ConfigSchema = Type.Object({
  port: Type.Integer({
    title: 'HTTPS port',
    description: 'OpenCPN always sends to port 8443. Change only for testing.',
    default: 8443,
    minimum: 1,
    maximum: 65535
  }),
  // Optional, because the admin UI drops an emptied text field from the
  // saved config and would then reject a required one.
  bindAddress: Type.Optional(
    Type.String({
      title: 'Bind address',
      description: 'IP address to listen on. Leave empty to listen on all interfaces.'
    })
  ),
  peerName: Type.String({
    title: 'Peer name',
    description: 'Name shown in the peer list of OpenCPN\'s "Send to Peer" dialog. Must not start with "Portable".',
    default: 'SignalK',
    pattern: '^[A-Za-z0-9][A-Za-z0-9_-]*$'
  }),
  announceMdns: Type.Boolean({
    title: 'Announce via mDNS',
    description: 'Lets OpenCPN find this server with "Scan". Without it, type the IP address into the dialog.',
    default: true
  }),
  peers: Type.Optional(
    Type.Array(Type.String({ title: 'Address' }), {
      title: 'OpenCPN computers to send to',
      description:
        'Host or host:port of OpenCPN instances, offered for sending in addition to those found on the network. Port 8443 if left out.'
    })
  ),
  requirePairing: Type.Boolean({
    title: 'Require PIN pairing',
    description: 'Off accepts routes from anyone on the network without a PIN.',
    default: true
  })
})
type Config = Static<typeof ConfigSchema>

export default function (app: ServerAPI): Plugin {
  let server: PeerServer | undefined
  let mdns: MdnsService | undefined
  let outbound: Outbound | undefined
  let peerName: string | undefined

  const apiDeps: ApiDeps = {
    outbound: () => outbound,
    scan: async () => {
      await mdns?.scan()
    },
    peerName: () => peerName
  }
  let pairingTimer: NodeJS.Timeout | undefined
  /** Bumped by stop() so a start() still running in the background stands down. */
  let generation = 0

  function setStatus(msg: string): void {
    app.setPluginStatus(msg)
  }

  function notifyPairing(message: string | undefined): void {
    clearTimeout(pairingTimer)
    pairingTimer = undefined
    app.handleMessage(PLUGIN_ID, {
      updates: [
        {
          values: [
            {
              path: PAIRING_PATH,
              value: message
                ? { state: 'alert', method: ['visual'], message }
                : { state: 'normal', method: [], message: '' }
            }
          ]
        }
      ]
    })
    if (message) pairingTimer = setTimeout(() => notifyPairing(undefined), PAIRING_NOTICE_MS)
  }

  async function exists(guid: string): Promise<boolean> {
    const id = resourceId(guid)
    for (const type of ['routes', 'waypoints'] as const) {
      try {
        await app.resourcesApi.getResource(type, id)
        return true
      } catch {
        // not found, or no provider for this type
      }
    }
    return false
  }

  async function store(type: 'routes' | 'waypoints', guid: string | undefined, data: Record<string, unknown>, force: boolean): Promise<ResultCode> {
    if (guid && !force && (await exists(guid))) return Result.DuplicateRejected
    await app.resourcesApi.setResource(type, resourceId(guid), data)
    return Result.NoError
  }

  async function receive(req: ReceiveRequest): Promise<ResultCode> {
    let content
    try {
      content = parseGpx(req.gpx)
    } catch (error) {
      if (error instanceof GpxError) {
        app.error(`Rejected GPX from ${req.source}: ${error.message}`)
        return Result.ObjectParseError
      }
      throw error
    }
    const origin: Origin = { sender: req.source, receivedAt: new Date().toISOString() }
    let stored = 0
    let result: ResultCode = Result.NoError
    try {
      for (const rte of content.routes) {
        const data = toSignalKRoute(rte, origin)
        if (!data) {
          app.error(`Skipped route "${rte.name ?? rte.guid ?? '?'}" from ${req.source}: fewer than two points`)
          continue
        }
        const r = await store('routes', rte.guid, data, req.force)
        if (r === Result.NoError) stored++
        else result = r
      }
      for (const wpt of content.waypoints) {
        const r = await store('waypoints', wpt.guid, toSignalKWaypoint(wpt, origin), req.force)
        if (r === Result.NoError) stored++
        else result = r
      }
    } catch (error) {
      app.error(`Could not store objects from ${req.source}: ${String(error)}`)
      return Result.RouteInsertError
    }
    if (content.trackCount > 0) {
      app.debug(`Ignored ${content.trackCount} track(s) from ${req.source}: no Signal K track resource`)
    }
    if (req.activate) app.debug(`Ignored "activate" from ${req.source}: not supported yet`)
    if (stored === 0 && result === Result.NoError) return Result.ObjectRejected
    setStatus(`Received ${content.routes.length} route(s), ${content.waypoints.length} waypoint(s) from ${req.source}`)
    return result
  }

  const plugin: Plugin = {
    id: PLUGIN_ID,
    name: 'OpenCPN Sync',
    description: 'Receive routes and waypoints from OpenCPN "Send to Peer" as Signal K resources',
    schema: () => ConfigSchema,

    registerWithRouter: (router) => {
      registerApi(router as unknown as RouterLike, apiDeps)
    },

    start: (settings: object) => {
      const config = { ...defaults(), ...(settings as Partial<Config>) }
      const bindAddress = config.bindAddress?.trim() || undefined
      const run = ++generation
      registerPutHandlers(app.registerPutHandler.bind(app), apiDeps, PLUGIN_ID)
      void (async () => {
        try {
          const dir = app.getDataDirPath()
          const keys = new KeyStore(join(dir, 'paired-keys.json'))
          await keys.load()
          const tls = await loadOrCreateCertificate(dir, config.peerName)
          server = new PeerServer({
            port: config.port,
            host: bindAddress,
            tls,
            version: EMULATED_VERSION,
            keys,
            requirePairing: config.requirePairing,
            onPairingRequest: (source, pin) => {
              const msg = `OpenCPN "${source}" wants to send routes. Enter PIN ${pin} in OpenCPN.`
              setStatus(msg)
              notifyPairing(msg)
            },
            onPaired: (source) => {
              setStatus(`Paired with OpenCPN "${source}"`)
              notifyPairing(undefined)
            },
            exists,
            receive,
            log: (msg) => app.debug(msg)
          })
          const peerKeys = new KeyStore(join(dir, 'peer-keys.json'))
          await peerKeys.load()
          const started = server
          const port = await started.start()
          if (run !== generation) {
            await started.stop()
            return
          }
          mdns = new MdnsService({
            announceAs: config.announceMdns ? config.peerName : undefined,
            log: (msg) => app.debug(msg)
          })
          const configuredPeers = config.peers ?? []
          outbound = new Outbound({
            client: new PeerClient({ source: config.peerName, keys: peerKeys }),
            getResource: async (type, id) => (await app.resourcesApi.getResource(type, id)) as SkResource,
            discovered: () => mdns?.list() ?? [],
            configuredPeers: () => configuredPeers
          })
          peerName = config.peerName
          void mdns.scan().catch(() => undefined)
          setStatus(`Listening on ${bindAddress ? `${bindAddress}:` : 'port '}${port} as "${config.peerName}"`)
        } catch (error) {
          app.setPluginError(`Could not start: ${String(error)}`)
        }
      })()
    },

    stop: async () => {
      generation++
      clearTimeout(pairingTimer)
      pairingTimer = undefined
      mdns?.stop()
      mdns = undefined
      outbound = undefined
      peerName = undefined
      await server?.stop()
      server = undefined
    }
  }
  return plugin
}

function defaults(): Config {
  return { port: 8443, peerName: 'SignalK', announceMdns: true, requirePairing: true }
}
