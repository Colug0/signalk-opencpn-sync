import { describe, expect, it } from 'vitest'
import { parseGpx } from '../src/gpx.js'
import { buildGpx, ExportError, guidFor } from '../src/gpx-writer.js'

const ROUTE_ID = '0b5e3a3c-1f2d-4c5b-9a8e-7f6d5c4b3a21'
const WPT_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

const route = {
  name: 'Kuata <> Navadra & back',
  description: 'via "the pass"',
  feature: {
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates: [
        [177.1328, -17.3657],
        [177.1, -17.39],
        [177.05, -17.43]
      ]
    },
    properties: { coordinatesMeta: [{ name: 'Start' }, { name: 'Pass', description: 'mind the reef' }, {}] }
  }
}

const waypoint = {
  name: 'Anchorage',
  feature: { type: 'Feature', geometry: { type: 'Point', coordinates: [178.25, -17.5] }, properties: { sym: 'anchor' } }
}

describe('buildGpx', () => {
  it('writes routes and waypoints that read back the same', () => {
    const out = buildGpx([
      { type: 'waypoints', id: WPT_ID, resource: waypoint },
      { type: 'routes', id: ROUTE_ID, resource: route }
    ])
    // routes come first, like OpenCPN writes them
    expect(out.guids).toEqual([ROUTE_ID, WPT_ID])
    const back = parseGpx(out.xml)
    expect(back.routes).toHaveLength(1)
    const [rte] = back.routes
    expect(rte.guid).toBe(ROUTE_ID)
    expect(rte.name).toBe('Kuata <> Navadra & back')
    expect(rte.description).toBe('via "the pass"')
    expect(rte.points.map((p) => [p.lon, p.lat])).toEqual(route.feature.geometry.coordinates)
    expect(rte.points.map((p) => p.name)).toEqual(['Start', 'Pass', '003'])
    expect(rte.points[1].description).toBe('mind the reef')
    expect(back.waypoints).toEqual([
      { lat: -17.5, lon: 178.25, name: 'Anchorage', description: undefined, sym: 'anchor', guid: WPT_ID }
    ])
  })

  it('gives route points stable GUIDs of their own', () => {
    const a = parseGpx(buildGpx([{ type: 'routes', id: ROUTE_ID, resource: route }]).xml).routes[0].points
    const b = parseGpx(buildGpx([{ type: 'routes', id: ROUTE_ID, resource: route }]).xml).routes[0].points
    expect(a.map((p) => p.guid)).toEqual(b.map((p) => p.guid))
    expect(new Set(a.map((p) => p.guid)).size).toBe(3)
    expect(a.map((p) => p.guid)).not.toContain(ROUTE_ID)
  })

  it('sends an object back under the GUID it came from OpenCPN with', () => {
    const fromOpencpn = {
      ...route,
      feature: { ...route.feature, properties: { ...route.feature.properties, opencpnSync: { guid: 'legacy-guid-1' } } }
    }
    expect(guidFor(ROUTE_ID, fromOpencpn)).toBe('legacy-guid-1')
    expect(buildGpx([{ type: 'routes', id: ROUTE_ID, resource: fromOpencpn }]).guids).toEqual(['legacy-guid-1'])
  })

  it('declares the opencpn namespace OpenCPN expects', () => {
    const { xml } = buildGpx([{ type: 'waypoints', id: WPT_ID, resource: waypoint }])
    expect(xml).toContain('xmlns:opencpn="http://www.opencpn.org"')
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="utf-8"\?>\n<gpx version="1.1"/)
  })

  it('rejects routes without a usable line', () => {
    const bad = { feature: { geometry: { type: 'LineString', coordinates: [[1, 2]] } } }
    expect(() => buildGpx([{ type: 'routes', id: ROUTE_ID, resource: bad }])).toThrow(ExportError)
    const outOfRange = { feature: { geometry: { type: 'LineString', coordinates: [[1, 2], [200, 2]] } } }
    expect(() => buildGpx([{ type: 'routes', id: ROUTE_ID, resource: outOfRange }])).toThrow(ExportError)
  })

  it('rejects waypoints without a point', () => {
    expect(() => buildGpx([{ type: 'waypoints', id: WPT_ID, resource: { name: 'x' } }])).toThrow(ExportError)
  })
})
