'use strict';

const crypto = require('node:crypto');

const SESSION_COOKIE = 'g99_session';

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function parseCookies(header) {
  const out = {};
  if (!header || typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function serializeSessionCookie(value, { maxAgeSec, secure }) {
  const parts = [`${SESSION_COOKIE}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (maxAgeSec !== undefined) parts.push(`Max-Age=${maxAgeSec}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Origin check used for state-changing requests and the WebSocket upgrade.
 * If ALLOWED_ORIGINS is empty, the Origin host must equal the Host header.
 */
function originAllowed(originHeader, hostHeader, allowedOrigins) {
  if (!originHeader) return false;
  let u;
  try {
    u = new URL(originHeader);
  } catch {
    return false;
  }
  if (allowedOrigins && allowedOrigins.length) return allowedOrigins.includes(u.origin);
  return !!hostHeader && u.host === hostHeader;
}

function securityHeaders(req, res, next) {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "media-src 'self' blob:",
      "connect-src 'self' ws: wss:",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join('; ')
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
}

module.exports = {
  SESSION_COOKIE,
  sha256Hex,
  newToken,
  parseCookies,
  serializeSessionCookie,
  originAllowed,
  securityHeaders,
};
