'use strict'

const API = '/plugins/signalk-opencpn-sync/api'
const RESOURCES = '/signalk/v2/api/resources'
const NM = 1852

const $ = (id) => document.getElementById(id)
const state = { peers: [], routes: [], waypoints: [], selected: { routes: new Set(), waypoints: new Set() } }

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
  if (res.status === 401 || res.status === 403) {
    if (!json || !json.status) throw new Error('Not allowed. Log in to the Signal K server and reload.')
  }
  if (!json) throw new Error(`HTTP ${res.status}`)
  return json
}

function say(text, kind) {
  const m = $('message')
  m.textContent = text
  m.className = kind || ''
}

function currentPeer() {
  const manual = $('peer-manual').value.trim()
  return manual || $('peer-select').value || undefined
}

function renderPeers(data) {
  state.peers = data.peers || []
  $('peer-name').textContent = data.peerName ? `as "${data.peerName}"` : ''
  const sel = $('peer-select')
  const before = sel.value
  sel.textContent = ''
  // Nothing is preselected unless exactly one peer is paired, so a transfer
  // never goes to a computer nobody chose.
  const placeholder = document.createElement('option')
  placeholder.value = ''
  placeholder.textContent = state.peers.length ? 'Choose OpenCPN…' : 'No OpenCPN found – Scan or type an address'
  sel.append(placeholder)
  for (const p of state.peers) {
    const o = document.createElement('option')
    o.value = p.address
    o.textContent = `${p.name ? p.name + ' – ' : ''}${p.address}${p.paired ? ' ✓' : ''}`
    sel.append(o)
  }
  const paired = state.peers.filter((p) => p.paired)
  if (state.peers.some((p) => p.address === before)) sel.value = before
  else if (paired.length === 1) sel.value = paired[0].address
  else sel.value = ''
  renderPairState()
}

function renderPairState() {
  const peer = currentPeer()
  const known = state.peers.find((p) => p.address === peer)
  const badge = $('pair-state')
  if (!peer) {
    badge.textContent = 'no peer'
    badge.className = 'badge'
  } else if (known && known.paired) {
    badge.textContent = 'paired'
    badge.className = 'badge ok'
  } else {
    badge.textContent = 'not paired'
    badge.className = 'badge warn'
  }
  updateSendButton()
}

async function loadPeers() {
  renderPeers(await request(`${API}/peers`))
}

async function scan() {
  $('scan').disabled = true
  say('Looking for OpenCPN on the network…')
  try {
    const data = await request(`${API}/scan`, {})
    renderPeers(data)
    say(data.peers.length ? `Found ${data.peers.length} OpenCPN instance(s).` : 'No OpenCPN answered. Type its address instead.', data.peers.length ? 'ok' : 'warn')
  } catch (e) {
    say(e.message, 'err')
  } finally {
    $('scan').disabled = false
  }
}

function showPin(show) {
  $('pin-form').hidden = !show
  if (show) $('pin').focus()
}

function handleOutcome(r) {
  switch (r.status) {
    case 'sent':
      say(`Sent ${r.count} object(s) to ${r.peer}.`, 'ok')
      showPin(false)
      break
    case 'paired':
      say(`Paired with ${r.peer}.`, 'ok')
      showPin(false)
      break
    case 'needsPin':
      say(`OpenCPN at ${r.peer} now shows a PIN. Enter it here, then send again.`, 'warn')
      showPin(true)
      break
    case 'exists':
      say(`${r.guids.length || 'Some'} object(s) already exist in OpenCPN. Tick "Replace existing" to overwrite them.`, 'warn')
      break
    default:
      say(r.message || 'Something went wrong.', r.code === 'unconfirmed' ? 'warn' : 'err')
  }
  return loadPeers().catch(() => undefined)
}

async function pair(pin) {
  try {
    await handleOutcome(await request(`${API}/pair`, { peer: currentPeer(), ...(pin ? { pin } : {}) }))
  } catch (e) {
    say(e.message, 'err')
  }
}

function fmtLength(m) {
  return typeof m === 'number' ? `${(m / NM).toFixed(1)} nm` : ''
}

function fromOpencpn(r) {
  const o = r.feature && r.feature.properties && r.feature.properties.opencpnSync
  return o && o.sender ? `from ${o.sender}` : ''
}

function renderTable(kind) {
  const body = $(kind)
  const filter = $('filter').value.trim().toLowerCase()
  const rows = state[kind].filter(([, r]) => !filter || (r.name || '').toLowerCase().includes(filter))
  body.textContent = ''
  if (rows.length === 0) {
    const tr = body.insertRow()
    const td = tr.insertCell()
    td.colSpan = 4
    td.className = 'empty'
    td.textContent = filter ? 'Nothing matches the filter.' : `No ${kind}.`
    return
  }
  for (const [id, r] of rows) {
    const tr = body.insertRow()
    const c = tr.insertCell()
    c.className = 'check'
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = state.selected[kind].has(id)
    box.setAttribute('aria-label', `Select ${r.name || id}`)
    box.addEventListener('change', () => {
      box.checked ? state.selected[kind].add(id) : state.selected[kind].delete(id)
      updateSendButton()
    })
    c.append(box)
    const name = tr.insertCell()
    name.textContent = r.name || id
    const tag = fromOpencpn(r)
    if (tag) {
      const s = document.createElement('span')
      s.className = 'tag'
      s.textContent = tag
      name.append(s)
    }
    if (kind === 'routes') {
      const len = tr.insertCell()
      len.className = 'num'
      len.textContent = fmtLength(r.distance)
      const pts = tr.insertCell()
      pts.className = 'num'
      const coords = r.feature && r.feature.geometry && r.feature.geometry.coordinates
      pts.textContent = Array.isArray(coords) ? String(coords.length) : ''
    } else {
      tr.insertCell().textContent = r.description || ''
    }
  }
}

async function loadResources() {
  for (const kind of ['routes', 'waypoints']) {
    try {
      const res = await fetch(`${RESOURCES}/${kind}`, { credentials: 'include' })
      const data = res.ok ? await res.json() : {}
      state[kind] = Object.entries(data).sort(([, a], [, b]) => (a.name || '').localeCompare(b.name || ''))
    } catch {
      state[kind] = []
    }
    renderTable(kind)
  }
  updateSendButton()
}

function updateSendButton() {
  const r = state.selected.routes.size
  const w = state.selected.waypoints.size
  $('selection').textContent = r + w ? `${r} route(s), ${w} waypoint(s) selected` : ''
  $('send').disabled = r + w === 0 || !currentPeer()
  const act = $('activate')
  act.disabled = r !== 1
  if (act.disabled) act.checked = false
}

async function send() {
  const items = [
    ...[...state.selected.routes].map((id) => ({ type: 'routes', id })),
    ...[...state.selected.waypoints].map((id) => ({ type: 'waypoints', id }))
  ]
  $('send').disabled = true
  say('Sending…')
  try {
    await handleOutcome(
      await request(`${API}/send`, { peer: currentPeer(), items, force: $('force').checked, activate: $('activate').checked })
    )
  } catch (e) {
    say(e.message, 'err')
  } finally {
    updateSendButton()
  }
}

function selectAll(kind, on) {
  const filter = $('filter').value.trim().toLowerCase()
  for (const [id, r] of state[kind]) {
    if (filter && !(r.name || '').toLowerCase().includes(filter)) continue
    on ? state.selected[kind].add(id) : state.selected[kind].delete(id)
  }
  renderTable(kind)
  updateSendButton()
}

$('scan').addEventListener('click', scan)
$('pair').addEventListener('click', () => pair())
$('pin-form').addEventListener('submit', (e) => {
  e.preventDefault()
  pair($('pin').value.trim()).then(() => ($('pin').value = ''))
})
$('peer-select').addEventListener('change', renderPairState)
$('peer-manual').addEventListener('input', renderPairState)
$('filter').addEventListener('input', () => {
  renderTable('routes')
  renderTable('waypoints')
})
$('all-routes').addEventListener('change', (e) => selectAll('routes', e.target.checked))
$('all-waypoints').addEventListener('change', (e) => selectAll('waypoints', e.target.checked))
$('send').addEventListener('click', send)

loadPeers().catch((e) => say(e.message, 'err'))
loadResources()
