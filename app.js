/* Chordbox v1.0 — original pocket chord synth (Web Audio). Offline PWA. */
'use strict';
const VER = 'v1.0';
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
  met: false,
  xy: { x: 0, y: 0, held: false }, // -1..1
  held: new Map(),  // degree -> voice
  loop: { rec: false, playing: false, events: [], start: 0, len: 0 },
};

let ac = null, master = null, filter = null, fxGain = null, dryGain = null, convolver = null, delay = null, delayGain = null, analyser = null;
let metroTimer = null, loopTimer = null, arpTimer = null, beat = 0;

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

function startChord(deg, fromLoop = false) {
  if (!ac) return;
  if (state.held.has(deg)) stopChord(deg);
  const { notes, label } = chordMidi(deg);
  const voices = notes.map(n => makeVoice(n));
  state.held.set(deg, { voices, label, notes, t0: ac.currentTime });
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
  paintKey(deg, false);
  if (state.loop.rec && !fromLoop) recordEvent('off', deg);
  if (!state.held.size && arpTimer) { clearInterval(arpTimer); arpTimer = null; }
}

/* ---------- arp ---------- */
function ensureArp() {
  if (arpTimer || !state.arp) return;
  let i = 0;
  const step = () => {
    if (!state.arp || !state.held.size) { clearInterval(arpTimer); arpTimer = null; return; }
    const entries = [...state.held.values()];
    const all = entries.flatMap(e => e.notes);
    if (!all.length) return;
    const n = all[i % all.length];
    const v = makeVoice(n);
    setTimeout(() => v.stop(), Math.max(80, (60 / state.bpm) * 1000 * 0.35));
    i++;
  };
  step();
  arpTimer = setInterval(step, (60 / state.bpm) * 1000 / 2);
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
  const down = (e) => { e.preventDefault(); resume(); const [x, y] = pt(e); setXy(x, y, true); };
  const move = (e) => { if (!state.xy.held) return; e.preventDefault(); const [x, y] = pt(e); setXy(x, y, true); };
  const up = (e) => { e.preventDefault(); setXy(0, 0, false); };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('pointerleave', (e) => { if (e.buttons === 0) up(e); });
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
function startMetro() {
  stopMetro();
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
  if (metroTimer) clearInterval(metroTimer);
  metroTimer = null;
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
  // scheduled via events relative to bar; on beat 0 restart scan
  if (b !== 0) return;
  const L = state.loop;
  if (!L.events.length) return;
  const len = L.len || barMs();
  // clear currently sounding loop voices first? keep live held; only fire recorded
  L.events.forEach(ev => {
    setTimeout(() => {
      if (!state.loop.playing) return;
      if (ev.type === 'on') startChord(ev.deg, true);
      else stopChord(ev.deg, true);
    }, ev.at % len);
  });
}
function toggleRec() {
  const L = state.loop;
  L.rec = !L.rec;
  $('#btnRec').setAttribute('aria-pressed', String(L.rec));
  if (L.rec) {
    if (!L.len) L.len = barMs();
    if (!L.start) L.start = performance.now();
    if (!state.met && !metroTimer) { state.met = true; $('#btnMet').setAttribute('aria-pressed', 'true'); startMetro(); }
    if (!L.playing) { L.playing = true; $('#btnPlayLoop').setAttribute('aria-pressed', 'true'); }
  }
}
function toggleLoopPlay() {
  const L = state.loop;
  L.playing = !L.playing;
  $('#btnPlayLoop').setAttribute('aria-pressed', String(L.playing));
  $('#btnPlayLoop').textContent = L.playing ? '■' : '▶';
  if (L.playing) {
    if (!metroTimer) startMetro();
  } else if (!state.met && !L.rec) stopMetro();
}
function clearLoop() {
  state.loop.events = [];
  state.loop.start = 0;
  state.loop.rec = false;
  state.loop.playing = false;
  $('#btnRec').setAttribute('aria-pressed', 'false');
  $('#btnPlayLoop').setAttribute('aria-pressed', 'false');
  $('#btnPlayLoop').textContent = '▶';
  if (!state.met) stopMetro();
}

/* ---------- UI: keys ---------- */
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
    // multitouch via pointer events with setPointerCapture
    btn.addEventListener('pointerdown', e => {
      e.preventDefault();
      resume();
      try { btn.setPointerCapture(e.pointerId); } catch (_) {}
      startChord(deg);
    });
    btn.addEventListener('pointerup', e => { e.preventDefault(); stopChord(deg); });
    btn.addEventListener('pointercancel', e => { e.preventDefault(); stopChord(deg); });
    btn.addEventListener('lostpointercapture', () => stopChord(deg));
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
    if (state.arp && state.held.size) ensureArp();
    if (!state.arp && arpTimer) { clearInterval(arpTimer); arpTimer = null; }
    refreshReadout();
  };
  $('#btnTempo').onclick = () => {
    const opts = [72, 84, 96, 110, 120, 140];
    const i = opts.indexOf(state.bpm);
    state.bpm = opts[(i + 1) % opts.length];
    if (state.fx === 'echo' && ac) delay.delayTime.setTargetAtTime(60 / state.bpm, ac.currentTime, 0.05);
    if (metroTimer) startMetro();
    if (arpTimer) { clearInterval(arpTimer); arpTimer = null; if (state.arp) ensureArp(); }
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
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

// test hooks
window.Chordbox = {
  VER, state, unlock, resume, startChord, stopChord, chordMidi, degreeRoot,
  get ctx() { return ac; },
  get filter() { return filter; },
  get held() { return state.held; },
};
