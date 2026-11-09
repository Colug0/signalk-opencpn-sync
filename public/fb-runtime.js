'use strict'
/*
 * Freeboard-SK background runtime of signalk-opencpn-sync. Freeboard loads it
 * hidden in every open tab. It dials the plugin's WebSocket and shows each
 * route the plugin announces (routes received from OpenCPN) on the chart.
 */
/* global connectPlotterBus */
const BRIDGE = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/plugins/signalk-opencpn-sync/fb-bridge`
const KEEP = 200

async function main() {
  const bus = await connectPlotterBus()
  if (!bus.has('routes')) {
    console.info('[opencpn-sync] host has no "routes" capability; received routes are not shown automatically')
    return
  }

  // Remember what this browser already showed, so a reconnect or reload does
  // not show a route again after the user hid it.
  let shown = {}
  try {
    const r = await bus.call('state.get', { keys: ['shown'] })
    if (r && r.values && r.values.shown && typeof r.values.shown === 'object') shown = r.values.shown
  } catch (e) {
    console.warn('[opencpn-sync] state.get failed', e)
  }

  const remember = async (id, at) => {
    shown[id] = at
    const keys = Object.keys(shown)
    if (keys.length > KEEP) for (const k of keys.slice(0, keys.length - KEEP)) delete shown[k]
    try {
      await bus.call('state.set', { values: { shown } })
    } catch (e) {
      console.warn('[opencpn-sync] state.set failed', e)
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
      for (const item of msg.items) {
        if (item.type !== 'routes' || typeof item.id !== 'string' || shown[item.id] === item.at) continue
        try {
          await bus.call('route.show', { ref: item.id })
          await remember(item.id, item.at)
          ws.send(JSON.stringify({ type: 'shown', id: item.id, ok: true }))
        } catch (e) {
          ws.send(JSON.stringify({ type: 'shown', id: item.id, ok: false, error: e.reason || e.message }))
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
