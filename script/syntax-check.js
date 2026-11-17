'use strict';
// Syntax-checks every JS file (server + tests + frontend modules). Usage: npm run check
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'data') continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}
let bad = 0;
for (const f of walk(path.join(__dirname, '..'))) {
  try {
    const isModule = f.includes(`${path.sep}public${path.sep}js${path.sep}`);
    execFileSync(process.execPath, isModule ? ['--input-type=module', '--check', '-'] : ['--check', f], isModule ? { input: fs.readFileSync(f) } : {});
  } catch (e) {
    bad++;
    console.error('SYNTAX ERROR in', f, String(e.stderr || e.message));
  }
}
console.log(bad ? `${bad} file(s) failed` : 'all files OK');
process.exit(bad ? 1 : 0);
