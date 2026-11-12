'use strict';
/* =====================================================================
   1. BOARD GEOMETRY (9 x 9 mini board)
   ===================================================================== */
// The 28 squares of the loop, clockwise, as [column, row].
const TRACK = [[5,0],[5,1],[5,2],[6,3],[7,3],[8,3],[8,4],[8,5],[7,5],[6,5],[5,6],[5,7],[5,8],[4,8],
               [3,8],[3,7],[3,6],[2,5],[1,5],[0,5],[0,4],[0,3],[1,3],[2,3],[3,2],[3,1],[3,0],[4,0]];
const START = { green: 1, yellow: 8, blue: 15, red: 22 };      // index in TRACK
const SAFE = [1, 8, 15, 22];                                    // star squares: the 4 coloured start squares
// Items live in the two empty arms (yellow and red), which both players must cross.
const ITEM_CELLS = [3, 4, 5, 6, 7, 8, 9, 17, 18, 19, 20, 21, 22, 23];
const HOMECOL = { green: [[4,1],[4,2]], yellow: [[7,4],[6,4]], blue: [[4,7],[4,6]], red: [[1,4],[2,4]] };
const BASE = { red: [0,0], green: [6,0], yellow: [6,6], blue: [0,6] };
const PAL = {   // light, main, dark
  red:    ['#ff8f9a', '#ff4757', '#c0283a'],
  green:  ['#8ff0b5', '#2ed573', '#159b4c'],
  yellow: ['#ffe17a', '#ffc312', '#c48c00'],
  blue:   ['#8cc8ff', '#1e90ff', '#0f5fb0'],
};
// Pawn position: -1 = at home base, 0..26 = on the loop (relative to own start),
// 27..28 = own coloured lane, 29 = finished (centre).
const LAST = 26, DONE = 29;
const WIN_POINTS = 3, ITEM_CAP = 2, TURN_MS = 15000;

function globalOf(color, pos) { return pos >= 0 && pos <= LAST ? (START[color] + pos) % 28 : -1; }

// Centre of a pawn's spot in board units (0..9), before stacking offsets.
function spotOf(color, i, pos) {
  if (pos < 0) {
    const [bx, by] = BASE[color];
    return [bx + 1.5 + (i % 2 ? .5 : -.5), by + 1.5 + (i < 2 ? -.5 : .5)];
  }
  if (pos === DONE) {
    const spread = [-.42, -.14, .14, .42][i];
    if (color === 'green') return [4.5 + spread, 3.95];
    if (color === 'blue') return [4.5 + spread, 5.55];
    if (color === 'red') return [3.6, 4.6 + spread];
    return [5.4, 4.6 + spread];
  }
  if (pos <= LAST) { const [x, y] = TRACK[globalOf(color, pos)]; return [x + .5, y + .5]; }
  const [x, y] = HOMECOL[color][pos - 27];
  return [x + .5, y + .5];
}

/* =====================================================================
   2. GAME RULES (pure functions: state in -> new state out)
   ===================================================================== */
const clone = (o) => JSON.parse(JSON.stringify(o));
const rand6 = () => 1 + Math.floor(Math.random() * 6);

function newPlayer(color, name) {
  return { color, name, pawns: [0, 0, -1, -1], shield: [0, 0, 0, 0], score: 0, caps: 0, items: { x2: 0, pick: 0, shield: 0 } };
}
function newGame(names, starter) {
  return {
    seq: 0, game: Math.random().toString(36).slice(2, 8),
    players: [newPlayer('blue', names[0]), newPlayer('green', names[1])],
    turn: starter, phase: 'roll', face: 0, dice: 0, x2: false, sixes: 0, burn: false,
    rollId: 0, moveId: 0, turnNo: 0, lastMove: null, winner: -1,
    // Always 3 items on the board, one of each kind at the start.
    powers: [{ type: 'x2', cell: 22 }, { type: 'pick', cell: 5 }, { type: 'shield', cell: 8 }],
  };
}
function canMovePawn(s, i) {
  if (s.phase !== 'move' || s.burn) return false;
  const pos = s.players[s.turn].pawns[i];
  if (pos === DONE) return false;
  if (pos < 0) return s.face === 6;
  return pos + s.dice <= DONE;
}
function legal(s) { return [0, 1, 2, 3].filter((i) => canMovePawn(s, i)); }

function applyRoll(s0, face, chosen) {
  const s = clone(s0), P = s.players[s.turn];
  let dice = face;
  if (chosen) { P.items.pick--; s.x2 = false; }
  else if (s.x2) { P.items.x2--; s.x2 = false; dice = face * 2; }
  s.face = face; s.dice = dice; s.rollId++;
  s.sixes = face === 6 ? s.sixes + 1 : 0;
  s.burn = s.sixes >= 3;          // three 6s in a row: turn lost
  s.phase = 'move';
  return s;
}
function applyArmX2(s0) { const s = clone(s0); s.x2 = !s.x2; return s; }
function applyShield(s0, i) {
  const s = clone(s0), P = s.players[s.turn];
  // The shield protects during the opponent's next turn only; it ends when my next turn starts.
  // The value stored is the turn number at which it expires.
  P.items.shield--; P.shield[i] = (s.turnNo || 0) + 2;
  return s;
}
function applyMove(s0, i) {
  const s = clone(s0), me = s.turn, P = s.players[me], O = s.players[1 - me];
  const from = P.pawns[i], to = from < 0 ? 0 : from + s.dice;
  P.pawns[i] = to;
  s.moveId++;
  const lm = { id: s.moveId, p: me, i, from, to, cap: [], broke: [], got: null };
  if (to <= LAST) {
    const g = globalOf(P.color, to);
    // Two or more pawns of the same colour on one square form a block: they cannot be captured.
    if (pawnsAt(O, g) >= 2) lm.blocked = true;
    else if (!SAFE.includes(g)) {
      O.pawns.forEach((op, j) => {
        if (globalOf(O.color, op) !== g) return;
        // A shielded pawn is not eaten and keeps its shield; both pawns share the square.
        if (O.shield[j]) lm.broke.push(j);
        else { O.pawns[j] = -1; P.score++; P.caps = (P.caps || 0) + 1; lm.cap.push(j); }
      });
    }
    const t = s.powers.find((w) => w.cell === g);
    if (t) { if (P.items[t.type] < ITEM_CAP) P.items[t.type]++; lm.got = t.type; t.cell = -1; }
  } else {
    P.shield[i] = 0;
  }
  if (to === DONE) P.score++;
  refillPowers(s, globalOf(P.color, to));   // a taken item comes back at once, somewhere else
  s.lastMove = lm;
  if (P.score >= WIN_POINTS) { s.phase = 'over'; s.winner = me; return s; }
  const extra = s.face === 6 || lm.cap.length > 0 || to === DONE;
  return extra ? rollAgain(s) : endTurn(s);
}
function applySkip(s0) { const s = clone(s0); return s.face === 6 && !s.burn ? rollAgain(s) : endTurn(s); }
function rollAgain(s) { s.phase = 'roll'; s.dice = 0; s.burn = false; return s; }
function endTurn(s) {
  s.turn = 1 - s.turn; s.phase = 'roll'; s.dice = 0; s.sixes = 0; s.x2 = false; s.burn = false;
  s.turnNo = (s.turnNo || 0) + 1;
  s.players.forEach((P) => { P.shield = P.shield.map((v) => (v > s.turnNo ? v : 0)); });   // expired shields go
  refillPowers(s, -1);
  return s;
}
// Put every taken item back on a free square of the yellow or red arm (no pawn, no other item,
// not the square where it was just taken). The new item is the kind the board has least of.
function refillPowers(s, avoid) {
  s.powers.forEach((t) => {
    if (t.cell >= 0) return;
    const used = new Set(s.powers.filter((w) => w.cell >= 0).map((w) => w.cell));
    s.players.forEach((P) => P.pawns.forEach((p) => used.add(globalOf(P.color, p))));
    used.add(avoid);
    const free = ITEM_CELLS.filter((g) => !used.has(g));
    if (!free.length) return;
    const kinds = ['x2', 'pick', 'shield'];
    const count = (k) => s.powers.filter((w) => w.cell >= 0 && w.type === k).length;
    const least = Math.min(...kinds.map(count));
    const options = kinds.filter((k) => count(k) === least);
    t.type = options[Math.floor(Math.random() * options.length)];
    t.cell = free[Math.floor(Math.random() * free.length)];
  });
}
// How many pawns of player P stand on loop square g.
function pawnsAt(P, g) { return P.pawns.filter((p) => globalOf(P.color, p) === g).length; }

/* ---------- Computer player (also used when time runs out) ---------- */
function threatened(s, oppIdx, g) {
  const O = s.players[oppIdx];
  return O.pawns.some((op) => {
    if (op < 0 || op > LAST) return false;
    const d = (g - globalOf(O.color, op) + 28) % 28;
    return d >= 1 && d <= 6 && op + d <= LAST;
  });
}
function scoreMove(s, i, dice) {
  const me = s.turn, P = s.players[me], O = s.players[1 - me];
  const from = P.pawns[i], to = from < 0 ? 0 : from + dice;
  let sc = to * .5 + Math.random() * 3;
  if (to === DONE) sc += 100;
  if (from < 0) sc += 55;
  if (to > LAST && to < DONE) sc += 30;
  if (to <= LAST) {
    const g = globalOf(P.color, to);
    if (SAFE.includes(g)) sc += 15;
    else if (pawnsAt(P, g) >= 1) sc += 20;      // forms a block
    else {
      if (pawnsAt(O, g) < 2) O.pawns.forEach((op, j) => { if (globalOf(O.color, op) === g) sc += O.shield[j] ? 10 : 90; });
      if (!P.shield[i] && threatened(s, 1 - me, g)) sc -= 40;
    }
    if (s.powers.some((t) => t.cell === g)) sc += 20;
  }
  if (from >= 0 && from <= LAST) {
    const gf = globalOf(P.color, from);
    if (!SAFE.includes(gf) && !P.shield[i] && threatened(s, 1 - me, gf)) sc += 25;
  }
  return sc;
}
function bestMove(s) {
  let best = -1, bs = -1e9;
  for (const i of legal(s)) { const v = scoreMove(s, i, s.dice); if (v > bs) { bs = v; best = i; } }
  return best;
}
// Computer's decision before rolling: use an item or just roll. Returns a new state.
function botRollPhase(s) {
  const P = s.players[s.turn];
  if (P.items.shield > 0) {
    const i = P.pawns.findIndex((p, k) => p >= 0 && p <= LAST && !P.shield[k] &&
      !SAFE.includes(globalOf(P.color, p)) && threatened(s, 1 - s.turn, globalOf(P.color, p)));
    if (i >= 0) return applyShield(s, i);
  }
  if (P.items.pick > 0) {
    for (let n = 6; n >= 1; n--) {
      const t = applyRoll(s, n, true);
      if (legal(t).some((i) => scoreMove(t, i, t.dice) >= 85)) return t;
    }
  }
  if (P.items.x2 > 0 && !s.x2 && Math.random() < .35) return applyArmX2(s);
  return applyRoll(s, rand6(), false);
}

/* =====================================================================
   3. ONLINE PLAY (public MQTT servers over secure websockets)
   Every message goes to all servers at once; the first copy that arrives wins.
   ===================================================================== */
const NS = 'ludomini-k7q2/v1/';
const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt', 'wss://test.mosquitto.org:8081'];
let msgCounter = 0;
const Net = {
  clients: [], topic: '', seen: new Set(), onMsg: null, onConnect: null, onStatus: null,
  open(code, onMsg, onConnect, onStatus) {
    this.close();
    this.topic = NS + code; this.onMsg = onMsg; this.onConnect = onConnect; this.onStatus = onStatus;
    if (!window.mqtt) { onStatus && onStatus(0); return; }
    BROKERS.forEach((url, k) => {
      let c;
      try {
        c = mqtt.connect(url, { clientId: 'lm_' + myId + '_' + k + '_' + Math.random().toString(36).slice(2, 6),
          clean: true, keepalive: 20, reconnectPeriod: 2500, connectTimeout: 8000 });
      } catch (e) { return; }
      c.on('connect', () => { c.subscribe(this.topic, { qos: 1 }); this.status(); this.onConnect && this.onConnect(); });
      c.on('close', () => this.status());
      c.on('offline', () => this.status());
      c.on('error', () => {});
      c.on('message', (t, buf) => { let m; try { m = JSON.parse(buf.toString()); } catch (e) { return; } this.recv(m); });
      this.clients.push(c);
    });
  },
  connectedCount() { return this.clients.filter((c) => c.connected).length; },
  status() { this.onStatus && this.onStatus(this.connectedCount()); },
  recv(m) {
    if (!m || !m.f || m.f === myId || (m.to && m.to !== myId)) return;
    const key = m.f + ':' + m.m;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > 600) this.seen = new Set([...this.seen].slice(-300));
    this.onMsg && this.onMsg(m);
  },
  send(obj) {
    obj.f = myId; obj.m = Date.now().toString(36) + '.' + (++msgCounter);
    const payload = JSON.stringify(obj);
    this.clients.forEach((c) => { try { c.publish(this.topic, payload, { qos: 1 }); } catch (e) {} });
  },
  close() { this.clients.forEach((c) => { try { c.end(true); } catch (e) {} }); this.clients = []; },
};

/* =====================================================================
   4. APP STATE, STORAGE
   ===================================================================== */
const $ = (q) => document.querySelector(q);
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} },
};
const rid = () => Math.random().toString(36).slice(2, 10);
function tabId() {   // one id per browser tab (two tabs on one phone = two players)
  try { let v = sessionStorage.getItem('lm.id'); if (!v) { v = rid(); sessionStorage.setItem('lm.id', v); } return v; }
  catch (e) { return rid(); }
}
const clean = (t) => String(t || '').replace(/[<>&"]/g, '').trim().slice(0, 14);
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let myId = tabId();
let mode = null;        // 'bot' | 'online'
let role = null;        // 'host' | 'guest'
let me = 0;             // my player index: 0 = blue, 1 = green
let S = null;           // current game state (the truth)
let code = null, peerId = null, peerName = 'Friend', myName = 'You';
let peerProf = null;    // opponent's public profile: { name, av, lvl, dk, uid }
let lastSeen = 0, inGame = false, probing = false, firstConnect = true;
let joinTimer = null, pingTimer = null, aim = null, sound = true;

function myProf() { return { name: Account.name(), av: Account.profile.av, lvl: Account.level(), dk: Account.profile.dice, uid: Account.fb ? Account.uid : null }; }
function cleanProf(p, name) {
  p = p || {};
  return { name: clean(p.name || name) || 'Friend', av: AVATARS.some((a) => a[0] === p.av) ? p.av : '😎',
           lvl: Math.max(1, Math.min(999, p.lvl | 0)), dk: DICE_SKINS[p.dk] ? p.dk : 'classic',
           uid: typeof p.uid === 'string' && p.uid.length < 129 ? p.uid : null };
}
function profOf(p) {   // profile shown for player index p
  if (p === me) return myProf();
  if (mode === 'bot') return { name: 'Computer', av: '🤖', lvl: Math.max(1, Account.level()), dk: 'classic' };
  return peerProf || cleanProf(null, peerName);
}
function persist() {
  if (mode !== 'online') return;
  store.set('lm.session', { role, code, myId, peerId, peerName, peerProf, me, S, t: Date.now() });
}
const peerOnline = () => mode !== 'online' || Date.now() - lastSeen < 12000;

/* =====================================================================
   5. HOME SCREEN, PROFILE, FRIENDS, RANKING, SHOP, ACCOUNT
   ===================================================================== */
function show(id) { document.querySelectorAll('.screen').forEach((e) => e.classList.toggle('active', e.id === id)); }
function toast(t, ms = 2400) {
  const el = $('#toast'); el.textContent = t; el.style.display = 'block';
  clearTimeout(toast.h); toast.h = setTimeout(() => (el.style.display = 'none'), ms);
}

function renderHome() {
  const p = Account.profile, L = levelInfo(p.xp);
  $('#p-av').textContent = p.av;
  $('#p-name').innerHTML = esc(p.name || 'Tap to set your name') + ' <small>✎</small>';
  $('#p-lvl').textContent = 'Lv.' + L.lvl;
  $('#p-bar').style.width = Math.round(100 * L.cur / L.need) + '%';
  $('#p-xp').textContent = L.cur + '/' + L.need;
  const c = $('#p-coins span'), old = +c.textContent || 0;
  if (old !== p.coins) { animateNumber(c, old, p.coins); if (renderHome.done) $('#p-coins').classList.add('bump'); setTimeout(() => $('#p-coins').classList.remove('bump'), 600); }
  renderHome.done = true;
  $('#btn-gift').style.display = Account.canClaimDaily() ? '' : 'none';
  const a = $('#btn-account');
  if (!Account.fb) {
    a.className = 'acct';
    a.innerHTML = Account.fbError ? '☁️ <span>Online accounts are not available right now: your progress is saved on this phone.</span>' : '☁️ <span>Connecting…</span>';
  } else if (Account.isGuest) {
    a.className = 'acct';
    a.innerHTML = '👤 <span>Playing as a guest. <b>Create an account</b> to keep your level and coins on any phone.</span>';
  } else {
    a.className = 'acct ok';
    a.innerHTML = '✅ <span>Progress saved · ' + esc(Account.accountLabel()) + '</span>';
  }
}
function animateNumber(el, from, to) {
  const t0 = performance.now(), d = 700;
  const step = (t) => { const k = Math.min(1, (t - t0) / d); el.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3))); if (k < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
Account.onChange(renderHome);

function needName(then) {
  if (Account.profile.name) return then();
  editName(then);
}
function editName(then) {
  sheet(`<h3>Your name</h3><input id="name-in" class="field" maxlength="14" placeholder="Your name" value="${esc(Account.profile.name)}" autocomplete="off">`,
    [['Save', () => { const v = $('#name-in').value; if (!clean(v)) return; Account.setName(v); closeSheet(); if (then) then(); }]], 'form');
  setTimeout(() => $('#name-in').focus(), 100);
}
$('#p-name').onclick = () => editName();
$('#p-av').onclick = () => {
  const lvl = Account.level();
  const html = AVATARS.map(([a, need]) => `<button class="gbtn ${a === Account.profile.av ? 'sel' : ''} ${need > lvl ? 'locked' : ''}" data-a="${a}">${a}${need > lvl ? `<small>🔒 Lv.${need}</small>` : ''}</button>`).join('');
  sheet('<h3>Choose your picture</h3><div class="grid-btns">' + html + '</div><p class="muted">Play more to unlock the locked ones.</p>', [['Close', closeSheet]], 'form');
  document.querySelectorAll('#sheet [data-a]').forEach((b) => (b.onclick = () => {
    if (Account.setAvatar(b.dataset.a)) { sfx('pop'); closeSheet(); } else toast('Reach the level shown to unlock it');
  }));
};
$('#btn-gift').onclick = () => {
  const n = Account.claimDaily(); if (!n) return;
  sfx('finish'); confetti(40);
  sheet(`<div class="trophy">🎁</div><div class="win-title">+${n} <b class="coin" style="vertical-align:middle"></b></div><p>Come back tomorrow for another gift!</p>`, [['Great!', closeSheet]]);
};
$('#btn-rules').onclick = () => sheet(`<h3>How to play</h3><div class="rules"><ul>
  <li>Each player has 4 pawns: 2 start on the board, 2 wait at home.</li>
  <li>Roll a 6 to bring a pawn out. A 6 gives another roll.</li>
  <li>Land on an opponent to send it home: <b>+1 point</b> and another roll.</li>
  <li>Bring a pawn to the centre: <b>+1 point</b>. First to <b>3 points</b> wins.</li>
  <li>The 4 coloured start squares (stars) are safe: no pawn can be eaten there.</li>
  <li>Two of your pawns on the same square make a <b>block</b>: they cannot be eaten.</li>
  <li>3 items wait in the yellow and red arms. Stop on one to take it; a new one appears at once.
    <b>Double</b> doubles your next roll, <b>Choose</b> lets you pick the number, <b>Shield</b> protects one pawn until your next turn.</li>
  <li>You have 15 seconds per action, then the game plays for you.</li>
  <li>Win games to earn XP (levels) and coins. Spend coins in the shop.</li></ul></div>`, [['Got it', closeSheet]]);

$('#btn-shop').onclick = openShop;
function openShop() {
  const p = Account.profile;
  const html = Object.entries(DICE_SKINS).map(([k, [nm, price]]) => {
    const own = p.owned.includes(k), used = p.dice === k;
    return `<button class="gbtn ${used ? 'sel' : ''}" data-k="${k}"><div class="skin-${k}"><div class="dice">${'<i class="pip"></i>'.repeat(9)}</div></div>
      <small>${nm}</small><small>${used ? '✓ In use' : own ? 'Use' : `<b class="coin" style="width:14px;height:14px;vertical-align:middle"></b> ${price}`}</small></button>`;
  }).join('');
  sheet(`<h3>Shop · dice styles</h3><p class="muted" style="margin-top:0">You have <b>${p.coins}</b> coins. Your friends see your dice too.</p><div class="grid-btns three">${html}</div>`, [['Close', closeSheet]], 'form');
  document.querySelectorAll('#sheet [data-k]').forEach((b) => {
    setFace(b.querySelector('.dice'), 5);
    b.onclick = () => {
      const r = Account.buyDice(b.dataset.k);
      if (r === 'poor') { toast('Not enough coins: win games to earn more'); return; }
      if (r === 'bought') { sfx('finish'); confetti(30); }
      openShop();
    };
  });
}

$('#btn-account').onclick = openAccount;
function openAccount() {
  if (!Account.fb) { toast('Online accounts are not available right now. Your progress is saved on this phone.', 3500); return; }
  if (!Account.isGuest) {
    sheet(`<h3>Your account</h3><p>Signed in as <b>${esc(Account.accountLabel())}</b>.</p><p class="muted">Your friend code: <b>${Account.profile.code}</b></p>`,
      [['Sign out', async () => { closeSheet(); await Account.signOut(); toast('Signed out'); }], ['Close', closeSheet]]);
    return;
  }
  sheet(`<h3>Save your progress</h3>
    <p class="muted" style="margin-top:0">Keep your level, coins and friends on any phone.</p>
    <button id="g-btn" class="btn google"><svg width="20" height="20" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>Continue with Google</button>
    <p class="muted" style="margin:12px 0 6px">or with email</p>
    <input id="em" class="field" type="email" placeholder="Email" autocomplete="email" style="margin-bottom:8px">
    <input id="pw" class="field" type="password" placeholder="Password (6+ characters)" autocomplete="current-password">
    <div class="row" style="margin-top:10px"><button id="em-new" class="btn small alt" style="flex:1">Create account</button><button id="em-in" class="btn small ghost" style="flex:1">Sign in</button></div>
    <div id="acc-err" class="err"></div>`, [['Close', closeSheet]], 'form');
  const err = (e) => {
    const m = {
      'auth/popup-blocked': 'The sign-in window was blocked. Allow pop-ups, or open this page in Chrome.',
      'auth/popup-closed-by-user': 'Sign-in cancelled.',
      'auth/operation-not-supported-in-this-environment': 'Open this page in Chrome or Safari to sign in with Google.',
      'auth/unauthorized-domain': 'This website is not allowed yet in Firebase (Authorized domains).',
      'auth/email-already-in-use': 'This email already has an account: tap "Sign in".',
      'auth/credential-already-in-use': 'This email already has an account: tap "Sign in".',
      'auth/invalid-email': 'This email is not valid.',
      'auth/weak-password': 'The password needs at least 6 characters.',
      'auth/invalid-credential': 'Wrong email or password.', 'auth/wrong-password': 'Wrong email or password.', 'auth/user-not-found': 'No account with this email: tap "Create account".',
      'auth/operation-not-allowed': 'This sign-in method is not switched on in Firebase yet.',
    }[e.code] || ('Could not sign in (' + (e.code || e.message) + ').');
    if (e.code !== 'auth/popup-closed-by-user') $('#acc-err').textContent = m;
  };
  const done = (r) => { closeSheet(); sfx('finish'); confetti(50); toast(r === 'switched' ? 'Welcome back! Your saved account is loaded.' : 'Account saved! 🎉'); };
  $('#g-btn').onclick = () => { $('#acc-err').textContent = ''; Account.google().then(done, err); };
  const creds = () => [$('#em').value.trim(), $('#pw').value];
  $('#em-new').onclick = () => { $('#acc-err').textContent = ''; Account.emailCreate(...creds()).then(done, err); };
  $('#em-in').onclick = () => {
    $('#acc-err').textContent = '';
    Account.emailSignIn(...creds()).then(() => done('switched'), err);
  };
}

$('#btn-friends').onclick = openFriends;
async function openFriends() {
  $('#btn-friends').classList.remove('has-dot');
  if (!Account.fb) { toast('Friends need an online account: not available right now.', 3000); return; }
  sheet('<h3>Friends</h3><div class="spinner"></div>', [['Close', closeSheet]], 'friends');
  let list = [];
  try { list = await Account.friends(); } catch (e) { console.warn(e); }
  if (sheet.kind !== 'friends') return;
  const rows = list.length ? list.map((f) => `<div class="li"><div class="av ${f.online ? 'on' : ''}">${esc(f.av || '😎')}</div>
      <div class="nm2">${esc(f.name)}<small>Lv.${levelOf(f.xp || 0)} · ${f.online ? 'online now' : 'offline'}</small></div>
      <button class="btn small ${f.online ? '' : 'ghost'}" data-inv="${f.uid}" data-nm="${esc(f.name)}">Invite</button></div>`).join('')
    : '<p class="muted">No friends yet. Share your code, or add a friend after a game.</p>';
  sheet(`<h3>Friends</h3>
    <p class="muted" style="margin:0">Your friend code</p><div class="mycode">${Account.profile.code}</div>
    <div class="row" style="margin:10px 0"><input id="fcode" class="field" maxlength="6" placeholder="Friend's code" style="text-transform:uppercase"><button id="fadd" class="btn small alt">Add</button></div>
    <div class="list">${rows}</div><div id="f-err" class="err"></div>`, [['Close', closeSheet]], 'friends');
  $('#fadd').onclick = async () => {
    try { const n = await Account.addFriendByCode($('#fcode').value); toast(n + ' is now your friend!'); sfx('finish'); openFriends(); }
    catch (e) { $('#f-err').textContent = e.message === 'notfound' ? 'No player with this code.' : e.message === 'self' ? 'That is your own code.' : 'Could not add (' + (e.code || e.message) + ')'; }
  };
  document.querySelectorAll('#sheet [data-inv]').forEach((b) => (b.onclick = () => needName(async () => {
    closeSheet(); unlockAudio(); createRoom();
    try { await Account.invite(b.dataset.inv, code); toast('Invitation sent to ' + b.dataset.nm); }
    catch (e) { toast('Could not send the invitation. Share the code instead.'); }
  })));
}
// Someone invites me (called by Account when an invitation arrives).
function showInvite(d, consume) {
  if (inGame) { consume(); return; }
  const el = $('#invite');
  el.innerHTML = `<div class="row"><div class="li" style="background:none;padding:0;flex:1"><div class="av">${esc(d.av || '😎')}</div><div class="nm2">${esc(d.name)}<small>invites you to play</small></div></div>
    <button class="btn small green" id="inv-ok">Play</button><button class="btn small ghost" id="inv-no">✕</button></div>`;
  el.style.display = 'block'; sfx('pop'); vibrate([60, 60, 60]);
  $('#inv-ok').onclick = () => { el.style.display = 'none'; consume(); needName(() => { unlockAudio(); joinRoom(String(d.room)); }); };
  $('#inv-no').onclick = () => { el.style.display = 'none'; consume(); };
  clearTimeout(showInvite.h); showInvite.h = setTimeout(() => { el.style.display = 'none'; }, 60000);
}

$('#btn-top').onclick = async () => {
  if (!Account.fb) { toast('The ranking needs online accounts: not available right now.', 3000); return; }
  sheet('<h3>Ranking</h3><div class="spinner"></div>', [['Close', closeSheet]], 'top');
  let list = [];
  try { list = await Account.leaderboard(); } catch (e) { console.warn(e); }
  if (sheet.kind !== 'top') return;
  const medal = ['🥇', '🥈', '🥉'];
  const rows = list.map((u, k) => `<div class="li ${u.uid === Account.uid ? 'me' : ''}"><span class="rank">${medal[k] || k + 1}</span><div class="av ${u.online ? 'on' : ''}">${esc(u.av || '😎')}</div>
    <div class="nm2">${esc(u.name)}<small>${u.wins || 0} wins</small></div><span class="lvl">Lv.${levelOf(u.xp || 0)}</span></div>`).join('');
  sheet('<h3>Top players</h3><div class="list">' + (rows || '<p class="muted">No players yet.</p>') + '</div>', [['Close', closeSheet]], 'top');
};

/* ---------- Play buttons ---------- */
function initMenu() {
  const q = new URLSearchParams(location.search).get('room');
  if (q && /^\d{4}$/.test(q)) $('#join-code').value = q;
  const sess = store.get('lm.session');
  const b = $('#btn-resume');
  if (sess && sess.S && Date.now() - sess.t < 3 * 3600e3 && sess.S.phase !== 'over') {
    b.style.display = 'block'; b.textContent = '▶ Resume game (room ' + sess.code + ')';
  } else b.style.display = 'none';
  renderHome();
}
$('#btn-create').onclick = () => needName(() => { unlockAudio(); createRoom(); });
$('#btn-join').onclick = () => {
  const c = $('#join-code').value.trim();
  if (!/^\d{4}$/.test(c)) { $('#menu-err').textContent = 'Enter the 4-digit code of your friend.'; return; }
  needName(() => { unlockAudio(); joinRoom(c); });
};
$('#join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-join').click(); });
$('#btn-bot').onclick = () => needName(() => { unlockAudio(); startBot(); });
$('#btn-resume').onclick = () => { unlockAudio(); resume(); };
$('#btn-cancel').onclick = () => { stopJoin(); Net.close(); store.del('lm.session'); backToMenu(); };
$('#btn-share').onclick = shareInvite;

function backToMenu(msg) {
  inGame = false; mode = null; S = null; aim = null; chatLog = [];
  clearInterval(pingTimer); clearTimers(); closeSheet();
  $('#menu-err').textContent = msg || '';
  initMenu();
  show('menu');
}
function inviteLink() { return location.origin + location.pathname + '?room=' + code; }
async function shareInvite() {
  const text = 'Play Ludo with me! Room code: ' + code;
  try {
    if (navigator.share) { await navigator.share({ title: 'Ludo Mini', text, url: inviteLink() }); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(text + '\n' + inviteLink()); toast('Invite link copied'); }
  catch (e) { toast('Code: ' + code); }
}
function setNetStatus(n) {
  const ok = n > 0;
  ['#wait-net', '#net-chip'].forEach((q) => {
    const el = $(q); el.classList.toggle('ok', ok);
    el.querySelector('span').textContent = q === '#net-chip' ? (ok ? 'Online' : 'Offline')
      : ok ? 'Connected to the game server' : 'Connecting to the game server…';
  });
}

/* ---------- Host ---------- */
function createRoom() {
  mode = 'online'; role = 'host'; me = 0; S = null; peerId = null; peerProf = null; inGame = false; firstConnect = true;
  myName = Account.name();
  code = String(1000 + Math.floor(Math.random() * 9000));
  $('#wait-host').style.display = ''; $('#wait-guest').style.display = 'none';
  $('#wait-code').textContent = code; $('#wait-msg').textContent = 'Waiting for your friend…';
  show('wait');
  Net.open(code, onNet, onNetConnect, setNetStatus);
}
/* ---------- Guest ---------- */
function joinRoom(c) {
  mode = 'online'; role = 'guest'; me = 1; S = null; peerId = null; peerProf = null; inGame = false; firstConnect = true; code = c;
  myName = Account.name();
  $('#wait-host').style.display = 'none'; $('#wait-guest').style.display = '';
  $('#wait-gcode').textContent = code; $('#wait-msg').textContent = 'Looking for the game…';
  show('wait');
  Net.open(code, onNet, onNetConnect, setNetStatus);
  const deadline = Date.now() + 25000;
  stopJoin();
  joinTimer = setInterval(() => {
    if (Date.now() > deadline) {
      stopJoin(); Net.close(); store.del('lm.session');
      backToMenu('No game found with code ' + code + '. Check the code: your friend must keep the game open on their screen.');
      return;
    }
    sendJoin();
  }, 2000);
}
function sendJoin() { if (role === 'guest') Net.send({ t: 'join', name: myName, prof: myProf() }); }
function stopJoin() { clearInterval(joinTimer); joinTimer = null; }

/* ---------- Resume after closing / reloading the page ---------- */
function resume() {
  const s = store.get('lm.session'); if (!s) return backToMenu();
  mode = 'online'; role = s.role; code = s.code; me = s.me; peerId = s.peerId; peerName = s.peerName; peerProf = s.peerProf || null; S = s.S;
  myId = s.myId; try { sessionStorage.setItem('lm.id', myId); } catch (e) {}
  myName = Account.name();
  firstConnect = false; lastSeen = Date.now();
  Net.open(code, onNet, onNetConnect, setNetStatus);
  enterGame();
}

function onNetConnect() {
  if (role === 'host' && firstConnect && !inGame) {
    firstConnect = false; probing = true;
    Net.send({ t: 'probe' });
    setTimeout(() => (probing = false), 2500);
  }
  if (role === 'guest' && !inGame) sendJoin();
  if (inGame) Net.send({ t: 'sync', prof: myProf() });
}

function onNet(m) {
  if (peerId && m.f === peerId) lastSeen = Date.now();
  switch (m.t) {
    case 'probe':      // someone else is creating this same code: tell them it is taken
      if (role === 'host') Net.send({ t: 'busy', to: m.f });
      break;
    case 'busy':
      if (probing && role === 'host' && !peerId) { probing = false; createRoom(); }
      break;
    case 'join':
      if (role !== 'host') break;
      if (peerId && peerId !== m.f) { Net.send({ t: 'full', to: m.f }); break; }
      peerId = m.f; peerProf = cleanProf(m.prof, m.name); peerName = peerProf.name; lastSeen = Date.now();
      if (!S) { S = newGame([myName, peerName], Math.random() < .5 ? 0 : 1); S.seq = 1; }
      Net.send({ t: 'welcome', to: m.f, name: myName, prof: myProf(), s: S });
      persist();
      if (!inGame) enterGame(); else if (shown) paint(shown);
      break;
    case 'welcome':
      if (role !== 'guest' || (peerId && peerId !== m.f) || !m.s) break;
      stopJoin();
      peerId = m.f; peerProf = cleanProf(m.prof, m.name); peerName = peerProf.name; lastSeen = Date.now();
      if (!S || m.s.game !== S.game || m.s.seq >= S.seq) S = m.s;
      else Net.send({ t: 'state', s: S });
      persist();
      if (!inGame) enterGame(); else push(S);
      break;
    case 'full':
      if (role === 'guest' && !inGame) { stopJoin(); Net.close(); backToMenu('This room already has two players.'); }
      break;
    case 'state':
      if (m.f !== peerId || !m.s) break;
      // Newest state wins; on a tie the host's version wins.
      if (!S || m.s.seq > S.seq || (m.s.seq === S.seq && role === 'guest' && JSON.stringify(m.s) !== JSON.stringify(S))) {
        S = m.s; persist(); if (inGame) push(S);
      }
      break;
    case 'sync':
      if (m.f === peerId && S) {
        if (m.prof) { peerProf = cleanProf(m.prof, peerName); persist(); }
        Net.send({ t: 'state', to: m.f, s: S });
      }
      break;
    case 'emoji':
    case 'chat':
      if (m.f === peerId) {
        const x = m.t === 'emoji' ? String(m.x || '').slice(0, 8) : cleanMsg(m.x);
        if (!x) break;
        bubble(1, x, m.t === 'emoji'); sfx('pop'); vibrate(40);
        if (m.t === 'chat') { addChat(peerName, x, false); if (sheet.kind !== 'chat') $('#btn-chat').classList.add('unread'); }
      }
      break;
    case 'rematch':
      if (role === 'host' && m.f === peerId && S && S.phase === 'over') startRematch();
      break;
    case 'leave':
      if (m.f === peerId) { Net.close(); store.del('lm.session'); clearTimers(); sheet(`<div class="win-title">😕</div><p>${esc(peerName)} left the game.</p>`, [['Menu', () => backToMenu()]]); }
      break;
  }
}

/* ---------- Vs computer ---------- */
function startBot() {
  mode = 'bot'; role = null; me = 0; peerName = 'Computer'; myName = Account.name();
  S = newGame([myName, 'Computer'], Math.random() < .5 ? 0 : 1); S.seq = 1;
  enterGame();
}
function startRematch() {
  const ns = newGame([S.players[0].name, S.players[1].name], S.winner === 0 ? 1 : 0);
  commit(ns);
}

/* =====================================================================
   6. RENDERING AND ANIMATIONS
   ===================================================================== */
const pct = (v) => (v * 100 / 9) + '%';
let flip = false;                 // guest sees the board turned so that their pawns are at the bottom
const V = (x, y) => (flip ? [9 - x, 9 - y] : [x, y]);
let pawnEls = [[], []];
let shown = null, busy = false, queue = Promise.resolve();

function pawnSVG(color) {
  const d = PAL[color][2];
  return `<svg viewBox="0 0 40 52" aria-hidden="true">
    <ellipse cx="20" cy="47" rx="14" ry="4" fill="rgba(0,0,0,.35)"/>
    <path d="M7 45 C7 41 12 39 14 33 L16 27 L24 27 L26 33 C28 39 33 41 33 45 C33 48.5 7 48.5 7 45Z" fill="url(#bd-${color})" stroke="${d}" stroke-width="1.3"/>
    <circle cx="20" cy="17" r="11" fill="url(#hd-${color})" stroke="${d}" stroke-width="1.3"/>
    <ellipse cx="16" cy="12.5" rx="4" ry="2.6" fill="#fff" opacity=".7"/></svg>`;
}
// Item pictures: two dice (double), a die with a pin (choose), a pawn under a glass dome (shield).
function dieSVG(x, y, w, rot, pips) {
  const p = { 3: [[.25, .25], [.5, .5], [.75, .75]], 4: [[.27, .27], [.73, .27], [.27, .73], [.73, .73]], 5: [[.25, .25], [.75, .25], [.5, .5], [.25, .75], [.75, .75]] }[pips];
  return `<g transform="rotate(${rot} ${x + w / 2} ${y + w / 2})"><rect x="${x}" y="${y}" width="${w}" height="${w}" rx="${w * .22}" fill="#fff" stroke="#b8c0d4" stroke-width="1"/>` +
    p.map(([a, b]) => `<circle cx="${x + a * w}" cy="${y + b * w}" r="${w * .09}" fill="#23263a"/>`).join('') + '</g>';
}
function iconSVG(type) {
  if (type === 'x2') return `<svg viewBox="0 0 40 40">${dieSVG(4, 13, 18, -14, 3)}${dieSVG(17, 8, 18, 12, 5)}</svg>`;
  if (type === 'pick') return `<svg viewBox="0 0 40 40">${dieSVG(9, 14, 22, 0, 4)}
    <line x1="20" y1="9" x2="20" y2="21" stroke="#5b6170" stroke-width="2"/><circle cx="20" cy="8" r="5" fill="#ff4b3e" stroke="#a91f16"/><circle cx="18.4" cy="6.4" r="1.6" fill="#fff" opacity=".8"/></svg>`;
  return `<svg viewBox="0 0 40 40"><rect x="7" y="30" width="26" height="6" rx="2.5" fill="#2a5fc0" stroke="#fff" stroke-width="1"/>
    <path d="M15 31 C15 27 17.5 25 18 22 L22 22 C22.5 25 25 27 25 31Z" fill="#e8453c"/><circle cx="20" cy="18.5" r="4.5" fill="#ff6a5e"/>
    <path d="M8.5 30.5 V20 A11.5 11.5 0 0 1 31.5 20 V30.5Z" fill="rgba(210,240,255,.35)" stroke="#e6f7ff" stroke-width="1.6"/>
    <path d="M12 21 A8 8 0 0 1 17 13" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" opacity=".8"/></svg>`;
}
const orbHTML = (type) => '<div class="orb">' + iconSVG(type) + '</div>';
function initGradients() {
  $('#grad-defs').innerHTML = Object.entries(PAL).map(([c, [l, m, d]]) => `
    <radialGradient id="hd-${c}" cx="35%" cy="30%" r="75%"><stop offset="0" stop-color="${l}"/><stop offset=".55" stop-color="${m}"/><stop offset="1" stop-color="${d}"/></radialGradient>
    <linearGradient id="bd-${c}" x1="0" x2="1"><stop offset="0" stop-color="${d}"/><stop offset=".35" stop-color="${l}"/><stop offset=".7" stop-color="${m}"/><stop offset="1" stop-color="${d}"/></linearGradient>`).join('');
  $('#logo-pawns').innerHTML = ['red', 'green', 'yellow', 'blue'].map(pawnSVG).join('');
  document.querySelectorAll('.orb[data-icon]').forEach((o) => (o.innerHTML = iconSVG(o.dataset.icon)));
}

function place(el, x, y, w, h) {   // rectangle in logical board units
  const X = flip ? 9 - x - w : x, Y = flip ? 9 - y - h : y;
  el.style.left = pct(X); el.style.top = pct(Y); el.style.width = pct(w); el.style.height = pct(h);
}
function add(cls, html) { const el = document.createElement('div'); el.className = cls; if (html) el.innerHTML = html; $('#board').appendChild(el); return el; }

function buildBoard() {
  flip = mode === 'online' && me === 1;
  $('#board').innerHTML = '';
  const active = S.players.map((p) => p.color);
  const R = 'calc(var(--c) * .16)';
  Object.entries(BASE).forEach(([c, [bx, by]]) => {
    const b = add('base', '<div class="base-inner"></div>');
    b.style.background = `linear-gradient(145deg, ${PAL[c][0]} -40%, ${PAL[c][1]} 45%, ${PAL[c][2]} 160%)`;
    place(b, bx, by, 3, 3);
    const vx = flip ? 6 - bx : bx, vy = flip ? 6 - by : by;   // where the base is on screen
    b.style.borderRadius = [vx === 0 && vy === 0, vx === 6 && vy === 0, vx === 6 && vy === 6, vx === 0 && vy === 6].map((k) => (k ? R : '0')).join(' ');
    for (let i = 0; i < 4; i++) {
      const [sx, sy] = spotOf(c, i, -1), s = add('slot');
      const [X, Y] = V(sx, sy);
      s.style.left = pct(X); s.style.top = pct(Y); s.style.width = pct(.62); s.style.height = pct(.62);
    }
    if (active.includes(c)) {
      // Name on the outer edge of the base, points on the inner edge.
      const k = active.indexOf(c), side = vx === 0 ? 'l' : 'r';
      const put = (el, y) => { el.style.left = pct(vx); el.style.top = pct(y); el.style.width = pct(3); el.style.height = pct(.42); };
      put(add('tag ' + side, `<span class="pts" id="pts-${k}"></span>`), vy + (vy === 0 ? 2.55 : 0.03));
      put(add('tag ' + side, `<span class="nm" id="bname-${k}"></span>`), vy + (vy === 0 ? 0.03 : 2.55));
    }
  });
  const lane = (cell, c) => { cell.classList.add('lane'); cell.style.background = `linear-gradient(${PAL[c][0]} -60%, ${PAL[c][1]} 40%, ${PAL[c][2]} 200%)`; };
  TRACK.forEach(([x, y], g) => {
    const cell = add('cell'); place(cell, x, y, 1, 1);
    const col = Object.keys(START).find((c) => START[c] === g);
    if (col) { lane(cell, col); if (SAFE.includes(g)) cell.classList.add('star'); }
  });
  Object.entries(HOMECOL).forEach(([c, cells]) => cells.forEach(([x, y]) => {
    const cell = add('cell'); place(cell, x, y, 1, 1); lane(cell, c);
  }));
  paint.tok = null;
  const ctr = add('center', `<svg viewBox="0 0 3 3" style="${flip ? 'transform:rotate(180deg)' : ''}">
    <defs>${['green', 'yellow', 'blue', 'red'].map((c) => `<linearGradient id="tri-${c}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${PAL[c][0]}"/><stop offset="1" stop-color="${PAL[c][1]}"/></linearGradient>`).join('')}</defs>
    <polygon points="0,0 3,0 1.5,1.5" fill="url(#tri-green)"/><polygon points="3,0 3,3 1.5,1.5" fill="url(#tri-yellow)"/>
    <polygon points="0,3 3,3 1.5,1.5" fill="url(#tri-blue)"/><polygon points="0,0 0,3 1.5,1.5" fill="url(#tri-red)"/>
    <circle cx="1.5" cy="1.5" r=".18" fill="#fff" opacity=".85"/></svg>`);
  place(ctr, 3, 3, 3, 3);
  pawnEls = [[], []];
  S.players.forEach((P, p) => {
    for (let i = 0; i < 4; i++) {
      const el = add('pawn', pawnSVG(P.color));
      el.onclick = () => onPawn(p, i);
      pawnEls[p].push(el);
    }
  });
  ['#seat-0', '#seat-1'].forEach((q) => { $(q + ' .dice').innerHTML = '<i class="pip"></i>'.repeat(9); });
  $('#seat-0 .dicebox').onclick = onDice;
}

const PIPS = { 1: [4], 2: [2, 6], 3: [2, 4, 6], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
function setFace(diceEl, face) { diceEl.querySelectorAll('.pip').forEach((p, k) => p.classList.toggle('on', (PIPS[face] || []).includes(k))); }
const seatOf = (p) => (p === me ? 0 : 1);
const seatEl = (p) => $('#seat-' + seatOf(p));

// Pawn positions with small offsets when several pawns share a square.
function layout(s) {
  const groups = {}, out = [[], []];
  s.players.forEach((P, p) => P.pawns.forEach((pos, i) => {
    const [x, y] = spotOf(P.color, i, pos);
    out[p][i] = [x, y];
    if (pos >= 0 && pos < DONE) { const k = x + ',' + y; (groups[k] = groups[k] || []).push([p, i]); }
  }));
  const OFF = { 2: [[-.17, 0], [.17, 0]], 3: [[-.17, -.12], [.17, -.12], [0, .14]], 4: [[-.17, -.12], [.17, -.12], [-.17, .14], [.17, .14]] };
  Object.values(groups).forEach((g) => {
    if (g.length < 2) return;
    const offs = OFF[Math.min(g.length, 4)];
    g.forEach(([p, i], k) => { const o = offs[k % offs.length]; out[p][i] = [out[p][i][0] + o[0], out[p][i][1] + o[1]]; });
  });
  return out;
}
function putPawn(el, x, y) {
  const [X, Y] = V(x, y);
  el.style.left = pct(X); el.style.top = pct(Y); el.style.zIndex = 10 + Math.round(Y * 10);
}
function floatText(x, y, text) {
  const el = add('float', esc(text)); const [X, Y] = V(x, y);
  el.style.left = pct(X); el.style.top = pct(Y);
  setTimeout(() => el.remove(), 1200);
}
// Little sparks flying out from a board spot.
function burst(x, y, colors, n = 14, stars) {
  const [X, Y] = V(x, y), c = $('#board').clientWidth / 9;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + Math.random() * .4, r = c * (.9 + Math.random() * 1.1);
    const el = add('spark' + (stars && k % 2 ? ' star' : ''), stars && k % 2 ? '★' : '');
    el.style.left = pct(X); el.style.top = pct(Y);
    el.style.background = colors[k % colors.length];
    el.style.setProperty('--dx', Math.cos(a) * r + 'px'); el.style.setProperty('--dy', Math.sin(a) * r + 'px');
    setTimeout(() => el.remove(), 800);
  }
}
function confetti(n = 80) {
  const cols = ['#ff4757', '#2ed573', '#ffc312', '#1e90ff', '#ff3d8b', '#ffffff', '#7a5cff'];
  for (let k = 0; k < n; k++) {
    const el = document.createElement('div');
    el.className = 'confetti';
    el.style.left = Math.random() * 100 + 'vw';
    el.style.background = cols[k % cols.length];
    el.style.borderRadius = k % 3 ? '2px' : '50%';
    el.style.animationDuration = 1.6 + Math.random() * 1.8 + 's';
    el.style.animationDelay = Math.random() * .6 + 's';
    el.style.setProperty('--dx', (Math.random() - .5) * 40 + 'vw');
    el.style.setProperty('--rot', (Math.random() * 1080 - 540) + 'deg');
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }
}
function banner(text, cls) {
  const b = $('#banner');
  b.textContent = text; b.className = cls || '';
  void b.offsetWidth; b.classList.add('go');
}
// An item picked up on the board flies down into its button.
function flyToItem(type, x, y) {
  const board = $('#board').getBoundingClientRect(), [X, Y] = V(x, y), btn = $('#it-' + type + ' .orb');
  const t = btn.getBoundingClientRect(), size = board.width / 9 * .8;
  const sx = board.left + X * board.width / 9 - size / 2, sy = board.top + Y * board.height / 9 - size / 2;
  const el = document.createElement('div');
  el.className = 'flyer'; el.innerHTML = orbHTML(type);
  Object.assign(el.style, { left: sx + 'px', top: sy + 'px', width: size + 'px', height: size + 'px' });
  document.body.appendChild(el);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const k = t.width / size;
    el.style.transform = `translate(${t.left - sx + (t.width - size) / 2}px, ${t.top - sy + (t.height - size) / 2}px) scale(${k})`;
  }));
  setTimeout(() => { el.remove(); const b = $('#it-' + type); b.classList.remove('gain'); void b.offsetWidth; b.classList.add('gain'); sfx('pop'); }, 720);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function push(s) {
  const snap = clone(s);
  queue = queue.then(() => draw(snap)).catch((e) => console.error(e));
}
async function draw(s) {
  busy = true;
  const prev = shown;
  const sameGame = prev && prev.game === s.game;
  if (sameGame && s.rollId !== prev.rollId && s.rollId > 0) await animDice(s);
  if (sameGame && s.lastMove && (!prev.lastMove || s.lastMove.id !== prev.lastMove.id)) await animMove(prev, s);
  shown = s;
  paint(s);
  busy = false;
  afterPaint(s);
}
async function animDice(s) {
  const box = seatEl(s.turn).querySelector('.dicebox'), d = box.querySelector('.dice');
  box.classList.add('on'); box.classList.remove('ready', 'dim');
  d.classList.remove('land'); d.classList.add('rolling'); sfx('dice');
  for (let k = 0; k < 7; k++) { setFace(d, rand6()); await wait(80); }
  d.classList.remove('rolling');
  setFace(d, s.face); void d.offsetWidth; d.classList.add('land');
  box.classList.toggle('doubled', s.dice > s.face);
  if (s.burn) banner('Three 6s!', 'gold');
  else if (s.face === 6) { banner(s.turn === me ? '6! Roll again' : '6!', 'gold'); sfx('six'); }
  await wait(180);
}
async function animMove(prev, s) {
  const lm = s.lastMove, P = s.players[lm.p], el = pawnEls[lm.p][lm.i];
  el.classList.remove('fly', 'can');
  const steps = lm.from < 0 ? [0] : Array.from({ length: lm.to - lm.from }, (_, k) => lm.from + 1 + k);
  if (lm.from < 0) { const [x, y] = spotOf(P.color, lm.i, 0); burst(x, y, [PAL[P.color][0], '#fff'], 10); }
  for (const pos of steps) {
    const [x, y] = spotOf(P.color, lm.i, pos);
    putPawn(el, x, y);
    el.classList.remove('hop'); void el.offsetWidth; el.classList.add('hop');
    sfx('step', pos);
    await wait(lm.to === DONE && pos === DONE ? 240 : 165);
  }
  el.classList.remove('hop');
  const [lx, ly] = spotOf(P.color, lm.i, lm.to);
  if (lm.cap.length) {
    sfx('capture'); vibrate(120);
    const O = s.players[1 - lm.p];
    burst(lx, ly, [PAL[O.color][1], PAL[O.color][0], '#fff', '#ffc312'], 20);
    floatText(lx, ly, lm.p === me ? 'Gotcha! +1' : 'Ouch!');
    const b = $('#board'); b.classList.remove('shake'); void b.offsetWidth; b.classList.add('shake');
  }
  if (lm.broke.length) { sfx('shield'); floatText(lx, ly, '🛡️ Protected!'); burst(lx, ly, ['#9ee8ff', '#fff'], 12); }
  if (lm.blocked) { sfx('shield'); floatText(lx, ly, '🧱 Blocked!'); burst(lx, ly, ['#fff', PAL[s.players[1 - lm.p].color][1]], 10); }
  if (lm.to === DONE) { sfx('finish'); floatText(lx, ly, '+1 ⭐'); burst(lx, ly, ['#ffc312', '#fff', PAL[P.color][1]], 22, true); if (lm.p === me) confetti(35); }
  if (lm.got) {
    if (lm.p === me) flyToItem(lm.got, lx, ly);
    else {
      sfx('pop');
      const f = add('float', orbHTML(lm.got)), [X, Y] = V(lx, ly - .3);
      f.style.left = pct(X); f.style.top = pct(Y); f.style.width = f.style.height = 'calc(var(--c) * .7)';
      setTimeout(() => f.remove(), 1200);
    }
  }
  lm.cap.forEach((j) => pawnEls[1 - lm.p][j].classList.add('fly'));
  if (lm.cap.length) await wait(120);
}

function paint(s) {
  const pos = layout(s);
  const mine = s.turn === me && s.phase === 'move' && s.seq === S.seq;
  const L = mine ? legal(s) : [];
  s.players.forEach((P, p) => P.pawns.forEach((ps, i) => {
    const el = pawnEls[p][i];
    putPawn(el, pos[p][i][0], pos[p][i][1]);
    el.classList.toggle('done', ps === DONE);
    el.classList.toggle('shielded', !!P.shield[i]);
    const shieldTarget = aim === 'shield' && p === me && ps >= 0 && ps <= LAST && !P.shield[i];
    el.classList.toggle('can', (p === me && L.includes(i)) || shieldTarget);
    setTimeout(() => el.classList.remove('fly'), 600);
  }));
  document.querySelectorAll('#board .power').forEach((e) => e.remove());
  const keys = new Set();
  s.powers.forEach((t) => {
    if (t.cell < 0) return;
    const key = t.cell + ':' + t.type; keys.add(key);
    const [x, y] = TRACK[t.cell], el = add('power', orbHTML(t.type)), [X, Y] = V(x + .5, y + .5);
    if (paint.tok && !paint.tok.has(key)) el.classList.add('pop');   // a new item just appeared
    el.style.left = pct(X); el.style.top = pct(Y);
  });
  paint.tok = keys;
  // Players
  s.players.forEach((P, p) => {
    const seat = seatEl(p), av = seat.querySelector('.avatar'), pr = profOf(p);
    av.style.background = `radial-gradient(circle at 35% 30%, ${PAL[P.color][0]}, ${PAL[P.color][1]} 55%, ${PAL[P.color][2]})`;
    av.querySelector('.em').textContent = pr.av;
    av.querySelector('.lv').textContent = 'Lv.' + pr.lvl;
    seat.querySelector('.pname').textContent = P.name + (p === me ? ' (you)' : '');
    const off = p !== me && !peerOnline();
    av.classList.toggle('off', off);
    av.classList.toggle('turn', s.turn === p && s.phase !== 'over');
    seat.querySelector('.pstate').textContent = off ? 'offline…' : s.turn === p && s.phase !== 'over' ? 'playing' : '';
    const pts = document.getElementById('pts-' + p);
    if (pts) {
      const t = '🏅 ' + Math.min(P.score, WIN_POINTS) + '/' + WIN_POINTS;
      if (pts.textContent && pts.textContent !== t) { pts.classList.remove('bump'); void pts.offsetWidth; pts.classList.add('bump'); }
      pts.textContent = t;
    }
    const bn = document.getElementById('bname-' + p); if (bn) bn.textContent = 'Lv.' + pr.lvl + ' ' + P.name;
    const box = seat.querySelector('.dicebox'), d = box.querySelector('.dice');
    box.className = 'dicebox skin-' + pr.dk;
    const isTurn = s.turn === p && s.phase !== 'over';
    box.classList.toggle('on', isTurn);
    box.classList.toggle('ready', isTurn && p === me && s.phase === 'roll' && s.seq === S.seq);
    box.classList.toggle('dim', isTurn && s.phase === 'roll');
    box.classList.toggle('doubled', isTurn && (s.phase === 'roll' ? s.x2 : s.dice > s.face));
    if (isTurn) setFace(d, s.phase === 'move' ? s.face : (s.face || 6));
  });
  // Items
  const MP = s.players[me], myTurn = s.turn === me && s.phase !== 'over';
  [['x2', '#it-x2'], ['pick', '#it-pick'], ['shield', '#it-shield']].forEach(([k, q]) => {
    const b = $(q); b.querySelector('.n').textContent = MP.items[k];
    let ok = myTurn && MP.items[k] > 0;
    if (k !== 'shield') ok = ok && s.phase === 'roll';
    if (k === 'shield') ok = ok && MP.pawns.some((p, i) => p >= 0 && p <= LAST && !MP.shield[i]);
    const armed = (k === 'x2' && s.x2 && myTurn) || (k === 'shield' && aim === 'shield');
    b.disabled = !ok && !armed;
    b.classList.toggle('empty', MP.items[k] === 0);
    b.classList.toggle('usable', ok && !armed);
    b.classList.toggle('armed', armed);
  });
  // Hint
  let h = '';
  if (s.phase === 'over') h = '';
  else if (s.turn === me) {
    if (aim === 'shield') h = 'Tap one of your pawns to protect it';
    else if (s.phase === 'roll') h = s.x2 ? 'Double is on: tap the dice' : 'Your turn: tap the dice';
    else if (s.burn) h = 'Three 6s in a row: turn lost';
    else if (!legal(s).length) h = s.face === 6 ? 'No move: roll again' : 'No move possible';
    else h = 'Choose a pawn to move';
  } else {
    const OP = s.players[1 - me];
    h = mode === 'bot' ? 'Computer is playing…' : OP.name + "'s turn" + (peerOnline() ? '' : ' (offline: we will play for them)');
  }
  $('#hint').textContent = h;
  $('#room-chip').textContent = mode === 'online' ? 'Room ' + code : 'Vs computer';
  $('#net-chip').style.display = mode === 'online' ? '' : 'none';
  if (s.phase === 'over' && paint.overShown !== s.game) { paint.overShown = s.game; gameOver(s); }
}

/* ---------- End of game: result, rewards, add friend ---------- */
async function gameOver(s) {
  const won = s.winner === me, P = s.players[me];
  sfx(won ? 'win' : 'lose');
  if (won) { confetti(140); banner('YOU WIN!', 'gold'); vibrate([80, 60, 160]); } else banner(s.players[s.winner].name + ' wins', '');
  const r = Account.reward(s.game, { won, caps: P.caps || 0, online: mode === 'online' });
  const sc = s.players.map((Q) => esc(Q.name) + ' ' + Math.min(Q.score, WIN_POINTS)).join('  –  ');
  const L = levelInfo(Account.profile.xp);
  const lvlUp = r && r.after > r.before;
  let canFriend = false;
  if (mode === 'online' && peerProf && peerProf.uid && Account.fb) canFriend = !(await Account.isFriend(peerProf.uid));
  await wait(900);
  const buttons = [['Play again', playAgain], ['Menu', leaveGame]];
  if (canFriend && peerProf.uid !== Account.uid) buttons.unshift(['👥 Add ' + peerProf.name + ' as friend', async (e) => {
    try { await Account.addFriend(peerProf.uid, peerProf.name, peerProf.av); e.target.textContent = '✓ Friends!'; e.target.disabled = true; sfx('finish'); }
    catch (err) { toast('Could not add the friend right now'); }
  }]);
  sheet(`<div class="trophy">${won ? '🏆' : '🎲'}</div><div class="win-title">${won ? 'You win!' : esc(s.players[s.winner].name) + ' wins'}</div><p style="margin:0">${sc}</p>
    ${r ? `<div class="reward"><span>+<b id="rw-xp">0</b> XP</span><span>+<b id="rw-c">0</b> <b class="coin"></b></span></div>
    <div class="lvl-row" style="margin:0 10px"><span class="lvl">Lv.${L.lvl}</span><div class="bar"><i id="rw-bar"></i></div><span class="xp">${L.cur}/${L.need}</span></div>
    ${lvlUp ? `<p class="levelup">⬆ LEVEL UP! Lv.${r.after}</p>` : ''}` : ''}`, buttons);
  if (r) {
    animateNumber($('#rw-xp'), 0, r.xp); animateNumber($('#rw-c'), 0, r.coins);
    setTimeout(() => { const bar = $('#rw-bar'); if (bar) bar.style.width = Math.round(100 * L.cur / L.need) + '%'; }, 150);
    if (lvlUp) { setTimeout(() => { sfx('win'); confetti(60); }, 600); }
  }
}

/* ---------- Turn timer (pie over the avatar) ---------- */
let timerStart = Date.now(), timerSeq = -1;
function tickRing() {
  requestAnimationFrame(tickRing);
  const s = shown;
  if (!inGame || !s) return;
  [0, 1].forEach((p) => {
    const pie = seatEl(p).querySelector('.avatar .pie');
    const active = s.turn === p && s.phase !== 'over';
    pie.style.opacity = active ? .7 : 0;
    if (!active) return;
    const f = Math.min(1, (Date.now() - timerStart) / TURN_MS);
    const col = f < .6 ? '#2ed573' : f < .85 ? '#ffc312' : '#ff4757';
    pie.style.background = `conic-gradient(rgba(255,255,255,.08) ${f * 360}deg, ${col} 0)`;
    if (p === me && f > .7 && !tickRing.warned && s.seq === S.seq) { tickRing.warned = s.seq; sfx('tick'); }
  });
}

/* =====================================================================
   7. TURN FLOW: who acts, automatic moves, time-outs
   ===================================================================== */
let timers = [];
function clearTimers() { timers.forEach(clearTimeout); timers = []; }
function later(ms, fn) {
  const seq = S.seq;
  timers.push(setTimeout(() => { if (S && S.seq === seq && !busy && inGame) fn(); }, ms));
}
function commit(ns) {
  ns.seq = S.seq + 1;
  S = ns; persist();
  if (mode === 'online') Net.send({ t: 'state', s: S });
  push(S);
}
function autoAct() {
  if (S.phase === 'roll') commit(mode === 'bot' && S.turn !== me ? botRollPhase(S) : applyRoll(S, rand6(), false));
  else if (S.phase === 'move') { const b = bestMove(S); commit(b >= 0 ? applyMove(S, b) : applySkip(S)); }
}
let lastBanner = '';
function afterPaint(s) {
  if (s.seq !== S.seq) return;            // a newer state is waiting to be drawn
  clearTimers();
  if (s.seq !== timerSeq) { timerSeq = s.seq; timerStart = Date.now(); tickRing.warned = 0; }
  if (sheet.kind === 'pick' && !(s.turn === me && s.phase === 'roll')) closeSheet();
  if (s.phase === 'over') return;
  const key = s.game + ':' + s.turnNo;
  if (s.turn === me && s.phase === 'roll' && lastBanner !== key) { lastBanner = key; banner('Your turn!'); sfx('turn'); vibrate(30); }
  const L = legal(s);
  const localTurn = s.turn === me || mode === 'bot';
  if (!localTurn) {
    // Opponent's turn online: if they went offline, play for them after the time limit.
    const watch = () => { if (!peerOnline()) { toast(s.players[s.turn].name + ' is away: playing for them'); autoAct(); } else later(3000, watch); };
    later(TURN_MS + 3000, watch);
    return;
  }
  if (s.phase === 'move' && !L.length) { later(1000, () => commit(applySkip(S))); return; }
  if (mode === 'bot' && s.turn !== me) {
    later(s.phase === 'roll' ? 750 : 600, autoAct);
    return;
  }
  // My turn
  if (s.phase === 'move') {
    const spots = new Set(L.map((i) => s.players[me].pawns[i]));
    if (spots.size === 1 && aim !== 'shield') later(450, () => commit(applyMove(S, L[0])));
  }
  later(TURN_MS, () => { aim = null; closeSheet(); autoAct(); });
}

/* ---------- Player input ---------- */
const canAct = () => inGame && S && !busy && S.turn === me && S.phase !== 'over';
function onDice() {
  if (!canAct() || S.phase !== 'roll') return;
  aim = null;
  commit(applyRoll(S, rand6(), false));
}
function onPawn(p, i) {
  if (!canAct() || p !== me) return;
  const P = S.players[me];
  if (aim === 'shield') {
    if (P.pawns[i] >= 0 && P.pawns[i] <= LAST && !P.shield[i] && P.items.shield > 0) {
      aim = null; commit(applyShield(S, i)); sfx('shield');
      const [x, y] = spotOf(P.color, i, P.pawns[i]); burst(x, y, ['#9ee8ff', '#fff'], 12);
    }
    return;
  }
  if (S.phase === 'move' && legal(S).includes(i)) commit(applyMove(S, i));
}
$('#it-x2').onclick = () => { if (canAct() && S.phase === 'roll' && (S.x2 || S.players[me].items.x2 > 0)) { aim = null; sfx('pop'); commit(applyArmX2(S)); } };
$('#it-pick').onclick = () => {
  if (!canAct() || S.phase !== 'roll' || S.players[me].items.pick < 1) return;
  aim = null;
  const sk = 'skin-' + Account.profile.dice;
  const btns = [1, 2, 3, 4, 5, 6].map((n) => `<button class="gbtn ${sk}" data-n="${n}"><div class="dice">${'<i class="pip"></i>'.repeat(9)}</div></button>`).join('');
  sheet('<h3>Choose your number</h3><div class="grid-btns three">' + btns + '</div>', [['Cancel', closeSheet]], 'pick');
  document.querySelectorAll('#sheet [data-n]').forEach((b) => {
    setFace(b.querySelector('.dice'), +b.dataset.n);
    b.onclick = () => { closeSheet(); if (canAct() && S.phase === 'roll') commit(applyRoll(S, +b.dataset.n, true)); };
  });
};
$('#it-shield').onclick = () => {
  if (!canAct() || S.players[me].items.shield < 1) return;
  aim = aim === 'shield' ? null : 'shield';
  sfx('pop');
  paint(S);
};

function playAgain() {
  closeSheet();
  if (mode === 'bot' || role === 'host') startRematch();
  else { Net.send({ t: 'rematch' }); toast('Waiting for ' + peerName + '…'); }
}
function leaveGame() {
  closeSheet();
  if (mode === 'online') { Net.send({ t: 'leave' }); setTimeout(() => Net.close(), 300); }
  store.del('lm.session');
  backToMenu();
}
$('#btn-leave').onclick = () => {
  if (S && S.phase === 'over') return leaveGame();
  sheet('<h3>Leave the game?</h3><p>' + (mode === 'online' ? 'Your friend will be told you left.' : '') + '</p>', [['Leave', leaveGame], ['Stay', closeSheet]]);
};

function enterGame() {
  inGame = true; aim = null; shown = null; paint.overShown = S.phase === 'over' ? S.game : null;
  $('#invite').style.display = 'none';
  closeSheet(); show('game'); buildBoard(); push(S);
  clearInterval(pingTimer);
  if (mode === 'online') {
    pingTimer = setInterval(() => {
      Net.send({ t: 'ping' });
      if (shown && !busy) {   // refresh the "offline" labels
        const off = !peerOnline();
        if (off !== enterGame.off) { enterGame.off = off; paint(shown); }
      }
    }, 4000);
    setNetStatus(Net.connectedCount());
  }
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && inGame && mode === 'online') Net.send({ t: 'sync', prof: myProf() });
});

/* =====================================================================
   8. SHEETS, EMOJI, CHAT, SOUND
   ===================================================================== */
function sheet(html, buttons, kind) {
  sheet.kind = kind || 'info';
  const card = $('#sheet-card');
  card.innerHTML = html + '<div class="grid-btns two" style="margin-top:14px"></div>';
  const row = card.lastElementChild;
  const many = buttons.length !== 2;
  if (many) row.className = 'grid-btns';
  buttons.forEach(([label, fn]) => {
    const b = document.createElement('button'); b.className = 'btn'; b.style.marginTop = '0'; b.textContent = label; b.onclick = fn;
    if (many) b.style.gridColumn = '1 / -1';
    row.appendChild(b);
  });
  if (buttons.length === 3) { row.children[1].style.gridColumn = 'auto'; row.children[2].style.gridColumn = 'auto'; row.className = 'grid-btns two'; row.children[0].style.gridColumn = '1 / -1'; row.children[0].className = 'btn green'; }
  $('#sheet').classList.add('on');
}
function closeSheet() { sheet.kind = null; $('#sheet').classList.remove('on'); }
$('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet' && sheet.kind && sheet.kind !== 'info') closeSheet(); });

const EMOJIS = ['😀', '😂', '😎', '😮', '😡', '😭', '👍', '👏', '🔥', '🙏', '😴', '🎉', '🍅', '💋', '🌹', '💣'];
const PHRASES = ['Hello!', 'Good luck!', 'Nice move!', 'Hurry up!', 'Oops!', 'Well played!', 'Thanks!', 'Bye!', 'Yalla!', 'Mabrouk!'];
function bubble(seat, text, big) {
  const b = $('#seat-' + seat + ' .bubble');
  b.textContent = text; b.classList.toggle('big', !!big);
  b.style.display = 'none'; void b.offsetWidth; b.style.display = 'block';
  clearTimeout(b._h); b._h = setTimeout(() => (b.style.display = 'none'), big ? 3000 : 5000);
}
const cleanMsg = (t) => String(t || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
let chatLog = [];
function addChat(who, text, mine) {
  chatLog.push({ who, text, mine });
  if (chatLog.length > 30) chatLog.shift();
  if (sheet.kind === 'chat') renderChatLog();
}
function renderChatLog() {
  const box = document.querySelector('#sheet .chat-log'); if (!box) return;
  box.innerHTML = chatLog.length ? chatLog.map((c) => `<div class="${c.mine ? 'mine' : ''}"><b>${esc(c.who)}:</b> ${esc(c.text)}</div>`).join('')
    : '<div style="opacity:.6">No messages yet</div>';
  box.scrollTop = box.scrollHeight;
}
function say(kind, x) {
  x = kind === 'emoji' ? x : cleanMsg(x);
  if (!x) return;
  if (kind === 'chat') addChat('You', x, true);
  closeSheet();
  bubble(0, x, kind === 'emoji');
  if (mode === 'online') Net.send({ t: kind, x });
  else if (mode === 'bot' && Math.random() < .5) setTimeout(() => bubble(1, ['👍', '😎', '😂', 'Good luck!'][Math.floor(Math.random() * 4)], true), 900);
}
$('#btn-emoji').onclick = () => {
  sheet('<h3>Emoji</h3><div class="grid-btns">' + EMOJIS.map((e) => `<button class="gbtn" data-e="${e}">${e}</button>`).join('') + '</div>', [['Close', closeSheet]], 'social');
  document.querySelectorAll('#sheet [data-e]').forEach((b) => (b.onclick = () => say('emoji', b.dataset.e)));
};
$('#btn-chat').onclick = () => {
  $('#btn-chat').classList.remove('unread');
  sheet('<h3>Chat</h3><div class="chat-log"></div>' +
    '<div class="chat-send"><input class="field" id="chat-in" maxlength="80" placeholder="Write a message…" autocomplete="off"><button class="btn alt" id="chat-go">Send</button></div>' +
    '<div class="grid-btns two">' + PHRASES.map((t) => `<button class="gbtn txt" data-t="${t}">${t}</button>`).join('') + '</div>', [['Close', closeSheet]], 'chat');
  renderChatLog();
  const send = () => say('chat', $('#chat-in').value);
  $('#chat-go').onclick = send;
  $('#chat-in').addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  document.querySelectorAll('#sheet [data-t]').forEach((b) => (b.onclick = () => say('chat', b.dataset.t)));
};

let actx = null;
function unlockAudio() { try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); actx.resume(); } catch (e) {} }
function tone(f, t0, dur, type = 'sine', vol = .15, slide) {
  const o = actx.createOscillator(), g = actx.createGain();
  o.type = type; o.frequency.value = f; o.connect(g); g.connect(actx.destination);
  const t = actx.currentTime + t0;
  if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(.001, t + dur);
  o.start(t); o.stop(t + dur);
}
function sfx(k, n) {
  if (!sound || !actx) return;
  try {
    if (k === 'dice') for (let i = 0; i < 6; i++) tone(250 + Math.random() * 350, i * .075, .05, 'square', .045);
    if (k === 'step') tone(520 + (n || 0) % 8 * 40, 0, .08, 'triangle', .12);
    if (k === 'pop') tone(700, 0, .12, 'sine', .15, 1200);
    if (k === 'turn') { tone(660, 0, .1, 'triangle', .12); tone(990, .08, .14, 'triangle', .12); }
    if (k === 'six') [784, 988, 1175].forEach((f, i) => tone(f, i * .06, .12, 'triangle', .1));
    if (k === 'tick') tone(1200, 0, .05, 'square', .05);
    if (k === 'capture') { tone(600, 0, .15, 'sawtooth', .1, 200); tone(180, .12, .25, 'square', .08, 80); }
    if (k === 'shield') tone(1100, 0, .25, 'sine', .1, 1600);
    if (k === 'finish') [523, 659, 784, 1046].forEach((f, i) => tone(f, i * .08, .2, 'triangle', .13));
    if (k === 'win') [523, 659, 784, 1046, 1318].forEach((f, i) => tone(f, i * .12, .35, 'triangle', .14));
    if (k === 'lose') [392, 330, 262, 196].forEach((f, i) => tone(f, i * .16, .35, 'triangle', .11));
  } catch (e) {}
}
function vibrate(ms) { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) {} }
$('#btn-sound').onclick = () => { sound = !sound; $('#btn-sound').textContent = sound ? '🔊' : '🔇'; store.set('lm.sound', sound); unlockAudio(); };

/* ---------- Start ---------- */
initGradients();
initMenu();
sound = store.get('lm.sound') !== false;
$('#btn-sound').textContent = sound ? '🔊' : '🔇';
requestAnimationFrame(tickRing);
Account.init();
