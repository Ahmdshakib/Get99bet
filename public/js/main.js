import { api, ApiError } from './api.js';
import { GameSocket } from './socket.js';
import { CrashCanvas } from './game-canvas.js';
import { initLang, setLang, getLang, t, errText, onLangChange } from './i18n.js';
import { fmtMoney, fmtSigned, parseMoney, fmtMult, parseMult, fmtTime, multClass, el } from './format.js';
import { sfx, unlock, engineStart, engineUpdate, engineStop, isMuted, setMuted } from './sound.js';
import { verifyRound, cryptoAvailable } from './fair-verify.js';

const $ = (id) => document.getElementById(id);

// --------------------------------------------------------------------------- state
const state = {
  user: null, // { username, handle }
  wallet: { mode: 'test', currency: { code: 'TC', label: 'Test Credits', real: false }, supportsTopup: true },
  balance: 0,
  rg: null,
  round: null, // { id, number, status, startedAt, bettingEndsAt, commitment, crashX100?, hash? }
  limits: { minBet: 100, maxBet: 100000, maxMultiplierX100: 1000000 },
  growth: 0.00008,
  bets: [],
  myBet: null,
  recent: [],
  busy: false,
  tab: 'live',
  view: 'game',
  sessionStart: Date.now(),
  sessionNet: 0,
  accounted: new Set(),
  fair: null,
};

const socket = new GameSocket();
let stage = null;

// ------------------------------------------------------------------------- helpers
const unit = () => state.wallet.currency.code;

function toast(text, kind = '') {
  const box = $('toasts');
  while (box.children.length >= 4) box.firstChild.remove();
  const n = el('div', { class: `toast ${kind}`, text });
  box.append(n);
  setTimeout(() => n.remove(), 4500);
}

function failToast(e) {
  const code = (e && e.code) || 'internal_error';
  toast(errText(code), 'err');
  sfx.error();
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function setBalance(n) {
  state.balance = n;
  setText($('balance'), fmtMoney(n));
  setText($('d-balance'), `${fmtMoney(n)} ${unit()}`);
  renderAction(true);
}

function renderHeader() {
  const loggedIn = !!state.user;
  $('balance-chip').hidden = !loggedIn;
  $('login-btn').hidden = loggedIn;
  $('logout-btn').hidden = !loggedIn;
  setText($('balance-unit'), unit());
  $('sound-btn').setAttribute('aria-pressed', String(isMuted()));
  $('lang-btn').textContent = getLang() === 'en' ? 'বাংলা' : 'English';
}

// ------------------------------------------------------------------------- session / me
async function refreshMe() {
  const me = await api('GET', '/api/me');
  state.user = me.user;
  state.wallet = { mode: me.wallet.mode, currency: me.wallet.currency, supportsTopup: me.wallet.supportsTopup };
  state.rg = me.rg;
  if (me.user && me.wallet.balance !== null) setBalance(me.wallet.balance);
  renderHeader();
  renderAction(true);
  renderExcluded();
  scheduleReality();
}

// ------------------------------------------------------------------------- bet panel
function maxAllowedBet() {
  const rgMax = state.rg && state.rg.maxBet ? state.rg.maxBet : Infinity;
  return Math.min(state.limits.maxBet, rgMax);
}

function readAmount() {
  return parseMoney($('bet-amount').value);
}

function writeAmount(minor) {
  const clamped = Math.max(state.limits.minBet, Math.min(maxAllowedBet(), minor));
  $('bet-amount').value = fmtMoney(clamped);
  renderAction(true);
}

function isExcluded() {
  return !!(state.rg && state.rg.excludedUntil && state.rg.excludedUntil > Date.now());
}

function renderExcluded() {
  const n = $('excluded-note');
  if (isExcluded()) {
    n.hidden = false;
    n.textContent = t('game.excluded', { date: fmtTime(state.rg.excludedUntil) });
  } else n.hidden = true;
}

let lastActionKey = '';
function renderAction(force) {
  const btn = $('action-btn');
  const r = state.round;
  const mine = state.myBet;
  let text = '';
  let mode = 'bet'; // bet | cashout | wait | login
  let enabled = true;

  if (!state.user) {
    text = t('game.loginToPlay');
    mode = 'login';
  } else if (isExcluded()) {
    text = t('game.waitNext');
    mode = 'wait';
    enabled = false;
  } else if (mine && mine.status === 'active' && r && r.status === 'running') {
    const x100 = Math.floor((stage ? stage.currentMultiplier() : 1) * 100);
    const payout = Math.floor((mine.amount * x100) / 100);
    text = t('game.cashout', { amount: fmtMoney(payout), unit: unit() });
    mode = 'cashout';
  } else if (mine && mine.status === 'active') {
    text = t('game.betPlaced');
    mode = 'wait';
    enabled = false;
  } else if (r && r.status === 'betting' && !mine) {
    const a = readAmount();
    text = t('game.bet', { amount: a === null ? '–' : fmtMoney(a), unit: unit() });
    mode = 'bet';
  } else {
    text = t('game.waitNext');
    mode = 'wait';
    enabled = false;
  }
  if (state.busy) enabled = false;

  const key = `${mode}|${text}|${enabled}`;
  if (!force && key === lastActionKey) return;
  lastActionKey = key;
  btn.textContent = text;
  btn.disabled = !enabled && mode !== 'login';
  btn.classList.toggle('cashout', mode === 'cashout');
  btn.classList.toggle('waiting', mode === 'wait');
  btn.dataset.mode = mode;
}

async function onSubmit(ev) {
  ev.preventDefault();
  unlock();
  const mode = $('action-btn').dataset.mode;
  if (mode === 'login') return openAuth('login');
  if (state.busy) return;
  state.busy = true;
  renderAction(true);
  try {
    if (mode === 'cashout') {
      await socket.request('cashout');
    } else if (mode === 'bet') {
      const amount = readAmount();
      if (amount === null) throw Object.assign(new Error('bad_amount'), { code: 'bad_amount' });
      let autoX100 = null;
      if ($('auto-on').checked) {
        autoX100 = parseMult($('auto-x').value);
        if (autoX100 === null || autoX100 < 101) throw Object.assign(new Error('bad_auto'), { code: 'bad_auto_cashout' });
      }
      const res = await socket.request('bet', { amount, autoX100, clientRef: crypto.randomUUID() });
      setBalance(res.balance);
    }
  } catch (e) {
    failToast(e);
  } finally {
    state.busy = false;
    renderAction(true);
  }
}

// ------------------------------------------------------------------------- game state -> UI
const myHandle = () => (state.user ? state.user.handle : null);
const isMine = (b) => !!myHandle() && b.handle === myHandle();

function upsertBet(b) {
  const i = state.bets.findIndex((x) => x.id === b.id);
  if (i >= 0) state.bets[i] = b;
  else state.bets.push(b);
  if (isMine(b)) state.myBet = b;
  scheduleBetsRender();
}

let betsRaf = 0;
function scheduleBetsRender() {
  if (betsRaf) return;
  betsRaf = requestAnimationFrame(() => {
    betsRaf = 0;
    renderBets();
    renderAction(false);
  });
}

function renderBets() {
  const list = $('bets-list');
  const bets = [...state.bets].sort((a, b) => (isMine(b) ? 1 : 0) - (isMine(a) ? 1 : 0) || b.amount - a.amount).slice(0, 150);
  const total = state.bets.reduce((s, b) => s + b.amount, 0);
  $('live-meta').replaceChildren(el('span', { text: `${t('game.players')}: ${state.bets.length}` }), el('span', { text: `${t('game.totalBet')}: ${fmtMoney(total)} ${unit()}` }));
  if (!bets.length) {
    list.replaceChildren(el('li', {}, el('span', { class: 'empty', text: t('game.noBets') })));
    return;
  }
  list.replaceChildren(
    ...bets.map((b) => {
      const cls = ['bet-row', b.status === 'cashed' ? 'won' : '', b.status === 'lost' ? 'lost' : '', isMine(b) ? 'me' : ''].filter(Boolean).join(' ');
      return el(
        'li',
        { class: cls },
        el('span', { text: isMine(b) ? t('common.you') : b.name }),
        el('span', { text: fmtMoney(b.amount) }),
        el('span', { class: b.cashoutX100 ? multClass(b.cashoutX100) : '', text: b.cashoutX100 ? `${fmtMult(b.cashoutX100)}×` : '–' }),
        el('span', { class: b.status === 'cashed' ? 'win' : '', text: b.status === 'cashed' ? `+${fmtMoney(b.payout)}` : '' })
      );
    })
  );
}

function renderRecent() {
  const box = $('recent');
  box.replaceChildren(
    ...state.recent.map((r, i) =>
      el('button', {
        type: 'button',
        class: `chip ${multClass(r.crashX100)}`,
        text: `${fmtMult(r.crashX100)}×`,
        title: `#${r.number}`,
        onclick: () => openVerify(r.hash, state.recent[i + 1] ? state.recent[i + 1].hash : ''),
      })
    )
  );
}

function syncStage() {
  const r = state.round;
  if (!r || !stage) return;
  stage.setRound({
    phase: r.status,
    startedAt: r.startedAt,
    bettingEndsAt: r.bettingEndsAt,
    growthRate: state.growth,
    crashX100: r.crashX100,
  });
  setText($('round-no'), String(r.number));
}

function onFrame(mult, phase) {
  const m = $('mult');
  const r = state.round;
  if (phase === 'betting' && r) {
    const s = Math.max(0, (r.bettingEndsAt - socket.serverNow()) / 1000);
    setText(m, t('game.takeoffIn', { s: s.toFixed(1) }));
    m.className = 'mult is-waiting';
    setText($('stage-status'), '');
  } else if (phase === 'running') {
    setText(m, `${mult.toFixed(2)}×`);
    m.className = `mult ${multClass(Math.floor(mult * 100))}`;
    setText($('stage-status'), t('game.flying'));
    engineUpdate(mult);
    renderAction(false);
  } else if (phase === 'crashed' && r) {
    setText(m, `${mult.toFixed(2)}×`);
    m.className = 'mult is-crashed';
    setText($('stage-status'), t('game.nextRound'));
  } else {
    setText(m, '–');
    m.className = 'mult is-waiting';
  }
}

// ------------------------------------------------------------------------- socket events
function account(bet, delta) {
  if (!isMine(bet) || state.accounted.has(bet.id + bet.status)) return;
  state.accounted.add(bet.id + bet.status);
  state.sessionNet += delta;
}

socket.on('open', () => {
  $('conn').classList.add('ok');
});

socket.on('close', () => {
  const c = $('conn');
  c.classList.remove('ok');
  c.textContent = t('game.reconnecting');
  engineStop();
});

socket.on('hello', (msg) => {
  const s = msg.snapshot;
  $('conn').classList.add('ok');
  state.growth = s.growthRate;
  state.limits = s.limits;
  state.round = s.round;
  state.bets = s.bets || [];
  state.myBet = s.myBet || null;
  state.recent = s.recent || [];
  if (msg.wallet) state.wallet = { ...state.wallet, mode: msg.wallet.mode, currency: msg.wallet.currency };
  if (msg.me) setBalance(msg.me.balance);
  if (state.round && state.round.status === 'running') engineStart();
  syncStage();
  renderRecent();
  renderBets();
  renderHeader();
  renderAction(true);
  if (!$('bet-amount').dataset.init) {
    $('bet-amount').dataset.init = '1';
    writeAmount(Math.max(state.limits.minBet, 1000));
  }
});

socket.on('betting', (msg) => {
  state.round = msg.round;
  state.bets = [];
  state.myBet = null;
  engineStop();
  syncStage();
  renderBets();
  renderAction(true);
  $('sr-status').textContent = t('game.round') + ' ' + msg.round.number;
});

socket.on('running', (msg) => {
  if (!state.round) return;
  state.round = { ...state.round, status: 'running', startedAt: msg.startedAt };
  state.growth = msg.growthRate;
  syncStage();
  engineStart();
  renderAction(true);
});

socket.on('bet', (msg) => {
  upsertBet(msg.bet);
  if (isMine(msg.bet)) {
    sfx.bet();
    toast(t('toast.betPlaced', { amount: fmtMoney(msg.bet.amount), unit: unit() }));
  }
});

socket.on('cashout', (msg) => {
  upsertBet(msg.bet);
  if (isMine(msg.bet)) {
    account(msg.bet, msg.bet.payout - msg.bet.amount);
    sfx.cashout();
    toast(t('toast.cashed', { x: fmtMult(msg.bet.cashoutX100), amount: fmtMoney(msg.bet.payout), unit: unit() }), 'win');
  }
});

socket.on('crashed', (msg) => {
  const wasActive = state.myBet && state.myBet.status === 'active';
  state.round = { ...state.round, status: 'crashed', crashX100: msg.crashX100, hash: msg.hash };
  state.bets = msg.bets || state.bets;
  state.myBet = state.bets.find(isMine) || state.myBet;
  state.recent.unshift({ number: msg.number, crashX100: msg.crashX100, hash: msg.hash });
  state.recent.length = Math.min(state.recent.length, 30);
  engineStop();
  sfx.crash();
  syncStage();
  renderRecent();
  renderBets();
  renderAction(true);
  $('sr-status').textContent = t('game.crashedAt', { x: fmtMult(msg.crashX100) });
  if (wasActive && state.myBet && state.myBet.status === 'lost') {
    account(state.myBet, -state.myBet.amount);
    toast(t('toast.lost', { x: fmtMult(msg.crashX100), amount: fmtMoney(state.myBet.amount), unit: unit() }), 'lose');
  }
  if (state.tab === 'mine') loadMine();
  if (state.view === 'history') loadRoundsHistory(true);
});

socket.on('balance', (msg) => setBalance(msg.balance));

// ------------------------------------------------------------------------- tabs: live / mine
function setTab(tab) {
  state.tab = tab;
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  $('bets-list').classList.toggle('hidden', tab !== 'live');
  document.querySelector('.list-head').classList.toggle('hidden', tab !== 'live');
  $('live-meta').classList.toggle('hidden', tab !== 'live');
  $('mine-wrap').classList.toggle('hidden', tab !== 'mine');
  if (tab === 'mine') loadMine();
}

async function loadMine() {
  const body = $('mine-table').tBodies[0];
  if (!state.user) {
    body.replaceChildren(el('tr', {}, el('td', { colspan: 4, class: 'muted', text: t('dash.loginPrompt') })));
    return;
  }
  try {
    const { items } = await api('GET', '/api/history/bets?limit=15');
    body.replaceChildren(
      ...items.map((b) =>
        el(
          'tr',
          {},
          el('td', { text: `#${b.roundNumber}` }),
          el('td', { text: fmtMoney(b.amount) }),
          el('td', { class: b.cashoutX100 ? multClass(b.cashoutX100) : '', text: b.cashoutX100 ? `${fmtMult(b.cashoutX100)}×` : '–' }),
          el('td', { class: b.payout - b.amount >= 0 ? 'win' : 'loss', text: b.status === 'active' ? '…' : fmtSigned(b.payout - b.amount) })
        )
      )
    );
  } catch (e) {
    failToast(e);
  }
}

// ------------------------------------------------------------------------- views
const VIEWS = ['game', 'dashboard', 'history', 'fair', 'safe'];

function route() {
  const name = (location.hash.replace(/^#\/?/, '') || 'game').split('?')[0];
  const view = VIEWS.includes(name) ? name : 'game';
  state.view = view;
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== view;
  for (const a of document.querySelectorAll('#nav a')) {
    if (a.dataset.view === view) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  if (view === 'game' && stage) requestAnimationFrame(() => stage.resize());
  if (view === 'dashboard') loadDashboard();
  if (view === 'history') loadHistory();
  if (view === 'fair') loadFair();
  if (view === 'safe') loadSafe();
  window.scrollTo(0, 0);
}

// ---- dashboard
function drawSpark(series) {
  const c = $('spark');
  const r = c.parentElement.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  c.width = Math.max(10, Math.floor(r.width * dpr));
  c.height = Math.max(10, Math.floor(r.height * dpr));
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = r.width;
  const h = r.height;
  ctx.clearRect(0, 0, w, h);
  if (!series.length) return;
  const pts = [0, ...series];
  const min = Math.min(...pts);
  const max = Math.max(...pts, min + 1);
  const x = (i) => 8 + (i / Math.max(1, pts.length - 1)) * (w - 16);
  const y = (v) => h - 10 - ((v - min) / (max - min)) * (h - 20);
  ctx.strokeStyle = 'rgba(138,151,176,0.35)';
  ctx.beginPath();
  ctx.moveTo(0, y(0));
  ctx.lineTo(w, y(0));
  ctx.stroke();
  const last = pts[pts.length - 1];
  ctx.strokeStyle = last >= 0 ? '#22e3a4' : '#ff5470';
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  pts.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  ctx.stroke();
}

async function loadDashboard() {
  const loggedIn = !!state.user;
  $('dash-login').hidden = loggedIn;
  $('dash-body').hidden = !loggedIn;
  if (!loggedIn) return;
  try {
    const [stats, tx, act] = await Promise.all([api('GET', '/api/stats'), api('GET', '/api/transactions?limit=15'), api('GET', '/api/activity?limit=12')]);
    setText($('d-balance'), `${fmtMoney(state.balance)} ${unit()}`);
    const net = $('d-net');
    net.textContent = `${fmtSigned(stats.net)} ${unit()}`;
    net.className = stats.net >= 0 ? 'win' : 'loss';
    setText($('d-bets'), String(stats.bets));
    setText($('d-win'), `${(stats.winRate * 100).toFixed(1)}%`);
    setText($('d-wagered'), `${fmtMoney(stats.wagered)} ${unit()}`);
    setText($('d-best'), stats.bestMultiplierX100 ? `${fmtMult(stats.bestMultiplierX100)}×` : '–');
    drawSpark(stats.series);
    $('tx-table').tBodies[0].replaceChildren(
      ...tx.items.map((x) => {
        const plus = ['grant', 'topup', 'credit', 'refund'].includes(x.type);
        return el(
          'tr',
          {},
          el('td', { text: t(`tx.${x.type}`) }),
          el('td', { class: plus ? 'win' : 'loss', text: `${plus ? '+' : '-'}${fmtMoney(x.amount)}` }),
          el('td', { text: fmtMoney(x.balanceAfter) }),
          el('td', { text: fmtTime(x.createdAt) })
        );
      })
    );
    $('topup-btn').hidden = !state.wallet.supportsTopup;
    $('activity').replaceChildren(...act.items.map((a) => el('li', {}, el('span', { text: a.event }), el('time', { text: fmtTime(a.ts) }))));
  } catch (e) {
    failToast(e);
  }
}

async function onTopup() {
  try {
    const r = await api('POST', '/api/wallet/test-topup', {});
    setBalance(r.balance);
    toast(t('toast.topup', { amount: fmtMoney(r.balance), unit: unit() }), 'win');
    loadDashboard();
  } catch (e) {
    failToast(e);
  }
}

// ---- history
const hist = { bets: 0, rounds: 0, roundsList: [] };

function loadHistory() {
  $('hist-login').hidden = !!state.user;
  if (state.user) loadBetsHistory(true);
  loadRoundsHistory(true);
}

async function loadBetsHistory(reset) {
  if (reset) hist.bets = 0;
  const { items } = await api('GET', `/api/history/bets?limit=25&offset=${hist.bets}`).catch((e) => (failToast(e), { items: [] }));
  hist.bets += items.length;
  const rows = items.map((b) =>
    el(
      'tr',
      {},
      el('td', { text: `#${b.roundNumber}` }),
      el('td', { text: fmtMoney(b.amount) }),
      el('td', { text: b.autoX100 ? `${fmtMult(b.autoX100)}×` : '–' }),
      el('td', { class: b.cashoutX100 ? multClass(b.cashoutX100) : '', text: b.cashoutX100 ? `${fmtMult(b.cashoutX100)}×` : t(`hist.status.${b.status}`) }),
      el('td', { text: fmtMoney(b.payout) }),
      el('td', { class: b.payout - b.amount >= 0 ? 'win' : 'loss', text: b.status === 'active' || b.status === 'void' ? '–' : fmtSigned(b.payout - b.amount) }),
      el('td', { class: b.crashX100 ? multClass(b.crashX100) : '', text: b.crashX100 ? `${fmtMult(b.crashX100)}×` : '–' }),
      el('td', { text: fmtTime(b.createdAt) })
    )
  );
  const body = $('hist-table').tBodies[0];
  if (reset) body.replaceChildren(...rows);
  else body.append(...rows);
  $('hist-more').hidden = items.length < 25;
}

async function loadRoundsHistory(reset) {
  if (reset) {
    hist.rounds = 0;
    hist.roundsList = [];
  }
  const { items } = await api('GET', `/api/history/rounds?limit=25&offset=${hist.rounds}`).catch((e) => (failToast(e), { items: [] }));
  hist.rounds += items.length;
  hist.roundsList.push(...items);
  const list = hist.roundsList;
  $('rounds-table').tBodies[0].replaceChildren(
    ...list.map((r, i) =>
      el(
        'tr',
        {},
        el('td', { text: `#${r.number}` }),
        el('td', { class: multClass(r.crashX100), text: `${fmtMult(r.crashX100)}×` }),
        el('td', { class: 'hash', text: r.hash || '' }),
        el('td', {}, el('button', { class: 'btn ghost small', type: 'button', text: t('hist.verify'), onclick: () => openVerify(r.hash, list[i + 1] ? list[i + 1].hash : '') }))
      )
    )
  );
  $('rounds-more').hidden = items.length < 25;
}

// ---- fairness
async function loadFair() {
  try {
    const f = await api('GET', '/api/fair');
    state.fair = f;
    setText($('f-terminal'), f.terminalHash);
    setText($('f-seed'), f.clientSeed);
    setText($('f-edge'), `${(f.houseEdgeBp / 100).toFixed(2)}%`);
    setText($('f-left'), String(f.remaining));
    if (!$('v-seed').value) $('v-seed').value = f.clientSeed;
  } catch (e) {
    failToast(e);
  }
}

function openVerify(hash, prev) {
  location.hash = '#/fair';
  setTimeout(() => {
    $('v-hash').value = hash || '';
    $('v-prev').value = prev || (state.fair ? '' : '');
    if (state.fair && !$('v-seed').value) $('v-seed').value = state.fair.clientSeed;
    if (hash) $('verify-form').requestSubmit();
  }, 250);
}

async function onVerify(ev) {
  ev.preventDefault();
  const out = $('verify-out');
  if (!cryptoAvailable()) return out.replaceChildren(el('div', { class: 'bad', text: t('fair.noCrypto') }));
  if (!state.fair) await loadFair();
  const hash = $('v-hash').value.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hash)) return out.replaceChildren(el('div', { class: 'bad', text: t('fair.linkBad') }));
  const res = await verifyRound({
    hash,
    previousHash: $('v-prev').value,
    clientSeed: $('v-seed').value || state.fair.clientSeed,
    houseEdgeBp: state.fair.houseEdgeBp,
    maxMultiplierX100: state.fair.maxMultiplierX100,
  });
  out.replaceChildren(
    res.linkOk === null ? el('div', { class: 'muted', text: t('fair.linkSkip') }) : el('div', { class: res.linkOk ? 'ok' : 'bad', text: res.linkOk ? t('fair.linkOk') : t('fair.linkBad') }),
    el('div', { text: t('fair.crashResult', { x: fmtMult(res.crashX100) }) })
  );
}

// ---- safer play
async function loadSafe() {
  $('safe-login').hidden = !!state.user;
  $('safe-body').hidden = !state.user;
  if (!state.user) return;
  try {
    const rg = await api('GET', '/api/rg');
    state.rg = rg;
    renderSafe(rg);
    renderExcluded();
    renderAction(true);
  } catch (e) {
    failToast(e);
  }
}

function renderSafe(rg) {
  $('l-reminder').value = rg.sessionReminderMin;
  $('l-maxbet').value = rg.maxBet ? fmtMoney(rg.maxBet) : '';
  $('l-loss').value = rg.dailyLossLimit ? fmtMoney(rg.dailyLossLimit) : '';
  setText($('loss-line'), t('safe.lossToday', { amount: fmtMoney(rg.lossLast24h || 0), unit: unit() }));
  const pn = $('pending-note');
  pn.hidden = !rg.pending;
  if (rg.pending) pn.textContent = t('safe.pending', { hours: rg.raiseDelayHours, date: fmtTime(rg.pendingEffectiveAt) });
  const sel = $('x-days');
  if (!sel.options.length) for (const d of rg.exclusionOptionsDays) sel.append(el('option', { value: String(d), text: t('safe.excl.days', { n: d }) }));
  const ea = $('excl-active');
  ea.hidden = !rg.excludedUntil;
  if (rg.excludedUntil) ea.textContent = t('safe.excl.active', { date: fmtTime(rg.excludedUntil) });
}

async function onSaveLimits(ev) {
  ev.preventDefault();
  const money = (id) => {
    const v = $(id).value.trim();
    if (!v) return null;
    const m = parseMoney(v);
    if (m === null || m <= 0) throw Object.assign(new Error('bad_limit'), { code: 'bad_limit' });
    return m;
  };
  try {
    const mins = parseInt($('l-reminder').value, 10);
    const rg = await api('POST', '/api/rg/limits', {
      maxBet: money('l-maxbet'),
      dailyLossLimit: money('l-loss'),
      sessionReminderMin: Number.isFinite(mins) ? mins : null,
    });
    state.rg = { ...state.rg, ...rg };
    renderSafe(state.rg);
    scheduleReality();
    toast(t('safe.saved'), 'win');
  } catch (e) {
    failToast(e);
  }
}

async function onExclude(ev) {
  ev.preventDefault();
  if (!$('x-confirm').checked) return;
  try {
    const rg = await api('POST', '/api/rg/exclude', { days: parseInt($('x-days').value, 10), confirm: true });
    state.rg = { ...state.rg, ...rg };
    $('x-confirm').checked = false;
    renderSafe(state.rg);
    renderExcluded();
    renderAction(true);
  } catch (e) {
    failToast(e);
  }
}

// ---- reality check (session reminder)
let realityTimer = 0;
function scheduleReality() {
  clearInterval(realityTimer);
  if (!state.user) return;
  const mins = (state.rg && state.rg.sessionReminderMin) || 30;
  realityTimer = setInterval(() => {
    if ($('reality-dialog').open || $('auth-dialog').open) return;
    const played = Math.max(1, Math.round((Date.now() - state.sessionStart) / 60000));
    $('reality-body').textContent = t('reality.body', { min: played, net: fmtSigned(state.sessionNet), unit: unit() });
    $('reality-dialog').showModal();
  }, mins * 60000);
}

// ------------------------------------------------------------------------- auth dialog
let authMode = 'login';
function openAuth(mode) {
  authMode = mode;
  const reg = mode === 'register';
  $('auth-title').textContent = t(reg ? 'auth.register' : 'auth.login');
  $('auth-submit').textContent = t(reg ? 'auth.register' : 'auth.login');
  $('a-hint').hidden = !reg;
  $('a-age-row').hidden = !reg;
  $('a-pass').setAttribute('autocomplete', reg ? 'new-password' : 'current-password');
  $('auth-switch-text').textContent = t(reg ? 'auth.haveAccount' : 'auth.noAccount');
  $('auth-switch').textContent = t(reg ? 'auth.login' : 'auth.register');
  $('auth-error').textContent = '';
  if (!$('auth-dialog').open) $('auth-dialog').showModal();
  $('a-user').focus();
}

async function onAuthSubmit(ev) {
  ev.preventDefault();
  const body = { username: $('a-user').value.trim(), password: $('a-pass').value };
  if (authMode === 'register') {
    body.ageConfirmed = $('a-age').checked;
    body.locale = getLang();
  }
  $('auth-submit').disabled = true;
  try {
    const res = await api('POST', authMode === 'register' ? '/api/auth/register' : '/api/auth/login', body);
    $('a-pass').value = '';
    $('auth-dialog').close();
    state.sessionStart = Date.now();
    state.sessionNet = 0;
    state.accounted.clear();
    await refreshMe();
    socket.reset(); // re-open the socket so the server binds it to the new session
    toast(t('auth.welcome', { name: res.user.username }), 'win');
  } catch (e) {
    $('auth-error').textContent = errText(e instanceof ApiError ? e.code : 'internal_error');
  } finally {
    $('auth-submit').disabled = false;
  }
}

async function logout() {
  try {
    await api('POST', '/api/auth/logout', {});
  } catch {
    /* cookie is cleared server-side on success; ignore network errors */
  }
  state.myBet = null;
  await refreshMe();
  socket.reset();
  location.hash = '#/game';
}

// ------------------------------------------------------------------------- wiring
function wire() {
  $('bet-form').addEventListener('submit', onSubmit);
  $('bet-amount').addEventListener('input', () => renderAction(true));
  $('bet-amount').addEventListener('blur', () => {
    const a = readAmount();
    writeAmount(a === null ? state.limits.minBet : a);
  });
  $('amt-minus').addEventListener('click', () => writeAmount((readAmount() ?? 0) - 100));
  $('amt-plus').addEventListener('click', () => writeAmount((readAmount() ?? 0) + 100));
  $('quick').addEventListener('click', (e) => {
    const q = e.target.dataset && e.target.dataset.q;
    if (!q) return;
    const a = readAmount() ?? state.limits.minBet;
    if (q === 'min') writeAmount(state.limits.minBet);
    if (q === 'half') writeAmount(Math.floor(a / 2));
    if (q === 'double') writeAmount(a * 2);
    if (q === 'max') writeAmount(Math.min(maxAllowedBet(), state.balance || maxAllowedBet()));
  });
  $('auto-on').addEventListener('change', (e) => ($('auto-x').disabled = !e.target.checked));

  for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => setTab(b.dataset.tab));

  $('login-btn').addEventListener('click', () => openAuth('login'));
  $('logout-btn').addEventListener('click', logout);
  $('auth-close').addEventListener('click', () => $('auth-dialog').close());
  $('auth-switch').addEventListener('click', () => openAuth(authMode === 'login' ? 'register' : 'login'));
  $('auth-form').addEventListener('submit', onAuthSubmit);

  $('lang-btn').addEventListener('click', () => {
    setLang(getLang() === 'en' ? 'bn' : 'en');
    if (state.user) api('POST', '/api/locale', { locale: getLang() }).catch(() => {});
  });
  $('sound-btn').addEventListener('click', () => {
    unlock();
    setMuted(!isMuted());
    $('sound-btn').setAttribute('aria-pressed', String(isMuted()));
    if (!isMuted() && state.round && state.round.status === 'running') engineStart();
  });

  $('topup-btn').addEventListener('click', onTopup);
  $('hist-more').addEventListener('click', () => loadBetsHistory(false));
  $('rounds-more').addEventListener('click', () => loadRoundsHistory(false));
  $('verify-form').addEventListener('submit', onVerify);
  $('limits-form').addEventListener('submit', onSaveLimits);
  $('exclude-form').addEventListener('submit', onExclude);

  $('reality-continue').addEventListener('click', () => $('reality-dialog').close());
  $('reality-logout').addEventListener('click', () => {
    $('reality-dialog').close();
    logout();
  });
  $('reality-break').addEventListener('click', async () => {
    $('reality-dialog').close();
    try {
      const rg = await api('POST', '/api/rg/exclude', { days: 1, confirm: true });
      state.rg = { ...state.rg, ...rg };
      renderExcluded();
      renderAction(true);
    } catch (e) {
      failToast(e);
    }
  });

  const firstGesture = () => {
    unlock();
    if (state.round && state.round.status === 'running') engineStart(); // join the flight already in progress
  };
  document.addEventListener('pointerdown', firstGesture, { once: true });
  document.addEventListener('keydown', firstGesture, { once: true });
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || state.view !== 'game') return;
    if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(e.target.tagName) || document.querySelector('dialog[open]')) return;
    e.preventDefault();
    $('bet-form').requestSubmit();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    socket.reconnectNow();
    if (socket.connected) socket.send({ type: 'sync' });
    if (state.user) api('GET', '/api/wallet').then((w) => setBalance(w.balance)).catch(() => {});
  });

  window.addEventListener('hashchange', route);
  window.addEventListener('resize', () => {
    if (state.view === 'dashboard' && state.user) loadDashboard();
  });
  onLangChange(() => {
    renderHeader();
    renderBets();
    renderAction(true);
    renderExcluded();
    $('conn').textContent = t('game.reconnecting');
    if (state.view === 'safe' && state.rg) renderSafe(state.rg);
    if (state.view === 'dashboard') loadDashboard();
    if (state.view === 'history') loadHistory();
  });
}

async function boot() {
  initLang();
  wire();
  stage = new CrashCanvas($('stage'), () => socket.serverNow());
  stage.onFrame = onFrame;
  stage.start();
  setTab('live');
  route();
  try {
    await refreshMe();
  } catch {
    toast(errText('network'), 'err');
  }
  renderHeader();
  route(); // re-run now that the session is known (deep links to #/dashboard etc.)
  socket.connect();
}

boot();
