// アマヤドリの音：雨・焚き火・タイピング・ノート。録音（BigSoundBank・Joseph SARDIN・CC0）を鳴らす
//
// しくみ
// - 素材は public/sounds/（作り方は sounds-src/build-sounds.py、中身の説明は sounds/manifest.json）。
// - 雨・焚き火は「主」と「副」の2本のループを重ねる（長さが違うので、くり返しの周期が延びる）。
//   つなぎの重ね（3 秒）はファイルに焼き込み済み。AudioBufferSourceNode の loop と loopStart/loopEnd で回すだけなので、
//   予約がなく、隠れたタブでも途切れない。ファイルの前後には詰め物（ループの続きの写し）があり、頭の詰め物がずれても崩れない。
// - タイピング・ノートは、1本のファイルに並んだ「かたまり」を、ランダムな順番と間隔でオーディオの時計に先に予約して鳴らす。
// - 音の流れ：各音 → 音量 → 休憩中の下げ → 門（ロック中モードで閉じる）→ マスター → コンプ（リミッター代わり）→ 出力
// - 合図（chime）だけは合成のまま。

const SOUNDS = Object.freeze([
  Object.freeze({ id: "rain", label: "雨" }),
  Object.freeze({ id: "fire", label: "焚き火" }),
  Object.freeze({ id: "typing", label: "タイピング" }),
  Object.freeze({ id: "pages", label: "ノートと鉛筆" }),
]);
const IDS = SOUNDS.map((s) => s.id);
const DEFAULT_VOL = { rain: 0.7, fire: 0.35, typing: 0, pages: 0.2 };
const DEFAULT_MASTER = 0.8;
const STORE_KEY = "amayadori.mix";
const DUCK = 0.6;
const MIN_V = 0.0005;
const MANIFEST_URL = new URL("../sounds/manifest.json", import.meta.url);
const FILE_BASE = new URL("../", import.meta.url); // manifest の src は public/ から
// つまみ 1.0・全体 1.0 のときの持ち上げ（dB）。ファイルの大きさ（manifest の lufs）からの差。
// 雨 −17・焚き火 −19・タイピング −23・ページ −17・鉛筆 −20 LUFS くらいになる
const LEVEL_DB = { rain: 5, fire: 6.5, typing: 5, pages: 8 };
const KIND_DB = { page: 0, pencil: 2 }; // ノートの中の種類ごとの差（鉛筆は小さい音なので少し上げる）
// 左右の位置（-1 左〜+1 右）。絵の右端にストーブ、左寄りに机の女性
const PAN = { fire: 0.25, typing: 0.15, page: -0.2, pencil: -0.25 };
const AHEAD = 4; // 単発の予約：これだけ先まで入れておく（秒）
const AHEAD_HIDDEN = 75; // 隠れたタブ：タイマーが 1 分に 1 回まで間引かれても途切れないように
const PUMP_MS = 1000;
const LOCK_SEC = 100; // ロック中モードのループの長さ（秒）
const LOCK_XF = 3; // その継ぎ目の重ね（秒）
// ロック中モードの WAV は再生の場と同じ速さ（ふつう 48000）で作る。録音はその速さでデコード済みなので、描き出しで変換しない（高い音が丸くならない）
const lockRate = () => (ctx ? ctx.sampleRate : 48000);
const LIMITER_MAKEUP = 1.15; // コンプの自動持ち上げぶん（Chrome で +1.2dB と測った。ロック中モードの WAV で合わせる）
const OUT_TRIM = 0.84; // コンプの後ろで少し下げる（自動の持ち上げで 1.0 を超えて割れないように）

const isIOS = (() => {
  try {
    const ua = navigator.userAgent || "";
    return /iP(hone|ad|od)/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  } catch { return false; }
})();

// ================= 小道具 =================
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
const subRand = (seed, key) => mulberry32((seed ^ hashStr(key)) >>> 0);
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const dB = (x) => Math.pow(10, x / 20);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const isHidden = () => { try { return document.visibilityState === "hidden"; } catch { return false; } };

// OfflineAudioContext の描き出し（古い Safari は oncomplete だけ）
function renderAsync(oac) {
  return new Promise((res, rej) => {
    let done = false;
    const ok = (b) => { if (!done) { done = true; res(b); } };
    oac.oncomplete = (e) => ok(e.renderedBuffer);
    try {
      const p = oac.startRendering();
      if (p && typeof p.then === "function") p.then(ok, (e) => { if (!done) { done = true; rej(e); } });
    } catch (e) { rej(e); }
  });
}
function newOffline(ch, length, sr) {
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OAC) throw new Error("このブラウザでは音を混ぜられません（OfflineAudioContext がない）");
  return new OAC(ch, length, sr);
}
// 左右の位置。StereoPanner が無い古いブラウザでは真ん中のまま
function makePan(c, pan) {
  if (!pan || !c.createStereoPanner) return null;
  const p = c.createStereoPanner();
  p.pan.value = Math.max(-1, Math.min(1, pan));
  return p;
}
// 音ごとの入り口（焚き火は少し右へ）
function soundInput(c, id, dest) {
  const p = makePan(c, PAN[id]);
  if (!p) return dest;
  p.connect(dest);
  return p;
}

// ================= 単発の並び（予約係の中身。本番もロック中モードも確かめ用も同じ） =================
// 同じかたまりが続かないように選ぶ（直近 k 個を避ける）
function pickAvoiding(cands, recent, rand, k) {
  const n = Math.min(k, cands.length - 1); // 候補が 1 つなら避けない（slice(-0) は全部になる）
  const avoid = new Set(n > 0 ? recent.slice(-n) : []);
  const ok = cands.filter((i) => !avoid.has(i));
  return ok[Math.floor(rand() * ok.length)];
}
const clipIdx = (meta, f) => meta.clips.map((c, i) => (f(c) ? i : -1)).filter((i) => i >= 0);
// rate: 速さ（＝高さ）をほんの少し揺らして、同じかたまりでも毎回少し違って聞こえるように
const clipEvent = (meta, i, t, kind, gainDb, pan, rate = 1) => {
  const c = meta.clips[i];
  return { t, clip: i, kind, start: c.start, end: c.end, gain: dB(gainDb), pan, rate, dur: (c.end - c.start) / rate };
};

// タイピング：かたまり → 1〜6 秒の間 → かたまり…。ときどき考える間（5〜15 秒）。
// キーボードは 1 回の集中のあいだ同じ（getKb で外から変えられる）。速打ちは少なめに
function typingPlan(meta, rand, t0, { getKb } = {}) {
  const R = (a, b) => a + (b - a) * rand();
  const sets = {
    desk: clipIdx(meta, (c) => c.keyboard !== "laptop" && c.pace !== "fast"),
    deskFast: clipIdx(meta, (c) => c.keyboard !== "laptop" && c.pace === "fast"),
    laptop: clipIdx(meta, (c) => c.keyboard === "laptop"),
  };
  const all = meta.clips.map((_, i) => i);
  let kb = rand() < 0.6 ? "desk" : "laptop";
  let t = t0 + R(0.3, 1.5);
  const recent = [];
  return {
    next() {
      if (getKb) kb = getKb() || kb;
      let cands = kb === "laptop" ? sets.laptop : rand() < 0.3 && sets.deskFast.length ? sets.deskFast : sets.desk;
      if (!cands.length) cands = all;
      const i = pickAvoiding(cands, recent, rand, 3);
      recent.push(i);
      if (recent.length > 8) recent.shift();
      const e = clipEvent(meta, i, t, "typing", R(-1.5, 1.5), PAN.typing + R(-0.04, 0.04), 1 + R(-0.025, 0.025));
      t += e.dur + (rand() < 0.18 ? R(5, 15) : R(1, 6));
      return e;
    },
  };
}

// ノート：15〜60 秒に 1 回めくる（ときどき 2〜3 枚続けて）。その間に鉛筆で書く音をときどき
function pagesPlan(meta, rand, t0) {
  const R = (a, b) => a + (b - a) * rand();
  const pages = clipIdx(meta, (c) => c.kind === "page");
  const pencils = clipIdx(meta, (c) => c.kind === "pencil");
  const m = Number(meta.marginSec) || 0.1;
  const span = (i) => meta.clips[i].end - meta.clips[i].start; // 速さ 1 のときの長さ
  const q = [];
  const recentP = [], recentW = [];
  let flipAt = t0 + R(1, 6);
  const remember = (arr, i) => { arr.push(i); if (arr.length > 8) arr.shift(); };
  function cycle() {
    let t = flipAt;
    if (pages.length) {
      const n = rand() < 0.2 ? (rand() < 0.6 ? 2 : 3) : 1;
      for (let k = 0; k < n; k++) {
        const i = pickAvoiding(pages, recentP, rand, 4);
        remember(recentP, i);
        const e = clipEvent(meta, i, t, "page", KIND_DB.page + R(-2, 1), PAN.page + R(-0.05, 0.05), 1 + R(-0.04, 0.04));
        q.push(e);
        t += e.dur - 2 * m + R(0.25, 0.9); // 前のめくりが終わってから少しして次
      }
    }
    const next = Math.max(flipAt + R(15, 60), t + 6);
    if (pencils.length && rand() < 0.6) {
      let p = t + R(1.5, 6);
      for (let k = rand() < 0.35 ? 2 : 1; k > 0; k--) {
        const i = pickAvoiding(pencils, recentW, rand, 3);
        if (p + span(i) * 1.04 > next - 1.5) break;
        remember(recentW, i);
        const e = clipEvent(meta, i, p, "pencil", KIND_DB.pencil + R(-1.5, 1.5), PAN.pencil + R(-0.05, 0.05), 1 + R(-0.03, 0.03));
        q.push(e);
        p += e.dur + R(3, 15);
      }
    }
    flipAt = next;
  }
  return {
    next() {
      let guard = 0;
      while (!q.length && guard++ < 10) cycle();
      return q.shift() || { t: Infinity };
    },
  };
}
const PLANS = { typing: typingPlan, pages: pagesPlan };

// 1 つの単発を鳴らす（start〜end は前後の無音込み。頭の詰め物が少しずれても欠けない）
function playEvent(c, E, e, dest, onEnd) {
  const src = c.createBufferSource();
  src.buffer = E.buf;
  const g = c.createGain();
  const p = makePan(c, e.pan);
  // モノラルをパンに通すと左右の和が 3dB 下がるので戻す（manifest の大きさは左右に同じ音が出る前提）
  g.gain.value = E.gain * e.gain * (p && E.buf.numberOfChannels === 1 ? Math.SQRT2 : 1);
  if (e.rate && e.rate !== 1) src.playbackRate.value = e.rate;
  src.connect(g);
  if (p) { g.connect(p); p.connect(dest); } else g.connect(dest);
  const off = Math.min(e.start, Math.max(0, E.buf.duration - 0.05));
  src.start(e.t, off, Math.max(0.01, Math.min(e.end, E.buf.duration) - off)); // 長さはファイルの中の秒（速さで割られて鳴る）
  const node = { src, out: p || g, t: e.t, end: e.t + (e.dur || e.end - e.start) };
  src.onended = () => {
    try { g.disconnect(); p?.disconnect(); } catch { /* なし */ }
    onEnd?.(node);
  };
  return node;
}
// ループの 1 層を鳴らす
function startLayer(c, L, dest, t, off, fadeSec = 0) {
  const src = c.createBufferSource();
  src.buffer = L.buf;
  src.loop = true;
  src.loopStart = L.loopStart;
  src.loopEnd = L.loopEnd;
  const g = c.createGain();
  if (fadeSec > 0) { g.gain.setValueAtTime(0, t); g.gain.setTargetAtTime(L.gain, t, fadeSec / 3); }
  else g.gain.value = L.gain;
  src.connect(g);
  g.connect(dest);
  src.start(t, off);
  return { src, g };
}

// ================= 状態 =================
let ctx = null;
let started = false;
let resuming = false; // resume() の返事待ち（その間は「止まっています」を出さない）
let failMsg = "";
const vol = { ...DEFAULT_VOL };
let master = DEFAULT_MASTER;
let ducked = false;
let live = true; // Web Audio で環境音を鳴らしているか（ロック中モードでは false）
let liveTimer = 0;
const status = Object.fromEntries(IDS.map((id) => [id, "waiting"])); // waiting | loading | ready | error
const failedAt = {};
const buffers = {}; // id → { loops: [層…] } または { events: {buf, clips, gain…} }
const loadP = {};
const players = {};
const gains = {};
const stopTimers = {};
let manifest = null, manifestP = null;
const bytesCache = new Map(); // 取りに行っている途中のファイル（url → Promise<ArrayBuffer>）。デコードしたら消す
let limiter = null, outTrim = null, masterGain = null, duckGain = null, liveGate = null, chimeBus = null, chimeVerb = null;
let unmuteEl = null; // 古い iPhone で消音スイッチに負けないための無音の <audio>
const listeners = new Set();
const timeline = []; // 確かめ用：はじめてから各音が鳴らせるまで（ミリ秒）
let startedAt = 0;
let typingKb = Math.random() < 0.6 ? "desk" : "laptop"; // 1 回の集中のあいだのキーボード
const lock = { on: false, status: "off", els: [], cur: -1, urls: [null, null], timer: 0, building: false, again: false, silentUrl: null, gen: 0, seed: 1 };

function load() {
  try {
    const j = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (!j || typeof j !== "object") return;
    if (j.vol && typeof j.vol === "object") {
      for (const id of IDS) { const v = Number(j.vol[id]); if (Number.isFinite(v)) vol[id] = clamp01(v); }
    }
    const m = Number(j.master);
    if (Number.isFinite(m)) master = clamp01(m);
    if (isIOS && j.lock === true) lock.on = true;
  } catch { /* 読めなくても既定値で動く */ }
}
let saveT = 0;
function saveLater() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ v: 1, vol, master, lock: isIOS ? lock.on : false })); } catch { /* 保存できなくても動く */ }
  }, 250);
}
load();

const audible = (id) => vol[id] > MIN_V;
function getState() {
  const loading = IDS.find((id) => status[id] === "loading" && audible(id)) || IDS.find((id) => status[id] === "loading") || null;
  const failed = IDS.filter((id) => status[id] === "error");
  return {
    started,
    ctxState: ctx ? ctx.state : "none",
    resuming,
    error: failMsg,
    sounds: { ...status },
    loading,
    building: loading, // 古い名前（互換）
    preparing: started && IDS.some((id) => audible(id) && (status[id] === "waiting" || status[id] === "loading")),
    failed,
    loadError: started && failed.some(audible),
    vol: { ...vol },
    master,
    ducked,
    lock: { supported: isIOS, on: lock.on, status: lock.status },
  };
}
function emit() {
  const st = getState();
  for (const fn of listeners) { try { fn(st); } catch (e) { console.error("[audio] onState", e); } }
}

function ramp(p, v, tau) {
  if (!ctx) return;
  const t = ctx.currentTime;
  try {
    if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(t);
    else { const cur = p.value; p.cancelScheduledValues(t); p.setValueAtTime(cur, t); }
  } catch { /* 古いブラウザ */ }
  p.setTargetAtTime(v, t, tau);
}

function buildGraph() {
  limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 3;
  limiter.ratio.value = 20;
  // 速く効いて速く戻す：つまみを上げたとき、パチッやキーの山で後ろの雨が沈む時間を短く（0.25 秒→0.1 秒）、
  // 山の頭も先に押さえる（全部 1.0・全体 1.0 で 0dBFS を超えない。既定とおすすめではほぼ効かない）
  limiter.attack.value = 0.001;
  limiter.release.value = 0.1;
  outTrim = ctx.createGain();
  outTrim.gain.value = OUT_TRIM;
  limiter.connect(outTrim);
  outTrim.connect(ctx.destination);
  masterGain = ctx.createGain();
  masterGain.gain.value = master;
  masterGain.connect(limiter);
  liveGate = ctx.createGain();
  liveGate.gain.value = 1;
  liveGate.connect(masterGain);
  duckGain = ctx.createGain();
  duckGain.gain.value = ducked ? DUCK : 1;
  duckGain.connect(liveGate);
  for (const id of IDS) {
    gains[id] = ctx.createGain();
    gains[id].gain.value = 0;
    gains[id].connect(duckGain);
  }
  chimeBus = ctx.createGain();
  chimeBus.connect(limiter);
  try {
    chimeVerb = ctx.createConvolver();
    chimeVerb.normalize = false;
    const ir = makeIR(ctx.sampleRate, 2, mulberry32(7), { len: 1.4, rt: 0.9 });
    const b = ctx.createBuffer(2, ir[0].length, ctx.sampleRate);
    ir.forEach((d, c) => b.copyToChannel(d, c));
    chimeVerb.buffer = b;
    chimeVerb.connect(chimeBus);
  } catch { chimeVerb = null; }
}

// ================= 読み込み =================
// v はファイルの中身のハッシュ（manifest の v）。中身が変わったときだけ URL が変わるので、長く控えてよい
const fileUrl = (src, v) => {
  const u = new URL(src, FILE_BASE);
  const ver = v || manifest?.built;
  if (ver) u.searchParams.set("v", ver);
  return u.href;
};
async function fetchOk(url, type, tries = 2) {
  let err = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}（${url}）`);
      return type === "json" ? await r.json() : await r.arrayBuffer();
    } catch (e) {
      err = e;
      if (i + 1 < tries) await wait(1200);
    }
  }
  throw err;
}
function getManifest() {
  if (!manifestP) {
    manifestP = fetchOk(MANIFEST_URL.href, "json").then((j) => {
      if (!j || !j.sounds) throw new Error("manifest.json の中身が読めません");
      manifest = j;
      return j;
    });
    manifestP.catch(() => { manifestP = null; }); // 次に頼まれたらもう一度
  }
  return manifestP;
}
function getBytes(url) {
  if (!bytesCache.has(url)) {
    const p = fetchOk(url, "bytes");
    p.catch(() => bytesCache.delete(url));
    bytesCache.set(url, p);
  }
  return bytesCache.get(url);
}
function decode(ab) {
  return new Promise((res, rej) => {
    let done = false;
    const ok = (b) => { if (!done) { done = true; res(b); } };
    const ng = (e) => { if (!done) { done = true; rej(e || new Error("デコードできませんでした")); } };
    try {
      const p = ctx.decodeAudioData(ab, ok, ng);
      if (p && typeof p.then === "function") p.then(ok, ng);
    } catch (e) { ng(e); }
  });
}
// ループの区間（デコード後の長さに収める）
function loopLayer(id, L, buf) {
  const end = Math.min(Number(L.loopEnd), buf.duration - 0.005);
  const start = Math.max(0, Math.min(Number(L.loopStart) || 0, end - 1));
  return { buf, loopStart: start, loopEnd: end, gain: (Number(L.gain) || 1) * dB(LEVEL_DB[id] || 0), src: L.src };
}
function ensureLoaded(id) {
  if (!ctx) return Promise.resolve(false);
  if (loadP[id]) return loadP[id];
  if (status[id] === "ready") return Promise.resolve(true);
  status[id] = "loading";
  emit();
  loadP[id] = (async () => {
    const m = await getManifest();
    const s = m.sounds && m.sounds[id];
    if (!s) throw new Error(`manifest に ${id} がありません`);
    if (s.loops) {
      // 全部の層を一度に取りに行き、届いた順ではなく主から鳴らす。
      // 取り直しのときは、もうある層（鳴っている主など）はそのまま使い、足りない層だけ取る
      const b = buffers[id]?.loops ? buffers[id] : { loops: [] };
      const from = b.loops.length;
      const urls = s.loops.map((L) => fileUrl(L.src, L.v));
      const bytes = urls.map((u, k) => (k < from ? null : getBytes(u)));
      bytes.forEach((p) => p?.catch(() => {}));
      for (let k = from; k < s.loops.length; k++) {
        let buf;
        try {
          const ab = await bytes[k];
          bytesCache.delete(urls[k]);
          buf = await decode(ab);
        } catch (e) {
          if (k === 0) throw e;
          // 副の層だけ失敗：主は鳴っているので、その層はあきらめて「使える」にする（記録だけ残す）
          console.warn(`[audio] ${id} の副の層 ${s.loops[k].src} を読み込めませんでした（主だけで鳴らします）`, e);
          for (let j = k; j < urls.length; j++) bytesCache.delete(urls[j]);
          break;
        }
        b.loops.push(loopLayer(id, s.loops[k], buf));
        if (k === 0) buffers[id] = b;
        if (players[id]) players[id].sync?.();
        else startIfNeeded(id);
      }
    } else if (s.events) {
      const url = fileUrl(s.events.src, s.events.v);
      const ab = await getBytes(url);
      bytesCache.delete(url);
      const buf = await decode(ab);
      buffers[id] = { events: { ...s.events, buf, gain: (Number(s.events.gain) || 1) * dB(LEVEL_DB[id] || 0) } };
    } else {
      throw new Error(`manifest の ${id} に音がありません`);
    }
    return true;
  })().then(
    (ok) => {
      status[id] = "ready";
      timeline.push({ id, ms: Math.round(performance.now() - startedAt) });
      return ok;
    },
    (e) => {
      console.error(`[audio] ${id} を読み込めませんでした`, e);
      status[id] = "error";
      failedAt[id] = performance.now();
      return false;
    },
  ).finally(() => {
    loadP[id] = null;
    emit();
    startIfNeeded(id);
    if (lock.on) scheduleLockBuild(400);
  });
  return loadP[id];
}
// 「はじめる」の後：音量が 0 でない音から 1 つずつ（雨を最優先）。
// 音量 0 の音は先読みしない（スマホの通信量を使わない）。つまみを上げたときに取りに行く
let queueRunning = false;
async function loadQueue() {
  if (queueRunning) return;
  queueRunning = true;
  try {
    for (;;) {
      const id = ["rain", ...IDS].find((x) => audible(x) && status[x] === "waiting");
      if (!id) break;
      await ensureLoaded(id);
    }
  } finally { queueRunning = false; }
}

// ================= 鳴らす =================
// ループ（雨・焚き火）：層ごとに loop で鳴らすだけ。あとから届いた層はふわっと足す
function loopPlayer(id, t0) {
  const input = soundInput(ctx, id, gains[id]);
  const on = [];
  function sync(fade) {
    const b = buffers[id];
    if (!b?.loops) return;
    for (let k = on.length; k < b.loops.length; k++) {
      const L = b.loops[k];
      const t = Math.max(t0, ctx.currentTime + 0.03);
      const off = L.loopStart + Math.random() * (L.loopEnd - L.loopStart); // 毎回ちがう所から
      on.push(startLayer(ctx, L, input, t, off, fade ? 1.5 : 0));
    }
  }
  sync(false);
  return {
    sync: () => sync(true),
    stop() {
      for (const o of on) {
        try { o.src.stop(); } catch { /* 止まっている */ }
        try { o.g.disconnect(); } catch { /* なし */ }
      }
      on.length = 0;
      if (input !== gains[id]) try { input.disconnect(); } catch { /* なし */ }
    },
    get count() { return on.length; },
  };
}
// 単発（タイピング・ノート）：予約係。AHEAD 秒先までをオーディオの時計に入れておく
function eventPlayer(id, t0) {
  const E = buffers[id].events;
  const opts = id === "typing" ? { getKb: () => typingKb } : {};
  const plan = PLANS[id](E, Math.random, t0, opts);
  let nx = plan.next();
  const playing = new Set();
  let timer = 0, stopped = false;
  const done = (n) => playing.delete(n);
  function pump() {
    clearTimeout(timer);
    timer = 0;
    if (stopped || !ctx) return;
    try {
      const now = ctx.currentTime;
      const ahead = isHidden() ? AHEAD_HIDDEN : AHEAD;
      let guard = 0;
      while (nx.t < now + ahead && guard++ < 400) {
        // 遅れたもの（タブが長く止まっていた）は飛ばす。まとめて鳴らさない
        if (nx.t >= now - 0.02) playing.add(playEvent(ctx, E, nx, gains[id], done));
        nx = plan.next();
      }
    } catch (e) {
      console.error(`[audio] ${id} の予約`, e);
      try { nx = plan.next(); } catch { nx = { t: Infinity }; } // 同じ所で止まり続けないように
    } finally {
      if (!stopped) timer = setTimeout(pump, PUMP_MS); // 失敗しても次の予約は続ける
    }
  }
  pump();
  return {
    pump,
    stop() {
      stopped = true;
      clearTimeout(timer);
      for (const n of playing) {
        try { n.src.stop(); } catch { /* 止まっている */ }
        try { n.out.disconnect(); } catch { /* なし */ }
      }
      playing.clear();
    },
    get count() { return playing.size; },
    get next() { return nx.t; },
  };
}

function startIfNeeded(id) {
  if (!ctx || !live || !audible(id) || players[id]) return false;
  const b = buffers[id];
  if (!b || !(b.loops?.length || b.events)) return false;
  const g = gains[id].gain;
  const t = ctx.currentTime;
  try { g.cancelScheduledValues(t); } catch { /* なし */ }
  g.setValueAtTime(0, t);
  g.setTargetAtTime(vol[id], t + 0.03, b.loops ? 0.45 : 0.03); // ループはすっと入ってくる
  players[id] = b.loops ? loopPlayer(id, t + 0.03) : eventPlayer(id, t + 0.03);
  return true;
}
function stopSrc(id) {
  const p = players[id];
  if (!p) return;
  players[id] = null;
  try { p.stop(); } catch { /* なし */ }
}
function setLive(on) {
  if (!ctx) return;
  live = on;
  clearTimeout(liveTimer);
  ramp(liveGate.gain, on ? 1 : 0, on ? 0.25 : 0.2);
  if (on) {
    for (const id of IDS) if (!startIfNeeded(id) && players[id]) ramp(gains[id].gain, vol[id], 0.1);
  } else {
    liveTimer = setTimeout(() => { if (!live) IDS.forEach(stopSrc); }, 1500);
  }
}
function pumpAll() {
  for (const id of IDS) players[id]?.pump?.();
}

function tryResume() {
  if (!ctx || !started) return;
  if (ctx.state !== "running" && ctx.state !== "closed") ctx.resume().catch(() => {});
  if (lock.on && lock.status === "playing") {
    const el = lock.els[lock.cur];
    if (el && el.paused && el.dataset.userPaused !== "1") el.play().catch(() => {});
  }
}
try {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") tryResume();
    else pumpAll(); // 隠れる前に先の分まで予約しておく
  });
  window.addEventListener("pageshow", tryResume);
  for (const ev of ["pointerdown", "keydown", "touchend"]) document.addEventListener(ev, tryResume, { passive: true, capture: true });
} catch { /* DOM がない */ }

async function start() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) {
      failMsg = "このブラウザでは音を出せません";
      emit();
      throw new Error(failMsg);
    }
    try { ctx = new AC({ latencyHint: "playback" }); } catch { ctx = new AC(); }
    buildGraph();
    ctx.addEventListener?.("statechange", emit);
    try { // 古い iOS 向け：操作の中で無音を1回鳴らして音を出せる状態にする
      const b = ctx.createBuffer(1, 1, ctx.sampleRate);
      const s = ctx.createBufferSource();
      s.buffer = b;
      s.connect(ctx.destination);
      s.start(0);
    } catch { /* なし */ }
  }
  if (!started) startedAt = performance.now();
  started = true;
  usePlaybackSession(); // 操作の中で呼ぶ（iPhone の消音スイッチがオンでも鳴らす）
  if (lock.on && !lock.els.length) enableLock(); // 操作の中で呼ぶ必要がある
  let p = null;
  if (ctx.state !== "running") {
    resuming = true;
    p = ctx.resume().catch(() => {}).finally(() => { resuming = false; });
  }
  loadQueue();
  emit();
  if (p) await p;
  emit();
}

function setVolume(id, v) {
  if (!IDS.includes(id)) return;
  v = clamp01(Number(v));
  if (!Number.isFinite(v)) return;
  vol[id] = v;
  saveLater();
  if (ctx) {
    clearTimeout(stopTimers[id]);
    if (!startIfNeeded(id)) ramp(gains[id].gain, v, 0.06);
    if (v <= MIN_V) stopTimers[id] = setTimeout(() => { if (vol[id] <= MIN_V) stopSrc(id); }, 800); // 0 のあいだは予約しない
    if (started && v > MIN_V) {
      // 上げられた音を読み込む（失敗したものは 3 秒たってから、もう一度だけ試す）
      if (status[id] === "waiting") ensureLoaded(id);
      else if (status[id] === "error" && performance.now() - (failedAt[id] || 0) > 3000) ensureLoaded(id);
    }
  }
  if (lock.on) scheduleLockBuild(800);
  emit();
}
function setMaster(v) {
  v = clamp01(Number(v));
  if (!Number.isFinite(v)) return;
  master = v;
  saveLater();
  if (ctx) ramp(masterGain.gain, v, 0.06);
  if (lock.on) scheduleLockBuild(800);
  emit();
}
function duck(on) {
  on = !!on;
  if (on === ducked) return;
  ducked = on;
  if (ctx) ramp(duckGain.gain, on ? DUCK : 1, 1.2);
  // 休憩が終わって次の集中に入るとき、ときどきキーボードを替える
  if (!on && Math.random() < 0.5) typingKb = typingKb === "desk" ? "laptop" : "desk";
  // ロック中モードでは下げない（差し替えるとぷつりと段差になるため。WAV も下げずに作る）
  emit();
}

// ================= 合図（やわらかいマリンバ風・合成） =================
// 小さな部屋の響き（インパルス応答）。高い音ほど早く消える
function makeIR(sr, ch, rand, { len = 0.6, rt = 0.35 } = {}) {
  const n = Math.round(len * sr);
  const out = [];
  for (let c = 0; c < ch; c++) {
    const d = new Float32Array(n);
    let lp = 0;
    for (let i = Math.round(0.004 * sr); i < n; i++) {
      const t = i / sr;
      const fc = 1400 + 6500 * Math.exp(-t * 6);
      const a = 1 - Math.exp((-2 * Math.PI * fc) / sr);
      lp += a * (rand() * 2 - 1 - lp);
      d[i] = lp * Math.exp((-6.91 * t) / rt);
    }
    for (let k = 0; k < 6; k++) { // 壁や机からの早い反射
      const i = Math.round(sr * (0.003 + rand() * 0.02));
      d[i] += (rand() < 0.5 ? -1 : 1) * (0.12 - k * 0.015);
    }
    // フェードアウト
    const fo = Math.round(0.05 * sr);
    for (let i = 0; i < fo; i++) d[n - 1 - i] *= i / fo;
    let e = 0;
    for (let i = 0; i < n; i++) e += d[i] * d[i];
    const g = 1 / Math.sqrt(e || 1);
    for (let i = 0; i < n; i++) d[i] *= g;
    out.push(d);
  }
  return out;
}
let malletBuf = null;
function bell(f, t, A) {
  const out = ctx.createGain();
  out.gain.value = A;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 5000;
  lp.Q.value = -3;
  out.connect(lp);
  lp.connect(chimeBus);
  if (chimeVerb) {
    const s = ctx.createGain();
    s.gain.value = 0.2;
    lp.connect(s);
    s.connect(chimeVerb);
  }
  // 倍音：基音（長く）・4倍（短く）・10倍近く（ごく短く）＝マリンバの鍵盤の鳴り方
  const parts = [[1, 1, 0.6], [2, 0.05, 0.3], [3.99, 0.2, 0.11], [9.2, 0.04, 0.035]];
  let longest = null;
  for (const [r, a, tau] of parts) {
    const fr = f * r;
    if (fr > ctx.sampleRate * 0.45) continue;
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.value = fr;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(a, t + 0.006);
    g.gain.setTargetAtTime(0, t + 0.006, tau);
    o.connect(g);
    g.connect(out);
    o.start(t);
    o.stop(t + 0.006 + tau * 9);
    if (!longest) longest = o;
  }
  // 撥が当たるやわらかい音
  if (!malletBuf) {
    const n = Math.round(ctx.sampleRate * 0.03);
    malletBuf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = malletBuf.getChannelData(0);
    const r = mulberry32(11);
    for (let i = 0; i < n; i++) d[i] = (r() * 2 - 1) * Math.exp(-i / (n / 6));
  }
  const ns = ctx.createBufferSource();
  ns.buffer = malletBuf;
  const nf = ctx.createBiquadFilter();
  nf.type = "lowpass";
  nf.frequency.value = 1500;
  const ng = ctx.createGain();
  ng.gain.value = 0.12;
  ns.connect(nf);
  nf.connect(ng);
  ng.connect(out);
  ns.start(t);
  if (longest) longest.onended = () => { try { out.disconnect(); lp.disconnect(); } catch { /* なし */ } };
}
function chime(kind) {
  if (!ctx || ctx.state === "closed") return;
  if (ctx.state !== "running") ctx.resume().catch(() => {});
  // focusEnd: 下がる2音（ソ→ド）、breakEnd: 上がる2音（ド→ソ）
  const notes = kind === "breakEnd" ? [523.25, 783.99] : [783.99, 523.25];
  const A = 0.2 * Math.max(master, 0.08); // マスターに追従（環境音との差がいつも同じくらいに）。0 でもかすかに聞こえる下限
  const t0 = ctx.currentTime + 0.05;
  notes.forEach((f, i) => bell(f, t0 + i * 0.36, A * (i ? 0.8 : 1)));
}

// ================= 録音を OfflineAudioContext で混ぜる（ロック中モードと確かめ用） =================
// 鳴らし方は本番と同じ（ループは loop＋loopStart/loopEnd、単発は同じ予約係の並び）。
// ループの始まりの位置は seed と音の名前から決める（音量を変えて作り直しても、同じ位置の同じ音になる）
async function renderScene({ length, sampleRate, vols = vol, master: mg = 1, seed = 1, eventsFrom = 0, eventsUntil = Infinity, ids = IDS }) {
  const oac = newOffline(2, length, sampleRate);
  const seconds = length / sampleRate;
  const until = Math.min(eventsUntil, seconds);
  const events = [];
  for (const id of ids) {
    const v = Number(vols[id]) || 0;
    const b = buffers[id];
    if (!b || v <= MIN_V) continue;
    const out = oac.createGain();
    out.gain.value = v * mg;
    out.connect(oac.destination);
    if (b.loops) {
      const input = soundInput(oac, id, out);
      b.loops.forEach((L, k) => {
        const r = subRand(seed, `${id}:${L.src}`)();
        startLayer(oac, L, input, 0, L.loopStart + r * (L.loopEnd - L.loopStart));
      });
    }
    if (b.events) {
      const E = b.events;
      const rand = subRand(seed, id);
      const plan = PLANS[id](E, rand, eventsFrom, {});
      for (let e = plan.next(), guard = 0; e.t < until && guard < 5000; e = plan.next(), guard++) {
        if (e.t + e.dur > until) continue; // はみ出すものは入れない（ロック中モードの継ぎ目を静かに）
        playEvent(oac, E, e, out);
        events.push({ id, t: e.t, clip: e.clip, kind: e.kind, dur: e.dur, gain: e.gain, pan: e.pan, rate: e.rate });
      }
    }
  }
  const buffer = await renderAsync(oac);
  return { buffer, events };
}

// ================= ロック中も流す（iPhone 向け） =================
// iOS Safari は画面ロックやバックグラウンドで Web Audio が止まる。
// そこで、いまの音量で全部の音を混ぜた 100 秒のループを WAV にして、隠した <audio loop playsinline> で鳴らす。
// 混ぜるのは読み込んだ録音そのもの（renderScene）。単発は継ぎ目の重ねの外にだけ置く。
// ※ 実機未確認（iPhone 実機では試していない）
function wavBlob(chs, sr) {
  const C = chs.length, N = chs[0].length;
  const bytes = 44 + N * C * 2;
  const buf = new ArrayBuffer(bytes);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, bytes - 8, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, C, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * C * 2, true); v.setUint16(32, C * 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, N * C * 2, true);
  const out = new Int16Array(buf, 44, N * C);
  for (let n = 0; n < N; n++) {
    for (let c = 0; c < C; c++) {
      let x = chs[c][n];
      const a = Math.abs(x);
      if (a > 0.85) x = Math.sign(x) * (0.85 + 0.15 * Math.tanh((a - 0.85) / 0.15)); // やわらかく頭打ち
      out[n * C + c] = Math.max(-32768, Math.min(32767, Math.round(x * 32767)));
    }
  }
  return new Blob([buf], { type: "audio/wav" });
}
function silentUrl() {
  if (!lock.silentUrl) lock.silentUrl = URL.createObjectURL(wavBlob([new Float32Array(2000)], 8000));
  return lock.silentUrl;
}
// 引数は確かめ用（ふだんは いまの音量・全体・並び）
async function mixToWav({ vols: vv = vol, master: mg = master, seed = lock.seed } = {}) {
  const sr = lockRate();
  const N = Math.round(LOCK_SEC * sr), X = Math.round(LOCK_XF * sr);
  const vols = {};
  let any = false;
  for (const id of IDS) {
    vols[id] = buffers[id] ? Number(vv[id]) || 0 : 0;
    if (vols[id] > MIN_V) any = true;
  }
  if (!any) return null;
  const { buffer } = await renderScene({
    length: N + X, sampleRate: sr, vols, master: mg * LIMITER_MAKEUP * OUT_TRIM, seed,
    eventsFrom: LOCK_XF, eventsUntil: LOCK_SEC, // 単発は重ねの外（X〜N 秒）だけ
  });
  const chs = [buffer.getChannelData(0), buffer.getChannelData(1)];
  // 継ぎ目：最後の X ぶんを頭に重ねる（等パワーのクロスフェード。ループの録音どうしは似ていないので等パワー）
  for (const d of chs) {
    for (let i = 0; i < X; i++) {
      const th = (i / X) * (Math.PI / 2);
      d[i] = d[i] * Math.sin(th) + d[N + i] * Math.cos(th);
    }
  }
  return URL.createObjectURL(wavBlob(chs.map((d) => d.subarray(0, N)), sr));
}
function setLockStatus(s) {
  if (lock.status === s) return;
  lock.status = s;
  emit();
}
function primeLockEls() {
  // iOS は play() をユーザー操作の中でしか許さない。ここで一度鳴らして（無音）、あとから差し替えられるようにする
  if (!lock.els.length) {
    for (let i = 0; i < 2; i++) {
      const el = document.createElement("audio");
      el.loop = true;
      el.preload = "auto";
      el.setAttribute("playsinline", "");
      el.playsInline = true;
      el.setAttribute("aria-hidden", "true");
      el.style.display = "none";
      el.addEventListener("pause", () => { if (lock.els[lock.cur] === el && lock.status === "playing") setMediaPlaying(false); });
      el.addEventListener("play", () => { if (lock.els[lock.cur] === el) setMediaPlaying(true); });
      (document.body || document.documentElement).appendChild(el);
      lock.els.push(el);
    }
  }
  lock.els.forEach((el, i) => {
    if (i === lock.cur && !el.paused) return;
    if (!el.src) el.src = silentUrl();
    el.play().then(() => { if (i !== lock.cur) el.pause(); }).catch(() => {});
  });
}
// iOS の Web Audio は、何もしないと消音スイッチ（マナーモード）で消える。
// audioSession があれば "playback" に。古い iOS では無音の <audio loop> を鳴らしておく（昔からの回避策）
// ※ playback にすると、ほかのアプリの音楽は止まる
function usePlaybackSession() {
  try {
    if (navigator.audioSession) { navigator.audioSession.type = "playback"; return; }
  } catch { /* なし */ }
  if (!isIOS) return;
  try {
    if (!unmuteEl) {
      unmuteEl = document.createElement("audio");
      unmuteEl.loop = true;
      unmuteEl.setAttribute("playsinline", "");
      unmuteEl.playsInline = true;
      unmuteEl.setAttribute("aria-hidden", "true");
      unmuteEl.style.display = "none";
      unmuteEl.src = silentUrl();
      (document.body || document.documentElement).appendChild(unmuteEl);
    }
    if (unmuteEl.paused) unmuteEl.play().catch(() => {});
  } catch { /* なし */ }
}
function enableLock() {
  usePlaybackSession();
  primeLockEls();
  lock.seed = (Math.random() * 4294967296) >>> 0; // 切り替えている間は同じ並び（作り直しても同じ位置から続く）
  setLockStatus("building");
  scheduleLockBuild(0);
}
function disableLock() {
  clearTimeout(lock.timer);
  lock.els.forEach((el) => { try { el.pause(); } catch { /* なし */ } });
  for (let i = 0; i < 2; i++) {
    if (lock.urls[i]) { URL.revokeObjectURL(lock.urls[i]); lock.urls[i] = null; }
    if (lock.els[i]) { lock.els[i].removeAttribute("src"); try { lock.els[i].load(); } catch { /* なし */ } }
  }
  lock.cur = -1;
  lock.gen++; // 予約中の片づけを無効に
  // Web Audio に戻すので "auto" にはしない（消音スイッチで消えないように）
  try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch { /* なし */ }
  try { if (navigator.mediaSession) navigator.mediaSession.playbackState = "none"; } catch { /* なし */ }
  setLive(true);
  setLockStatus("off");
}
function scheduleLockBuild(ms) {
  if (!lock.on || !ctx) return;
  clearTimeout(lock.timer);
  lock.timer = setTimeout(buildLock, ms);
}
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("時間切れ")), ms))]);
async function buildLock() {
  if (!lock.on || !ctx) return;
  if (lock.building) { lock.again = true; return; }
  lock.building = true;
  if (lock.status !== "playing") setLockStatus("building");
  try {
    const url = await mixToWav();
    if (!lock.on) { if (url) URL.revokeObjectURL(url); return; }
    if (!url) { // まだ音がない（読み込みの途中、または全部 0）
      if (lock.cur >= 0) {
        // 前の音量で混ぜた WAV を無音に差し替える（止めるだけだと、次のタップやロック画面の再生でまた鳴る）
        const el = lock.els[lock.cur];
        el.pause();
        if (lock.urls[lock.cur]) {
          el.src = silentUrl();
          URL.revokeObjectURL(lock.urls[lock.cur]);
          lock.urls[lock.cur] = null;
        }
      }
      if (IDS.every((id) => !audible(id) || status[id] === "ready" || status[id] === "error")) setLockStatus("playing");
      return;
    }
    const prev = lock.cur >= 0 ? lock.els[lock.cur] : null;
    const prevIdx = lock.cur;
    const ni = lock.cur === 0 ? 1 : 0;
    const el = lock.els[ni];
    const gen = ++lock.gen; // 差し替えの番号（古い片づけが新しい音を消さないように）
    el.src = url;
    el.loop = true;
    el.dataset.userPaused = "";
    // 前の音と同じ位置から続ける（先に位置を合わせてから鳴らす）
    const follow = prev && !prev.paused;
    if (follow) {
      await withTimeout(new Promise((r) => (el.readyState >= 1 ? r() : el.addEventListener("loadedmetadata", r, { once: true }))), 1500).catch(() => {});
      try { el.currentTime = (prev.currentTime + 0.05) % LOCK_SEC; } catch { /* なし */ }
    }
    await withTimeout(el.play(), 6000);
    if (follow && Math.abs(el.currentTime - (prev.currentTime % LOCK_SEC)) > 0.3) { try { el.currentTime = prev.currentTime % LOCK_SEC; } catch { /* なし */ } }
    if (prev) prev.pause();
    const old = prevIdx >= 0 ? lock.urls[prevIdx] : null;
    const oldEl = lock.urls[ni]; // 前に ni で使っていた URL（もう使わない）
    lock.urls[ni] = url;
    lock.cur = ni;
    if (oldEl && oldEl !== url) URL.revokeObjectURL(oldEl);
    setTimeout(() => {
      // この 1 秒の間に次の差し替えが始まっていたら、前の要素には触らない（いま鳴っている方かもしれない）
      if (lock.gen !== gen) return;
      if (prev && prev !== lock.els[lock.cur]) prev.src = silentUrl();
      if (old && prevIdx >= 0 && lock.urls[prevIdx] === old) { URL.revokeObjectURL(old); lock.urls[prevIdx] = null; }
    }, 1000);
    setLive(false); // Web Audio 側は止める
    setMedia();
    setLockStatus("playing");
  } catch (e) {
    console.error("[audio] ロック中モード", e);
    setLive(true);
    setLockStatus("error");
  } finally {
    lock.building = false;
    if (lock.again) { lock.again = false; scheduleLockBuild(150); }
  }
}
function setMediaPlaying(on) {
  try { if (navigator.mediaSession) navigator.mediaSession.playbackState = on ? "playing" : "paused"; } catch { /* なし */ }
}
function setMedia() {
  const ms = navigator.mediaSession;
  if (!ms) return;
  try {
    if (typeof MediaMetadata === "function") {
      ms.metadata = new MediaMetadata({
        title: "アマヤドリ",
        artist: "雨音と集中の部屋",
        album: "アマヤドリ",
        artwork: [{ src: new URL("../art/room.png", import.meta.url).href, sizes: "1536x1024", type: "image/png" }],
      });
    }
    ms.setActionHandler("play", () => {
      const el = lock.els[lock.cur];
      if (el) { el.dataset.userPaused = ""; el.play().catch(() => {}); }
    });
    ms.setActionHandler("pause", () => {
      const el = lock.els[lock.cur];
      if (el) { el.dataset.userPaused = "1"; el.pause(); }
    });
    ms.playbackState = "playing";
  } catch { /* なし */ }
}
function setLockMode(on) {
  on = !!on;
  if (on === lock.on) return;
  lock.on = on;
  saveLater();
  if (ctx && started) {
    if (on) enableLock();
    else disableLock();
  } else {
    setLockStatus(on ? "waiting" : "off"); // 「はじめる」のときに切り替える
  }
  emit();
}

// ================= 確かめ用（開発ページから使う） =================
// ループの継ぎ目をまたいで、本番と同じ作り（loop＋loopStart/loopEnd）で描き出し、数字にする
async function seamTest(id, k = 0, { before = 1, after = 0.25 } = {}) {
  const L = buffers[id]?.loops?.[k];
  if (!L) return null;
  const buf = L.buf, sr = buf.sampleRate, C = buf.numberOfChannels;
  const nB = Math.round(before * sr), nA = Math.round(after * sr);
  const oac = newOffline(C, nB + nA, sr);
  const src = oac.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  src.loopStart = L.loopStart;
  src.loopEnd = L.loopEnd;
  src.connect(oac.destination);
  src.start(0, L.loopEnd - before);
  const out = await renderAsync(oac);
  const i0 = Math.round((L.loopEnd - before) * sr), s0 = Math.round(L.loopStart * sr);
  const w = Math.round(0.05 * sr);
  let diffLoop = 0, padE = 0, refE = 0, eb = 0, ea = 0, seamStep = 0;
  const steps = [];
  for (let c = 0; c < C; c++) {
    const o = out.getChannelData(c), d = buf.getChannelData(c);
    for (let n = 0; n < nB + nA; n++) {
      // 継ぎ目の後は loopStart からの続き、前はそのまま
      const want = n < nB ? d[i0 + n] : d[s0 + (n - nB)];
      diffLoop = Math.max(diffLoop, Math.abs(o[n] - want));
      // ファイルの詰め物（ループの続きの写し）とも比べる。AAC は雑音の波形までは残さないので、ここは差が出てよい
      if (n >= nB && i0 + n < d.length) { padE += (o[n] - d[i0 + n]) ** 2; refE += o[n] ** 2; }
      if (n) steps.push(Math.abs(o[n] - o[n - 1]));
    }
    for (let i = 0; i < w; i++) { eb += o[nB - w + i] ** 2; ea += o[nB + i] ** 2; }
    seamStep = Math.max(seamStep, Math.abs(o[nB] - o[nB - 1])); // 継ぎ目ちょうど（loopEnd の手前 → loopStart）
  }
  steps.sort((a, b) => a - b);
  const pct = (x) => { const i = steps.findIndex((s) => s >= x); return (100 * (i < 0 ? steps.length : i)) / (steps.length || 1); };
  const q = (p) => steps[Math.min(steps.length - 1, Math.floor(p * steps.length))];
  const db = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
  return {
    id, layer: k, src: L.src, sampleRate: sr, channels: C,
    loopStart: L.loopStart, loopEnd: L.loopEnd, loopSec: L.loopEnd - L.loopStart, bufSec: buf.duration,
    rms50BeforeDb: db(Math.sqrt(eb / (w * C))), rms50AfterDb: db(Math.sqrt(ea / (w * C))),
    rms50RatioDb: 10 * Math.log10((ea + 1e-20) / (eb + 1e-20)),
    seamStep, seamStepPctile: pct(seamStep), stepP50: q(0.5), stepP99: q(0.99), stepMax: steps[steps.length - 1],
    diffVsLoop: diffLoop, // 0 なら loopStart/loopEnd どおりに回っている
    padRmsDiffDb: 10 * Math.log10((padE + 1e-20) / (refE + 1e-20)), // 詰め物との差（RMS 比）。頭の詰め物を捨てない環境でだけ効く
  };
}
// 並びだけを作る（鳴らさない）
function planEvents(id, seconds = 60, seed = 1) {
  const E = buffers[id]?.events || manifest?.sounds?.[id]?.events;
  if (!E || !PLANS[id]) return [];
  const plan = PLANS[id](E, subRand(seed, id), 0, {});
  const out = [];
  for (let e = plan.next(), g = 0; e.t < seconds && g < 5000; e = plan.next(), g++) {
    const c = E.clips[e.clip];
    out.push({ t: e.t, clip: e.clip, kind: e.kind, dur: e.dur, source: c.source, keyboard: c.keyboard, pace: c.pace, gain: e.gain, pan: e.pan, rate: e.rate });
  }
  return out;
}
// 出力の手前を分けて覗く（左右別）。出力そのものは変わらない
function tapNode(node) {
  if (!ctx || !node) return null;
  const sp = ctx.createChannelSplitter(2);
  const L = ctx.createAnalyser(), R = ctx.createAnalyser();
  L.fftSize = R.fftSize = 8192;
  node.connect(sp);
  sp.connect(L, 0);
  sp.connect(R, 1);
  return { L, R, rms() {
    const a = new Float32Array(L.fftSize), b = new Float32Array(R.fftSize);
    L.getFloatTimeDomainData(a);
    R.getFloatTimeDomainData(b);
    const r = (x) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
    return { L: r(a), R: r(b) };
  } };
}

export const audio = {
  start,
  setVolume,
  getVolume: (id) => (IDS.includes(id) ? vol[id] : 0),
  setMaster,
  getMaster: () => master,
  chime,
  duck,
  sounds: SOUNDS,
  // 追加：状態の知らせ（mixer-ui が使う）。戻り値で解除
  onState(fn) {
    listeners.add(fn);
    try { fn(getState()); } catch (e) { console.error("[audio] onState", e); }
    return () => listeners.delete(fn);
  },
  getState,
  // 追加：ロック中も流す（iPhone 向け）。ユーザー操作の中で呼ぶ
  lockSupported: isIOS,
  setLockMode,
  getLockMode: () => lock.on,
  // 開発用
  debug: {
    manifest: () => manifest,
    buffers: () => ({ ...buffers }),
    context: () => ctx,
    timeline: () => timeline.slice(),
    tap: () => tapNode(outTrim), // コンプの後
    tapSound: (id) => tapNode(gains[id]), // 音ごと（音量の後・休憩の下げの前）
    players: () => Object.fromEntries(IDS.map((id) => [id, players[id] ? players[id].count : 0])),
    nextEvent: (id) => players[id]?.next ?? null,
    keyboard: () => typingKb,
    levels: { LEVEL_DB: { ...LEVEL_DB }, KIND_DB: { ...KIND_DB }, PAN: { ...PAN }, AHEAD, AHEAD_HIDDEN, LOCK_SEC, LOCK_XF, get LOCK_RATE() { return lockRate(); } },
    load: ensureLoaded,
    plan: planEvents,
    // 例: render({ seconds: 60, vols: { typing: 1 }, seed: 3 }) → { buffer, events }
    render(o = {}) {
      const sampleRate = o.sampleRate || (ctx ? ctx.sampleRate : 48000);
      return renderScene({ ...o, sampleRate, length: Math.round((o.seconds || 60) * sampleRate) });
    },
    seam: seamTest,
    lockElements: () => lock.els.slice(),
    mixToWav,
  },
};
