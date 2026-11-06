/** GPX in the shape OpenCPN's NavObjectCollection1 writes for "Send to Peer". */
export const ROUTE_GPX = `<?xml version="1.0"?>
<gpx version="1.1" creator="OpenCPN" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:gpxx="http://www.garmin.com/xmlschemas/GpxExtensions/v3" xmlns:opencpn="http://www.opencpn.org">
 <rte>
  <name>Savusavu &amp; back</name>
  <desc>Test route</desc>
  <extensions>
   <opencpn:guid>3f2a1c4e-9b7d-4e21-a8c3-5d6e7f8a9b0c</opencpn:guid>
   <opencpn:viz>1</opencpn:viz>
   <opencpn:planned_departure>2026-11-06T00:00:00Z</opencpn:planned_departure>
   <gpxx:RouteExtension>
    <gpxx:IsAutoNamed>false</gpxx:IsAutoNamed>
   </gpxx:RouteExtension>
  </extensions>
  <rtept lat="-16.779000000" lon="179.333000000">
   <name>001</name>
   <sym>diamond</sym>
   <extensions>
    <opencpn:guid>11111111-2222-4333-8444-555555555555</opencpn:guid>
    <opencpn:arrival_radius>0.050</opencpn:arrival_radius>
   </extensions>
  </rtept>
  <rtept lat="-16.800000000" lon="179.400000000">
   <name>002</name>
   <desc>Reef pass</desc>
   <sym>diamond</sym>
  </rtept>
  <rtept lat="-16.850000000" lon="179.450000000">
   <sym>diamond</sym>
  </rtept>
 </rte>
</gpx>
`

export const WAYPOINT_AND_TRACK_GPX = `<?xml version="1.0"?>
<gpx version="1.1" creator="OpenCPN" xmlns:opencpn="http://www.opencpn.org">
 <wpt lat="-17.5" lon="178.25">
  <name>Anchorage</name>
  <sym>anchor</sym>
  <extensions>
   <opencpn:guid>legacy-guid-0001</opencpn:guid>
  </extensions>
 </wpt>
 <trk>
  <name>Track</name>
  <trkseg><trkpt lat="-17.5" lon="178.25"/><trkpt lat="-17.6" lon="178.3"/></trkseg>
 </trk>
</gpx>
`

export const TRACK_ONLY_GPX = `<?xml version="1.0"?>
<gpx version="1.1"><trk><trkseg><trkpt lat="1" lon="2"/></trkseg></trk></gpx>`
