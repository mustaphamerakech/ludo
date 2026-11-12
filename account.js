'use strict';
/* =====================================================================
   ACCOUNTS (Firebase): guest play, Google / email sign-in, profile
   (name, picture, level, coins, stats, dice style), friends, invites,
   ranking. The profile is also kept on the phone, so the game still
   works when Firebase cannot be reached.
   ===================================================================== */
const FB_CONFIG = {
  apiKey: 'AIzaSyB4Vdlx5v_CHFmwPPsHfwVsEJnlA73LYu8',
  authDomain: 'ludo-mini-586c5.firebaseapp.com',
  projectId: 'ludo-mini-586c5',
  storageBucket: 'ludo-mini-586c5.firebasestorage.app',
  messagingSenderId: '1013880233484',
  appId: '1:1013880233484:web:f1feea3914995227c5d829',
};

// Pictures: [emoji, level needed]
const AVATARS = [['😎', 1], ['🦁', 1], ['🐯', 1], ['🐼', 1], ['🦊', 1], ['🐸', 1], ['🐵', 1], ['🐻', 1],
                 ['🦄', 3], ['🐲', 5], ['🦅', 7], ['🐺', 9], ['🤖', 12], ['👽', 15], ['👑', 20], ['🔥', 25]];
const DICE_SKINS = { classic: ['Classic', 0], gold: ['Gold', 200], ruby: ['Ruby', 300], emerald: ['Emerald', 300], night: ['Neon night', 500] };
const DAILY_COINS = 50;

// Level n starts at 50*n*(n-1) XP: Lv1 0, Lv2 100, Lv3 300, Lv4 600, Lv5 1000...
const xpAt = (n) => 50 * n * (n - 1);
function levelOf(xp) { let n = 1; while (xpAt(n + 1) <= xp) n++; return n; }
function levelInfo(xp) { const n = levelOf(xp); return { lvl: n, cur: xp - xpAt(n), need: xpAt(n + 1) - xpAt(n) }; }
const today = () => new Date().toISOString().slice(0, 10);
const randCode = () => Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');

function defaultProfile() {
  return { name: '', av: AVATARS[Math.floor(Math.random() * 8)][0], xp: 0, coins: 100, wins: 0, losses: 0, games: 0,
           caps: 0, streak: 0, best: 0, daily: '', dice: 'classic', owned: ['classic'], code: randCode() };
}
function lsGet(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

const Account = {
  fb: false,            // Firebase reachable and set up
  fbError: '',
  user: null, db: null, auth: null,
  profile: Object.assign(defaultProfile(), lsGet('lm.profile') || {}),
  rewarded: lsGet('lm.rewarded') || [],
  listeners: [],
  onChange(fn) { this.listeners.push(fn); },
  changed() { lsSet('lm.profile', this.profile); this.listeners.forEach((f) => { try { f(); } catch (e) { console.error(e); } }); },
  get isGuest() { return !this.user || this.user.isAnonymous; },
  get uid() { return this.user ? this.user.uid : null; },
  level() { return levelOf(this.profile.xp); },
  name() { return this.profile.name || 'Player'; },

  init() {
    if (!this.profile.name) this.profile.name = lsGet('lm.name') || '';
    try {
      firebase.initializeApp(FB_CONFIG);
      this.auth = firebase.auth();
      this.db = firebase.firestore();
    } catch (e) { this.fbError = 'load'; this.changed(); return; }
    this.auth.onAuthStateChanged(async (u) => {
      if (!u) {
        try { await this.auth.signInAnonymously(); }
        catch (e) { this.fb = false; this.fbError = e.code || 'auth'; console.warn('Firebase sign-in:', e.code); this.changed(); }
        return;
      }
      this.user = u;
      await this.loadProfile();
      this.startPresence();
      this.listenInvites();
      this.changed();
    });
    this.auth.getRedirectResult().catch(() => {});
  },

  /* ---------- Profile ---------- */
  ref(uid) { return this.db.collection('users').doc(uid || this.uid); },
  async loadProfile() {
    try {
      const snap = await this.ref().get();
      if (snap.exists) {
        this.profile = Object.assign(defaultProfile(), snap.data());
        delete this.profile.lastSeen;
      } else {
        // First time on this account: keep what was played on this phone (within the safety limits).
        const p = this.profile;
        p.xp = Math.min(p.xp, 5000); p.coins = Math.min(p.coins, 5000);
        if (!p.name) p.name = 'Player' + Math.floor(100 + Math.random() * 900);
        await this.ref().set(this.dbData());
      }
      this.fb = true; this.fbError = '';
    } catch (e) {
      this.fb = false; this.fbError = e.code || 'db'; console.warn('Firebase profile:', e.code || e);
    }
  },
  dbData() {
    const p = this.profile;
    return { name: (p.name || 'Player').slice(0, 16), av: p.av, xp: Math.round(p.xp), coins: Math.max(0, Math.round(p.coins)),
             wins: p.wins, losses: p.losses, games: p.games, caps: p.caps, streak: p.streak, best: p.best,
             daily: p.daily, dice: p.dice, owned: p.owned, code: p.code,
             lastSeen: firebase.firestore.FieldValue.serverTimestamp() };
  },
  save() {
    this.changed();
    if (!this.fb || !this.user) return;
    this.ref().set(this.dbData(), { merge: true }).catch((e) => console.warn('save', e.code || e));
  },
  setName(n) { n = String(n || '').replace(/[<>&"]/g, '').trim().slice(0, 14); if (!n) return; this.profile.name = n; lsSet('lm.name', n); this.save(); },
  setAvatar(a) { const f = AVATARS.find((x) => x[0] === a); if (!f || f[1] > this.level()) return false; this.profile.av = a; this.save(); return true; },
  canClaimDaily() { return this.profile.daily !== today(); },
  claimDaily() { if (!this.canClaimDaily()) return 0; this.profile.daily = today(); this.profile.coins += DAILY_COINS; this.save(); return DAILY_COINS; },
  buyDice(k) {
    const s = DICE_SKINS[k]; if (!s) return 'no';
    if (this.profile.owned.includes(k)) { this.profile.dice = k; this.save(); return 'used'; }
    if (this.profile.coins < s[1]) return 'poor';
    this.profile.coins -= s[1]; this.profile.owned = [...this.profile.owned, k]; this.profile.dice = k; this.save(); return 'bought';
  },
  // Rewards at the end of a game. Returns null if this game was already rewarded.
  reward(gameId, r) {
    if (this.rewarded.includes(gameId)) return null;
    this.rewarded = [...this.rewarded.slice(-30), gameId]; lsSet('lm.rewarded', this.rewarded);
    const p = this.profile, before = levelOf(p.xp);
    let xp = r.won ? (r.online ? 60 : 30) : (r.online ? 20 : 10);
    let coins = r.won ? (r.online ? 40 : 20) : (r.online ? 10 : 5);
    xp += Math.min(r.caps, 8) * 5;
    p.xp += xp; p.coins += coins; p.games++; p.caps += r.caps;
    if (r.won) { p.wins++; p.streak++; p.best = Math.max(p.best, p.streak); } else { p.losses++; p.streak = 0; }
    this.save();
    return { xp, coins, before, after: levelOf(p.xp) };
  },

  /* ---------- Sign-in ---------- */
  async google() {
    const prov = new firebase.auth.GoogleAuthProvider();
    try {
      if (this.user && this.user.isAnonymous) await this.user.linkWithPopup(prov);
      else await this.auth.signInWithPopup(prov);
      await this.afterSignIn();
    } catch (e) {
      if (e.code === 'auth/credential-already-in-use' && e.credential) {
        await this.auth.signInWithCredential(e.credential); await this.afterSignIn(); return 'switched';
      }
      throw e;
    }
  },
  async emailCreate(email, pw) {
    const cred = firebase.auth.EmailAuthProvider.credential(email, pw);
    if (this.user && this.user.isAnonymous) await this.user.linkWithCredential(cred);
    else await this.auth.createUserWithEmailAndPassword(email, pw);
    await this.afterSignIn();
  },
  async emailSignIn(email, pw) { await this.auth.signInWithEmailAndPassword(email, pw); await this.afterSignIn(); },
  async afterSignIn() { this.user = this.auth.currentUser; await this.loadProfile(); this.save(); },
  async signOut() {
    this.profile = defaultProfile(); this.profile.name = lsGet('lm.name') || '';
    lsSet('lm.profile', this.profile);
    await this.auth.signOut();   // a new guest account starts automatically
  },
  accountLabel() {
    if (!this.user) return '';
    if (this.user.isAnonymous) return 'Guest';
    return this.user.email || (this.user.providerData[0] && this.user.providerData[0].email) || 'Signed in';
  },

  /* ---------- Presence (who is online) ---------- */
  startPresence() {
    clearInterval(this._pres);
    const beat = () => { if (this.fb && this.user && !document.hidden) this.ref().update({ lastSeen: firebase.firestore.FieldValue.serverTimestamp() }).catch(() => {}); };
    this._pres = setInterval(beat, 120000);
    document.addEventListener('visibilitychange', beat);
  },
  isOnline(d) { return !!(d.lastSeen && d.lastSeen.toMillis && Date.now() - d.lastSeen.toMillis() < 180000); },

  /* ---------- Friends ---------- */
  async friends() {
    const snap = await this.ref().collection('friends').get();
    const docs = await Promise.all(snap.docs.map((d) => this.ref(d.id).get()));
    return docs.filter((d) => d.exists).map((d) => Object.assign({ uid: d.id, online: this.isOnline(d.data()) }, d.data()))
      .sort((a, b) => (b.online - a.online) || (b.xp - a.xp));
  },
  async addFriend(uid, name, av) {
    if (!this.fb || !uid || uid === this.uid) return false;
    const at = firebase.firestore.FieldValue.serverTimestamp();
    const b = this.db.batch();
    b.set(this.ref().collection('friends').doc(uid), { name: String(name || '').slice(0, 16), av: av || '', at });
    b.set(this.ref(uid).collection('friends').doc(this.uid), { name: this.name(), av: this.profile.av, at });
    await b.commit();
    return true;
  },
  async addFriendByCode(code) {
    code = String(code || '').trim().toUpperCase();
    if (code === this.profile.code) throw new Error('self');
    const q = await this.db.collection('users').where('code', '==', code).limit(1).get();
    if (q.empty) throw new Error('notfound');
    const d = q.docs[0];
    await this.addFriend(d.id, d.data().name, d.data().av);
    return d.data().name;
  },
  async isFriend(uid) {
    if (!this.fb || !uid) return false;
    try { return (await this.ref().collection('friends').doc(uid).get()).exists; } catch (e) { return false; }
  },
  async invite(uid, room) {
    await this.ref(uid).collection('invites').doc(this.uid).set({ name: this.name(), av: this.profile.av, room,
      at: firebase.firestore.FieldValue.serverTimestamp() });
  },
  listenInvites() {
    if (this._inv) this._inv();
    if (!this.fb) return;
    this._inv = this.ref().collection('invites').onSnapshot((snap) => {
      snap.docChanges().forEach((ch) => {
        if (ch.type === 'removed') return;
        const d = ch.doc.data(), at = d.at && d.at.toMillis ? d.at.toMillis() : Date.now();
        if (Date.now() - at > 180000) { ch.doc.ref.delete().catch(() => {}); return; }
        if (typeof showInvite === 'function') showInvite(d, () => ch.doc.ref.delete().catch(() => {}));
      });
    }, () => {});
  },
  async leaderboard() {
    const q = await this.db.collection('users').orderBy('xp', 'desc').limit(20).get();
    return q.docs.map((d) => Object.assign({ uid: d.id, online: this.isOnline(d.data()) }, d.data()));
  },
};
