'use strict';

/**
 * All amounts are integers in minor units (100 = 1.00). Floats never touch money.
 */

const MAX_SAFE_AMOUNT = 1e12;

function isValidAmount(n) {
  return Number.isSafeInteger(n) && n > 0 && n <= MAX_SAFE_AMOUNT;
}

/** "12.34" -> 1234. Returns null when invalid. */
function parseAmount(str) {
  if (typeof str !== 'string') return null;
  const s = str.trim();
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  const n = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  return Number.isSafeInteger(n) ? n : null;
}

function formatAmount(minor) {
  const neg = minor < 0;
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = String(abs % 100).padStart(2, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

/** payout = floor(amount * x100 / 100), computed with integers only. */
function payoutFor(amount, x100) {
  return Math.floor((amount * x100) / 100);
}

module.exports = { isValidAmount, parseAmount, formatAmount, payoutFor, MAX_SAFE_AMOUNT };
