import { createHash, randomUUID } from 'node:crypto'
import { XMLParser, XMLValidator } from 'fast-xml-parser'

export interface GpxPoint {
  lat: number
  lon: number
  name?: string
  description?: string
  sym?: string
  guid?: string
}

export interface GpxRoute {
  guid?: string
  name?: string
  description?: string
  points: GpxPoint[]
}

export interface GpxContent {
  routes: GpxRoute[]
  waypoints: GpxPoint[]
  /** Tracks are counted but not converted: Signal K has no track resource. */
  trackCount: number
}

export class GpxError extends Error {}

const ARRAY_ELEMENTS = new Set(['rte', 'rtept', 'wpt', 'trk'])

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => ARRAY_ELEMENTS.has(name)
})

type XmlNode = Record<string, unknown>

function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value === '' ? undefined : value
  if (value && typeof value === 'object' && '#text' in value) {
    return text((value as XmlNode)['#text'])
  }
  return undefined
}

function extension(node: XmlNode, name: string): string | undefined {
  const ext = node.extensions
  if (!ext || typeof ext !== 'object') return undefined
  return text((ext as XmlNode)[`opencpn:${name}`])
}

function parsePoint(node: XmlNode): GpxPoint {
  const lat = Number(node['@_lat'])
  const lon = Number(node['@_lon'])
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw new GpxError(`invalid coordinates lat=${String(node['@_lat'])} lon=${String(node['@_lon'])}`)
  }
  return {
    lat,
    lon,
    name: text(node.name),
    description: text(node.desc),
    sym: text(node.sym),
    guid: extension(node, 'guid')
  }
}

function asNodes(value: unknown): XmlNode[] {
  return Array.isArray(value) ? (value.filter((v) => v && typeof v === 'object') as XmlNode[]) : []
}

/** Parse the GPX document OpenCPN sends with "Send to Peer". */
export function parseGpx(xml: string): GpxContent {
  const valid = XMLValidator.validate(xml)
  if (valid !== true) {
    throw new GpxError(`not well-formed XML: ${valid.err.msg} (line ${valid.err.line})`)
  }
  let doc: XmlNode
  try {
    doc = parser.parse(xml) as XmlNode
  } catch (error) {
    throw new GpxError(`not well-formed XML: ${(error as Error).message}`)
  }
  const gpx = doc.gpx
  if (!gpx || typeof gpx !== 'object') throw new GpxError('root element <gpx> missing')
  const root = gpx as XmlNode

  const routes = asNodes(root.rte).map((rte) => ({
    guid: extension(rte, 'guid'),
    name: text(rte.name),
    description: text(rte.desc),
    points: asNodes(rte.rtept).map(parsePoint)
  }))
  const waypoints = asNodes(root.wpt).map(parsePoint)
  return { routes, waypoints, trackCount: asNodes(root.trk).length }
}

const SK_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Signal K requires UUID v4 resource ids. Current OpenCPN GUIDs already are
 * v4 and are used as they are, so a resend replaces the same resource. Other
 * GUIDs map to a stable v4-shaped id derived from them.
 */
export function resourceId(guid: string | undefined): string {
  if (!guid) return randomUUID()
  if (SK_UUID.test(guid)) return guid.toLowerCase()
  return derivedUuid(guid)
}

/** A stable UUID v4-shaped id derived from a seed string. */
export function derivedUuid(seed: string): string {
  const h = createHash('sha1').update(`opencpn-sync:${seed}`).digest('hex')
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

const EARTH_RADIUS_M = 6371008.8

function distanceM(a: GpxPoint, b: GpxPoint): number {
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLon = (b.lon - a.lon) * rad
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

export interface Origin {
  /** The `source` OpenCPN sent: the sender's host name. */
  sender: string
  receivedAt: string
}

function originProperties(origin: Origin, guid: string | undefined): Record<string, unknown> {
  return {
    opencpnSync: { sender: origin.sender, receivedAt: origin.receivedAt, ...(guid ? { guid } : {}) }
  }
}

/** Signal K route resource for a GPX route, or undefined with fewer than two points. */
export function toSignalKRoute(route: GpxRoute, origin: Origin): Record<string, unknown> | undefined {
  if (route.points.length < 2) return undefined
  let distance = 0
  for (let i = 1; i < route.points.length; i++) {
    distance += distanceM(route.points[i - 1], route.points[i])
  }
  return {
    ...(route.name ? { name: route.name } : {}),
    ...(route.description ? { description: route.description } : {}),
    distance: Math.round(distance),
    feature: {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: route.points.map((p) => [p.lon, p.lat])
      },
      properties: {
        coordinatesMeta: route.points.map((p) => ({
          name: p.name ?? '',
          ...(p.description ? { description: p.description } : {})
        })),
        ...originProperties(origin, route.guid)
      }
    }
  }
}

/** Signal K waypoint resource for a stand-alone GPX waypoint. */
export function toSignalKWaypoint(point: GpxPoint, origin: Origin): Record<string, unknown> {
  return {
    ...(point.name ? { name: point.name } : {}),
    ...(point.description ? { description: point.description } : {}),
    feature: {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [point.lon, point.lat] },
      properties: {
        ...(point.sym ? { sym: point.sym } : {}),
        ...originProperties(origin, point.guid)
      }
    }
  }
}
