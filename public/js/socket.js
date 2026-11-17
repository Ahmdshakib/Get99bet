// WebSocket client with automatic reconnect, request/reply correlation and server-clock estimation.

export class GameSocket {
  constructor() {
    this.ws = null;
    this.handlers = new Map();
    this.pending = new Map();
    this.nextId = 1;
    this.backoff = 500;
    this.closedByUs = false;
    this.samples = [];
    this.offset = 0; // serverNow ≈ Date.now() + offset
    this.connected = false;
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
  }

  _emit(type, data) {
    const set = this.handlers.get(type);
    if (set) set.forEach((fn) => fn(data));
  }

  serverNow() {
    return Date.now() + this.offset;
  }

  /** Best-case clock offset = the sample with the lowest network latency (largest server - client delta). */
  _sample(serverTime) {
    if (typeof serverTime !== 'number') return;
    this.samples.push(serverTime - Date.now());
    if (this.samples.length > 20) this.samples.shift();
    this.offset = Math.max(...this.samples);
  }

  connect() {
    this.closedByUs = false;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.addEventListener('open', () => {
      if (this.ws !== ws) return;
      this.connected = true;
      this.backoff = 500;
      this._emit('open');
    });
    ws.addEventListener('message', (ev) => {
      if (this.ws !== ws) return; // ignore a superseded socket
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.serverTime) this._sample(msg.serverTime);
      if (msg.type === 'reply' && msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        msg.ok ? p.resolve(msg) : p.reject(Object.assign(new Error(msg.error || 'error'), { code: msg.error || 'internal_error', data: msg }));
        return;
      }
      this._emit(msg.type, msg);
    });
    ws.addEventListener('close', () => {
      if (this.ws !== ws) return; // a replaced socket must never trigger a reconnect
      this.connected = false;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(Object.assign(new Error('network'), { code: 'network' }));
      }
      this.pending.clear();
      this._emit('close');
      if (!this.closedByUs) {
        const wait = this.backoff + Math.random() * 300;
        this.backoff = Math.min(this.backoff * 2, 8000);
        setTimeout(() => this.connect(), wait);
      }
    });
    ws.addEventListener('error', () => {
      /* close handler does the reconnect */
    });
  }

  reconnectNow() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.backoff = 500;
    this.connect();
  }

  close() {
    this.closedByUs = true;
    if (this.ws) this.ws.close();
  }

  /** Drop the current connection and open a fresh one (used after login/logout so the server re-reads the session cookie). */
  reset() {
    const old = this.ws;
    this.ws = null;
    this.connected = false;
    if (old) {
      try {
        old.close();
      } catch {
        /* ignore */
      }
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(Object.assign(new Error('network'), { code: 'network' }));
    }
    this.pending.clear();
    this.samples = [];
    this.backoff = 500;
    this.connect();
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  request(type, payload = {}) {
    return new Promise((resolve, reject) => {
      const id = `m${this.nextId++}`;
      if (!this.send({ id, type, ...payload })) return reject(Object.assign(new Error('network'), { code: 'network' }));
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error('network'), { code: 'network' }));
      }, 10000);
      this.pending.set(id, { resolve, reject, timer });
    });
  }
}
