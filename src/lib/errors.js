'use strict';

/** Error with a stable machine-readable code and an HTTP status. */
class AppError extends Error {
  constructor(code, status = 400, message, extra) {
    super(message || code);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

/** Turn any thrown error into a JSON response. Never leaks internals. */
function sendError(res, err, logger = console) {
  if (err && (err.name === 'AppError' || (err.code && err.status && err.expose))) {
    return res.status(err.status).json({ error: err.code, message: err.message, ...(err.extra || {}) });
  }
  if (err && err.publicCode) {
    // Domain errors (wallet / game / limits) carry a publicCode and a status.
    return res
      .status(err.httpStatus || 400)
      .json({ error: err.publicCode, message: err.message, ...(err.extra || {}) });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'bad_json', message: 'Malformed JSON body' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'too_large', message: 'Body too large' });
  }
  logger.error('[unhandled]', err && err.stack ? err.stack : err);
  return res.status(500).json({ error: 'internal_error', message: 'Internal error' });
}

/** Wrap an async route handler so rejections reach sendError. */
function wrap(fn, logger) {
  return async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (e) {
      sendError(res, e, logger);
    }
  };
}

/** Errors thrown by domain services expose a publicCode. */
class DomainError extends Error {
  constructor(publicCode, message, httpStatus = 400, extra) {
    super(message || publicCode);
    this.name = 'DomainError';
    this.publicCode = publicCode;
    this.httpStatus = httpStatus;
    this.extra = extra;
  }
}

module.exports = { AppError, DomainError, sendError, wrap };
