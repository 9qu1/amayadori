// 起動。各部品の init を呼ぶだけ（中身は各ファイル）
import { bus } from "./bus.js";
import { initTimer } from "./timer.js";

const $ = (id) => document.getElementById(id);
const report = (what, e) => console.error(`[main] ${what}`, e);

// 部品はひとつ壊れても他が動くよう、別々に読み込む
const load = (path) => import(path).catch((e) => { report(`${path} を読み込めませんでした`, e); return null; });

// 音はあとから届くので、タイマーには取り次ぎ役を渡す
let audio = null;
let duckWanted = false;
const audioProxy = {
  chime: (kind) => audio?.chime?.(kind),
  duck: (on) => { duckWanted = on; return audio?.duck?.(on); },
};

let timer = null;
try {
  timer = initTimer({ root: $("timer"), stats: $("stats"), audio: audioProxy });
} catch (e) { report("initTimer", e); }

// 音は届いたらすぐ使えるようにする（「はじめる」の操作の中で start() を呼ぶため）
const audioLoad = load("./audio.js").then((m) => { audio = m?.audio ?? null; return m; });

const ready = (async () => {
  const [audioMod, sceneMod, mixerMod] = await Promise.all([audioLoad, load("./scene.js"), load("./mixer-ui.js")]);
  try { sceneMod?.initScene?.($("scene")); } catch (e) { report("initScene", e); }
  audio = audioMod?.audio ?? null;
  if (audio) {
    try { if (duckWanted) audio.duck?.(true); } catch (e) { report("audio.duck", e); }
    try { mixerMod?.initMixer?.($("mixer"), audio); } catch (e) { report("initMixer", e); }
  }
  // 絵や音があとから来たので、タイマーの状態をもう一度知らせる
  try { timer?.announce?.(); } catch (e) { report("timer.announce", e); }
})();

// ---------- 絵の位置を CSS に知らせる（パネルがテレビや火を避けるため） ----------
// #scene .stage が絵そのものの大きさ（3:2）なら測って使う。違えば CSS の既定（中央基準の cover）のまま
const PIC_VARS = ["--pic-s", "--pic-x", "--pic-y"];
function syncPicVars() {
  const rootStyle = document.documentElement.style;
  const stage = document.querySelector("#scene .stage");
  const r = stage?.getBoundingClientRect();
  const fullScreen = getComputedStyle($("scene")).position === "fixed";
  if (!r || !fullScreen || !(r.width > 0 && r.height > 0) || Math.abs(r.width / r.height - 1536 / 1024) > 0.02) {
    for (const k of PIC_VARS) rootStyle.removeProperty(k);
    return;
  }
  rootStyle.setProperty("--pic-s", `${r.width / 1536}px`);
  rootStyle.setProperty("--pic-x", `${r.left}px`);
  rootStyle.setProperty("--pic-y", `${r.top}px`);
}
let picRaf = 0;
const queuePicSync = () => { cancelAnimationFrame(picRaf); picRaf = requestAnimationFrame(syncPicVars); };
bus.on("scene:ready", queuePicSync);
window.addEventListener("resize", queuePicSync);
ready.then(queuePicSync);

// ---------- はじめる ----------
const overlay = $("start-overlay");
const startBtn = $("start-btn");
const appEl = document.querySelector(".app");
// 幕が出ている間は、後ろの部品に触れない・フォーカスが入らないようにする
if (appEl) appEl.inert = true;
document.documentElement.classList.add("is-starting");
// 音の部品が届くまでは押せない（iPhone は操作の外で始めた音が鳴らないため）。読めなくても押せるようにはする
startBtn.disabled = true;
const enableStart = () => {
  if (!startBtn.disabled) return;
  startBtn.disabled = false;
  if (!overlay.hidden && !overlay.classList.contains("is-gone")) {
    try { startBtn.focus({ preventScroll: true }); } catch { /* なし */ }
  }
};
audioLoad.then(enableStart);
setTimeout(enableStart, 8000);
function startAudio() {
  try {
    const r = audio?.start?.();
    if (r && typeof r.catch === "function") r.catch((e) => report("audio.start", e));
  } catch (e) { report("audio.start", e); }
}
startBtn.addEventListener("click", () => {
  // 音はユーザー操作の中で始める（ブラウザの決まり）
  bus.emit("app:start");
  if (audio) startAudio(); else ready.then(startAudio);
  wakeLock.want = true;
  requestWakeLock();
  overlay.classList.add("is-gone");
  if (appEl) appEl.inert = false;
  document.documentElement.classList.remove("is-starting");
  try { window.scrollTo(0, 0); } catch { /* なし */ }
  // 次はタイマーの「開始」へ（キーボードで続けて操作できるように）
  const next = document.querySelector('#timer .t-main');
  try { next?.focus({ preventScroll: true }); } catch { /* なし */ }
  setTimeout(() => { overlay.hidden = true; }, 600);
});

// ---------- 画面を消さない（Screen Wake Lock。机に置いて集中するとき用） ----------
// 使えない端末では何もしない。隠れると外れるので、見えるようになったら取り直す
const wakeLock = { want: false, sentinel: null, busy: false };
async function requestWakeLock() {
  if (!wakeLock.want || wakeLock.sentinel || wakeLock.busy) return;
  if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;
  wakeLock.busy = true;
  try {
    const s = await navigator.wakeLock.request("screen");
    wakeLock.sentinel = s;
    s.addEventListener("release", () => { if (wakeLock.sentinel === s) wakeLock.sentinel = null; });
  } catch { /* 電池の節約モードなどで断られたら諦める */ }
  wakeLock.busy = false;
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") requestWakeLock(); });
bus.on("timer:phase", (d) => { if (d?.running) { wakeLock.want = true; requestWakeLock(); } });

// iPhone で押した瞬間の見た目（:active）を出すため（受け手がないと付かない）
document.addEventListener("touchstart", () => {}, { passive: true });

// マウスで押したボタンはフォーカスを外す（あとのスペースキーがタイマーに届くように）
const blurIfMouse = (e) => { if (e.detail > 0 && e.currentTarget.blur) e.currentTarget.blur(); };

// ---------- 表示を隠す ----------
const uiBtn = $("ui-toggle");
function setUiHidden(on) {
  document.body.classList.toggle("ui-hidden", on);
  // 名前が「表示を戻す」に変わるので aria-pressed は付けない（「押されている」と重なって逆の意味に聞こえる）
  uiBtn.querySelector("[data-label]").textContent = on ? "表示を戻す" : "表示を隠す";
  uiBtn.title = on ? "パネルを元に戻す" : "パネルを畳んで絵を見る";
  uiBtn.querySelector("[data-eye-off]").hidden = on;
  uiBtn.querySelector("[data-eye]").hidden = !on;
  // 絵の箱の大きさが変わるので知らせる（stage.js が測り直せるように）
  requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
}
uiBtn.addEventListener("click", (e) => { blurIfMouse(e); setUiHidden(!document.body.classList.contains("ui-hidden")); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.body.classList.contains("ui-hidden") && !fsElement()) setUiHidden(false);
});

// ---------- 全画面（使えないときは出さない） ----------
const fsBtn = $("fs-toggle");
const docEl = document.documentElement;
const requestFs = docEl.requestFullscreen || docEl.webkitRequestFullscreen;
const exitFs = document.exitFullscreen || document.webkitExitFullscreen;
const fsEnabled = document.fullscreenEnabled ?? document.webkitFullscreenEnabled ?? false;
function fsElement() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
function syncFs() {
  const on = !!fsElement();
  fsBtn.querySelector("[data-label]").textContent = on ? "全画面をやめる" : "全画面";
  fsBtn.title = on ? "全画面をやめる" : "全画面にする";
}
if (requestFs && exitFs && fsEnabled) {
  fsBtn.hidden = false;
  syncFs();
  fsBtn.addEventListener("click", (e) => {
    blurIfMouse(e);
    try {
      const r = fsElement() ? exitFs.call(document) : requestFs.call(docEl);
      if (r && typeof r.catch === "function") r.catch((e) => report("全画面", e));
    } catch (e) { report("全画面", e); }
  });
  document.addEventListener("fullscreenchange", syncFs);
  document.addEventListener("webkitfullscreenchange", syncFs);
}
