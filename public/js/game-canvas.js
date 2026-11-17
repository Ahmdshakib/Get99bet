// Canvas renderer for the crash stage. Everything is drawn procedurally (original artwork):
// parallax starfield, glowing multiplier curve, rocket sprite, flame particles and a crash explosion.

const ACCENT = '#22e3a4';
const BLUE = '#3aa0ff';
const DANGER = '#ff5470';

const NICE = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000];

function niceStep(range, target) {
  const raw = range / target;
  return NICE.find((n) => n >= raw) || NICE[NICE.length - 1];
}

export class CrashCanvas {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {() => number} serverNow  returns the estimated server time in ms
   */
  constructor(canvas, serverNow) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.now = serverNow;
    this.dpr = 1;
    this.w = 0;
    this.h = 0;
    this.phase = 'idle'; // idle | betting | running | crashed
    this.startedAt = 0;
    this.bettingEndsAt = 0;
    this.bettingMs = 8000;
    this.rate = 0.00008;
    this.crashX100 = 0;
    this.finalT = 0;
    this.particles = [];
    this.shock = null;
    this.stars = Array.from({ length: 70 }, () => ({ x: Math.random(), y: Math.random(), z: 0.2 + Math.random() * 0.8 }));
    this.last = performance.now();
    this.mult = 1;
    this.onFrame = null;
    this.reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    this.tip = { x: 0, y: 0, angle: -0.5 };
    this._raf = 0;

    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(canvas.parentElement || canvas);
    this.resize();
  }

  setRound({ phase, startedAt, bettingEndsAt, bettingMs, growthRate, crashX100 }) {
    const prev = this.phase;
    if (growthRate) this.rate = growthRate;
    if (bettingMs) this.bettingMs = bettingMs;
    if (startedAt !== undefined) this.startedAt = startedAt;
    if (bettingEndsAt !== undefined) this.bettingEndsAt = bettingEndsAt;
    if (phase === 'crashed') {
      this.crashX100 = crashX100 || this.crashX100;
      this.finalT = Math.log(Math.max(100, this.crashX100) / 100) / this.rate;
      if (prev === 'running') this._explode();
    }
    if (phase === 'betting') {
      this.particles.length = 0;
      this.shock = null;
    }
    this.phase = phase;
  }

  start() {
    const loop = (t) => {
      this._frame(t);
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this._raf);
    this._ro.disconnect();
  }

  resize() {
    const p = this.canvas.parentElement || this.canvas;
    const r = p.getBoundingClientRect();
    const w = Math.max(200, Math.floor(r.width));
    const h = Math.max(160, Math.floor(r.height));
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.canvas.width = Math.floor(w * this.dpr);
    this.canvas.height = Math.floor(h * this.dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.w = w;
    this.h = h;
  }

  currentMultiplier() {
    return this.mult;
  }

  // ----------------------------------------------------------------- frame

  _frame(now) {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);

    let t = 0;
    if (this.phase === 'running') t = Math.max(0, this.now() - this.startedAt);
    else if (this.phase === 'crashed') t = this.finalT;
    this.mult = this.phase === 'crashed' ? this.crashX100 / 100 : Math.max(1, Math.floor(100 * Math.exp(this.rate * t)) / 100);

    const small = this.w < 520;
    const pad = small ? { l: 38, r: 12, t: 12, b: 26 } : { l: 52, r: 20, t: 18, b: 32 };
    const W = this.w - pad.l - pad.r;
    const H = this.h - pad.t - pad.b;
    const tMax = Math.max(10000, t * 1.12);
    const mMax = Math.max(2, Math.exp(this.rate * t) * 1.18);
    const xOf = (tt) => pad.l + (tt / tMax) * W;
    const yOf = (m) => pad.t + H - ((m - 1) / (mMax - 1)) * H;

    this._background(dt, W, H, pad);
    this._grid(pad, W, H, tMax, mMax, xOf, yOf, small);

    const size = Math.max(20, Math.min(42, Math.min(this.w, this.h) * 0.095));

    if (this.phase === 'running' || this.phase === 'crashed') {
      this._curve(t, xOf, yOf, pad, H, W);
      if (this.phase === 'running') {
        this._drawRocket(dt, size, true);
      }
    } else {
      // Waiting on the launch pad.
      this.tip = { x: pad.l + size * 1.1, y: pad.t + H - size * 0.9, angle: -0.62 };
      this._drawRocket(dt, size, false);
      this._countdown(pad, W, H);
    }
    this._effects(dt);
    if (this.onFrame) this.onFrame(this.mult, this.phase);
  }

  _background(dt, W, H, pad) {
    const ctx = this.ctx;
    const g = ctx.createLinearGradient(0, 0, 0, this.h);
    g.addColorStop(0, '#0c1428');
    g.addColorStop(1, '#070b15');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.w, this.h);

    const glow = ctx.createRadialGradient(pad.l, pad.t + H, 10, pad.l, pad.t + H, Math.max(W, H));
    glow.addColorStop(0, this.phase === 'crashed' ? 'rgba(255,84,112,0.12)' : 'rgba(34,227,164,0.10)');
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, this.w, this.h);

    const speed = this.reduced ? 0 : this.phase === 'running' ? 0.03 + Math.log(this.mult) * 0.05 : 0.004;
    ctx.fillStyle = '#cfe0ff';
    for (const s of this.stars) {
      s.x -= speed * s.z * dt;
      if (s.x < 0) {
        s.x += 1;
        s.y = Math.random();
      }
      ctx.globalAlpha = 0.25 + 0.5 * s.z;
      ctx.fillRect(s.x * this.w, s.y * this.h, s.z * 1.6, s.z * 1.6);
    }
    ctx.globalAlpha = 1;
  }

  _grid(pad, W, H, tMax, mMax, xOf, yOf, small) {
    const ctx = this.ctx;
    ctx.font = `${small ? 10 : 11}px system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(160,176,205,0.7)';
    ctx.strokeStyle = 'rgba(120,140,180,0.13)';
    ctx.lineWidth = 1;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    const step = niceStep(mMax - 1, small ? 3 : 4);
    for (let m = 1 + step; m < mMax; m += step) {
      const y = Math.round(yOf(m)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(pad.l + W, y);
      ctx.stroke();
      ctx.fillText(`${+m.toFixed(1)}×`, pad.l - 6, y);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const secs = tMax / 1000;
    const ts = niceStep(secs, small ? 3 : 5);
    for (let s = ts; s < secs; s += ts) {
      const x = Math.round(xOf(s * 1000)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, pad.t);
      ctx.lineTo(x, pad.t + H);
      ctx.stroke();
      ctx.fillText(`${s}s`, x, pad.t + H + 6);
    }
    ctx.strokeStyle = 'rgba(160,176,205,0.35)';
    ctx.beginPath();
    ctx.moveTo(pad.l + 0.5, pad.t);
    ctx.lineTo(pad.l + 0.5, pad.t + H + 0.5);
    ctx.lineTo(pad.l + W, pad.t + H + 0.5);
    ctx.stroke();
  }

  _curve(t, xOf, yOf, pad, H, W) {
    const ctx = this.ctx;
    const crashed = this.phase === 'crashed';
    const n = Math.max(30, Math.min(180, Math.floor(W / 4)));
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const tt = (t * i) / n;
      pts.push([xOf(tt), yOf(Math.exp(this.rate * tt))]);
    }
    const base = pad.t + H;
    // Filled area
    const fill = ctx.createLinearGradient(0, pad.t, 0, base);
    fill.addColorStop(0, crashed ? 'rgba(255,84,112,0.28)' : 'rgba(34,227,164,0.30)');
    fill.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.beginPath();
    ctx.moveTo(pts[0][0], base);
    pts.forEach(([x, y]) => ctx.lineTo(x, y));
    ctx.lineTo(pts[n][0], base);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    // Glowing line
    const line = ctx.createLinearGradient(pts[0][0], 0, pts[n][0], 0);
    line.addColorStop(0, crashed ? '#ff9aa9' : BLUE);
    line.addColorStop(1, crashed ? DANGER : ACCENT);
    ctx.save();
    ctx.shadowColor = crashed ? DANGER : ACCENT;
    ctx.shadowBlur = 14;
    ctx.lineWidth = 3.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = line;
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
    ctx.restore();

    const a = pts[Math.max(0, n - 3)];
    const b = pts[n];
    this.tip = { x: b[0], y: b[1], angle: Math.atan2(b[1] - a[1], b[0] - a[0]) };
  }

  // ---------------------------------------------------------------- rocket

  _drawRocket(dt, s, flying) {
    const { x, y, angle } = this.tip;
    const ctx = this.ctx;
    const flick = 0.75 + Math.random() * 0.5;
    const flameLen = (flying ? 1.5 : 0.55) * flick;

    if (!this.reduced) {
      const rate = flying ? 3 : 1;
      for (let i = 0; i < rate; i++) {
        const back = angle + Math.PI;
        const sp = 40 + Math.random() * 60;
        this.particles.push({
          x: x - Math.cos(angle) * s * 0.9,
          y: y - Math.sin(angle) * s * 0.9,
          vx: Math.cos(back) * sp + (Math.random() - 0.5) * 30,
          vy: Math.sin(back) * sp + (Math.random() - 0.5) * 30,
          life: 0,
          max: 0.35 + Math.random() * 0.3,
          r: s * (0.14 + Math.random() * 0.12),
          kind: 'flame',
        });
      }
    }

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);

    // Flame
    const fg = ctx.createLinearGradient(-s * 0.85, 0, -s * (0.85 + flameLen), 0);
    fg.addColorStop(0, 'rgba(255,230,120,0.95)');
    fg.addColorStop(0.45, 'rgba(255,140,60,0.8)');
    fg.addColorStop(1, 'rgba(255,60,60,0)');
    ctx.fillStyle = fg;
    ctx.beginPath();
    ctx.moveTo(-s * 0.85, -s * 0.15);
    ctx.quadraticCurveTo(-s * (0.85 + flameLen * 0.7), -s * 0.07, -s * (0.85 + flameLen), 0);
    ctx.quadraticCurveTo(-s * (0.85 + flameLen * 0.7), s * 0.07, -s * 0.85, s * 0.15);
    ctx.closePath();
    ctx.fill();

    // Fins
    ctx.fillStyle = BLUE;
    for (const sign of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(-s * 0.15, sign * s * 0.3);
      ctx.lineTo(-s * 0.78, sign * s * 0.78);
      ctx.lineTo(-s * 0.72, sign * s * 0.2);
      ctx.closePath();
      ctx.fill();
    }

    // Nozzle
    ctx.fillStyle = '#5b6785';
    ctx.fillRect(-s * 0.9, -s * 0.13, s * 0.17, s * 0.26);

    // Body
    const body = new Path2D();
    body.moveTo(s * 1.0, 0);
    body.bezierCurveTo(s * 0.6, -s * 0.4, s * 0.0, -s * 0.4, -s * 0.6, -s * 0.28);
    body.lineTo(-s * 0.75, -s * 0.2);
    body.lineTo(-s * 0.75, s * 0.2);
    body.lineTo(-s * 0.6, s * 0.28);
    body.bezierCurveTo(s * 0.0, s * 0.4, s * 0.6, s * 0.4, s * 1.0, 0);
    const bg = ctx.createLinearGradient(0, -s * 0.4, 0, s * 0.4);
    bg.addColorStop(0, '#ffffff');
    bg.addColorStop(0.55, '#d6e2fa');
    bg.addColorStop(1, '#8fa3cc');
    ctx.fillStyle = bg;
    ctx.fill(body);
    ctx.save();
    ctx.clip(body);
    ctx.fillStyle = ACCENT; // nose cone
    ctx.fillRect(s * 0.5, -s, s, s * 2);
    ctx.fillStyle = 'rgba(58,160,255,0.9)'; // stripe
    ctx.fillRect(-s * 0.38, -s, s * 0.1, s * 2);
    ctx.restore();

    // Window
    ctx.fillStyle = '#0b1224';
    ctx.beginPath();
    ctx.arc(s * 0.12, 0, s * 0.14, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#bcd0f5';
    ctx.lineWidth = Math.max(1, s * 0.05);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.beginPath();
    ctx.arc(s * 0.08, -s * 0.05, s * 0.035, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // --------------------------------------------------------------- effects

  _explode() {
    const { x, y } = this.tip;
    const n = this.reduced ? 14 : 46;
    const colors = ['#ffd166', '#ff9f43', '#ff5470', '#ffffff'];
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 60 + Math.random() * 260;
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 0,
        max: 0.6 + Math.random() * 0.8,
        r: 2 + Math.random() * 4,
        kind: 'spark',
        color: colors[(Math.random() * colors.length) | 0],
      });
    }
    this.shock = { x, y, life: 0, max: 0.7 };
  }

  _effects(dt) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life += dt;
      if (p.life >= p.max) {
        this.particles.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.kind === 'spark') p.vy += 120 * dt;
      const k = 1 - p.life / p.max;
      if (p.kind === 'flame') {
        ctx.fillStyle = `rgba(255,${Math.floor(90 + 140 * k)},60,${0.55 * k})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * (0.5 + k), 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.globalAlpha = k;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * k + 0.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
    ctx.restore();
    if (this.particles.length > 400) this.particles.splice(0, this.particles.length - 400);

    if (this.shock) {
      const s = this.shock;
      s.life += dt;
      if (s.life >= s.max) this.shock = null;
      else {
        const k = s.life / s.max;
        ctx.save();
        ctx.strokeStyle = `rgba(255,120,120,${0.8 * (1 - k)})`;
        ctx.lineWidth = 3 * (1 - k) + 1;
        ctx.beginPath();
        ctx.arc(s.x, s.y, 8 + k * Math.min(this.w, this.h) * 0.35, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  _countdown(pad, W, H) {
    const ctx = this.ctx;
    const remaining = Math.max(0, this.bettingEndsAt - this.now());
    const frac = Math.min(1, remaining / Math.max(1, this.bettingMs));
    const cx = pad.l + W / 2;
    const cy = pad.t + H / 2 - 6;
    const r = Math.min(W, H) * 0.2;
    ctx.save();
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(120,140,180,0.2)';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = ACCENT;
    ctx.shadowColor = ACCENT;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
    ctx.stroke();
    ctx.restore();
  }
}
