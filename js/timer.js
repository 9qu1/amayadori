// ポモドーロタイマーと今日の記録。initTimer({ root, stats, audio })
import { bus } from "./bus.js";

const NAMES = { focus: "集中", short: "小休憩", long: "長休憩" };
const LONG_EVERY = 4; // 4回目の集中のあとは長休憩
const PRESETS = [
  { focus: 25, short: 5, long: 15 },
  { focus: 50, short: 10, long: 20 },
  { focus: 15, short: 3, long: 10 },
];
const DEFAULTS = { focus: 25, short: 5, long: 15, autoStart: true, notify: false };
const MIN_MIN = 1;
const MAX_MIN = 180;
// 終わりに気づくのがこれより遅れたら（スリープ明け・閉じていた等）鳴らさず、自動でも続けない
const LATE_LIMIT_MS = 90_000;
const RESTORE_LATE_LIMIT_MS = 5_000; // 読み込み直しのとき
const KEEP_DAYS = 60;
const BASE_TITLE = "アマヤドリ";
// 複数のタブ: 動いているタイマーを進める（記録を足す・合図を鳴らす）のは「持ち主」のタブだけ
const TAB_ID = Math.random().toString(36).slice(2, 10);
const HEARTBEAT_MS = 30_000; // 持ち主は動いている間これごとに保存する（生きている印・閉じた時刻の目安）
const OWNER_STALE_MS = 180_000; // 持ち主がこれだけ保存しなければ、固まった・閉じたとみなす
const CLOSED_GAP_MS = 15_000; // 読み込み直しとみなす間。これより長く空いていたら「閉じていた」
// 通知: スマホ（Android・iPhone）はページから直接は出せない（Service Worker が要る）ので出さない
const IS_MOBILE = (() => {
  try {
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || "") || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  } catch { return false; }
})();

// 早回し: ?fast=1 で 1分を1秒に。記録と状態は本物と別の場所に保存
const FAST = (() => {
  try { return new URLSearchParams(location.search).get("fast") === "1"; } catch { return false; }
})();
const SCALE = FAST ? 60 : 1;
const KEY_TIMER = FAST ? "amayadori.timer.fast" : "amayadori.timer";
const KEY_STATS = FAST ? "amayadori.stats.fast" : "amayadori.stats";

const pad2 = (n) => String(n).padStart(2, "0");
const WEEK = ["日", "月", "火", "水", "木", "金", "土"];

function readJSON(key) {
  try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : null; } catch { return null; }
}
function writeJSON(key, v) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* 保存できなくても動かす */ }
}
function clampMin(v, fallback) {
  if (v === null || v === undefined || String(v).trim() === "") return fallback; // 空は 0 ではなく「元のまま」
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(MAX_MIN, Math.max(MIN_MIN, n)) : fallback;
}
function dayKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function startOfDay(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
function nextMidnight(t) { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime(); }
function fmt(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
}
function clock(t) { const d = new Date(t); return `${d.getHours()}:${pad2(d.getMinutes())}`; }

const ICON = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.2v13.6a.8.8 0 0 0 1.2.7l10.6-6.8a.8.8 0 0 0 0-1.4L9.2 4.5A.8.8 0 0 0 8 5.2z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1.2" fill="currentColor"/><rect x="13.5" y="5" width="4" height="14" rx="1.2" fill="currentColor"/></svg>',
  reset: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 4v5h5"/></svg>',
  skip: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 5.5 15 12l-9.5 6.5z" fill="currentColor"/><path d="M18.5 5v14"/></svg>',
  gear: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/></svg>',
};

export function initTimer({ root, stats: statsRoot, audio } = {}) {
  if (!root) throw new Error("タイマーの置き場所（#timer）がありません");

  // ---------- 保存と復元 ----------
  const saved = readJSON(KEY_TIMER) || {};
  const settings = { ...DEFAULTS };
  if (saved.settings && typeof saved.settings === "object") {
    for (const k of ["focus", "short", "long"]) settings[k] = clampMin(saved.settings[k], DEFAULTS[k]);
    if (typeof saved.settings.autoStart === "boolean") settings.autoStart = saved.settings.autoStart;
    if (typeof saved.settings.notify === "boolean") settings.notify = saved.settings.notify;
  }
  const dur = (phase) => (settings[phase] * 60_000) / SCALE; // 実時間の ms

  const fresh = () => ({
    phase: "focus", round: 1, running: false, started: false,
    endsAt: 0, remainingMs: dur("focus"), totalMs: dur("focus"), segStart: 0, owner: null,
  });
  let st = restoreRun(saved.run) || fresh();
  let lastRemoteSaveAt = Number(saved.run?.savedAt) || 0; // 持ち主が最後に保存した時刻（ほかのタブのとき）
  let lastSaveAt = 0;

  function restoreRun(r) {
    if (!r || typeof r !== "object") return null;
    if (!NAMES[r.phase]) return null;
    const round = Math.round(Number(r.round));
    if (!(round >= 1 && round <= LONG_EVERY)) return null;
    const totalMs = Number(r.totalMs);
    if (!(totalMs > 0)) return null;
    const out = {
      phase: r.phase, round, running: !!r.running, started: !!r.started || !!r.running,
      endsAt: Number(r.endsAt) || 0,
      remainingMs: Math.min(totalMs, Math.max(0, Number(r.remainingMs) || 0)),
      totalMs, segStart: Number(r.segStart) || 0,
      owner: typeof r.owner === "string" && r.owner ? r.owner : null,
    };
    if (out.running && !out.endsAt) return null;
    // 止まっていて手つかずなら、いまの設定の長さに合わせる
    if (!out.running && !out.started) { out.totalMs = dur(out.phase); out.remainingMs = out.totalMs; }
    return out;
  }

  let statsData = loadStats();
  function loadStats() {
    const s = readJSON(KEY_STATS);
    const days = {};
    if (s && s.days && typeof s.days === "object") {
      const limit = dayKey(Date.now() - KEEP_DAYS * 86_400_000);
      for (const [k, v] of Object.entries(s.days)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || k < limit || !v) continue;
        days[k] = { focusMs: Math.max(0, Number(v.focusMs) || 0), pomos: Math.max(0, Math.round(Number(v.pomos) || 0)) };
      }
    }
    return { v: 1, days };
  }
  const day = (k) => (statsData.days[k] ||= { focusMs: 0, pomos: 0 });
  const saveStats = () => writeJSON(KEY_STATS, statsData);
  // 記録は足す直前に読み直す（ほかのタブが足した分を消さないように）
  const reloadStats = () => { statsData = loadStats(); lastWeekSig = ""; };
  const save = () => {
    lastSaveAt = Date.now();
    writeJSON(KEY_TIMER, { v: 1, settings, run: { ...st, savedAt: lastSaveAt } });
  };
  const isOwner = () => st.owner === TAB_ID;
  const othersRun = () => st.running && !!st.owner && st.owner !== TAB_ID;
  const claim = () => { st.owner = TAB_ID; };

  // 集中していた時間を日ごとに足す（日付をまたげば分ける）
  function addFocus(from, to) {
    let a = from;
    while (a < to) {
      const b = Math.min(to, nextMidnight(a));
      day(dayKey(a)).focusMs += (b - a) * SCALE;
      a = b;
    }
  }
  function creditFocus(until) {
    if (st.phase === "focus" && st.running && st.segStart && until > st.segStart) {
      reloadStats();
      addFocus(st.segStart, until);
      saveStats();
    }
    st.segStart = st.running && st.phase === "focus" ? until : 0;
  }

  // ---------- 画面 ----------
  root.classList.add("timer");
  root.innerHTML = `
    <div class="timer-full">
      <div class="timer-head">
        <span class="timer-phase"><i class="phase-dot" aria-hidden="true"></i><span data-name>集中</span></span>
        <span class="head-time" data-time aria-hidden="true">25:00</span>
        <span class="timer-round" data-round>
          <span class="dots" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
          <span class="round-num" data-round-num aria-hidden="true">1 / 4</span>
          <span class="sr-only" data-round-sr>4回中1回目</span>
        </span>
        <button class="icon-btn" type="button" data-act="settings" aria-expanded="false" aria-label="タイマーの設定" title="タイマーの設定">${ICON.gear}</button>
      </div>
      <div class="timer-body">
        <div class="timer-dial" data-dial>
          <svg class="ring" viewBox="0 0 120 120" aria-hidden="true">
            <circle class="ring-track" cx="60" cy="60" r="54"/>
            <circle class="ring-prog" cx="60" cy="60" r="54" pathLength="100" data-ring/>
          </svg>
          <div class="dial-center">
            <div class="time" data-time role="timer" aria-live="off">25:00</div>
            <div class="dial-sub" data-sub></div>
          </div>
        </div>
        <div class="timer-settings" data-settings hidden>
          <div class="set-block">
            <span class="set-label">おすすめ（集中 / 休憩）</span>
            <div class="presets">
              ${PRESETS.map((p, i) => `<button type="button" class="chip" data-preset="${i}" aria-pressed="false" title="集中${p.focus}分・小休憩${p.short}分・長休憩${p.long}分">${p.focus} / ${p.short}</button>`).join("")}
            </div>
          </div>
          <div class="set-durs">
            ${["focus", "short", "long"].map((k) => `
              <label class="dur"><span>${NAMES[k]}</span>
                <span class="dur-input"><input type="number" inputmode="numeric" min="${MIN_MIN}" max="${MAX_MIN}" step="1" data-dur="${k}" aria-label="${NAMES[k]}の長さ（分）"><small>分</small></span>
              </label>`).join("")}
          </div>
          <label class="set-check"><input type="checkbox" data-opt="autoStart"><span>終わったら次を自動で始める</span></label>
          <label class="set-check" data-notify-row hidden><input type="checkbox" data-opt="notify"><span>通知を出す</span></label>
          <p class="set-note" data-note aria-live="polite"></p>
          <div class="set-foot">
            <span class="set-hint">スペースキーで開始／一時停止</span>
            <button type="button" class="chip" data-act="close-settings">とじる</button>
          </div>
        </div>
      </div>
      <div class="timer-controls">
        <button type="button" class="t-sub t-reset" data-act="reset" aria-label="リセット" title="この段階を最初から">
          <span class="t-sub-icon">${ICON.reset}</span><span>リセット</span>
        </button>
        <button type="button" class="t-main" data-act="toggle" aria-label="開始">
          <span class="t-main-icon" data-toggle-icon>${ICON.play}</span><span data-toggle-label>開始</span>
        </button>
        <button type="button" class="t-sub t-skip" data-act="skip" aria-label="次へ" title="次の段階へ（飛ばす）">
          <span class="t-sub-icon">${ICON.skip}</span><span>次へ</span>
        </button>
      </div>
    </div>
    <div class="timer-mini">
      <i class="phase-dot" aria-hidden="true"></i>
      <span class="mini-name" data-name>集中</span>
      <span class="mini-time" data-time>25:00</span>
      <button type="button" class="mini-btn" data-act="toggle" aria-label="開始"><span data-toggle-icon>${ICON.play}</span></button>
    </div>
    <p class="sr-only" aria-live="polite" data-live></p>`;

  const $ = (s) => root.querySelector(s);
  const $$ = (s) => [...root.querySelectorAll(s)];
  const el = {
    names: $$("[data-name]"), times: $$("[data-time]"), ring: $("[data-ring]"), sub: $("[data-sub]"),
    dots: $$(".dots i"), round: $("[data-round]"), roundNum: $("[data-round-num]"), roundSr: $("[data-round-sr]"),
    toggles: $$('[data-act="toggle"]'), toggleIcons: $$("[data-toggle-icon]"), toggleLabel: $("[data-toggle-label]"),
    reset: $('[data-act="reset"]'), skip: $('[data-act="skip"]'), gear: $('[data-act="settings"]'),
    dial: $("[data-dial]"), settings: $("[data-settings]"), note: $("[data-note]"), live: $("[data-live]"),
    presets: $$("[data-preset]"), durs: $$("[data-dur]"),
    auto: $('[data-opt="autoStart"]'), notify: $('[data-opt="notify"]'), notifyRow: $("[data-notify-row]"),
  };
  const canNotify = typeof window !== "undefined" && "Notification" in window && !IS_MOBILE;
  el.notifyRow.hidden = !canNotify;

  // 早回しの印（画面の隅）
  if (FAST && !document.querySelector(".fast-badge")) {
    const b = document.createElement("span");
    b.className = "fast-badge";
    b.textContent = "早回し中（1分＝1秒）";
    const bar = document.querySelector(".toolbar");
    if (bar) bar.prepend(b); else document.body.append(b);
  }

  // ---------- 状態 ----------
  let endTimer = 0;
  let tickTimer = 0;
  let lastDuck = null;
  let settingsOpen = false;
  let claimTimer = 0;
  let midnightTimer = 0;
  let subNote = ""; // ひとこと（閉じていた間は止めた、など）。次の操作で消す

  const remaining = (now = Date.now()) => (st.running ? Math.max(0, st.endsAt - now) : st.remainingMs);
  const isIdle = () => !st.running && !st.started && st.phase === "focus" && st.round === 1;
  const publicPhase = () => (isIdle() ? "idle" : st.phase);

  function callAudio(name, ...args) {
    const fn = audio && audio[name];
    if (typeof fn !== "function") return;
    try {
      const r = fn.apply(audio, args);
      if (r && typeof r.catch === "function") r.catch((e) => console.error(`[timer] audio.${name}`, e));
    } catch (e) { console.error(`[timer] audio.${name}`, e); }
  }

  function applyDuck() {
    const want = st.phase !== "focus";
    if (want === lastDuck) return;
    lastDuck = want;
    callAudio("duck", want);
  }

  // 次の段階へ（止まった・手つかずの状態にする）
  function advance() {
    if (st.phase === "focus") st.phase = st.round >= LONG_EVERY ? "long" : "short";
    else if (st.phase === "short") { st.phase = "focus"; st.round = Math.min(LONG_EVERY, st.round + 1); }
    else { st.phase = "focus"; st.round = 1; }
    st.totalMs = dur(st.phase);
    st.remainingMs = st.totalMs;
    st.running = false;
    st.started = false;
    st.endsAt = 0;
    st.segStart = 0;
  }

  function runFrom(t) {
    st.running = true;
    st.started = true;
    st.endsAt = t + st.remainingMs;
    st.segStart = st.phase === "focus" ? t : 0;
  }

  function commit() {
    if (!othersRun()) save(); // ほかのタブが持ち主のときは書かない（書き合いにならないように）
    applyDuck();
    render();
    schedule();
    bus.emit("timer:phase", { phase: publicPhase(), running: st.running });
    emitTick();
  }

  function emitTick() {
    bus.emit("timer:tick", { phase: publicPhase(), remainingMs: remaining() * SCALE, totalMs: st.totalMs * SCALE });
  }

  // 終わった段階をまとめて片づける（隠れたタブ・スリープ明けも）
  function processDue(lateLimit = LATE_LIMIT_MS) {
    if (st.running && !isOwner()) {
      // ほかのタブが持ち主: 進めるのはそちら。ただし長く音沙汰がなければ引き継ぐ
      if (st.owner && Date.now() - lastRemoteSaveAt < OWNER_STALE_MS) return false;
      // 持ち主がいない（閉じられた）: 裏のタブは、ほかのタブと取り合わないよう先に引き継ぎを試す
      if (!st.owner && document.visibilityState !== "visible") { tryClaim(); return false; }
      claim();
    }
    let changed = false;
    let guard = 0;
    while (st.running && Date.now() >= st.endsAt && guard++ < 200) {
      const endedAt = st.endsAt;
      const ended = st.phase;
      const late = Date.now() - endedAt;
      const onTime = late <= lateLimit;
      if (ended === "focus") {
        reloadStats();
        creditFocus(endedAt);
        day(dayKey(endedAt)).pomos += 1;
        saveStats();
      }
      advance();
      if (onTime) {
        callAudio("chime", ended === "focus" ? "focusEnd" : "breakEnd");
        bus.emit("timer:done", { phase: ended });
        notify(ended);
        announce(ended);
      }
      if (settings.autoStart && onTime) runFrom(endedAt);
      changed = true;
    }
    if (changed) commit();
    return changed;
  }

  function schedule() {
    clearTimeout(endTimer);
    clearTimeout(tickTimer);
    if (!st.running) return;
    // 終わりの時刻に合わせて予約（表示の更新とは別）。ほかのタブが持ち主なら、固まっていないか確かめる時刻にも
    let at = st.endsAt;
    if (othersRun()) at = Math.max(at, lastRemoteSaveAt + OWNER_STALE_MS);
    endTimer = setTimeout(() => { if (!processDue()) { render(); queueTick(); } }, Math.max(0, at - Date.now()) + 5);
    queueTick();
  }

  // 秒が切り替わった直後に描く
  const nextDelay = () => Math.max(20, ((st.endsAt - Date.now()) % 1000) + 15);

  function queueTick() {
    clearTimeout(tickTimer);
    if (!st.running) return;
    const delay = nextDelay();
    tickTimer = setTimeout(tick, delay);
    render(delay);
  }

  function tick() {
    if (!st.running) return;
    if (Date.now() >= st.endsAt) { if (!processDue()) render(); return; }
    // 持ち主は、ときどき保存して生きている印を残す
    if (isOwner() && Date.now() - lastSaveAt > HEARTBEAT_MS) save();
    emitTick();
    queueTick();
  }

  // ---------- 操作 ----------
  // 操作の前に: このタブが持ち主になり、終わり時刻を過ぎていれば先に終わりの処理をする
  function beforeAction() {
    subNote = "";
    claim();
    return st.running && Date.now() >= st.endsAt ? processDue() : false;
  }
  function start() {
    beforeAction();
    if (st.running) return;
    if (st.remainingMs <= 0) st.remainingMs = st.totalMs;
    runFrom(Date.now());
    commit();
  }
  function pauseNow() {
    if (!st.running) return;
    const now = Date.now();
    creditFocus(now);
    st.remainingMs = Math.max(0, st.endsAt - now);
    st.running = false;
    st.endsAt = 0;
    commit();
  }
  // 終わった直後に届いた「一時停止」は、終わりを数えたうえで次の段階を止める
  function pause() { beforeAction(); pauseNow(); }
  function toggle() {
    const wasRunning = st.running;
    const ended = beforeAction();
    if (ended) { if (wasRunning) pauseNow(); return; }
    if (st.running) pauseNow(); else start();
  }
  function skip() {
    if (beforeAction()) return; // ちょうど終わった: 次の段階へはもう進んでいる
    const now = Date.now();
    const wasRunning = st.running;
    if (wasRunning) creditFocus(now);
    advance();
    if (wasRunning) runFrom(now);
    commit();
  }
  function reset() {
    beforeAction();
    const now = Date.now();
    if (st.running) creditFocus(now);
    const wasFresh = !st.running && !st.started;
    if (wasFresh) { st.phase = "focus"; st.round = 1; } // 2回目は最初から
    st.running = false;
    st.started = false;
    st.endsAt = 0;
    st.segStart = 0;
    st.totalMs = dur(st.phase);
    st.remainingMs = st.totalMs;
    commit();
  }

  // ---------- 通知・読み上げ ----------
  function nextText() {
    const n = settings[st.phase];
    return st.phase === "focus" ? `次は集中（${n}分）です。` : `次は${NAMES[st.phase]}（${n}分）です。`;
  }
  function announce(ended) {
    el.live.textContent = `${NAMES[ended]}がおわりました。${nextText()}`;
  }
  function notify(ended) {
    if (!settings.notify || !canNotify || Notification.permission !== "granted") return;
    if (document.visibilityState === "visible" && document.hasFocus()) return;
    const title = ended === "focus" ? "集中おわり" : "休憩おわり";
    const body = ended === "focus"
      ? `おつかれさま。${nextText()}`
      : (settings.autoStart ? `集中（${settings.focus}分）がはじまりました。` : `次の集中（${settings.focus}分）をはじめましょう。`);
    try { new Notification(title, { body, tag: "amayadori-timer" }); } catch { /* 出せない環境は黙って続ける */ }
  }

  // ---------- 描画 ----------
  // ahead: 次の描画までの ms。輪はその時刻の値へ、その長さで動かす（遅れない）
  function render(ahead = 0) {
    const now = Date.now();
    const rem = remaining(now);
    const text = fmt(FAST ? Math.ceil(rem / 1000) * 1000 * SCALE : rem);
    for (const t of el.times) t.textContent = text;
    root.classList.toggle("is-long-time", text.length > 5);
    root.dataset.phase = st.phase;
    root.dataset.state = st.running ? "running" : st.started ? "paused" : "ready";
    root.classList.toggle("is-running", st.running);
    for (const n of el.names) n.textContent = NAMES[st.phase];

    const target = st.running && ahead > 0 ? Math.max(0, rem - ahead) : rem;
    const frac = st.totalMs > 0 ? target / st.totalMs : 0;
    const offset = String(Math.min(100, Math.max(0, 100 * (1 - frac))));
    if (st.running && ahead > 0) {
      el.ring.style.transition = `stroke-dashoffset ${ahead}ms linear`;
      el.ring.style.strokeDashoffset = offset;
    } else {
      // 段階の切り替えや停止では動かさずに置く
      el.ring.style.transition = "none";
      el.ring.style.strokeDashoffset = offset;
      void el.ring.getBoundingClientRect();
    }

    const done = st.phase === "focus" ? st.round - 1 : st.round;
    el.dots.forEach((d, i) => {
      d.classList.toggle("is-done", i < done);
      d.classList.toggle("is-now", st.phase === "focus" && i === st.round - 1);
    });
    el.roundNum.textContent = `${st.round} / ${LONG_EVERY}`;
    el.roundSr.textContent = `${LONG_EVERY}回中${st.round}回目`;
    el.round.title = `${LONG_EVERY}回中${st.round}回目（${LONG_EVERY}回ごとに長休憩）`;

    el.sub.textContent = subNote || (othersRun()
      ? "別のタブで動いています"
      : st.running
        ? (FAST ? "早回し中" : `${clock(st.endsAt)} まで`)
        : st.started ? "一時停止中" : st.phase === "focus" ? "はじめましょう" : "ひと休み");

    const label = st.running ? "一時停止" : st.started ? "再開" : "開始";
    el.toggleLabel.textContent = label;
    for (const b of el.toggles) { b.setAttribute("aria-label", label); b.title = `${label}（スペースキー）`; }
    for (const i of el.toggleIcons) i.innerHTML = st.running ? ICON.pause : ICON.play;

    el.reset.disabled = isIdle();
    el.reset.title = !st.running && !st.started ? "最初（1回目の集中）に戻す" : "この段階を最初から";

    document.title = st.running ? `${text} ${NAMES[st.phase]} — ${BASE_TITLE}` : BASE_TITLE;
    renderStats(now);
  }

  // 今日の記録
  let statsEl = null;
  if (statsRoot) {
    statsRoot.innerHTML = `
      <h2 class="panel-title">今日の記録</h2>
      <div class="stats-nums">
        <div class="stat"><span class="stat-val"><b data-today-min>0</b><small>分</small></span><span class="stat-label">集中した時間</span></div>
        <div class="stat"><span class="stat-val"><b data-today-pomo>0</b><small>回</small></span><span class="stat-label">終えたポモドーロ</span></div>
      </div>
      <div class="week-head"><span>直近7日</span><span class="week-max" data-week-max></span></div>
      <div class="stats-week" data-week role="img"></div>`;
    statsEl = {
      min: statsRoot.querySelector("[data-today-min]"),
      pomo: statsRoot.querySelector("[data-today-pomo]"),
      week: statsRoot.querySelector("[data-week]"),
      max: statsRoot.querySelector("[data-week-max]"),
    };
    statsEl.week.innerHTML = Array.from({ length: 7 }, () =>
      '<div class="bar-col"><div class="bar"><i></i></div><span class="bar-day"></span></div>').join("");
    statsEl.cols = [...statsEl.week.children];
  }

  // いま進んでいる集中のうち、[from, to) に入る分（0時をまたぐ集中は日ごとに分けて出す）
  function liveFocusIn(from, to, now) {
    if (!(st.running && st.phase === "focus" && st.segStart)) return 0;
    return Math.max(0, Math.min(now, to) - Math.max(st.segStart, from)) * SCALE;
  }
  const liveFocusMs = (now) => liveFocusIn(startOfDay(now), nextMidnight(now), now);

  let lastWeekSig = "";
  function renderStats(now) {
    if (!statsEl) return;
    const k = dayKey(now);
    const today = statsData.days[k] || { focusMs: 0, pomos: 0 };
    const todayMs = today.focusMs + liveFocusMs(now);
    statsEl.min.textContent = String(Math.floor(todayMs / 60_000));
    statsEl.pomo.textContent = String(today.pomos);

    const rows = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setHours(12, 0, 0, 0);
      d.setDate(d.getDate() - i);
      const key = dayKey(d.getTime());
      const ms = i === 0 ? todayMs : (statsData.days[key]?.focusMs || 0) + liveFocusIn(startOfDay(d.getTime()), nextMidnight(d.getTime()), now);
      rows.push({ d, min: Math.floor(ms / 60_000), today: i === 0 });
    }
    const sig = rows.map((r) => r.min).join(",") + k;
    if (sig === lastWeekSig) return;
    lastWeekSig = sig;
    const max = Math.max(60, ...rows.map((r) => r.min));
    rows.forEach((r, i) => {
      const col = statsEl.cols[i];
      col.classList.toggle("is-today", r.today);
      col.querySelector("i").style.height = `${r.min > 0 ? Math.max(4, (r.min / max) * 100) : 0}%`;
      col.querySelector(".bar-day").textContent = r.today ? "今日" : WEEK[r.d.getDay()];
      col.title = `${r.d.getMonth() + 1}/${r.d.getDate()}（${WEEK[r.d.getDay()]}） ${r.min}分`;
    });
    const best = Math.max(...rows.map((r) => r.min));
    statsEl.max.textContent = best > 0 ? `いちばん ${best}分` : "";
    statsEl.week.setAttribute("aria-label",
      "直近7日の集中時間: " + rows.map((r) => `${r.today ? "今日" : WEEK[r.d.getDay()] + "曜"} ${r.min}分`).join("、"));
  }

  // ---------- 設定 ----------
  function syncSettingsUI() {
    for (const inp of el.durs) inp.value = String(settings[inp.dataset.dur]);
    el.presets.forEach((b, i) => {
      const p = PRESETS[i];
      b.setAttribute("aria-pressed", String(p.focus === settings.focus && p.short === settings.short && p.long === settings.long));
    });
    el.auto.checked = settings.autoStart;
    el.notify.checked = settings.notify && canNotify && Notification.permission === "granted";
  }

  function applySettings(patch) {
    Object.assign(settings, patch);
    const untouched = !st.running && !st.started;
    if (untouched) { st.totalMs = dur(st.phase); st.remainingMs = st.totalMs; }
    if ("focus" in patch || "short" in patch || "long" in patch) {
      el.note.textContent = untouched ? "" : "いま進んでいる段階はそのまま。次の段階から変わります。";
    }
    syncSettingsUI();
    save();
    render();
    if (untouched) emitTick();
  }

  function setSettingsOpen(open) {
    settingsOpen = open;
    el.dial.hidden = open;
    el.settings.hidden = !open;
    el.gear.setAttribute("aria-expanded", String(open));
    root.classList.toggle("is-settings", open);
    if (open) syncSettingsUI(); else el.note.textContent = "";
  }

  async function onNotifyChange() {
    if (!el.notify.checked) { applySettings({ notify: false }); return; }
    if (!canNotify) { el.notify.checked = false; return; }
    let perm = Notification.permission;
    if (perm === "default") {
      perm = await new Promise((res) => {
        try {
          const p = Notification.requestPermission(res);
          if (p && typeof p.then === "function") p.then(res, () => res("denied"));
        } catch { res("denied"); }
      });
    }
    if (perm === "granted") {
      applySettings({ notify: true });
      el.note.textContent = "タブが裏にあるとき、終わりを通知でお知らせします。";
    } else {
      applySettings({ notify: false });
      el.notify.checked = false;
      el.note.textContent = "通知が許可されませんでした（ブラウザの設定で変えられます）。";
    }
  }

  // ---------- つなぐ ----------
  const blurIfMouse = (e) => { if (e.detail > 0 && e.currentTarget.blur) e.currentTarget.blur(); };
  for (const b of el.toggles) b.addEventListener("click", (e) => { blurIfMouse(e); toggle(); });
  el.reset.addEventListener("click", (e) => { blurIfMouse(e); reset(); });
  el.skip.addEventListener("click", (e) => { blurIfMouse(e); skip(); });
  el.gear.addEventListener("click", (e) => { blurIfMouse(e); setSettingsOpen(!settingsOpen); });
  // キーボードで閉じたときだけ歯車へ戻す（マウスのあとのスペースが設定を開き直さないように）
  $('[data-act="close-settings"]').addEventListener("click", (e) => { blurIfMouse(e); setSettingsOpen(false); if (e.detail === 0) el.gear.focus(); });
  el.presets.forEach((b, i) => b.addEventListener("click", (e) => { blurIfMouse(e); applySettings({ ...PRESETS[i] }); }));
  for (const inp of el.durs) {
    inp.addEventListener("change", () => {
      const k = inp.dataset.dur;
      // 空・数字でないときは元の値に戻す（1分にしない）
      if (inp.value.trim() === "" || inp.validity?.badInput) { inp.value = String(settings[k]); return; }
      applySettings({ [k]: clampMin(inp.value, settings[k]) });
    });
  }
  el.auto.addEventListener("change", () => applySettings({ autoStart: el.auto.checked }));
  el.notify.addEventListener("change", onNotifyChange);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && settingsOpen && root.contains(document.activeElement)) { setSettingsOpen(false); return; }
    if (e.code !== "Space" && e.key !== " ") return;
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
    const t = e.target;
    if (t && t.closest && t.closest('input, textarea, select, button, summary, a[href], [contenteditable=""], [contenteditable="true"], [role="slider"], [role="button"], [role="textbox"]')) return;
    const ov = document.getElementById("start-overlay");
    if (ov && !ov.hidden && !ov.classList.contains("is-gone")) return;
    e.preventDefault();
    toggle();
  });

  // 見えているタブが持ち主になる（合図はいま見ているタブで鳴る）
  const wake = () => {
    if (othersRun() && document.visibilityState === "visible") { claim(); save(); }
    if (!processDue()) { render(); queueTick(); }
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") wake();
    else if (st.running && isOwner()) save(); // 隠れる時刻を残す（このあと閉じられたときの目安）
  });
  window.addEventListener("pageshow", (e) => { if (e.persisted) adoptFromStorage(); wake(); });
  window.addEventListener("focus", wake);
  // 閉じる・移るとき: 持ち主をやめて時刻を残す（ほかのタブが引き継ぐ。読み込み直しならすぐ取り戻す）
  window.addEventListener("pagehide", () => {
    if (st.running && isOwner()) { st.owner = null; save(); }
  });

  // ---------- ほかのタブとそろえる ----------
  function adoptSettings(s0) {
    if (!s0 || typeof s0 !== "object") return;
    for (const k of ["focus", "short", "long"]) settings[k] = clampMin(s0[k], settings[k]);
    if (typeof s0.autoStart === "boolean") settings.autoStart = s0.autoStart;
    if (typeof s0.notify === "boolean") settings.notify = s0.notify;
  }
  function adoptFromStorage() {
    const saved2 = readJSON(KEY_TIMER);
    if (!saved2) return;
    adoptSettings(saved2.settings);
    const r = restoreRun(saved2.run);
    if (r) {
      st = r;
      lastRemoteSaveAt = Number(saved2.run.savedAt) || Date.now();
    }
    reloadStats();
    subNote = "";
    if (settingsOpen) syncSettingsUI();
    // 保存はしない（書き合いにならないように）
    applyDuck();
    render();
    schedule();
    bus.emit("timer:phase", { phase: publicPhase(), running: st.running });
    emitTick();
    if (st.running && !st.owner) tryClaim();
  }
  // 持ち主が閉じたとき、残ったタブのどれか1つが引き継ぐ（見えているタブが先）
  function tryClaim() {
    clearTimeout(claimTimer);
    const delay = document.visibilityState === "visible" ? 30 : 400 + Math.random() * 1200;
    claimTimer = setTimeout(() => {
      const s1 = readJSON(KEY_TIMER);
      const r = s1 && restoreRun(s1.run);
      if (!r || !r.running || r.owner) return; // もう誰かが持った（その知らせは storage で届く）
      claim();
      save();
      // 同時に取ったタブがあれば、最後に書いた方を持ち主にそろえる
      claimTimer = setTimeout(() => {
        const s2 = readJSON(KEY_TIMER);
        const o = s2?.run?.owner;
        if (o && o !== TAB_ID) { st.owner = o; lastRemoteSaveAt = Date.now(); render(); schedule(); return; }
        if (!processDue()) { render(); schedule(); }
      }, 300);
    }, delay);
  }
  window.addEventListener("storage", (e) => {
    if (e.storageArea && e.storageArea !== localStorage) return;
    if (e.key === KEY_STATS) { reloadStats(); render(); return; }
    if (e.key === KEY_TIMER || e.key === null) adoptFromStorage();
  });

  // 0時を過ぎたら「今日の記録」を描き直す（止まっている間も）
  function scheduleMidnight() {
    clearTimeout(midnightTimer);
    const now = Date.now();
    midnightTimer = setTimeout(() => { lastWeekSig = ""; render(); scheduleMidnight(); }, nextMidnight(now) - now + 50);
  }
  scheduleMidnight();

  // 起動
  {
    const now = Date.now();
    const seenAt = Number(saved.run?.savedAt) || 0;
    if (st.running) {
      const ownerAlive = !!st.owner && now - seenAt < OWNER_STALE_MS;
      if (!ownerAlive && seenAt && now - seenAt > CLOSED_GAP_MS && seenAt < st.endsAt) {
        // ページを閉じていた: 閉じた時刻で一時停止したことにする（閉じていた間は数えない）
        st.owner = TAB_ID;
        creditFocus(seenAt);
        st.remainingMs = Math.max(0, st.endsAt - seenAt);
        st.running = false;
        st.endsAt = 0;
        st.segStart = 0;
        st.owner = null;
        subNote = "閉じていた間は止めていました";
        el.live.textContent = "ページを閉じていた間は、タイマーを止めていました。";
      } else if (!ownerAlive || document.visibilityState === "visible") {
        claim(); // 読み込み直し・見えているタブ: このタブが引き継ぐ
      }
      // それ以外（裏で開いたタブ）は、ほかのタブが動かしているので表示だけ合わせる
    }
  }
  // 読み込み直しの間に終わっていたら片づける
  if (!processDue(RESTORE_LATE_LIMIT_MS)) commit();

  return {
    start, pause, toggle, skip, reset,
    // あとから読み込まれた部品のために、いまの状態をもう一度知らせる
    announce() {
      bus.emit("timer:phase", { phase: publicPhase(), running: st.running });
      emitTick();
    },
    getState: () => ({ ...st, remainingMs: remaining(), fast: FAST }),
    getSettings: () => ({ ...settings }),
  };
}
