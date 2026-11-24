/*
 * RideCom — two-person voice intercom over WebRTC (via PeerJS).
 *
 * How two phones find each other without accounts:
 *   A room code maps to two fixed IDs on the signalling server:
 *     <prefix>-<room>-a   (the "answerer")
 *     <prefix>-<room>-b   (the "dialer")
 *   Each phone grabs whichever ID is free. The dialer (b) keeps calling the
 *   answerer (a) until it picks up, and calls again whenever the line drops.
 *   Only one side ever dials, so the two phones never call each other at the
 *   same time.
 *
 * Reliability:
 *   A supervisor runs every second. It checks the server connection and the
 *   call, and repairs whatever is broken. Events only update state; the
 *   supervisor decides what to do. That keeps the reconnect logic in one place.
 */
(() => {
  'use strict';

  const CFG = window.RIDECOM_CONFIG || {};
  const PREFIX = String(CFG.idPrefix || 'ridecom-v1').toLowerCase().replace(/[^a-z0-9-]/g, '') || 'ridecom';

  // ---- Timings (ms) ---------------------------------------------------------
  const TICK_MS = 1000;
  const METER_MS = 200;
  const DIAL_RETRY_MS = 3000;            // dialer retries this often while friend is away
  const CALL_SETUP_TIMEOUT_MS = 15000;   // give up on a call that never produces audio
  const ICE_GRACE_MS = 6000;             // tolerate a weak signal this long before redialling
  const SIGNAL_STUCK_MS = 20000;         // restart a server connection that never opens
  const ROOM_BUSY_RETRY_MS = 5000;
  const SIGNAL_BACKOFF_MAX_MS = 8000;

  // ---- DOM ------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const ui = {};
  [
    'joinScreen', 'callScreen', 'joinForm', 'roomInput', 'joinBtn', 'joinError',
    'roomLabel', 'netBadge', 'statusCard', 'statusText', 'statusSub',
    'remoteMeter', 'localMeter', 'enableSoundBtn', 'muteBtn', 'muteIcon', 'muteText',
    'wakeBadge', 'leaveBtn', 'details', 'statRole', 'statRoute', 'statRtt', 'statData',
    'statReconnects', 'copyLogBtn', 'logBox', 'remoteAudio',
  ].forEach((id) => { ui[id] = $(id); });

  // ---- Storage (may be unavailable in private mode) -------------------------
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* ignore */ } },
  };

  // ---- State ----------------------------------------------------------------
  const S = {
    active: false,
    fatal: '',
    room: '',
    slot: 'a',
    preferredSlot: 'a',
    slotAttempt: 0,
    roomBusy: false,
    peer: null,
    peerOpen: false,
    signalAttemptAt: 0,
    signalBackoff: 1000,
    nextPeerActionAt: 0,
    call: null,
    callConnected: false,
    callStartedAt: 0,
    iceBadSince: 0,
    lastDialAt: 0,
    dialCount: 0,
    connectedSince: 0,
    everConnected: false,
    reconnects: 0,
    setupFailures: 0,
    localStream: null,
    muted: false,
    iceServers: [],
    hasTurn: false,
    wakeLock: null,
    audioCtx: null,
    localSource: null,
    localAnalyser: null,
    meterBuf: null,
    statsBusy: false,
    energy: null,
    tickTimer: null,
    meterTimer: null,
  };
  window.__ridecom = S; // handy for debugging from the browser console

  // ---- Logging --------------------------------------------------------------
  const logLines = [];
  function log(msg) {
    const line = `${new Date().toTimeString().slice(0, 8)}  ${msg}`;
    logLines.push(line);
    if (logLines.length > 300) logLines.shift();
    ui.logBox.textContent = logLines.slice().reverse().join('\n');
    console.log('[RideCom]', msg);
  }

  // ---- Helpers --------------------------------------------------------------
  const normalizeRoom = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
  const otherSlot = (slot) => (slot === 'a' ? 'b' : 'a');
  const peerId = (slot) => `${PREFIX}-${S.room.toLowerCase()}-${slot}`;
  const slotKey = () => `ridecom.slot.${S.room}`;

  function vibrate(pattern) {
    try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (_) { /* ignore */ }
  }

  function fmtDuration(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const mm = String(m).padStart(h ? 2 : 1, '0');
    return h ? `${h}:${mm}:${String(sec).padStart(2, '0')}` : `${mm}:${String(sec).padStart(2, '0')}`;
  }

  function fmtBytes(n) {
    if (!n) return '0 MB';
    return n < 1e6 ? `${(n / 1e3).toFixed(0)} KB` : `${(n / 1e6).toFixed(1)} MB`;
  }

  // Linear level (0..1) to meter width: -50 dBFS = empty, 0 dBFS = full.
  function levelToPct(level) {
    if (!level || level <= 0.0001) return 0;
    const db = 20 * Math.log10(level);
    return Math.max(0, Math.min(100, ((db + 50) / 50) * 100));
  }

  function setMeter(el, pct) { el.style.width = `${pct.toFixed(0)}%`; }

  // ---- Sound cues (heard in the earphones, so you needn't look at the phone) -
  function primeAudio() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    try {
      if (!S.audioCtx || S.audioCtx.state === 'closed') S.audioCtx = new Ctx();
      S.audioCtx.resume().catch(() => {});
    } catch (_) {
      S.audioCtx = null;
    }
  }

  function chime(freqs) {
    const ctx = S.audioCtx;
    if (!ctx || ctx.state !== 'running') return;
    try {
      let t = ctx.currentTime + 0.02;
      freqs.forEach((f) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = f;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.2);
        t += 0.2;
      });
    } catch (_) { /* cues are best effort */ }
  }
  const chimeConnected = () => chime([660, 880]);
  const chimeLost = () => chime([600, 400]);

  // ---- Microphone -----------------------------------------------------------
  function getMic() {
    return navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
      video: false,
    });
  }

  function watchLocalTrack(stream) {
    const track = stream.getAudioTracks()[0];
    if (!track) return;
    track.addEventListener('mute', () => log('Mic paused by the phone (app in background or another app took the mic)'));
    track.addEventListener('unmute', () => log('Mic active again'));
    track.addEventListener('ended', () => {
      log('Mic stopped by the phone');
      if (S.active && document.visibilityState === 'visible') reacquireMic();
    });
  }

  function micErrorMessage(err) {
    const name = err && err.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return 'Microphone access was blocked. iPhone: Settings → Safari → Microphone → Allow. '
        + 'Android: tap the lock icon next to the address → Permissions → Microphone.';
    }
    if (name === 'NotFoundError') return 'No microphone found. Connect your earphones and try again.';
    if (name === 'NotReadableError') return 'The microphone is busy (maybe a phone call?). Close other apps using it and try again.';
    return `Could not start the microphone (${name || err}).`;
  }

  async function reacquireMic() {
    try {
      const fresh = await getMic();
      const track = fresh.getAudioTracks()[0];
      if (S.localStream) S.localStream.getTracks().forEach((t) => t.stop());
      S.localStream = fresh;
      watchLocalTrack(fresh);
      applyMute();
      setupLocalMeter();
      const pc = S.call && S.call.peerConnection;
      if (pc) {
        const sender = pc.getSenders().find((s) => !s.track || s.track.kind === 'audio');
        if (sender) await sender.replaceTrack(track);
      }
      log('Microphone restarted');
    } catch (err) {
      log(`Could not restart microphone: ${err.message || err}`);
    }
  }

  function checkMicAlive() {
    const track = S.localStream && S.localStream.getAudioTracks()[0];
    if (!track || track.readyState === 'ended') reacquireMic();
  }

  function setupLocalMeter() {
    if (!S.audioCtx || !S.localStream) return;
    try {
      if (S.localSource) S.localSource.disconnect();
      S.localSource = S.audioCtx.createMediaStreamSource(S.localStream);
      S.localAnalyser = S.audioCtx.createAnalyser();
      S.localAnalyser.fftSize = 512;
      S.meterBuf = new Uint8Array(S.localAnalyser.fftSize);
      S.localSource.connect(S.localAnalyser);
    } catch (err) {
      S.localAnalyser = null;
      log(`Mic meter unavailable: ${err.message || err}`);
    }
  }

  // ---- Mute -----------------------------------------------------------------
  function applyMute() {
    if (!S.localStream) return;
    S.localStream.getAudioTracks().forEach((t) => { t.enabled = !S.muted; });
  }

  function setMuted(muted) {
    S.muted = !!muted;
    applyMute();
    ui.muteBtn.setAttribute('aria-pressed', String(S.muted));
    ui.muteIcon.textContent = S.muted ? '🔇' : '🎙️';
    ui.muteText.textContent = S.muted ? 'Mic MUTED — tap to talk' : 'Mic ON — tap to mute';
    renderStatus(Date.now());
  }

  // ---- ICE (STUN/TURN) servers ----------------------------------------------
  async function loadIceServers() {
    const servers = [...(CFG.stunServers || []), ...(CFG.extraIceServers || [])];
    if (CFG.turnCredentialsUrl) {
      let turn = null;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 6000);
        const res = await fetch(CFG.turnCredentialsUrl, { signal: ctrl.signal, cache: 'no-store' });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        turn = Array.isArray(data) ? data : data && data.iceServers;
        if (!Array.isArray(turn)) throw new Error('unexpected response');
        store.set('ridecom.turnCache', JSON.stringify(turn));
        log(`Relay (TURN) servers loaded: ${turn.length}`);
      } catch (err) {
        try { turn = JSON.parse(store.get('ridecom.turnCache') || 'null'); } catch (_) { turn = null; }
        log(turn
          ? `Could not refresh relay servers (${err.message}); using saved copy`
          : `Could not load relay servers (${err.message}); continuing without`);
      }
      if (Array.isArray(turn)) servers.push(...turn);
    }
    S.hasTurn = servers.some((s) => [].concat(s.urls || s.url || []).some((u) => /^turns?:/i.test(u)));
    if (!S.hasTurn) log('No relay (TURN) server set — may fail on mobile data. See README.');
    return servers;
  }

  // ---- Signalling (PeerJS server) -------------------------------------------
  function bumpSignalBackoff() {
    S.nextPeerActionAt = Date.now() + S.signalBackoff;
    S.signalBackoff = Math.min(S.signalBackoff * 2, SIGNAL_BACKOFF_MAX_MS);
  }

  function destroyPeer() {
    const p = S.peer;
    S.peer = null;
    S.peerOpen = false;
    if (p) { try { p.destroy(); } catch (_) { /* ignore */ } }
  }

  function createPeer() {
    const slot = S.slot;
    const opts = { debug: 1, config: { iceServers: S.iceServers } };
    if (CFG.peerServer) Object.assign(opts, CFG.peerServer);
    log(`Connecting to server as rider ${slot.toUpperCase()}…`);
    const p = new Peer(peerId(slot), opts);
    S.peer = p;
    S.peerOpen = false;
    S.signalAttemptAt = Date.now();
    ui.statRole.textContent = slot === 'a' ? 'Rider A (answers)' : 'Rider B (calls)';

    p.on('open', () => {
      if (p !== S.peer) return;
      S.peerOpen = true;
      S.slotAttempt = 0;
      S.roomBusy = false;
      S.signalBackoff = 1000;
      S.preferredSlot = slot;
      store.set(slotKey(), slot);
      log('Server connected');
      S.lastDialAt = 0; // dial straight away if we're the dialer
      tick();
    });
    p.on('call', (c) => onIncomingCall(p, c));
    p.on('disconnected', () => {
      if (p !== S.peer) return;
      if (S.peerOpen) log('Lost connection to server (voice may continue)');
      S.peerOpen = false;
    });
    p.on('close', () => { if (p === S.peer) S.peerOpen = false; });
    p.on('error', (err) => onPeerError(p, err));
  }

  function onPeerError(p, err) {
    if (p !== S.peer) return;
    const type = err && err.type;
    switch (type) {
      case 'peer-unavailable':
        // Friend isn't connected yet. Normal while waiting; the dialer retries.
        if (S.call && !S.callConnected) dropCall(null);
        return;
      case 'unavailable-id':
        destroyPeer();
        S.slotAttempt += 1;
        if (S.slotAttempt === 1) {
          S.slot = otherSlot(S.slot);
          S.nextPeerActionAt = 0;
          log('That place in the room is taken, trying the other one');
        } else {
          // Both IDs taken: a third phone, or an old session of ours the server
          // hasn't timed out yet (takes up to ~1 min). Wait and try again.
          S.slotAttempt = 0;
          S.roomBusy = true;
          S.slot = S.preferredSlot;
          S.nextPeerActionAt = Date.now() + ROOM_BUSY_RETRY_MS;
          log('Both places in this room are taken — retrying in 5 s');
        }
        setTimeout(tick, 0);
        return;
      case 'browser-incompatible':
        S.fatal = 'This browser cannot make voice calls. Use Safari (iPhone) or Chrome (Android).';
        break;
      case 'invalid-id':
      case 'invalid-key':
      case 'ssl-unavailable':
        S.fatal = `Server setup problem (${type}). Check config.js.`;
        break;
      default:
        // network / server-error / socket-error / socket-closed / webrtc:
        // PeerJS either destroys or disconnects the peer; the supervisor repairs it.
        bumpSignalBackoff();
    }
    log(`Server error: ${type || 'unknown'} — ${(err && err.message) || err}`);
    renderStatus(Date.now());
  }

  function superviseSignal(now) {
    if (S.fatal || now < S.nextPeerActionAt) return;
    const p = S.peer;
    if (!p || p.destroyed) { createPeer(); return; }
    if (S.peerOpen) return;
    if (p.disconnected) {
      // Keep the same ID so the friend can still reach us.
      log('Reconnecting to server…');
      S.signalAttemptAt = now;
      bumpSignalBackoff();
      try { p.reconnect(); } catch (_) { destroyPeer(); }
      return;
    }
    if (now - S.signalAttemptAt > SIGNAL_STUCK_MS) {
      log('Server connection is taking too long — starting over');
      destroyPeer();
      bumpSignalBackoff();
    }
  }

  // ---- Calls ----------------------------------------------------------------
  function dial(now) {
    S.lastDialAt = now;
    S.dialCount += 1;
    if (S.dialCount === 1 || S.dialCount % 20 === 0) log('Calling friend…');
    const c = S.peer.call(peerId('a'), S.localStream);
    if (c) attachCall(c);
  }

  function onIncomingCall(p, c) {
    if (p !== S.peer || !S.active) { try { c.close(); } catch (_) { /* ignore */ } return; }
    if (c.peer !== peerId(otherSlot(S.slot))) {
      log('Ignored a call from an unknown device');
      try { c.close(); } catch (_) { /* ignore */ }
      return;
    }
    if (S.call) dropCall(null); // friend is reconnecting; the new call replaces the old one
    log('Friend is calling — answering');
    c.answer(S.localStream);
    attachCall(c);
  }

  function attachCall(c) {
    S.call = c;
    S.callConnected = false;
    S.callStartedAt = Date.now();
    S.iceBadSince = 0;
    S.energy = null;

    c.on('stream', (remote) => {
      if (c !== S.call) return;
      playRemote(remote);
      if (S.callConnected) return; // 'stream' can fire more than once
      S.callConnected = true;
      S.connectedSince = Date.now();
      S.setupFailures = 0;
      S.dialCount = 0;
      if (S.everConnected) S.reconnects += 1;
      S.everConnected = true;
      ui.statReconnects.textContent = String(S.reconnects);
      log('Connected to friend');
      chimeConnected();
      vibrate([80, 60, 80]);
      tick();
    });
    c.on('close', () => {
      if (c !== S.call) return;
      const ice = c.peerConnection && c.peerConnection.iceConnectionState;
      if (!S.callConnected && ice === 'failed') S.setupFailures += 1;
      log(S.callConnected ? 'Call dropped — reconnecting…' : 'Call attempt ended');
      clearCall();
      tick();
    });
    c.on('error', (err) => {
      if (c !== S.call) return;
      log(`Call error: ${(err && err.type) || ''} ${(err && err.message) || err}`);
    });
  }

  function clearCall() {
    const wasConnected = S.callConnected;
    S.call = null;
    S.callConnected = false;
    S.iceBadSince = 0;
    setMeter(ui.remoteMeter, 0);
    if (wasConnected) {
      // Redial almost immediately after losing a live call.
      S.lastDialAt = Date.now() - DIAL_RETRY_MS + 500;
      chimeLost();
      vibrate(300);
    }
  }

  function dropCall(reason) {
    const c = S.call;
    if (!c) return;
    if (reason) log(reason);
    clearCall();
    try { c.close(); } catch (_) { /* ignore */ }
  }

  function superviseCall(now) {
    const c = S.call;
    if (c) {
      const pc = c.peerConnection;
      const ice = pc ? pc.iceConnectionState : 'new';
      if (S.callConnected) {
        if (ice === 'failed' || ice === 'closed') {
          dropCall('Connection to friend failed — reconnecting…');
        } else if (ice === 'disconnected') {
          if (!S.iceBadSince) {
            S.iceBadSince = now;
            log('Weak signal — holding the line…');
          } else if (now - S.iceBadSince > ICE_GRACE_MS) {
            dropCall('Signal lost — reconnecting…');
          }
        } else if (S.iceBadSince) {
          S.iceBadSince = 0;
          log('Signal recovered');
        }
      } else if (now - S.callStartedAt > CALL_SETUP_TIMEOUT_MS) {
        S.setupFailures += 1;
        dropCall('Call could not connect in time — retrying');
      }
      return;
    }
    // No call: only the dialer (rider B) places calls.
    if (S.peerOpen && S.slot === 'b' && now - S.lastDialAt >= DIAL_RETRY_MS) dial(now);
  }

  function playRemote(stream) {
    const a = ui.remoteAudio;
    if (stream && a.srcObject !== stream) a.srcObject = stream;
    if (!a.srcObject) return;
    const p = a.play();
    if (p && typeof p.then === 'function') {
      p.then(() => { ui.enableSoundBtn.hidden = true; })
        .catch(() => {
          log('Phone blocked sound — tap the yellow button');
          ui.enableSoundBtn.hidden = false;
        });
    }
  }

  // ---- Status display -------------------------------------------------------
  let lastStatus = '';
  function setStatus(kind, text, sub) {
    const key = `${kind}|${text}|${sub}`;
    if (key === lastStatus) return;
    lastStatus = key;
    ui.statusCard.className = `status status-${kind}`;
    ui.statusText.textContent = text;
    ui.statusSub.textContent = sub;
  }

  function renderStatus(now) {
    const online = navigator.onLine !== false;
    ui.netBadge.textContent = online ? 'Online' : 'Offline';
    ui.netBadge.classList.toggle('offline', !online);
    if (!S.active) return;

    const again = S.everConnected;
    if (S.fatal) {
      setStatus('bad', 'Problem', S.fatal);
    } else if (S.callConnected && S.iceBadSince) {
      setStatus('wait', 'Weak signal', 'Holding the line…');
    } else if (S.callConnected) {
      setStatus('ok', 'Connected', `${S.muted ? 'Your mic is MUTED · ' : ''}${fmtDuration(now - S.connectedSince)}`);
    } else if (!online) {
      setStatus('bad', 'No internet', 'Reconnects automatically when signal returns');
    } else if (S.roomBusy) {
      setStatus('bad', 'Room is full', 'Two other phones are using this code. Retrying…');
    } else {
      let sub;
      if (!S.peerOpen) sub = 'Reaching the server…';
      else if (S.call) sub = 'Found your friend, starting audio…';
      else sub = again ? 'Waiting for your friend’s signal' : `Ask your friend to join room ${S.room}`;
      if (S.setupFailures >= 2 && !S.hasTurn) {
        sub = 'Can’t connect directly on this network. Add a TURN relay server (see README).';
      }
      const title = again ? 'Reconnecting…' : (S.peerOpen && !S.call ? 'Waiting for friend' : 'Connecting…');
      setStatus('wait', title, sub);
    }
  }

  // ---- Meters & stats -------------------------------------------------------
  async function updateMeters() {
    if (!S.active || document.hidden) return;

    let localPct = 0;
    if (S.localAnalyser && !S.muted) {
      S.localAnalyser.getByteTimeDomainData(S.meterBuf);
      let sum = 0;
      for (let i = 0; i < S.meterBuf.length; i += 1) {
        const v = (S.meterBuf[i] - 128) / 128;
        sum += v * v;
      }
      localPct = levelToPct(Math.sqrt(sum / S.meterBuf.length));
    }
    setMeter(ui.localMeter, localPct);

    const pc = S.callConnected && S.call && S.call.peerConnection;
    if (!pc) { setMeter(ui.remoteMeter, 0); return; }
    if (S.statsBusy) return;
    S.statsBusy = true;
    try {
      handleStats(await pc.getStats());
    } catch (_) { /* stats are best effort */ } finally {
      S.statsBusy = false;
    }
  }

  function handleStats(report) {
    const byId = new Map();
    let inbound = null;
    let outbound = null;
    let transport = null;
    report.forEach((s) => {
      byId.set(s.id, s);
      const audio = s.kind === 'audio' || s.mediaType === 'audio';
      if (s.type === 'inbound-rtp' && audio) inbound = s;
      else if (s.type === 'outbound-rtp' && audio) outbound = s;
      else if (s.type === 'transport') transport = s;
    });

    // Friend's voice level
    let level = 0;
    if (inbound) {
      if (typeof inbound.audioLevel === 'number') {
        level = inbound.audioLevel;
      } else if (typeof inbound.totalAudioEnergy === 'number' && typeof inbound.totalSamplesDuration === 'number') {
        const prev = S.energy;
        S.energy = { e: inbound.totalAudioEnergy, d: inbound.totalSamplesDuration };
        if (prev && S.energy.d > prev.d) level = Math.sqrt((S.energy.e - prev.e) / (S.energy.d - prev.d));
      }
    }
    setMeter(ui.remoteMeter, levelToPct(level));

    if (!ui.details.open) return;
    let pair = transport && transport.selectedCandidatePairId ? byId.get(transport.selectedCandidatePairId) : null;
    if (!pair) {
      report.forEach((s) => {
        if (!pair && s.type === 'candidate-pair' && s.state === 'succeeded' && (s.nominated || s.selected)) pair = s;
      });
    }
    if (pair) {
      const local = byId.get(pair.localCandidateId);
      const remote = byId.get(pair.remoteCandidateId);
      const relayed = (local && local.candidateType === 'relay') || (remote && remote.candidateType === 'relay');
      ui.statRoute.textContent = relayed ? 'Via relay (TURN)' : 'Direct phone-to-phone';
      ui.statRtt.textContent = typeof pair.currentRoundTripTime === 'number'
        ? `${Math.round(pair.currentRoundTripTime * 1000)} ms` : '–';
    }
    ui.statData.textContent = `${fmtBytes(inbound && inbound.bytesReceived)} / ${fmtBytes(outbound && outbound.bytesSent)}`;
  }

  // ---- Screen wake lock -----------------------------------------------------
  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) {
      ui.wakeBadge.textContent = 'Tip: set screen Auto-Lock to Never';
      return;
    }
    if (S.wakeLock && !S.wakeLock.released) return;
    try {
      S.wakeLock = await navigator.wakeLock.request('screen');
      ui.wakeBadge.textContent = '☀️ Screen stays on';
      S.wakeLock.addEventListener('release', () => {
        if (S.active) ui.wakeBadge.textContent = 'Screen may turn off';
      });
    } catch (err) {
      ui.wakeBadge.textContent = 'Screen may turn off';
      log(`Could not keep screen on: ${err.message || err}`);
    }
  }

  function releaseWakeLock() {
    if (S.wakeLock) { S.wakeLock.release().catch(() => {}); S.wakeLock = null; }
    ui.wakeBadge.textContent = '';
  }

  // ---- Earphone buttons (experimental) --------------------------------------
  // Pressing pause/play on earphones (or taking an AirPod out) mutes/unmutes.
  function setupMediaSession(enable) {
    const ms = navigator.mediaSession;
    if (!ms) return;
    const set = (action, fn) => { try { ms.setActionHandler(action, fn); } catch (_) { /* unsupported */ } };
    if (!enable) { set('play', null); set('pause', null); return; }
    try { ms.metadata = new MediaMetadata({ title: 'RideCom intercom', artist: `Room ${S.room}` }); } catch (_) { /* ignore */ }
    set('pause', () => { log('Earphone button → mute'); setMuted(true); });
    set('play', () => { log('Earphone button → unmute'); setMuted(false); playRemote(null); });
  }

  // ---- Main loop ------------------------------------------------------------
  function tick() {
    if (!S.active) return;
    const now = Date.now();
    try {
      superviseSignal(now);
      superviseCall(now);
    } catch (err) {
      log(`Unexpected error: ${err.message || err}`);
    }
    renderStatus(now);
  }

  // ---- Join / leave ---------------------------------------------------------
  function showJoinError(msg) {
    ui.joinError.textContent = msg;
    ui.joinError.hidden = !msg;
  }

  async function join(ev) {
    ev.preventDefault();
    const room = normalizeRoom(ui.roomInput.value);
    ui.roomInput.value = room;
    if (room.length < 4) { showJoinError('The room code needs at least 4 letters or numbers.'); return; }
    if (typeof window.Peer === 'undefined') { showJoinError('The app did not load completely. Check your internet and reload.'); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.RTCPeerConnection) {
      showJoinError(window.isSecureContext === false
        ? 'Voice needs a secure (https://) link. Open the app from its https:// address.'
        : 'This browser cannot make voice calls. Use Safari on iPhone or Chrome on Android.');
      return;
    }
    showJoinError('');
    ui.joinBtn.disabled = true;
    ui.joinBtn.textContent = 'Starting…';

    // Must happen during the tap, before any await.
    try { if (navigator.audioSession) navigator.audioSession.type = 'play-and-record'; } catch (_) { /* Safari only */ }
    primeAudio();

    try {
      S.localStream = await getMic();
    } catch (err) {
      showJoinError(micErrorMessage(err));
      ui.joinBtn.disabled = false;
      ui.joinBtn.textContent = 'Join ride';
      return;
    }
    if (S.audioCtx && S.audioCtx.state !== 'running') S.audioCtx.resume().catch(() => {});
    watchLocalTrack(S.localStream);

    Object.assign(S, {
      room, fatal: '', slotAttempt: 0, roomBusy: false, peer: null, peerOpen: false,
      signalBackoff: 1000, nextPeerActionAt: 0, call: null, callConnected: false,
      lastDialAt: 0, dialCount: 0, everConnected: false, reconnects: 0, setupFailures: 0,
    });
    store.set('ridecom.room', room);
    const saved = store.get(slotKey());
    S.slot = saved === 'b' ? 'b' : 'a';
    S.preferredSlot = S.slot;

    ui.roomLabel.textContent = room;
    ui.statReconnects.textContent = '0';
    ui.joinScreen.hidden = true;
    ui.callScreen.hidden = false;
    setStatus('wait', 'Connecting…', 'Getting ready');
    log(`Joining room ${room}`);

    S.iceServers = await loadIceServers();
    setupLocalMeter();
    setMuted(false);
    setupMediaSession(true);
    requestWakeLock();

    S.active = true;
    S.tickTimer = setInterval(tick, TICK_MS);
    S.meterTimer = setInterval(updateMeters, METER_MS);
    tick();

    ui.joinBtn.disabled = false;
    ui.joinBtn.textContent = 'Join ride';
  }

  function stopAll() {
    S.active = false;
    clearInterval(S.tickTimer);
    clearInterval(S.meterTimer);
    const c = S.call;
    S.call = null;
    S.callConnected = false;
    if (c) { try { c.close(); } catch (_) { /* ignore */ } }
    destroyPeer();
    if (S.localStream) S.localStream.getTracks().forEach((t) => t.stop());
    S.localStream = null;
    if (S.localSource) { try { S.localSource.disconnect(); } catch (_) { /* ignore */ } }
    S.localSource = null;
    S.localAnalyser = null;
    ui.remoteAudio.srcObject = null;
    setupMediaSession(false);
    releaseWakeLock();
  }

  function leave() {
    if (!window.confirm('Leave the intercom?')) return;
    log('Left the room');
    stopAll();
    lastStatus = '';
    ui.callScreen.hidden = true;
    ui.joinScreen.hidden = false;
    ui.enableSoundBtn.hidden = true;
  }

  // ---- Wiring ---------------------------------------------------------------
  ui.joinForm.addEventListener('submit', join);
  ui.leaveBtn.addEventListener('click', leave);
  ui.muteBtn.addEventListener('click', () => { setMuted(!S.muted); vibrate(40); });
  ui.enableSoundBtn.addEventListener('click', () => {
    if (S.audioCtx) S.audioCtx.resume().catch(() => {});
    playRemote(null);
  });
  ui.copyLogBtn.addEventListener('click', async () => {
    const text = logLines.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      ui.copyLogBtn.textContent = 'Copied!';
    } catch (_) {
      ui.copyLogBtn.textContent = 'Copy failed';
    }
    setTimeout(() => { ui.copyLogBtn.textContent = 'Copy log'; }, 1500);
  });
  ui.details.addEventListener('toggle', () => { if (ui.details.open) updateMeters(); });

  window.addEventListener('online', () => {
    log('Internet back');
    S.signalBackoff = 1000;
    S.nextPeerActionAt = 0;
    tick();
  });
  window.addEventListener('offline', () => { log('Internet lost'); renderStatus(Date.now()); });

  document.addEventListener('visibilitychange', () => {
    if (!S.active) return;
    if (document.visibilityState === 'visible') {
      log('App back on screen');
      requestWakeLock();
      checkMicAlive();
      if (S.audioCtx && S.audioCtx.state !== 'running') S.audioCtx.resume().catch(() => {});
      if (S.callConnected) playRemote(null);
      tick();
    } else {
      log('App went to background');
    }
  });

  // Free our ID on the server right away when the page is closed, so
  // reopening the app doesn't find its own old session in the way.
  window.addEventListener('pagehide', () => { if (S.active) destroyPeer(); });
  window.addEventListener('pageshow', (e) => { if (e.persisted && S.active) tick(); });

  // Prefill the room code: link like https://…/#RIDE42, else the last one used.
  ui.roomInput.value = normalizeRoom(decodeURIComponent(location.hash.slice(1))) || store.get('ridecom.room') || '';

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline cache is optional */ });
  }
})();
