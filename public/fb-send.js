'use strict'
/*
 * "Send to OpenCPN" window, opened by Freeboard-SK when the user picks the
 * action on a route or waypoint. Freeboard serves it same-origin, so it talks
 * to the plugin's REST API with the user's own session.
 */
/* global connectPlotterBus */
const API = '/plugins/signalk-opencpn-sync/api'
const $ = (id) => document.getElementById(id)
let item // { type: 'routes' | 'waypoints', id }

function say(text, kind) {
  $('message').textContent = text
  $('message').className = kind || ''
}

async function request(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'include',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  let json
  try {
    json = await res.json()
  } catch {
    json = undefined
  }
  if (!json) throw new Error(res.status === 401 || res.status === 403 ? 'Not allowed. Log in to Signal K.' : `HTTP ${res.status}`)
  return json
}

function peer() {
  return $('manual').value.trim() || $('peer').value || undefined
}

function update() {
  $('send').disabled = !item || !peer()
}

async function loadPeers() {
  const data = await request(`${API}/peers`)
  const sel = $('peer')
  const before = sel.value
  sel.textContent = ''
  const none = document.createElement('option')
  none.value = ''
  none.textContent = data.peers.length ? 'Choose OpenCPN…' : 'No OpenCPN known – type an address'
  sel.append(none)
  for (const p of data.peers) {
    const o = document.createElement('option')
    o.value = p.address
    o.textContent = `${p.name ? p.name + ' – ' : ''}${p.address}${p.paired ? ' ✓' : ''}`
    sel.append(o)
  }
  const paired = data.peers.filter((p) => p.paired)
  if (data.peers.some((p) => p.address === before)) sel.value = before
  else if (paired.length === 1) sel.value = paired[0].address
  update()
}

function target(invocation) {
  const t = invocation && invocation.target
  if (!t) return
  if ((t.kind !== 'route' && t.kind !== 'waypoint') || typeof t.id !== 'string') {
    item = undefined
    $('what').textContent = t.kind === 'route' ? 'Save the route first, then send it.' : 'Only routes and waypoints can be sent.'
    update()
    return
  }
  item = { type: t.kind === 'route' ? 'routes' : 'waypoints', id: t.id }
  $('what').textContent = `${t.kind === 'route' ? 'Route' : 'Waypoint'}: ${t.name || t.id}`
  $('what').classList.remove('muted')
  say('')
  update()
}

async function handle(r) {
  switch (r.status) {
    case 'sent':
      say(`Sent to ${r.peer}.`, 'ok')
      $('pin-form').hidden = true
      break
    case 'paired':
      say(`Paired with ${r.peer}. Sending…`, 'ok')
      $('pin-form').hidden = true
      return send()
    case 'needsPin':
      say('OpenCPN now shows a PIN. Enter it here.', 'warn')
      $('pin-form').hidden = false
      $('pin').focus()
      break
    case 'exists':
      say('It already exists in OpenCPN. Tick "Replace" and send again.', 'warn')
      break
    default:
      say(r.message || 'Something went wrong.', r.code === 'unconfirmed' ? 'warn' : 'err')
  }
  await loadPeers().catch(() => undefined)
}

async function send() {
  if (!item) return
  $('send').disabled = true
  say('Sending…')
  try {
    await handle(await request(`${API}/send`, { peer: peer(), items: [item], force: $('force').checked }))
  } catch (e) {
    say(e.message, 'err')
  } finally {
    update()
  }
}

$('send').addEventListener('click', send)
$('peer').addEventListener('change', update)
$('manual').addEventListener('input', update)
$('pin-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  try {
    await handle(await request(`${API}/pair`, { peer: peer(), pin: $('pin').value.trim() }))
  } catch (err) {
    say(err.message, 'err')
  }
  $('pin').value = ''
})

loadPeers().catch((e) => say(e.message, 'err'))
connectPlotterBus()
  .then(async (bus) => {
    target(bus.handshake.context && bus.handshake.context.invocation)
    // A window that stays open hears later choices as events.
    await bus.subscribe(['action.invoked'], (_name, inv) => target(inv))
  })
  .catch(() => say('Open this from Freeboard-SK.', 'warn'))
