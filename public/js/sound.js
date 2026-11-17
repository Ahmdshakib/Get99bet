// Original synthesized sound effects (Web Audio API) - no audio files, nothing copied from anywhere.

let ctx = null;
let master = null;
let muted = false;
let engine = null;
let unlocked = false; // browsers only allow audio after a user gesture; never create the context earlier

try {
  muted = localStorage.getItem('g99_muted') === '1';
} catch {
  /* ignore */
}

function ensure() {
  if (ctx) return ctx;
  if (!unlocked) return null;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = muted ? 0 : 0.5;
  master.connect(ctx.destination);
  return ctx;
}

/** Call from a user gesture (click / key) so browsers allow audio. */
export function unlock() {
  unlocked = true;
  const c = ensure();
  if (c && c.state === 'suspended') c.resume().catch(() => {});
}

export function isMuted() {
  return muted;
}

export function setMuted(m) {
  muted = m;
  try {
    localStorage.setItem('g99_muted', m ? '1' : '0');
  } catch {
    /* ignore */
  }
  if (master) master.gain.value = m ? 0 : 0.5;
  if (m) engineStop();
}

function tone({ freq, type = 'sine', dur = 0.12, gain = 0.25, when = 0, slideTo }) {
  const c = ensure();
  if (!c || muted) return;
  const t0 = c.currentTime + when;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(master);
  o.start(t0);
  o.stop(t0 + dur + 0.02);
}

function noise(dur, { gain = 0.3, from = 2000, to = 200 } = {}) {
  const c = ensure();
  if (!c || muted) return;
  const len = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = buf;
  const f = c.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.setValueAtTime(from, c.currentTime);
  f.frequency.exponentialRampToValueAtTime(to, c.currentTime + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(gain, c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
  src.connect(f).connect(g).connect(master);
  src.start();
}

export const sfx = {
  bet() {
    tone({ freq: 520, type: 'square', dur: 0.07, gain: 0.12 });
    tone({ freq: 780, type: 'square', dur: 0.09, gain: 0.1, when: 0.06 });
  },
  tick() {
    tone({ freq: 900, type: 'sine', dur: 0.05, gain: 0.08 });
  },
  cashout() {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone({ freq: f, type: 'triangle', dur: 0.18, gain: 0.22, when: i * 0.07 }));
  },
  crash() {
    noise(0.7, { gain: 0.45, from: 3000, to: 120 });
    tone({ freq: 140, type: 'sawtooth', dur: 0.6, gain: 0.25, slideTo: 40 });
  },
  error() {
    tone({ freq: 220, type: 'square', dur: 0.12, gain: 0.1 });
  },
};

export function engineStart() {
  const c = ensure();
  if (!c || muted || engine) return;
  const o = c.createOscillator();
  o.type = 'sawtooth';
  o.frequency.value = 70;
  const f = c.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = 400;
  const g = c.createGain();
  g.gain.value = 0.0001;
  g.gain.exponentialRampToValueAtTime(0.07, c.currentTime + 0.4);
  o.connect(f).connect(g).connect(master);
  o.start();
  engine = { o, f, g };
}

/** Pitch and brightness rise with the multiplier. */
export function engineUpdate(multiplier) {
  if (!engine || !ctx) return;
  const m = Math.max(1, multiplier);
  const p = Math.log(m);
  engine.o.frequency.setTargetAtTime(70 + p * 55, ctx.currentTime, 0.1);
  engine.f.frequency.setTargetAtTime(400 + p * 500, ctx.currentTime, 0.1);
}

export function engineStop() {
  if (!engine || !ctx) return;
  const { o, g } = engine;
  engine = null;
  try {
    g.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.05);
    o.stop(ctx.currentTime + 0.3);
  } catch {
    /* already stopped */
  }
}
