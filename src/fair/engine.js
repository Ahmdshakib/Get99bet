'use strict';

/**
 * Provably fair crash engine (original implementation).
 *
 * Commitment scheme (hash chain):
 *   chain[0] = secret random seed
 *   chain[i] = SHA256(chain[i-1])            (hex string hashed as UTF-8 text)
 *   The operator publishes chain[N] (the "terminal hash") BEFORE any round.
 *   Round k (0-based) uses chain[N-1-k]; once the round ends that hash is revealed.
 *   Anyone can verify:  SHA256(revealed hash of round k) == revealed hash of round k-1
 *   (or == terminal hash for k = 0). Because hashes are revealed in reverse order,
 *   the operator cannot change future outcomes after publishing the terminal hash.
 *
 * Crash point from a round hash:
 *   mac = HMAC_SHA256(key = roundHash, message = clientSeed)
 *   h   = first 52 bits of mac (13 hex chars) as an integer in [0, 2^52)
 *   crash = floor( 100 * (1 - edge) * 2^52 / (2^52 - h) ) / 100, minimum 1.00
 *   => P(crash >= x) = (1 - edge) / x, i.e. a constant RTP of (1 - edge) for any cash-out target.
 *
 * Everything is integer arithmetic (BigInt) so the browser verifier gives identical results.
 */

const crypto = require('node:crypto');

const E = 2n ** 52n;

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function hmacSha256Hex(key, message) {
  return crypto.createHmac('sha256', key).update(message, 'utf8').digest('hex');
}

function newSeed() {
  return crypto.randomBytes(32).toString('hex');
}

/** Build chain[0..length]; chain[length] is the terminal (public) hash. */
function buildChain(seed, length) {
  const chain = new Array(length + 1);
  chain[0] = seed;
  for (let i = 1; i <= length; i++) chain[i] = sha256Hex(chain[i - 1]);
  return chain;
}

/**
 * Crash point as integer hundredths (250 = 2.50x). Capped at maxX100.
 * @param {string} roundHash
 * @param {string} clientSeed
 * @param {{houseEdgeBp:number, maxMultiplierX100:number}} opts
 */
function crashPointX100(roundHash, clientSeed, { houseEdgeBp, maxMultiplierX100 }) {
  const mac = hmacSha256Hex(roundHash, clientSeed);
  const h = BigInt('0x' + mac.slice(0, 13));
  const numerator = 100n * BigInt(10000 - houseEdgeBp) * E;
  const denominator = 10000n * (E - h);
  let x = numerator / denominator;
  if (x < 100n) x = 100n;
  if (x > BigInt(maxMultiplierX100)) x = BigInt(maxMultiplierX100);
  return Number(x);
}

/** Multiplier (x100, integer) shown after `elapsedMs` of flight. */
function multiplierX100At(elapsedMs, growthRate) {
  if (elapsedMs <= 0) return 100;
  return Math.max(100, Math.floor(100 * Math.exp(growthRate * elapsedMs)));
}

/** Flight time (ms, float) at which the multiplier first reaches x100. */
function timeToReachMs(x100, growthRate) {
  if (x100 <= 100) return 0;
  return Math.log(x100 / 100) / growthRate;
}

/** Verify one revealed hash against the previously revealed hash (or the terminal hash). */
function verifyLink(revealedHash, previousHash) {
  return sha256Hex(revealedHash) === previousHash;
}

module.exports = {
  sha256Hex,
  hmacSha256Hex,
  newSeed,
  buildChain,
  crashPointX100,
  multiplierX100At,
  timeToReachMs,
  verifyLink,
};
