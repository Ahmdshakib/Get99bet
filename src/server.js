'use strict';

const http = require('node:http');
const { loadConfig } = require('./config');
const { createDb, migrate } = require('./db');
const { createWallet } = require('./wallet');
const { Audit } = require('./services/audit');
const { AuthService } = require('./services/auth');
const { LimitsService } = require('./services/limits');
const { ChainStore } = require('./fair/chainStore');
const { Game } = require('./services/game');
const { Gateway } = require('./ws/gateway');
const { createApp } = require('./app');

async function main() {
  const config = loadConfig();
  const logger = console;

  if (config.wallet.mode === 'test') {
    logger.warn('[get99bet] WALLET_MODE=test -> TEST CREDITS ONLY. No real money is involved.');
  }
  if (config.production && !config.cookieSecure) {
    logger.warn('[get99bet] COOKIE_SECURE is off in production. Serve over HTTPS and enable it.');
  }

  const db = createDb(config);
  await migrate(db);

  const wallet = createWallet({ db, config });
  const audit = new Audit({ db, logger });
  await audit.init();
  const auth = new AuthService({ db, wallet, audit, config });
  const limits = new LimitsService({ db, audit, config });
  const chains = new ChainStore({ db, config });
  const game = new Game({ db, wallet, audit, limits, chains, config, logger });
  await game.init();

  const gateway = new Gateway({ game, auth, wallet, config, logger });
  const app = createApp({ db, config, auth, wallet, game, limits, audit, chains, gateway, logger });

  const server = http.createServer(app);
  gateway.attach(server);
  server.listen(config.port, config.host, () => {
    logger.log(`[get99bet] Crash game listening on http://${config.host}:${config.port} (db: ${db.dialect}, wallet: ${wallet.mode})`);
  });

  await audit.log('system', 'server.start', { walletMode: wallet.mode, db: db.dialect });
  game.start();

  const shutdown = async (sig) => {
    logger.log(`[get99bet] ${sig} received, shutting down...`);
    game.stop();
    server.close();
    // Open stakes of the interrupted round are refunded by recover() on next start.
    await audit.log('system', 'server.stop', { sig }).catch(() => {});
    await db.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  console.error('[get99bet] fatal:', e);
  process.exit(1);
});
