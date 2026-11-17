'use strict';

/**
 * Minimal in-memory stand-in for express.Router so the real route handlers and
 * middleware (auth, CSRF, rate limits) can be exercised without Express installed.
 */
class FakeRouter {
  constructor() {
    this.globals = [];
    this.routes = [];
  }
  use(fn) {
    this.globals.push(fn);
  }
  get(path, ...h) {
    this.routes.push({ method: 'GET', path, handlers: h });
  }
  post(path, ...h) {
    this.routes.push({ method: 'POST', path, handlers: h });
  }

  async call(method, fullPath, { body, headers = {}, cookie, ip = '10.0.0.1' } = {}) {
    const [pathname, qs] = fullPath.split('?');
    const query = Object.fromEntries(new URLSearchParams(qs || ''));
    const route = this.routes.find((r) => r.method === method && r.path === pathname);
    const req = {
      method,
      path: pathname,
      query,
      body,
      ip,
      headers: {
        host: 'localhost:3000',
        origin: 'http://localhost:3000',
        'x-requested-with': 'g99',
        ...headers,
        ...(cookie ? { cookie } : {}),
      },
    };
    const res = {
      statusCode: 200,
      headers: {},
      body: undefined,
      status(c) {
        this.statusCode = c;
        return this;
      },
      json(b) {
        this.body = b;
        this.done = true;
        return this;
      },
      setHeader(k, v) {
        this.headers[k.toLowerCase()] = v;
      },
    };
    if (!route) {
      res.status(404).json({ error: 'not_found' });
      return res;
    }
    const chain = [...this.globals, ...route.handlers];
    for (const fn of chain) {
      let nextCalled = false;
      await fn(req, res, () => (nextCalled = true));
      if (res.done || !nextCalled) {
        if (!res.done) await new Promise((r) => setImmediate(r));
        break;
      }
    }
    return res;
  }
}

/** Pull "g99_session=..." out of a Set-Cookie header so tests can replay it. */
function cookieFrom(res) {
  const sc = res.headers['set-cookie'];
  return sc ? sc.split(';')[0] : null;
}

module.exports = { FakeRouter, cookieFrom };
