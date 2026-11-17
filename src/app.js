'use strict';

const path = require('node:path');
const { securityHeaders } = require('./lib/security');
const { sendError } = require('./lib/errors');
const { registerRoutes } = require('./routes');

/** Build the Express application (REST API + static frontend). */
function createApp(deps) {
  const express = require('express');
  const { config } = deps;
  const logger = deps.logger || console;
  const app = express();

  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use(securityHeaders);
  app.use(express.json({ limit: '8kb' }));

  const api = express.Router();
  registerRoutes(api, deps);
  app.use('/', api);

  // Unknown API paths -> JSON 404 (never fall through to the HTML app).
  app.use('/api', (req, res) => res.status(404).json({ error: 'not_found', message: 'Not found' }));

  app.use(
    express.static(path.join(__dirname, '..', 'public'), {
      index: 'index.html',
      etag: true,
      setHeaders(res, filePath) {
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
        else res.setHeader('Cache-Control', 'public, max-age=300');
      },
    })
  );

  // Last-resort error handler (body parse errors, etc.).
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => sendError(res, err, logger));

  return app;
}

module.exports = { createApp };
