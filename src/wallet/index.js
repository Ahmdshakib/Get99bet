'use strict';

const { TestWalletAdapter } = require('./TestWalletAdapter');

/**
 * Wallet factory. Real-money mode is hard-blocked: the config loader refuses
 * WALLET_MODE=external without LEGAL_AUTHORIZATION_CONFIRMED=true, and even then
 * ExternalWalletAdapter throws until it is actually implemented.
 */
function createWallet({ db, config, now }) {
  if (config.wallet.mode === 'external') {
    const { ExternalWalletAdapter } = require('./ExternalWalletAdapter');
    return new ExternalWalletAdapter({ db, config });
  }
  return new TestWalletAdapter({ db, config, now });
}

module.exports = { createWallet };
