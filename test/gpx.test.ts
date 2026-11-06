import { describe, expect, it } from 'vitest'
import { GpxError, parseGpx, resourceId, toSignalKRoute, toSignalKWaypoint } from '../src/gpx.js'
import { ROUTE_GPX, TRACK_ONLY_GPX, WAYPOINT_AND_TRACK_GPX } from './fixtures.js'

const SK_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const origin = { sender: 'nav-pc', receivedAt: '2026-11-06T10:00:00.000Z' }

describe('parseGpx', () => {
  it('reads an OpenCPN route with its GUID and points', () => {
    const { routes, waypoints, trackCount } = parseGpx(ROUTE_GPX)
    expect(waypoints).toEqual([])
    expect(trackCount).toBe(0)
    expect(routes).toHaveLength(1)
    const [rte] = routes
    expect(rte.guid).toBe('3f2a1c4e-9b7d-4e21-a8c3-5d6e7f8a9b0c')
    expect(rte.name).toBe('Savusavu & back')
    expect(rte.description).toBe('Test route')
    expect(rte.points).toHaveLength(3)
    expect(rte.points[0]).toMatchObject({ lat: -16.779, lon: 179.333, name: '001', sym: 'diamond' })
    expect(rte.points[1].description).toBe('Reef pass')
    expect(rte.points[2].name).toBeUndefined()
  })

  it('reads stand-alone waypoints and counts tracks', () => {
    const { routes, waypoints, trackCount } = parseGpx(WAYPOINT_AND_TRACK_GPX)
    expect(routes).toEqual([])
    expect(trackCount).toBe(1)
    expect(waypoints).toEqual([
      { lat: -17.5, lon: 178.25, name: 'Anchorage', sym: 'anchor', guid: 'legacy-guid-0001', description: undefined }
    ])
  })

  it('keeps names that look like numbers as text', () => {
    const { routes } = parseGpx(ROUTE_GPX)
    expect(routes[0].points[0].name).toBe('001')
  })

  it('rejects documents without <gpx>', () => {
    expect(() => parseGpx('<kml/>')).toThrow(GpxError)
  })

  it('rejects malformed XML', () => {
    expect(() => parseGpx('<gpx><rte></gpx')).toThrow(GpxError)
    expect(() => parseGpx('<gpx><rte>')).toThrow(GpxError)
  })

  it('rejects points outside the coordinate range', () => {
    expect(() => parseGpx('<gpx><wpt lat="91" lon="0"/></gpx>')).toThrow(GpxError)
    expect(() => parseGpx('<gpx><wpt lat="x" lon="0"/></gpx>')).toThrow(GpxError)
  })

  it('handles an empty or track-only document', () => {
    expect(parseGpx(TRACK_ONLY_GPX)).toEqual({ routes: [], waypoints: [], trackCount: 1 })
  })
})

describe('resourceId', () => {
  it('keeps a UUID v4 GUID, lower-cased', () => {
    expect(resourceId('3F2A1C4E-9B7D-4E21-A8C3-5D6E7F8A9B0C')).toBe('3f2a1c4e-9b7d-4e21-a8c3-5d6e7f8a9b0c')
  })

  it('derives a stable UUID v4 from other GUIDs', () => {
    const id = resourceId('legacy-guid-0001')
    expect(id).toMatch(SK_UUID)
    expect(resourceId('legacy-guid-0001')).toBe(id)
    expect(resourceId('legacy-guid-0002')).not.toBe(id)
  })

  it('makes a random UUID v4 without a GUID', () => {
    expect(resourceId(undefined)).toMatch(SK_UUID)
  })
})

describe('toSignalKRoute', () => {
  it('builds a LineString route with point names for Freeboard', () => {
    const route = toSignalKRoute(parseGpx(ROUTE_GPX).routes[0], origin)!
    expect(route.name).toBe('Savusavu & back')
    expect(route.description).toBe('Test route')
    expect(route.feature).toEqual({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [
          [179.333, -16.779],
          [179.4, -16.8],
          [179.45, -16.85]
        ]
      },
      properties: {
        coordinatesMeta: [{ name: '001' }, { name: '002', description: 'Reef pass' }, { name: '' }],
        opencpnSync: { sender: 'nav-pc', receivedAt: origin.receivedAt, guid: '3f2a1c4e-9b7d-4e21-a8c3-5d6e7f8a9b0c' }
      }
    })
  })

  it('computes the distance in metres', () => {
    const route = toSignalKRoute(
      { points: [{ lat: 0, lon: 0 }, { lat: 1, lon: 0 }] },
      origin
    )!
    // one degree of latitude on the mean sphere
    expect(route.distance).toBe(111195)
  })

  it('skips routes with fewer than two points', () => {
    expect(toSignalKRoute({ points: [{ lat: 0, lon: 0 }] }, origin)).toBeUndefined()
  })
})

describe('toSignalKWaypoint', () => {
  it('builds a Point waypoint', () => {
    const wpt = toSignalKWaypoint(parseGpx(WAYPOINT_AND_TRACK_GPX).waypoints[0], origin)
    expect(wpt).toEqual({
      name: 'Anchorage',
      feature: {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [178.25, -17.5] },
        properties: {
          sym: 'anchor',
          opencpnSync: { sender: 'nav-pc', receivedAt: origin.receivedAt, guid: 'legacy-guid-0001' }
        }
      }
    })
  })
})
