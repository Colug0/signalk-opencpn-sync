'use strict'
/*
 * Minimal client for the Freeboard-SK Plotter Extensions message bus:
 * JSON-RPC 2.0 inside {bus: "plotterExt/1", msg} envelopes over postMessage
 * to the parent frame (docs/api/plotter-extensions-api.md, "Communication").
 */
// eslint-disable-next-line no-unused-vars
function connectPlotterBus(timeoutMs = 15000) {
  const BUS = 'plotterExt/1'
  const pending = new Map()
  const listeners = []
  let seq = 0
  let handshake

  const post = (msg) => window.parent.postMessage({ bus: BUS, msg }, location.origin)

  return new Promise((resolve, reject) => {
    const ready = setInterval(() => post({ jsonrpc: '2.0', method: 'bus.ready' }), 250)
    const giveUp = setTimeout(() => {
      clearInterval(ready)
      reject(new Error('no Plotter Extensions host answered'))
    }, timeoutMs)

    window.addEventListener('message', (event) => {
      if (event.source !== window.parent || !event.data || event.data.bus !== BUS) return
      const msg = event.data.msg || {}
      if (msg.method === 'bus.handshake' && !handshake) {
        handshake = msg.params
        clearInterval(ready)
        clearTimeout(giveUp)
        resolve(client)
        return
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id)
        pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.error) {
          const err = new Error(msg.error.message || 'host error')
          err.reason = msg.error.data && msg.error.data.reason
          p.reject(err)
        } else p.resolve(msg.result)
        return
      }
      if (msg.method && msg.id === undefined) {
        for (const l of listeners) {
          if (l.match(msg.method)) l.cb(msg.method, msg.params)
        }
      }
    })

    const client = {
      get handshake() {
        return handshake
      },
      has(capability) {
        return Array.isArray(handshake && handshake.capabilities) && handshake.capabilities.includes(capability)
      },
      call(method, params, ms = 10000) {
        const id = `ocs-${Date.now().toString(36)}-${++seq}`
        return new Promise((res, rej) => {
          const timer = setTimeout(() => {
            pending.delete(id)
            rej(new Error(`${method}: no answer from host`))
          }, ms)
          pending.set(id, { resolve: res, reject: rej, timer })
          post({ jsonrpc: '2.0', id, method, params })
        })
      },
      async subscribe(patterns, cb) {
        for (const p of patterns) {
          const re = new RegExp(
            '^' + p.split('.').map((s) => (s === '**' ? '.*' : s === '*' ? '[^.]+' : s.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&'))).join('\\.') + '$'
          )
          listeners.push({ match: (m) => re.test(m), cb })
        }
        return client.call('events.subscribe', { patterns })
      }
    }
  })
}
