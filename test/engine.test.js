'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  sha256Hex,
  buildChain,
  crashPointX100,
  multiplierX100At,
  timeToReachMs,
  verifyLink,
  hmacSha256Hex,
} = require('../src/fair/engine');

const OPTS = { houseEdgeBp: 100, maxMultiplierX100: 1000000 };

test('hash chain: every revealed hash hashes to the previously revealed one', () => {
  const chain = buildChain('a'.repeat(64), 100);
  assert.equal(chain.length, 101);
  // Round k uses chain[N-1-k]; its commitment is chain[N-k].
  for (let k = 0; k < 100; k++) {
    const revealed = chain[100 - 1 - k];
    const previous = chain[100 - k];
    assert.ok(verifyLink(revealed, previous));
  }
  assert.ok(!verifyLink(chain[5], chain[7]));
});

test('crash point is deterministic and has a fixed known vector', () => {
  const h = sha256Hex('vector-1');
  const a = crashPointX100(h, 'seed', OPTS);
  const b = crashPointX100(h, 'seed', OPTS);
  assert.equal(a, b);
  // Recompute independently with plain BigInt math.
  const mac = hmacSha256Hex(h, 'seed');
  const hh = BigInt('0x' + mac.slice(0, 13));
  const E = 2n ** 52n;
  let expected = (100n * 9900n * E) / (10000n * (E - hh));
  if (expected < 100n) expected = 100n;
  assert.equal(a, Number(expected));
  assert.ok(a >= 100);
});

test('crash point never below 1.00x and respects the cap', () => {
  for (let i = 0; i < 5000; i++) {
    const c = crashPointX100(sha256Hex('x' + i), 's', OPTS);
    assert.ok(c >= 100 && c <= OPTS.maxMultiplierX100);
  }
  const capped = crashPointX100(sha256Hex('y'), 's', { houseEdgeBp: 100, maxMultiplierX100: 150 });
  assert.ok(capped <= 150);
});

test('distribution: P(crash >= m) ~ (1-edge)/m  (RTP 99% for any target)', () => {
  const N = 200000;
  let hit2 = 0;
  let hit10 = 0;
  let instant = 0;
  let h = sha256Hex('dist-seed');
  for (let i = 0; i < N; i++) {
    h = sha256Hex(h);
    const c = crashPointX100(h, 'public', OPTS);
    if (c >= 200) hit2++;
    if (c >= 1000) hit10++;
    if (c === 100) instant++;
  }
  // Expected 0.495, 0.099, and P(1.00x) = 1 - 0.99/1.01 ~ 0.0198 (the 1% edge plus flooring to hundredths).
  assert.ok(Math.abs(hit2 / N - 0.495) < 0.006, `P(>=2x)=${hit2 / N}`);
  assert.ok(Math.abs(hit10 / N - 0.099) < 0.004, `P(>=10x)=${hit10 / N}`);
  assert.ok(Math.abs(instant / N - (1 - 0.99 / 1.01)) < 0.002, `P(1.00x)=${instant / N}`);
});

test('simulated RTP for a fixed 2x target is within tolerance of 99%', () => {
  const N = 200000;
  let returned = 0;
  let h = sha256Hex('rtp-seed');
  for (let i = 0; i < N; i++) {
    h = sha256Hex(h);
    if (crashPointX100(h, 'public', OPTS) >= 200) returned += 2;
  }
  const rtp = returned / N;
  assert.ok(Math.abs(rtp - 0.99) < 0.012, `RTP=${rtp}`);
});

test('a different client seed changes the outcome for the same hash', () => {
  const h = sha256Hex('same');
  const set = new Set();
  for (let i = 0; i < 20; i++) set.add(crashPointX100(h, 'seed-' + i, OPTS));
  assert.ok(set.size > 5);
});

test('multiplier curve: monotonic, starts at 1.00, round-trips with timeToReach', () => {
  const rate = 0.00008;
  assert.equal(multiplierX100At(0, rate), 100);
  assert.equal(multiplierX100At(-50, rate), 100);
  let prev = 100;
  for (let t = 0; t < 60000; t += 137) {
    const m = multiplierX100At(t, rate);
    assert.ok(m >= prev);
    prev = m;
  }
  for (const target of [101, 150, 200, 1000, 12345]) {
    const t = timeToReachMs(target, rate);
    assert.ok(multiplierX100At(Math.ceil(t) + 1, rate) >= target);
    assert.ok(multiplierX100At(Math.floor(t) - 1, rate) < target || t < 1);
  }
  // ~2x after about 8.7 s at the default growth rate.
  assert.ok(Math.abs(timeToReachMs(200, rate) - 8664) < 10);
});

test('crypto sanity: sha256 vector', () => {
  assert.equal(sha256Hex('abc'), crypto.createHash('sha256').update('abc').digest('hex'));
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
