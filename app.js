/* Chordbox v1.0 — original pocket chord synth (Web Audio). Offline PWA. */
'use strict';
const VER = 'v1.0.3';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];
const MINOR_STEPS = [0, 2, 3, 5, 7, 8, 10];
const DEG_LABELS = ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°'];
const DEG_LABELS_MIN = ['i', 'ii°', 'III', 'iv', 'v', 'VI', 'VII'];
const QUAL_MAJOR = ['', 'm', 'm', '', '', 'm', 'dim'];
const QUAL_MINOR = ['m', 'dim', '', 'm', 'm', '', ''];

const state = {
  key: 0,           // C
  scale: 'major',
  octave: 3,
  sound: 'pad',
  fx: 'room',
  bpm: 96,
  arp: false,
  latch: false,
  latchedDeg: null, // mono latch: which degree is locked on
  met: false,
  xy: { x: 0, y: 0, held: false }, // -1..1
  held: new Map(),  // degree -> voice
  loop: { rec: false, playing: false, events: [], start: 0, len: 0 },
};

let ac = null, master = null, filter = null, fxGain = null, dryGain = null, convolver = null, delay = null, delayGain = null, analyser = null;
let metroTimer = null, loopTimer = null, arpTimer = null, beat = 0;
let loopTimeouts = []; // pending bar event timers — must cancel on CLR / stop

/* ---------- audio bootstrap ---------- */
function unlock() {
  if (ac) return ac;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  ac = new Ctx();
  master = ac.createGain(); master.gain.value = 0.85;
  filter = ac.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 12000; filter.Q.value = 0.7;
  dryGain = ac.createGain(); dryGain.gain.value = 0.85;
  fxGain = ac.createGain(); fxGain.gain.value = 0.35;
  delay = ac.createDelay(1.0); delay.delayTime.value = 0.28;
  delayGain = ac.createGain(); delayGain.gain.value = 0;
  const fb = ac.createGain(); fb.gain.value = 0.35;
  delay.connect(fb); fb.connect(delay);
  delay.connect(delayGain);
  convolver = ac.createConvolver();
  convolver.buffer = makeImpulse(ac, 1.6, 2.2);
  analyser = ac.createAnalyser(); analyser.fftSize = 256;
  filter.connect(dryGain); dryGain.connect(master);
  filter.connect(convolver); convolver.connect(fxGain); fxGain.connect(master);
  filter.connect(delay); delayGain.connect(master);
  master.connect(analyser); analyser.connect(ac.destination);
  applyFx(state.fx);
  return ac;
}
async function resume() {
  unlock();
  if (ac.state !== 'running') await ac.resume();
}
function makeImpulse(ctx, seconds, decay) {
  const rate = ctx.sampleRate, len = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(2, len, rate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}
function applyFx(mode) {
  state.fx = mode;
  if (!ac) return;
  const now = ac.currentTime;
  if (mode === 'dry') {
    fxGain.gain.setTargetAtTime(0, now, 0.05);
    delayGain.gain.setTargetAtTime(0, now, 0.05);
    dryGain.gain.setTargetAtTime(1, now, 0.05);
  } else if (mode === 'room') {
    convolver.buffer = makeImpulse(ac, 1.1, 2.4);
    fxGain.gain.setTargetAtTime(0.32, now, 0.05);
    delayGain.gain.setTargetAtTime(0, now, 0.05);
    dryGain.gain.setTargetAtTime(0.9, now, 0.05);
  } else if (mode === 'hall') {
    convolver.buffer = makeImpulse(ac, 2.6, 2.0);
    fxGain.gain.setTargetAtTime(0.48, now, 0.05);
    delayGain.gain.setTargetAtTime(0.08, now, 0.05);
    dryGain.gain.setTargetAtTime(0.8, now, 0.05);
  } else { // echo
    fxGain.gain.setTargetAtTime(0.12, now, 0.05);
    delay.delayTime.setTargetAtTime(60 / state.bpm, now, 0.05);
    delayGain.gain.setTargetAtTime(0.35, now, 0.05);
    dryGain.gain.setTargetAtTime(0.9, now, 0.05);
  }
  $('#fxLbl').textContent = { dry: 'Dry', room: 'Room', hall: 'Hall', echo: 'Echo' }[mode];
  refreshReadout();
}

/* ---------- music theory ---------- */
function midiToHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }
function degreeRoot(deg) {
  const steps = state.scale === 'minor' ? MINOR_STEPS : MAJOR_STEPS;
  return state.key + steps[deg] + (state.octave + 1) * 12;
}
function baseQuality(deg) {
  return (state.scale === 'minor' ? QUAL_MINOR : QUAL_MAJOR)[deg];
}
function morphQuality(base) {
  const { x, y, held } = state.xy;
  if (!held) return { intervals: intervalsFor(base), label: base || 'maj' };
  let q = base;
  // left: flip maj/min; right: add9
  if (x < -0.35) {
    if (q === '' || q === 'maj') q = 'm';
    else if (q === 'm') q = '';
    else if (q === 'dim') q = 'm';
  }
  let intervals = intervalsFor(q);
  if (y > 0.35) { // up: 7th
    intervals = [...intervals];
    if (q === 'dim') intervals.push(9); else if (q === 'm') intervals.push(10); else intervals.push(10);
    q = (q === 'm' ? 'm7' : q === 'dim' ? 'dim7' : '7');
  }
  if (y < -0.35) { // down: sus
    intervals = [0, 5, 7];
    q = 'sus4';
  }
  if (x > 0.35) {
    intervals = [...new Set([...intervals, 14])].sort((a, b) => a - b);
    q = (q === 'sus4' ? 'sus4add9' : (q || 'maj') + 'add9');
  }
  return { intervals, label: q || 'maj' };
}
function intervalsFor(q) {
  if (q === 'm') return [0, 3, 7];
  if (q === 'dim') return [0, 3, 6];
  if (q === 'aug') return [0, 4, 8];
  return [0, 4, 7]; // maj
}
function chordMidi(deg) {
  const root = degreeRoot(deg);
  const { intervals, label } = morphQuality(baseQuality(deg));
  return { notes: intervals.map(i => root + i), label, root };
}

/* ---------- voices ---------- */
function envGain(g, a, d, s, r, t0, vel = 0.7) {
  g.gain.cancelScheduledValues(t0);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vel, t0 + a);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0001, vel * s), t0 + a + d);
  return () => {
    const t = ac.currentTime;
    const v = Math.max(0.0001, g.gain.value);
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(v, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + r);
  };
}
function makeVoice(midi, when = ac.currentTime) {
  const out = ac.createGain(); out.connect(filter);
  const partials = [];
  const snd = state.sound;
  const stopFns = [];
  const hz = midiToHz(midi);

  if (snd === 'pad') {
    [1, 2, 3].forEach((mul, i) => {
      const o = ac.createOscillator();
      o.type = i === 0 ? 'sawtooth' : 'triangle';
      o.frequency.setValueAtTime(hz * mul, when);
      o.detune.setValueAtTime((i - 1) * 6, when);
      const g = ac.createGain(); g.gain.value = i === 0 ? 0.22 : 0.08;
      o.connect(g); g.connect(out); o.start(when); partials.push(o);
    });
    stopFns.push(envGain(out, 0.12, 0.35, 0.7, 0.55, when, 0.55));
  } else if (snd === 'keys') {
    const o = ac.createOscillator(); o.type = 'triangle'; o.frequency.setValueAtTime(hz, when);
    const o2 = ac.createOscillator(); o2.type = 'sine'; o2.frequency.setValueAtTime(hz * 2, when);
    const g2 = ac.createGain(); g2.gain.value = 0.18;
    o.connect(out); o2.connect(g2); g2.connect(out);
    o.start(when); o2.start(when); partials.push(o, o2);
    stopFns.push(envGain(out, 0.005, 0.25, 0.35, 0.35, when, 0.6));
  } else if (snd === 'pluck') {
    const o = ac.createOscillator(); o.type = 'sawtooth'; o.frequency.setValueAtTime(hz, when);
    const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(hz * 6, when);
    f.frequency.exponentialRampToValueAtTime(hz * 1.5, when + 0.25);
    o.connect(f); f.connect(out); o.start(when); partials.push(o);
    stopFns.push(envGain(out, 0.002, 0.18, 0.05, 0.2, when, 0.65));
  } else { // organ
    [1, 2, 3, 4, 6].forEach((mul, i) => {
      const o = ac.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(hz * mul, when);
      const g = ac.createGain(); g.gain.value = 0.18 / (i + 1);
      o.connect(g); g.connect(out); o.start(when); partials.push(o);
    });
    stopFns.push(envGain(out, 0.02, 0.1, 0.85, 0.25, when, 0.45));
  }

  return {
    out, partials,
    stop() {
      const t = ac.currentTime;
      stopFns.forEach(fn => fn());
      partials.forEach(o => { try { o.stop(t + 0.8); } catch (_) {} });
    }
  };
}

/** Short, loud, fast-attack voice for every arp step — audible in all presets. */
function makeArpVoice(midi, stepMs, when = ac.currentTime) {
  const out = ac.createGain(); out.connect(filter);
  const hz = midiToHz(midi);
  const partials = [];
  const snd = state.sound;
  const gate = Math.max(0.09, Math.min(0.55, (stepMs / 1000) * 0.7));
  if (snd === 'organ') {
    [1, 2, 3].forEach((mul, i) => {
      const o = ac.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(hz * mul, when);
      const g = ac.createGain(); g.gain.value = 0.28 / (i + 1);
      o.connect(g); g.connect(out); o.start(when); partials.push(o);
    });
  } else if (snd === 'pad') {
    const o = ac.createOscillator(); o.type = 'sawtooth'; o.frequency.setValueAtTime(hz, when);
    const o2 = ac.createOscillator(); o2.type = 'triangle'; o2.frequency.setValueAtTime(hz * 2, when);
    const g2 = ac.createGain(); g2.gain.value = 0.2;
    o.connect(out); o2.connect(g2); g2.connect(out); o.start(when); o2.start(when); partials.push(o, o2);
  } else if (snd === 'pluck') {
    const o = ac.createOscillator(); o.type = 'sawtooth'; o.frequency.setValueAtTime(hz, when);
    const f = ac.createBiquadFilter(); f.type = 'lowpass';
    f.frequency.setValueAtTime(Math.min(8000, hz * 8), when);
    f.frequency.exponentialRampToValueAtTime(hz * 2, when + gate);
    o.connect(f); f.connect(out); o.start(when); partials.push(o);
  } else {
    const o = ac.createOscillator(); o.type = 'triangle'; o.frequency.setValueAtTime(hz, when);
    const o2 = ac.createOscillator(); o2.type = 'square'; o2.frequency.setValueAtTime(hz, when);
    const g2 = ac.createGain(); g2.gain.value = 0.12;
    o.connect(out); o2.connect(g2); g2.connect(out); o.start(when); o2.start(when); partials.push(o, o2);
  }
  // Punchy envelope: fast attack, audible body, clean release within the step
  out.gain.setValueAtTime(0.0001, when);
  out.gain.exponentialRampToValueAtTime(0.85, when + 0.008);
  out.gain.exponentialRampToValueAtTime(0.45, when + Math.max(0.04, gate * 0.45));
  out.gain.exponentialRampToValueAtTime(0.0001, when + gate);
  partials.forEach(o => { try { o.stop(when + gate + 0.05); } catch (_) {} });
  return {
    out, partials,
    stop() {
      const t = ac.currentTime;
      try {
        out.gain.cancelScheduledValues(t);
        out.gain.setValueAtTime(Math.max(0.0001, out.gain.value), t);
        out.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
      } catch (_) {}
      partials.forEach(o => { try { o.stop(t + 0.05); } catch (_) {} });
    }
  };
}

function startChord(deg, fromLoop = false, { latched = false } = {}) {
  if (!ac) return;
  // Silent replace: don't record a false off or tear down the arp interval mid-hold
  if (state.held.has(deg)) {
    const prev = state.held.get(deg);
    prev.voices.forEach(x => x.stop());
    state.held.delete(deg);
  }
  const { notes, label } = chordMidi(deg);
  // With ARP on, don't stack a sustained chord under the arp — the arp IS the sound
  const voices = state.arp ? [] : notes.map(n => makeVoice(n));
  state.held.set(deg, { voices, label, notes, t0: ac.currentTime, fromLoop: !!fromLoop, latched: !!latched });
  paintKey(deg, true, label);
  if (state.arp) ensureArp();
  if (state.loop.rec && !fromLoop) recordEvent('on', deg);
  refreshReadout();
}
function stopChord(deg, fromLoop = false) {
  const v = state.held.get(deg);
  if (!v) return;
  v.voices.forEach(x => x.stop());
  state.held.delete(deg);
  if (state.latchedDeg === deg) state.latchedDeg = null;
  paintKey(deg, false);
  if (state.loop.rec && !fromLoop) recordEvent('off', deg);
  if (!state.held.size) stopArp();
  refreshReadout();
}

/* ---------- arp ---------- */
let arpNoteTimers = [];
let arpStepIndex = 0;
let arpNextAt = 0; // audio-time scheduler (survives timer throttling better while page is open)
function stopArpNotes() {
  for (const { id, voice } of arpNoteTimers) { clearTimeout(id); try { voice.stop(); } catch (_) {} }
  arpNoteTimers = [];
}
function stopArp() {
  if (arpTimer) { clearInterval(arpTimer); arpTimer = null; }
  stopArpNotes();
  arpNextAt = 0;
}
function arpStepMs() { return (60 / state.bpm) * 1000 / 2; } // 8th notes
function ensureArp() {
  if (!state.arp) return;
  if (arpTimer) return; // already running — keep cycling
  state.arpFires = state.arpFires || 0;
  arpStepIndex = 0;
  arpNextAt = 0;
  const fireOne = (when, stepMs) => {
    const entries = [...state.held.values()];
    const all = entries.flatMap(e => e.notes);
    if (!all.length) return;
    const n = all[arpStepIndex % all.length];
    const v = makeArpVoice(n, stepMs, when);
    state.arpFires++;
    arpStepIndex++;
    const id = setTimeout(() => { arpNoteTimers = arpNoteTimers.filter(x => x.id !== id); }, stepMs + 80);
    arpNoteTimers.push({ id, voice: v });
  };
  const tick = () => {
    if (!state.arp || !state.held.size) { stopArp(); return; }
    if (!ac) return;
    const stepMs = arpStepMs();
    const now = ac.currentTime;
    if (!arpNextAt || arpNextAt < now - 0.2) arpNextAt = now;
    let guard = 0;
    while (arpNextAt <= now + 0.025 && guard++ < 3) {
      fireOne(Math.max(arpNextAt, now), stepMs);
      arpNextAt += stepMs / 1000;
    }
  };
  tick();
  // Poll often; audio clock decides when a step is due (one note per step, not per poll)
  arpTimer = setInterval(tick, 30);
}

/* ---------- XY pad ---------- */
function setXy(nx, ny, held) {
  state.xy.x = Math.max(-1, Math.min(1, nx));
  state.xy.y = Math.max(-1, Math.min(1, ny));
  state.xy.held = held;
  const k = $('#xyKnob');
  const px = state.xy.x * 28, py = -state.xy.y * 28;
  k.style.transform = `translate(calc(-50% + ${px}%), calc(-50% + ${py}%))`;
  if (ac && filter) {
    // filter: center open, edges darker; also Y opens a bit
    const r = Math.hypot(state.xy.x, state.xy.y);
    const open = held ? 900 + (1 - r) * 9000 + Math.max(0, state.xy.y) * 3000 : 12000;
    filter.frequency.setTargetAtTime(open, ac.currentTime, 0.05);
  }
  if (held) {
    for (const deg of [...state.held.keys()]) {
      const prev = state.held.get(deg);
      const next = chordMidi(deg);
      paintKey(deg, true, next.label);
      if (prev && prev.notes.join() !== next.notes.join()) startChord(deg); // revoice
    }
  }
}
function bindXy() {
  const el = $('#xy');
  const pt = (e) => {
    const r = el.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    const x = ((t.clientX - r.left) / r.width) * 2 - 1;
    const y = -(((t.clientY - r.top) / r.height) * 2 - 1);
    return [x, y];
  };
  let xyPtr = null;
  const down = (e) => {
    e.preventDefault(); resume(); xyPtr = e.pointerId;
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
    const [x, y] = pt(e); setXy(x, y, true);
  };
  const move = (e) => {
    if (!state.xy.held || (xyPtr != null && e.pointerId !== xyPtr)) return;
    e.preventDefault(); const [x, y] = pt(e); setXy(x, y, true);
  };
  const up = (e) => {
    if (xyPtr != null && e.pointerId !== xyPtr) return;
    e.preventDefault(); xyPtr = null; setXy(0, 0, false);
  };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', (e) => { if (e.buttons & 1) { e.preventDefault(); return; } up(e); });
  // Keep morphing if the finger slides off the pad while captured
  el.addEventListener('pointerleave', e => e.preventDefault());
  el.addEventListener('lostpointercapture', e => { if (xyPtr === e.pointerId && !(e.buttons & 1)) up(e); });
  el.addEventListener('contextmenu', e => e.preventDefault());
  el.addEventListener('touchstart', e => e.preventDefault(), { passive: false });
}


/* ---------- loop / metro ---------- */
function barMs() { return (60 / state.bpm) * 1000 * 4; }
function recordEvent(type, deg) {
  const L = state.loop;
  if (!L.rec) return;
  const t = performance.now();
  if (!L.start) L.start = t;
  const at = (t - L.start) % (L.len || barMs());
  L.events.push({ type, deg, at });
}
function cancelLoopSched() {
  for (const id of loopTimeouts) clearTimeout(id);
  loopTimeouts = [];
}
function silenceLoopVoices() {
  for (const [deg, v] of [...state.held.entries()]) {
    if (v.fromLoop) stopChord(deg, true);
  }
  stopArpNotes();
}
function silenceAllVoices() {
  for (const deg of [...state.held.keys()]) stopChord(deg, true);
  stopArp();
}
function startMetro() {
  stopMetro(); // always replace — avoids duplicate intervals if Rec/Play/Met race
  beat = 0;
  const tick = () => {
    paintBeat(beat);
    if (state.met && ac) click(beat === 0);
    if (state.loop.playing) playLoopBeat(beat);
    beat = (beat + 1) % 4;
  };
  tick();
  metroTimer = setInterval(tick, (60 / state.bpm) * 1000);
}
function stopMetro() {
  if (metroTimer) { clearInterval(metroTimer); metroTimer = null; }
  paintBeat(-1);
}
function click(accent) {
  const t = ac.currentTime;
  const o = ac.createOscillator(); o.type = 'square';
  o.frequency.setValueAtTime(accent ? 1200 : 800, t);
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(accent ? 0.2 : 0.1, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
  o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.08);
}
function paintBeat(i) {
  $$('#beats i').forEach((el, n) => {
    el.classList.toggle('on', n === i);
    el.classList.toggle('accent', n === i && i === 0);
  });
}
function playLoopBeat(b) {
  if (b !== 0) return;
  const L = state.loop;
  if (!L.playing || !L.events.length) return;
  const len = L.len || barMs();
  cancelLoopSched(); // one bar schedule at a time — no stacked duplicates
  L.events.forEach(ev => {
    const id = setTimeout(() => {
      loopTimeouts = loopTimeouts.filter(x => x !== id);
      if (!state.loop.playing) return;
      if (ev.type === 'on') startChord(ev.deg, true);
      else stopChord(ev.deg, true);
    }, ev.at % len);
    loopTimeouts.push(id);
  });
}
function syncLoopButtons() {
  const L = state.loop;
  $('#btnRec').setAttribute('aria-pressed', String(!!L.rec));
  $('#btnPlayLoop').setAttribute('aria-pressed', String(!!L.playing));
  $('#btnPlayLoop').textContent = L.playing ? '■' : '▶';
}
function stopLoopPlayback({ keepMet = false } = {}) {
  state.loop.playing = false;
  state.loop.rec = false;
  cancelLoopSched();
  silenceLoopVoices();
  syncLoopButtons();
  if (!keepMet && !state.met) stopMetro();
}
function toggleRec() {
  const L = state.loop;
  if (L.rec) {
    // arm off — keep playing if there are events, else just stop recording
    L.rec = false;
    syncLoopButtons();
    return;
  }
  L.rec = true;
  if (!L.len) L.len = barMs();
  if (!L.start) L.start = performance.now();
  L.playing = true; // overdub while the bar runs
  if (!state.met) { state.met = true; $('#btnMet').setAttribute('aria-pressed', 'true'); }
  startMetro(); // fresh single interval
  syncLoopButtons();
}
function toggleLoopPlay() {
  const L = state.loop;
  if (L.playing) {
    // ▶ / ■ stops playback immediately (and recording arm)
    stopLoopPlayback({ keepMet: state.met });
    return;
  }
  if (!L.events.length) return; // nothing to play
  L.playing = true;
  L.rec = false;
  syncLoopButtons();
  startMetro();
}
function clearLoop() {
  // CLR: hard stop — cancel timers, silence loop (+ arp) voices, wipe data, reset buttons
  state.loop.playing = false;
  state.loop.rec = false;
  state.loop.events = [];
  state.loop.start = 0;
  state.loop.len = 0;
  cancelLoopSched();
  keyPointers.clear();
  state.latchedDeg = null;
  silenceAllVoices();
  syncLoopButtons();
  if (state.met) {
    // metronome alone may keep clicking; ensure only one metro interval
    startMetro();
  } else {
    stopMetro();
  }
}

/* ---------- UI: keys ---------- */
// Active pointer ids per degree — sustains across Android long-press / scroll attempts
const keyPointers = new Map(); // deg -> Set<pointerId>

function activeIds(deg) {
  if (!keyPointers.has(deg)) keyPointers.set(deg, new Set());
  return keyPointers.get(deg);
}
function keyIsDown(deg) { return (keyPointers.get(deg)?.size || 0) > 0 || state.latchedDeg === deg; }

/** Latch: tap toggles; tapping another key switches; HOLD off releases. */
let lastLatchAt = 0;
function tapLatch(deg) {
  // Pointer + Touch both fire on Android/Chrome — debounce so one tap ≠ on then off
  const now = performance.now();
  if (now - lastLatchAt < 80) return;
  lastLatchAt = now;
  resume();
  if (state.latchedDeg === deg) {
    keyPointers.delete(deg);
    stopChord(deg);
    state.latchedDeg = null;
    return;
  }
  if (state.latchedDeg != null && state.latchedDeg !== deg) {
    const prev = state.latchedDeg;
    keyPointers.delete(prev);
    stopChord(prev);
  }
  state.latchedDeg = deg;
  startChord(deg, false, { latched: true });
}

function bindKeyPointer(btn, deg) {
  // Track both pointerIds and touch identifiers. Android long-press fires pointercancel with
  // buttons=0 while the finger is still down — we IGNORE cancel and only release on real up/end.
  const addId = (id) => {
    const ids = activeIds(deg);
    const first = ids.size === 0 && state.latchedDeg !== deg;
    ids.add(id);
    return first;
  };
  const removeId = (id) => {
    const ids = keyPointers.get(deg);
    if (!ids || !ids.has(id)) return false;
    ids.delete(id);
    if (ids.size === 0) keyPointers.delete(deg);
    return !keyIsDown(deg);
  };

  const pointerDown = (e) => {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault(); e.stopPropagation(); resume();
    if (state.latch) {
      // debounce: latch uses click-like gesture; ignore extra pointers while switching
      if (e.pointerType === 'touch' && btn._latchTouched) return;
      tapLatch(deg);
      return;
    }
    try { btn.setPointerCapture(e.pointerId); } catch (_) {}
    if (addId('p' + e.pointerId)) startChord(deg);
  };
  const pointerUp = (e) => {
    e.preventDefault();
    if (state.latch) return; // latched chords ignore finger-up
    try { if (btn.hasPointerCapture?.(e.pointerId)) btn.releasePointerCapture(e.pointerId); } catch (_) {}
    if (removeId('p' + e.pointerId)) stopChord(deg);
  };

  btn.addEventListener('pointerdown', pointerDown);
  btn.addEventListener('pointerup', pointerUp);
  // Critical: do NOT stop on pointercancel / lostpointercapture — Android long-press noise
  btn.addEventListener('pointercancel', e => { e.preventDefault(); });
  btn.addEventListener('lostpointercapture', e => { e.preventDefault(); });
  btn.addEventListener('pointerleave', e => { e.preventDefault(); });
  btn.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); });

  // Touch Events fallback (and dual-track so cancel of the pointer doesn't end the note)
  btn.addEventListener('touchstart', (e) => {
    e.preventDefault(); e.stopPropagation(); resume();
    if (state.latch) {
      btn._latchTouched = true;
      tapLatch(deg);
      setTimeout(() => { btn._latchTouched = false; }, 50);
      return;
    }
    for (const t of e.changedTouches) {
      if (addId('t' + t.identifier)) startChord(deg);
    }
  }, { passive: false });
  btn.addEventListener('touchend', (e) => {
    e.preventDefault();
    if (state.latch) return;
    for (const t of e.changedTouches) {
      if (removeId('t' + t.identifier)) stopChord(deg);
    }
  }, { passive: false });
  // Ignore touchcancel for the same reason as pointercancel (long-press / system gesture)
  btn.addEventListener('touchcancel', (e) => { e.preventDefault(); }, { passive: false });
}

function scaleLabels() {
  return state.scale === 'minor' ? DEG_LABELS_MIN : DEG_LABELS;
}
function noteName(midi) {
  return NOTE_NAMES[((midi % 12) + 12) % 12];
}
function buildKeys() {
  const root = $('#keys');
  root.innerHTML = '';
  const labs = scaleLabels();
  for (let deg = 0; deg < 7; deg++) {
    const q = baseQuality(deg);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'key' + (q === 'm' ? ' minor' : q === 'dim' ? ' dim' : '');
    btn.dataset.deg = deg;
    btn.innerHTML = `<span class="deg">${labs[deg]}</span><span class="nm">${noteName(degreeRoot(deg))}</span><span class="ql">${q || 'maj'}</span>`;
    // Multitouch hold: capture the pointer, ignore leave/lost-capture noise (Android long-press),
    // and only release when THIS pointer goes up. Spurious pointercancel from a blocked context
    // menu is ignored while the pointer is still in our active set and buttons are down.
    bindKeyPointer(btn, deg);
    root.appendChild(btn);
  }
}
function paintKey(deg, on, label) {
  const btn = $(`.key[data-deg="${deg}"]`);
  if (!btn) return;
  btn.classList.toggle('on', on);
  if (label != null) btn.querySelector('.ql').textContent = label || 'maj';
  else btn.querySelector('.ql').textContent = baseQuality(deg) || 'maj';
}

function refreshReadout() {
  const key = NOTE_NAMES[state.key];
  const scale = state.scale;
  const snd = { pad: 'Pad', keys: 'Keys', pluck: 'Pluck', organ: 'Organ' }[state.sound];
  const held = [...state.held.entries()].map(([d, v]) => noteName(degreeRoot(d)) + v.label).join(' · ');
  $('#readout').textContent = held || `${key} ${scale} · oct ${state.octave} · ${snd}`;
  $('#keyLbl').textContent = key + (scale === 'minor' ? 'm' : '');
  $('#octLbl').textContent = state.octave;
  $('#sndLbl').textContent = snd;
  $('#arpLbl').textContent = state.arp ? 'On' : 'Off';
  if ($('#latchLbl')) $('#latchLbl').textContent = state.latch ? 'On' : 'Off';
  $('#bpmLbl').textContent = state.bpm;
  $('#ver').textContent = VER;
}

/* ---------- pickers ---------- */
function fillKeyGrid() {
  const g = $('#keyGrid');
  g.innerHTML = '';
  NOTE_NAMES.forEach((n, i) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = n;
    if (i === state.key) b.classList.add('on');
    b.onclick = () => {
      state.key = i;
      $$('#keyGrid button').forEach(x => x.classList.toggle('on', x === b));
      rebuild();
    };
    g.appendChild(b);
  });
  $$('#scaleSeg button').forEach(b => {
    b.classList.toggle('on', b.dataset.scale === state.scale);
    b.onclick = (e) => {
      e.preventDefault();
      state.scale = b.dataset.scale;
      $$('#scaleSeg button').forEach(x => x.classList.toggle('on', x === b));
      rebuild();
      $('#dlgKey').close();
    };
  });
}
function rebuild() {
  // release held
  [...state.held.keys()].forEach(stopChord);
  buildKeys();
  refreshReadout();
}

/* ---------- wire controls ---------- */
function wire() {
  $('#btnKey').onclick = () => { fillKeyGrid(); $('#dlgKey').showModal(); };
  $('#btnOct').onclick = () => {
    state.octave = state.octave >= 5 ? 2 : state.octave + 1;
    rebuild();
  };
  $('#btnSound').onclick = () => {
    $$('#sndSeg button').forEach(b => b.classList.toggle('on', b.dataset.snd === state.sound));
    $('#dlgSound').showModal();
  };
  $$('#sndSeg button').forEach(b => b.onclick = (e) => {
    e.preventDefault();
    state.sound = b.dataset.snd;
    refreshReadout();
    $('#dlgSound').close();
  });
    $('#btnArp').onclick = () => {
    state.arp = !state.arp;
    $('#btnArp').setAttribute('aria-pressed', String(state.arp));
    if (!state.arp) {
      stopArp();
      // restore sustained voices under any held/latched chords
      for (const deg of [...state.held.keys()]) {
        const h = state.held.get(deg);
        startChord(deg, h.fromLoop, { latched: !!h.latched });
      }
    } else {
      // switch held chords to arp-only voices
      stopArp();
      for (const deg of [...state.held.keys()]) {
        const h = state.held.get(deg);
        startChord(deg, h.fromLoop, { latched: !!h.latched });
      }
      if (state.held.size) ensureArp();
    }
    refreshReadout();
  };
  $('#btnLatch').onclick = () => {
    state.latch = !state.latch;
    $('#btnLatch').setAttribute('aria-pressed', String(state.latch));
    if (!state.latch && state.latchedDeg != null) {
      const d = state.latchedDeg;
      state.latchedDeg = null;
      keyPointers.delete(d);
      stopChord(d);
    }
    refreshReadout();
  };
  $('#btnTempo').onclick = () => {
    const opts = [72, 84, 96, 110, 120, 140];
    const i = opts.indexOf(state.bpm);
    state.bpm = opts[(i + 1) % opts.length];
    if (state.fx === 'echo' && ac) delay.delayTime.setTargetAtTime(60 / state.bpm, ac.currentTime, 0.05);
    if (metroTimer) startMetro();
    if (arpTimer) { stopArp(); if (state.arp) ensureArp(); }
    if (state.loop.len) state.loop.len = barMs();
    refreshReadout();
  };
  $('#btnFx').onclick = () => {
    $$('#fxSeg button').forEach(b => b.classList.toggle('on', b.dataset.fx === state.fx));
    $('#dlgFx').showModal();
  };
  $$('#fxSeg button').forEach(b => b.onclick = (e) => {
    e.preventDefault();
    applyFx(b.dataset.fx);
    $('#dlgFx').close();
  });
  $('#btnMet').onclick = () => {
    state.met = !state.met;
    $('#btnMet').setAttribute('aria-pressed', String(state.met));
    if (state.met) { resume(); startMetro(); }
    else if (!state.loop.playing && !state.loop.rec) stopMetro();
  };
  $('#btnRec').onclick = () => { resume(); toggleRec(); };
  $('#btnPlayLoop').onclick = () => { resume(); toggleLoopPlay(); };
  $('#btnClear').onclick = () => clearLoop();
  bindXy();
  // Kill long-press callouts / selection / synthetic cancels across the instrument
  const unit = $('#unit');
  unit.addEventListener('contextmenu', e => e.preventDefault());
  unit.addEventListener('selectstart', e => e.preventDefault());
  unit.addEventListener('dragstart', e => e.preventDefault());
  document.addEventListener('gesturestart', e => e.preventDefault());
}

/* ---------- boot ---------- */
async function boot() {
  await resume();
  // silent buffer to unlock iOS
  const b = ac.createBuffer(1, 1, ac.sampleRate);
  const s = ac.createBufferSource(); s.buffer = b; s.connect(ac.destination); s.start(0);
  $('#gate').hidden = true;
  rebuild();
  refreshReadout();
}
$('#startBtn').addEventListener('pointerdown', (e) => { e.preventDefault(); boot(); });
$('#startBtn').addEventListener('click', () => boot());

wire();
buildKeys();
refreshReadout();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js');
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) nw.postMessage('skipWaiting');
        });
      });
      // Poll for updates when the app becomes visible again (Android often keeps the old SW)
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
      setInterval(() => reg.update().catch(() => {}), 60_000);
    } catch (_) {}
  });
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    location.reload();
  });
}

// test hooks
window.Chordbox = {
  VER, state, unlock, resume, startChord, stopChord, chordMidi, degreeRoot,
  clearLoop, stopLoopPlayback, cancelLoopSched, silenceAllVoices, toggleLoopPlay, toggleRec,
  get ctx() { return ac; },
  get filter() { return filter; },
  get held() { return state.held; },
  get loopTimeouts() { return loopTimeouts; },
  get metroTimer() { return metroTimer; },
  get arpTimer() { return arpTimer; },
  get keyPointers() { return keyPointers; },
  tapLatch, ensureArp, stopArp, makeArpVoice, arpStepMs,
  setLatch(v) { state.latch = !!v; $('#btnLatch')?.setAttribute('aria-pressed', String(state.latch)); refreshReadout(); },
  pressKey: (deg, pid=1) => { const b = document.querySelector(`.key[data-deg="${deg}"]`); if (!b) return; b.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true, pointerId:pid, pointerType:'touch', buttons:1, button:0, cancelable:true })); },
  releaseKey: (deg, pid=1) => { const b = document.querySelector(`.key[data-deg="${deg}"]`); if (!b) return; b.dispatchEvent(new PointerEvent('pointerup', { bubbles:true, pointerId:pid, pointerType:'touch', buttons:0, button:0, cancelable:true })); },
  touchKey: (deg, id=1) => { const b = document.querySelector(`.key[data-deg="${deg}"]`); if (!b) return;
    const t = { identifier: id, clientX: 0, clientY: 0, force: 1, pageX: 0, pageY: 0, radiusX: 1, radiusY: 1, rotationAngle: 0, screenX: 0, screenY: 0, target: b };
    const ev = new Event('touchstart', { bubbles:true, cancelable:true });
    Object.defineProperty(ev, 'changedTouches', { get: () => [t] });
    Object.defineProperty(ev, 'touches', { get: () => [t] });
    b.dispatchEvent(ev);
  },
  untouchKey: (deg, id=1) => { const b = document.querySelector(`.key[data-deg="${deg}"]`); if (!b) return;
    const t = { identifier: id, clientX: 0, clientY: 0, force: 0, pageX: 0, pageY: 0, radiusX: 1, radiusY: 1, rotationAngle: 0, screenX: 0, screenY: 0, target: b };
    const ev = new Event('touchend', { bubbles:true, cancelable:true });
    Object.defineProperty(ev, 'changedTouches', { get: () => [t] });
    Object.defineProperty(ev, 'touches', { get: () => [] });
    b.dispatchEvent(ev);
  },
};
