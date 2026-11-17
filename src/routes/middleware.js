'use strict';

const { AppError, sendError } = require('../lib/errors');
const { SESSION_COOKIE, parseCookies, originAllowed } = require('../lib/security');

/** Resolve the session cookie into req.user / req.session (never trusts any client-supplied user id). */
function attachUser({ auth, logger = console }) {
  return async (req, res, next) => {
    try {
      const cookies = parseCookies(req.headers && req.headers.cookie);
      const token = cookies[SESSION_COOKIE];
      req.sessionToken = token || null;
      req.session = null;
      req.user = null;
      if (token) {
        const s = await auth.resolveSession(token);
        if (s) {
          req.session = s;
          req.user = s.user;
        }
      }
      next();
    } catch (e) {
      sendError(res, e, logger);
    }
  };
}

function requireAuth(req, res, next) {
  if (!req.user) return sendError(res, new AppError('unauthorized', 401, 'Please log in'));
  next();
}

/**
 * CSRF defence for state-changing requests (defence in depth on top of SameSite=Strict cookies):
 *  1. a custom header that cross-site forms cannot set,
 *  2. the Origin header, when present, must match the site.
 */
function csrfGuard({ config }) {
  return (req, res, next) => {
    const method = String(req.method || 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
    const h = req.headers || {};
    if (h['x-requested-with'] !== 'g99') return sendError(res, new AppError('csrf', 403, 'Missing request header'));
    if (h.origin && !originAllowed(h.origin, h.host, config.allowedOrigins)) {
      return sendError(res, new AppError('csrf', 403, 'Origin not allowed'));
    }
    if (!h.origin && h['sec-fetch-site'] && !['same-origin', 'none'].includes(h['sec-fetch-site'])) {
      return sendError(res, new AppError('csrf', 403, 'Cross-site request blocked'));
    }
    next();
  };
}

function rateLimit(limiter, keyFn = (req) => req.ip || 'unknown') {
  return (req, res, next) => {
    const r = limiter.hit(keyFn(req));
    if (!r.ok) {
      if (res.setHeader) res.setHeader('Retry-After', String(Math.ceil(r.retryAfterMs / 1000)));
      return res.status(429).json({ error: 'rate_limited', message: 'Too many requests', retryAfterMs: r.retryAfterMs });
    }
    next();
  };
}

function parsePaging(query, { maxLimit = 100, defLimit = 25 } = {}) {
  let limit = parseInt(query && query.limit, 10);
  let offset = parseInt(query && query.offset, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = defLimit;
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  return { limit: Math.min(limit, maxLimit), offset: Math.min(offset, 100000) };
}

module.exports = { attachUser, requireAuth, csrfGuard, rateLimit, parsePaging };
