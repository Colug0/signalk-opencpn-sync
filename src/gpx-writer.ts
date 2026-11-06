import { derivedUuid } from './gpx.js'

/** Signal K route or waypoint resource, as far as the GPX export needs it. */
export interface SkResource {
  name?: string
  description?: string
  feature?: {
    geometry?: { type?: string; coordinates?: unknown }
    properties?: Record<string, unknown>
  }
}

export class ExportError extends Error {}

export interface ExportItem {
  type: 'routes' | 'waypoints'
  id: string
  resource: SkResource
}

export interface GpxExport {
  xml: string
  /** GUIDs of the top-level objects, for OpenCPN's /api/writable check. */
  guids: string[]
}

function esc(text: string): string {
  return text.replace(/[<>&'"]/g, (c) =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c === "'" ? '&apos;' : '&quot;'
  )
}

function isLonLat(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number' &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1]) &&
    Math.abs(value[0]) <= 180 &&
    Math.abs(value[1]) <= 90
  )
}

/**
 * The GUID OpenCPN gets for a resource. An object that came from OpenCPN
 * goes back under the GUID it arrived with, so OpenCPN replaces it instead of
 * adding a copy; anything else uses its Signal K id, which is a UUID as well.
 */
export function guidFor(id: string, resource: SkResource): string {
  const origin = resource.feature?.properties?.opencpnSync
  if (origin && typeof origin === 'object') {
    const guid = (origin as Record<string, unknown>).guid
    if (typeof guid === 'string' && guid !== '') return guid
  }
  return id
}

function optional(tag: string, value: unknown, indent: string): string {
  return typeof value === 'string' && value !== '' ? `${indent}<${tag}>${esc(value)}</${tag}>\n` : ''
}

function point(
  tag: 'wpt' | 'rtept',
  [lon, lat]: [number, number],
  guid: string,
  name: string | undefined,
  description: string | undefined,
  sym: string,
  indent: string
): string {
  return (
    `${indent}<${tag} lat="${lat.toFixed(9)}" lon="${lon.toFixed(9)}">\n` +
    optional('name', name, `${indent}  `) +
    optional('desc', description, `${indent}  `) +
    `${indent}  <sym>${esc(sym)}</sym>\n` +
    `${indent}  <extensions>\n` +
    `${indent}    <opencpn:guid>${esc(guid)}</opencpn:guid>\n` +
    `${indent}  </extensions>\n` +
    `${indent}</${tag}>\n`
  )
}

function routeXml(id: string, route: SkResource): { xml: string; guid: string } {
  const geometry = route.feature?.geometry
  const coords = geometry?.type === 'LineString' && Array.isArray(geometry.coordinates) ? geometry.coordinates : []
  if (coords.length < 2 || !coords.every(isLonLat)) {
    throw new ExportError(`route ${id} has no valid LineString with at least two points`)
  }
  const guid = guidFor(id, route)
  const meta = route.feature?.properties?.coordinatesMeta
  const metaList = Array.isArray(meta) ? meta : []
  const points = coords
    .map((c, i) => {
      const m = metaList[i] && typeof metaList[i] === 'object' ? (metaList[i] as Record<string, unknown>) : {}
      const name = typeof m.name === 'string' && m.name !== '' ? m.name : String(i + 1).padStart(3, '0')
      const description = typeof m.description === 'string' ? m.description : undefined
      // Route points need GUIDs of their own; deriving them from the route
      // keeps them the same on every resend.
      return point('rtept', c as [number, number], derivedUuid(`${guid}:${i}`), name, description, 'diamond', '    ')
    })
    .join('')
  const xml =
    '  <rte>\n' +
    optional('name', route.name, '    ') +
    optional('desc', route.description, '    ') +
    '    <extensions>\n' +
    `      <opencpn:guid>${esc(guid)}</opencpn:guid>\n` +
    '      <opencpn:viz>1</opencpn:viz>\n' +
    '    </extensions>\n' +
    points +
    '  </rte>\n'
  return { xml, guid }
}

function waypointXml(id: string, wpt: SkResource): { xml: string; guid: string } {
  const geometry = wpt.feature?.geometry
  if (geometry?.type !== 'Point' || !isLonLat(geometry.coordinates)) {
    throw new ExportError(`waypoint ${id} has no valid Point geometry`)
  }
  const guid = guidFor(id, wpt)
  const sym = wpt.feature?.properties?.sym
  return {
    xml: point('wpt', geometry.coordinates, guid, wpt.name, wpt.description, typeof sym === 'string' && sym ? sym : 'triangle', '  '),
    guid
  }
}

/** GPX in the form OpenCPN's "Send to Peer" sends: routes first, then waypoints. */
export function buildGpx(items: ExportItem[]): GpxExport {
  const parts: Array<{ xml: string; guid: string }> = []
  for (const item of items.filter((i) => i.type === 'routes')) parts.push(routeXml(item.id, item.resource))
  for (const item of items.filter((i) => i.type === 'waypoints')) parts.push(waypointXml(item.id, item.resource))
  const xml =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<gpx version="1.1" creator="signalk-opencpn-sync" xmlns="http://www.topografix.com/GPX/1/1" xmlns:opencpn="http://www.opencpn.org">\n' +
    parts.map((p) => p.xml).join('') +
    '</gpx>\n'
  return { xml, guids: parts.map((p) => p.guid) }
}
