'use strict';

/* =========================================================================
 * workspace — client (vanilla JS, no dependencies)
 *
 * Shell model: a tiny "corporate OS". A left dock lists services; the
 * workspace shows the active one. The signaling connection lives at the OS
 * level, so an incoming call can pop over ANY service and, once accepted,
 * brings the user into the Calls service.
 *
 * WebRTC core (unchanged): full-mesh, one RTCPeerConnection per remote peer,
 * text over DataChannel, audio/video over media tracks. Connection setup
 * uses the "perfect negotiation" pattern (polite/impolite by peerId).
 * ========================================================================= */

// --- ICE config. Add your own TURN here for strict NATs. -------------------
const ICE_CONFIG = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
    // { urls: 'turn:turn.example.com:3478', username: 'user', credential: 'pass' }
  ]
};

const SERVICE_TITLES = { calls: 'Calls', empty: 'Empty window' };

// --- Global state (ephemeral; cleared on reload) ---------------------------
const state = {
  me: { peerId: (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)), username: '' },
  server: '',
  es: null,            // EventSource
  ready: false,
  activeService: 'calls',
  room: null,
  peers: new Map(),    // peerId -> Peer
  localStream: null,
  micOn: false,
  camOn: false,
  _localTile: null
};

const $ = (s) => document.querySelector(s);
const el = {
  screenLogin: $('#screen-login'), desktop: $('#desktop'),
  loginForm: $('#login-form'), inUsername: $('#in-username'), inServer: $('#in-server'), loginStatus: $('#login-status'),
  dockApps: document.querySelectorAll('.dock-app[data-service]'),
  callsDock: document.querySelector('.dock-app[data-service="calls"]'),
  btnLogout: $('#btn-logout'),
  dockInitials: $('#dock-initials'), dockUser: $('#dock-user'),
  activeTitle: $('#active-title'), topbarUser: $('#topbar-user'), clock: $('#clock'),
  services: document.querySelectorAll('.service[data-service]'),
  callsViews: document.querySelectorAll('.calls-view[data-view]'),
  roomForm: $('#room-form'), inRoom: $('#in-room'),
  callForm: $('#call-form'), inCall: $('#in-call'), lobbyStatus: $('#lobby-status'),
  roomName: $('#room-name'), roomCount: $('#room-count'),
  grid: $('#grid'), chat: $('#chat'), chatLog: $('#chat-log'),
  chatForm: $('#chat-form'), chatInput: $('#chat-input'), btnChatToggle: $('#btn-chat-toggle'),
  btnMic: $('#btn-mic'), btnCam: $('#btn-cam'), btnLeave: $('#btn-leave'),
  inviteModal: $('#invite-modal'), inviteFrom: $('#invite-from'), inviteWith: $('#invite-with'),
  inviteAccept: $('#invite-accept'), inviteDecline: $('#invite-decline'),
  toast: $('#toast')
};

// ===========================================================================
// Helpers
// ===========================================================================
function setStatus(node, text, kind) {
  node.textContent = text || '';
  node.classList.toggle('is-error', kind === 'error');
  node.classList.toggle('is-ok', kind === 'ok');
}

let toastTimer = null;
function toast(text) {
  el.toast.textContent = text;
  el.toast.classList.remove('hidden');
  requestAnimationFrame(() => el.toast.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.classList.remove('show');
    setTimeout(() => el.toast.classList.add('hidden'), 250);
  }, 3200);
}

async function post(path, body) {
  const res = await fetch(state.server + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

function sendSignal(to, data) {
  post('/signal', { from: state.me.peerId, to, data }).catch(() => {});
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function initials(name) { return (name || '?').trim().slice(0, 2).toUpperCase(); }

// ===========================================================================
// OS shell: screens, dock, services
// ===========================================================================
function showLogin() {
  el.desktop.classList.add('hidden');
  el.screenLogin.classList.remove('hidden');
}

function showDesktop() {
  el.screenLogin.classList.add('hidden');
  el.desktop.classList.remove('hidden');
  el.dockInitials.textContent = initials(state.me.username);
  el.dockUser.title = state.me.username;
  el.topbarUser.textContent = state.me.username + ' @ ' + state.server.replace(/^https?:\/\//, '');
}

function switchService(name) {
  state.activeService = name;
  el.services.forEach((s) => s.classList.toggle('is-active', s.dataset.service === name));
  el.dockApps.forEach((b) => b.classList.toggle('is-active', b.dataset.service === name));
  el.activeTitle.textContent = SERVICE_TITLES[name] || '';
  if (name === 'calls') stopRinging();
}

function showCallsView(view) {
  el.callsViews.forEach((v) => v.classList.toggle('hidden', v.dataset.view !== view));
}

function startRinging() { el.callsDock.classList.add('ringing'); }
function stopRinging()  { el.callsDock.classList.remove('ringing'); }
function setInCall(on)  { el.callsDock.classList.toggle('in-call', on); }

function updateClock() {
  el.clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ===========================================================================
// Signaling connection (SSE)
// ===========================================================================
function connect(username, server) {
  state.me.username = username;
  state.server = server.replace(/\/+$/, '');

  const url = state.server + '/sse'
    + '?peerId=' + encodeURIComponent(state.me.peerId)
    + '&username=' + encodeURIComponent(username);

  setStatus(el.loginStatus, 'connecting…');

  const es = new EventSource(url);
  state.es = es;

  es.onmessage = (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    handleEvent(msg);
  };
  es.onerror = () => {
    if (!state.ready) setStatus(el.loginStatus, 'could not connect to server', 'error');
    else toast('reconnecting to server…');
  };
}

function logout() {
  if (state.room) leaveRoom(false);
  if (state.es) { state.es.close(); state.es = null; }
  state.ready = false;
  setStatus(el.loginStatus, '');
  showLogin();
}

function handleEvent(msg) {
  switch (msg.type) {
    case 'ready':
      state.ready = true;
      showDesktop();
      switchService('calls');
      showCallsView('lobby');
      break;
    case 'peer-joined':
      if (msg.room === state.room) addPeer(msg.peerId, msg.username, { initiate: true });
      break;
    case 'peer-left':
      if (msg.room === state.room) removePeer(msg.peerId, true);
      break;
    case 'signal':
      onSignal(msg.from, msg.data);
      break;
    case 'invite':
      onInvite(msg);
      break;
  }
}

// ===========================================================================
// Rooms
// ===========================================================================
async function joinRoom(room) {
  switchService('calls');
  state.room = room;
  openRoomView(room);
  setInCall(true);
  try {
    const r = await post('/join', { peerId: state.me.peerId, username: state.me.username, room });
    for (const m of r.members) addPeer(m.peerId, m.username, { initiate: true });
    refreshLocalTile();
  } catch {
    sysMessage('failed to join room');
  }
}

function leaveRoom(navigateBack = true) {
  if (state.room) post('/leave', { peerId: state.me.peerId, room: state.room }).catch(() => {});
  for (const peerId of [...state.peers.keys()]) removePeer(peerId, false);

  if (state.localStream) {
    state.localStream.getTracks().forEach((t) => t.stop());
    state.localStream = null;
  }
  state.micOn = false; state.camOn = false;
  updateControls();
  setInCall(false);

  state.room = null;
  el.grid.innerHTML = '';
  el.chatLog.innerHTML = '';
  el.chat.classList.remove('open');

  if (navigateBack) showCallsView('lobby');
}

function openRoomView(room) {
  el.roomName.textContent = room;
  el.grid.innerHTML = '';
  el.chatLog.innerHTML = '';
  showCallsView('room');
  createLocalTile();
  updateCount();
  updateControls();
}

// ===========================================================================
// Peers / WebRTC (perfect negotiation)
// ===========================================================================
function addPeer(peerId, username, { initiate = true } = {}) {
  if (peerId === state.me.peerId || state.peers.has(peerId)) return;

  const polite = state.me.peerId < peerId;
  const pc = new RTCPeerConnection(ICE_CONFIG);
  const peer = {
    peerId, username, pc, dc: null, polite,
    makingOffer: false, ignoreOffer: false, pendingCandidates: [],
    micOn: false, camOn: false, tile: null, videoEl: null, _parts: null
  };
  state.peers.set(peerId, peer);
  createTile(peer);

  pc.onnegotiationneeded = async () => {
    try {
      peer.makingOffer = true;
      await pc.setLocalDescription();
      sendSignal(peerId, { description: pc.localDescription });
    } catch (err) { console.error('negotiationneeded', err); }
    finally { peer.makingOffer = false; }
  };
  pc.onicecandidate = ({ candidate }) => { if (candidate) sendSignal(peerId, { candidate }); };
  pc.ontrack = (ev) => {
    if (ev.streams && ev.streams[0]) peer.videoEl.srcObject = ev.streams[0];
    updateTile(peer);
  };
  pc.onconnectionstatechange = () => {
    updateTile(peer);
    if (pc.connectionState === 'failed') { try { pc.restartIce(); } catch {} }
  };
  pc.ondatachannel = (ev) => setupDataChannel(peer, ev.channel);

  if (!polite && initiate) setupDataChannel(peer, pc.createDataChannel('chat', { ordered: true }));

  if (state.localStream) {
    for (const track of state.localStream.getTracks()) {
      try { pc.addTrack(track, state.localStream); } catch {}
    }
  }
  updateCount();
}

function removePeer(peerId, notify) {
  const peer = state.peers.get(peerId);
  if (!peer) return;
  try { peer.dc && peer.dc.close(); } catch {}
  try { peer.pc.close(); } catch {}
  if (peer.tile) peer.tile.remove();
  state.peers.delete(peerId);
  if (notify) sysMessage(peer.username + ' left');
  updateCount();
}

async function onSignal(from, data) {
  let peer = state.peers.get(from);
  if (!peer) {
    addPeer(from, 'peer', { initiate: false });
    peer = state.peers.get(from);
    if (!peer) return;
  }
  const pc = peer.pc;
  try {
    if (data.description) {
      const desc = data.description;
      const offerCollision = desc.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
      peer.ignoreOffer = !peer.polite && offerCollision;
      if (peer.ignoreOffer) return;

      await pc.setRemoteDescription(desc);
      for (const c of peer.pendingCandidates) { try { await pc.addIceCandidate(c); } catch {} }
      peer.pendingCandidates = [];

      if (desc.type === 'offer') {
        await pc.setLocalDescription();
        sendSignal(from, { description: pc.localDescription });
      }
    } else if (data.candidate) {
      if (!pc.remoteDescription) peer.pendingCandidates.push(data.candidate);
      else { try { await pc.addIceCandidate(data.candidate); } catch (err) { if (!peer.ignoreOffer) console.error(err); } }
    }
  } catch (err) { console.error('onSignal', err); }
}

// ===========================================================================
// DataChannel — text + media-state signalling
// ===========================================================================
function setupDataChannel(peer, dc) {
  peer.dc = dc;
  dc.onopen = () => {
    dcSend(peer, { kind: 'hello', username: state.me.username, micOn: state.micOn, camOn: state.camOn });
    sysMessage(peer.username + ' connected');
    updateTile(peer);
  };
  dc.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.kind === 'chat') addChatMessage(peer.username, m.text, false);
    else if (m.kind === 'hello' || m.kind === 'state') {
      if (m.username) peer.username = m.username;
      peer.micOn = !!m.micOn; peer.camOn = !!m.camOn;
      updateTile(peer);
    }
  };
  dc.onclose = () => updateTile(peer);
}

function dcSend(peer, obj) {
  if (peer.dc && peer.dc.readyState === 'open') { try { peer.dc.send(JSON.stringify(obj)); } catch {} }
}
function broadcast(obj) { for (const peer of state.peers.values()) dcSend(peer, obj); }
function broadcastState() { broadcast({ kind: 'state', username: state.me.username, micOn: state.micOn, camOn: state.camOn }); }

// ===========================================================================
// Media: microphone & camera
// ===========================================================================
async function acquireTrack(kind) {
  const constraints = kind === 'audio'
    ? { audio: { echoCancellation: true, noiseSuppression: true } }
    : { video: { width: { ideal: 1280 }, height: { ideal: 720 } } };
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  const track = kind === 'audio' ? stream.getAudioTracks()[0] : stream.getVideoTracks()[0];
  if (!state.localStream) state.localStream = new MediaStream();
  state.localStream.addTrack(track);
  for (const peer of state.peers.values()) { try { peer.pc.addTrack(track, state.localStream); } catch {} }
  return track;
}

async function toggleMic() {
  let track = state.localStream && state.localStream.getAudioTracks()[0];
  if (!track) {
    try { track = await acquireTrack('audio'); state.micOn = true; }
    catch { toast('no microphone access'); return; }
  } else { state.micOn = !state.micOn; track.enabled = state.micOn; }
  refreshLocalTile(); broadcastState(); updateControls();
}

async function toggleCam() {
  let track = state.localStream && state.localStream.getVideoTracks()[0];
  if (!track) {
    try { track = await acquireTrack('video'); state.camOn = true; }
    catch { toast('no camera access'); return; }
  } else { state.camOn = !state.camOn; track.enabled = state.camOn; }
  refreshLocalTile(); broadcastState(); updateControls();
}

function updateControls() {
  el.btnMic.setAttribute('aria-pressed', String(state.micOn));
  el.btnCam.setAttribute('aria-pressed', String(state.camOn));
}

// ===========================================================================
// Video tiles
// ===========================================================================
function makeTileEl({ local }) {
  const tile = document.createElement('div');
  tile.className = 'tile' + (local ? ' is-local' : '');
  const video = document.createElement('video');
  video.autoplay = true; video.playsInline = true;
  if (local) video.muted = true;
  const avatar = document.createElement('div'); avatar.className = 'tile__avatar';
  const bar = document.createElement('div'); bar.className = 'tile__bar';
  bar.innerHTML = '<span class="tile__name"></span><span class="tile__state"></span><span class="tile__mic">🎙</span>';
  tile.append(video, avatar, bar);
  return { tile, video, avatar, name: bar.querySelector('.tile__name'),
           micIcon: bar.querySelector('.tile__mic'), stateEl: bar.querySelector('.tile__state') };
}

function createLocalTile() {
  const parts = makeTileEl({ local: true });
  parts.tile.id = 'tile-local';
  parts.avatar.textContent = initials(state.me.username);
  parts.name.innerHTML = escapeHtml(state.me.username) + ' <span class="you">(you)</span>';
  parts.micIcon.style.display = 'none';
  el.grid.prepend(parts.tile);
  state._localTile = parts;
  refreshLocalTile();
}

function refreshLocalTile() {
  const p = state._localTile; if (!p) return;
  if (state.localStream) p.video.srcObject = state.localStream;
  const vTrack = state.localStream && state.localStream.getVideoTracks()[0];
  p.tile.classList.toggle('has-video', !!(state.camOn && vTrack && vTrack.enabled));
}

function createTile(peer) {
  const parts = makeTileEl({ local: false });
  parts.avatar.textContent = initials(peer.username);
  parts.name.textContent = peer.username;
  peer.tile = parts.tile; peer.videoEl = parts.video; peer._parts = parts;
  el.grid.append(parts.tile);
  updateTile(peer);
}

function updateTile(peer) {
  const p = peer._parts; if (!p) return;
  p.name.textContent = peer.username;
  p.avatar.textContent = initials(peer.username);
  const hasVideo = peer.camOn && peer.videoEl.srcObject && peer.videoEl.srcObject.getVideoTracks().length > 0;
  p.tile.classList.toggle('has-video', !!hasVideo);
  p.micIcon.classList.toggle('is-muted', !peer.micOn);
  p.micIcon.textContent = peer.micOn ? '🎙' : '🔇';
  const st = peer.pc.connectionState;
  p.stateEl.textContent = (st === 'connected' || st === 'completed') ? ''
    : (st === 'failed' ? 'no connection' : 'connecting…');
}

function updateCount() {
  const n = state.peers.size + 1;
  el.roomCount.textContent = n === 1 ? 'only you' : n + ' people';
  el.grid.dataset.count = String(n);
}

// ===========================================================================
// Chat
// ===========================================================================
function sendChat(text) {
  text = text.trim(); if (!text) return;
  broadcast({ kind: 'chat', text });
  addChatMessage(state.me.username, text, true);
}

function addChatMessage(author, text, mine) {
  const div = document.createElement('div');
  div.className = 'msg' + (mine ? ' mine' : '');
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  div.innerHTML =
    '<div class="msg__head"><span class="msg__author">' + escapeHtml(author) +
    '</span><span>' + time + '</span></div>' +
    '<div class="msg__text">' + escapeHtml(text) + '</div>';
  el.chatLog.append(div);
  el.chatLog.scrollTop = el.chatLog.scrollHeight;
}

function sysMessage(text) {
  const div = document.createElement('div');
  div.className = 'msg msg--sys';
  div.innerHTML = '<div class="msg__text">' + escapeHtml(text) + '</div>';
  el.chatLog.append(div);
  el.chatLog.scrollTop = el.chatLog.scrollHeight;
}

// ===========================================================================
// Direct call by username (via invite)
// ===========================================================================
async function startCall(raw) {
  const targets = raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean).filter((u) => u !== state.me.username);
  if (!targets.length) { setStatus(el.lobbyStatus, 'enter at least one username', 'error'); return; }

  const room = 'dm-' + (crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Date.now().toString(36));
  await joinRoom(room);
  try {
    const r = await post('/invite', { from: state.me.peerId, fromUsername: state.me.username, room, targets });
    if (!r.delivered || !r.delivered.length) sysMessage('no one with that username is online on this server');
    else sysMessage('invite sent: ' + r.delivered.join(', '));
  } catch { sysMessage('failed to send invite'); }
}

let pendingInvite = null;
function onInvite(msg) {
  pendingInvite = msg;
  startRinging(); // pulse the Calls icon even if another service is open
  el.inviteFrom.textContent = msg.fromUsername;
  const others = (msg.targets || []).filter((u) => u !== state.me.username);
  el.inviteWith.textContent = others.length ? ' (together with ' + others.join(', ') + ')' : '';
  el.inviteModal.classList.remove('hidden'); // overlay sits on top of any service
}

function closeInvite() { el.inviteModal.classList.add('hidden'); pendingInvite = null; stopRinging(); }

function acceptInvite() {
  const inv = pendingInvite;
  el.inviteModal.classList.add('hidden');
  pendingInvite = null;
  stopRinging();
  if (!inv) return;
  if (state.room && state.room !== inv.room) leaveRoom(false); // drop current call first
  switchService('calls');       // accepting brings you into the Calls service
  joinRoom(inv.room);
}

// ===========================================================================
// Wire up UI
// ===========================================================================
el.loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const username = el.inUsername.value.trim();
  const server = el.inServer.value.trim();
  if (!username || !server) return;
  if (!/^https?:\/\//i.test(server)) { setStatus(el.loginStatus, 'server address must start with http:// or https://', 'error'); return; }
  connect(username, server);
});

el.btnLogout.addEventListener('click', logout);

el.dockApps.forEach((b) => b.addEventListener('click', () => switchService(b.dataset.service)));

el.roomForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const room = el.inRoom.value.trim();
  if (room) { el.inRoom.value = ''; joinRoom(room); }
});
el.callForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const raw = el.inCall.value.trim();
  if (raw) { el.inCall.value = ''; startCall(raw); }
});
el.chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  sendChat(el.chatInput.value);
  el.chatInput.value = '';
});

el.btnMic.addEventListener('click', toggleMic);
el.btnCam.addEventListener('click', toggleCam);
el.btnLeave.addEventListener('click', () => leaveRoom(true));
el.btnChatToggle.addEventListener('click', () => el.chat.classList.toggle('open'));

el.inviteAccept.addEventListener('click', acceptInvite);
el.inviteDecline.addEventListener('click', closeInvite);

// Prefill server with the default punkolink gateway.
el.inServer.value = 'https://gateway.europe-central2-a.core.punkolink.com';

// Clock.
updateClock();
setInterval(updateClock, 30000);

// Tell the server we're gone when the tab closes.
window.addEventListener('pagehide', () => {
  if (state.room) {
    try {
      const blob = new Blob([JSON.stringify({ peerId: state.me.peerId, room: state.room })], { type: 'application/json' });
      navigator.sendBeacon(state.server + '/leave', blob);
    } catch {}
  }
});
