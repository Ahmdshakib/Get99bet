// Money is integer minor units (100 = 1.00). Multipliers are integer hundredths (250 = 2.50x).

export function fmtMoney(minor) {
  const neg = minor < 0;
  const abs = Math.abs(Math.trunc(minor));
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${whole}.${String(abs % 100).padStart(2, '0')}`;
}

export function fmtSigned(minor) {
  return (minor > 0 ? '+' : '') + fmtMoney(minor);
}

/** "12.34" -> 1234, or null if invalid. */
export function parseMoney(str) {
  const s = String(str).trim().replace(/,/g, '');
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(s)) return null;
  const [w, f = ''] = s.split('.');
  return Number(w) * 100 + Number((f + '00').slice(0, 2));
}

export function fmtMult(x100) {
  return (x100 / 100).toFixed(2);
}

export function parseMult(str) {
  const s = String(str).trim().replace(/[x×]/gi, '');
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

export function fmtTime(ms) {
  const d = new Date(ms);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function multClass(x100) {
  if (x100 < 200) return 'm-low';
  if (x100 < 1000) return 'm-mid';
  return 'm-high';
}

/** Tiny DOM helper - builds nodes with textContent only, so server data can never inject HTML. */
export function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c);
  return n;
}
