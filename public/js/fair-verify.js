// Browser-side provably-fair verifier. Mirrors src/fair/engine.js exactly (BigInt integer maths),
// so players can check outcomes on their own device without trusting the server.

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export const cryptoAvailable = () => !!(globalThis.crypto && globalThis.crypto.subtle);

export async function sha256Hex(text) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

async function hmacHex(key, message) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(message)));
}

export async function crashPointX100(roundHash, clientSeed, houseEdgeBp, maxMultiplierX100) {
  const mac = await hmacHex(roundHash, clientSeed);
  const h = BigInt('0x' + mac.slice(0, 13));
  const E = 2n ** 52n;
  let x = (100n * BigInt(10000 - houseEdgeBp) * E) / (10000n * (E - h));
  if (x < 100n) x = 100n;
  if (x > BigInt(maxMultiplierX100)) x = BigInt(maxMultiplierX100);
  return Number(x);
}

/** @returns {{linkOk: boolean|null, crashX100: number}} */
export async function verifyRound({ hash, previousHash, clientSeed, houseEdgeBp, maxMultiplierX100 }) {
  const clean = (s) => String(s || '').trim().toLowerCase();
  const h = clean(hash);
  const p = clean(previousHash);
  const linkOk = p ? (await sha256Hex(h)) === p : null;
  const crashX100 = await crashPointX100(h, String(clientSeed), houseEdgeBp, maxMultiplierX100);
  return { linkOk, crashX100 };
}
