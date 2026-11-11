'use strict'
/*
 * Freeboard-SK background runtime of signalk-opencpn-sync. Freeboard loads it
 * hidden in every open tab. It dials the plugin's WebSocket and shows each
 * route and waypoint the plugin announces (objects received from OpenCPN) on
 * the chart: with `resources.show` where Freeboard offers it (3.5 and later),
 * otherwise routes only, with `route.show`.
 */
/* global connectPlotterBus */
const BRIDGE = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/plugins/signalk-opencpn-sync/fb-bridge`
const KEEP = 200
const TYPES = ['routes', 'waypoints']

async function main() {
  const bus = await connectPlotterBus()
  const display = bus.has('resources.display')
  const routeShow = bus.has('routes')
  if (!display && !routeShow) {
    console.info('[opencpn-sync] host can neither show resources nor routes; received objects are not shown automatically')
    return
  }
  if (!display) console.info('[opencpn-sync] host has no "resources.display"; only received routes are shown automatically')

  // Remember what this browser already showed, so a reconnect or reload does
  // not show an object again after the user hid it. Routes are kept under
  // their bare id (as before waypoints were shown), waypoints as "waypoints/<id>".
  let shown = {}
  try {
    const r = await bus.call('state.get', { keys: ['shown'] })
    if (r && r.values && r.values.shown && typeof r.values.shown === 'object') shown = r.values.shown
  } catch (e) {
    console.warn('[opencpn-sync] state.get failed', e)
  }
  const key = (item) => (item.type === 'routes' ? item.id : `${item.type}/${item.id}`)

  const remember = async (items) => {
    for (const item of items) shown[key(item)] = item.at
    const keys = Object.keys(shown)
    if (keys.length > KEEP) for (const k of keys.slice(0, keys.length - KEEP)) delete shown[k]
    try {
      await bus.call('state.set', { values: { shown } })
    } catch (e) {
      console.warn('[opencpn-sync] state.set failed', e)
    }
  }

  // Show objects of one type: with resources.show (any number of ids) or
  // route.show (one route). Resolves to an error reason, or undefined when shown.
  const show = async (type, items) => {
    try {
      if (display) await bus.call('resources.show', { type, ids: items.map((i) => i.id) })
      else await bus.call('route.show', { ref: items[0].id })
      return undefined
    } catch (e) {
      return e.reason || e.message
    }
  }

  let delay = 2000
  const connect = () => {
    const ws = new WebSocket(BRIDGE)
    ws.onopen = () => {
      delay = 2000
    }
    ws.onmessage = async (event) => {
      let msg
      try {
        msg = JSON.parse(event.data)
      } catch {
        return
      }
      if (msg.type !== 'show' || !Array.isArray(msg.items)) return
      for (const type of TYPES) {
        if (type !== 'routes' && !display) continue
        const items = msg.items.filter(
          (i) => i && i.type === type && typeof i.id === 'string' && shown[key(i)] !== i.at
        )
        if (items.length === 0) continue
        const report = (item, error) =>
          ws.send(JSON.stringify({ type: 'shown', resource: type, id: item.id, ok: !error, error }))
        // All at once where possible; if that fails, one by one, so one bad
        // id does not keep the others from showing.
        if (display && items.length > 1 && !(await show(type, items))) {
          await remember(items)
          for (const item of items) report(item)
          continue
        }
        for (const item of items) {
          const error = await show(type, [item])
          if (!error) await remember([item])
          report(item, error)
        }
      }
    }
    ws.onclose = () => {
      setTimeout(connect, delay)
      delay = Math.min(delay * 2, 60000)
    }
  }
  connect()
}

main().catch((e) => console.warn('[opencpn-sync] runtime stopped:', e.message))
