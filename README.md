# signalk-opencpn-sync

A [Signal K](https://signalk.org) server plugin that receives routes and
waypoints from [OpenCPN](https://opencpn.org)'s **Send to Peer** and stores
them as Signal K resources, so they show up in Freeboard-SK and every other app
that uses the Resources API.

To OpenCPN, the plugin looks like another OpenCPN instance on the network: it
answers OpenCPN's peer discovery, pairs with a PIN like OpenCPN does, and
accepts the GPX that OpenCPN sends.

## Requirements

- Signal K server 2.x with a resources provider for `routes` and `waypoints`
  (the bundled **Resources Provider** plugin is enough).
- OpenCPN 5.8 or later. Tested with OpenCPN 5.15.0.
- TCP port **8443** free on the Signal K host and reachable from the OpenCPN
  computer. OpenCPN always sends to port 8443; it cannot be changed on the
  OpenCPN side.
- For discovery with **Scan**: UDP multicast (mDNS, port 5353) between both
  computers. A server in a container needs host networking for that.
  Without discovery you can type the server's IP address instead.

## Setup

1. Install the plugin from the Signal K App Store and enable it.
2. Make sure the Resources Provider plugin is enabled for routes and waypoints.

### Settings

| Setting | Default | Meaning |
|---|---|---|
| HTTPS port | 8443 | Port the plugin listens on. OpenCPN only uses 8443; change it for testing only. |
| Bind address | empty | IP address to listen on. Empty means all interfaces. |
| Peer name | `SignalK` | Name shown in OpenCPN's peer list. Must not start with `Portable`. |
| Announce via mDNS | on | Lets OpenCPN find the server with **Scan**. |
| Require PIN pairing | on | Off accepts routes from anyone on the network without a PIN. |

## Sending a route from OpenCPN

1. In OpenCPN, right-click a route (or select it in the Route & Mark Manager)
   and choose **Send to Peer**.
2. Pick the Signal K server from the list after **Scan**, or type its IP
   address into the peer field.
3. Click **Send**. The first time, OpenCPN asks for a PIN. The plugin shows it
   as a Signal K notification (`notifications.opencpnSync.pairing`, visible in
   Freeboard-SK) and in the plugin status in the server's admin UI. Enter it in
   OpenCPN. Pairing is remembered per OpenCPN computer.
4. The route appears in Freeboard-SK under **Routes**.

Sending the same route again replaces it: OpenCPN asks whether to overwrite,
and the route keeps its id.

## What is converted

| OpenCPN | Signal K |
|---|---|
| Route | `routes` resource: name, description, distance, point names in `feature.properties.coordinatesMeta` |
| Stand-alone waypoint / mark | `waypoints` resource: name, description, symbol in `feature.properties.sym` |
| Track | ignored (not supported yet) |

Each resource carries `feature.properties.opencpnSync` with the sender's host
name, the time it was received and the OpenCPN GUID. The OpenCPN GUID is used
as the resource id, so resending replaces the same resource.

**Activate route** in OpenCPN's dialog is ignored for now.

## Security

- The plugin speaks HTTPS with a self-signed certificate, created once and kept
  in the plugin's data directory. OpenCPN does not check certificates.
- Senders must pair with a 4-digit PIN, the same scheme OpenCPN uses. The PIN
  is only shown on the Signal K side. After 20 failed attempts within a minute,
  pairing is locked for a minute.
- Paired keys are stored in `paired-keys.json` in the plugin's data directory.
  Delete an entry there to unpair a computer.

## How it works

The plugin implements the receiving side of OpenCPN's REST interface
(`model/src/rest_server.cpp` in the OpenCPN sources):

| Endpoint | Purpose |
|---|---|
| `GET /api/get-version` | Reports an OpenCPN version, so the sender uses the current pairing scheme. |
| `GET /api/ping` | Pairing and key check. |
| `GET /api/writable?guid=` | Tells the sender whether an object already exists. |
| `POST /api/rx_object` | Receives the GPX. |

Discovery answers mDNS queries for `opencpn-object-control-service`, the
non-standard service name OpenCPN uses.

## Development

```bash
npm install
npm test          # unit tests (vitest)
npm run typecheck
npm run build     # compiles to dist/
```

To try it against a local Signal K server, link the plugin directory into the
server's configuration directory (`node_modules/signalk-opencpn-sync`), enable
it, and send from OpenCPN. If OpenCPN runs on the same computer, it already
uses port 8443; set **Bind address** to `127.0.0.2` and type `127.0.0.2` as the
peer in OpenCPN.

## License

MIT
