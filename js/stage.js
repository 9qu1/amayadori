// 絵を画面に敷く（cover）。重ねものは .stage の中に絵のピクセル座標で置く
export const PIC_W = 1536;
export const PIC_H = 1024;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const TALL = 0.8;

export function createStage(rootEl, opts = {}) {
  let picW = opts.w || PIC_W;
  let picH = opts.h || PIC_H;
  let focus = opts.focus || { x: picW / 2, y: picH / 2 };
  let keepX = opts.keepX || null; // できれば必ず入れたい横の範囲 [x0, x1]（絵の座標）
  let keepTop = opts.keepTop || 0; // これより上は切らない（絵の y。ポスターの上の縁など）
  let focusTall = opts.focusTall || null; // 縦長の画面（幅÷高さ < TALL）のときの中心

  const el = document.createElement("div");
  el.className = "stage";
  el.style.width = `${picW}px`;
  el.style.height = `${picH}px`;
  rootEl.appendChild(el);

  // s: 絵の1画素が画面で何 px か。tx, ty: 絵の左上の位置（rootEl の中）
  const st = { s: 1, tx: 0, ty: 0, dpr: 1, rw: 0, rh: 0 };
  const listeners = new Set();

  function layout() {
    const rw = rootEl.clientWidth;
    const rh = rootEl.clientHeight;
    if (!(rw > 0 && rh > 0)) return;
    const s = Math.max(rw / picW, rh / picH);
    // focus をできるだけ真ん中に。ただし絵の外が見えないよう端で止める
    const tall = !!focusTall && rw / rh < TALL;
    const f = tall ? focusTall : focus;
    const W = rw / s; // 見える横幅（絵の座標）
    let left = f.x - W / 2;
    if (!tall && keepX) {
      const [k0, k1] = keepX;
      // 入るなら範囲ごと入れる。入らないときは右（火・テレビ・ポスター）を優先
      left = W >= k1 - k0 ? clamp(left, k1 - W, k0) : k1 - W;
    }
    const tx = clamp(-left * s, rw - picW * s, 0);
    // 超横長でも keepTop より上は切らない
    const ty = clamp(rh / 2 - f.y * s, Math.min(0, Math.max(rh - picH * s, -keepTop * s)), 0);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const changed = s !== st.s || tx !== st.tx || ty !== st.ty || dpr !== st.dpr || rw !== st.rw || rh !== st.rh;
    Object.assign(st, { s, tx, ty, dpr, rw, rh });
    el.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
    if (changed) for (const fn of listeners) { try { fn(api); } catch (e) { console.error("[stage]", e); } }
  }

  let ro = null;
  if ("ResizeObserver" in window) {
    ro = new ResizeObserver(() => layout());
    ro.observe(rootEl);
  }
  // 画面の拡大率（devicePixelRatio）が変わったときも測り直す
  const onResize = () => layout();
  window.addEventListener("resize", onResize);

  const api = {
    el,
    get scale() { return st.s; },
    get dpr() { return st.dpr; },
    // 絵の座標 → 画面（ビューポート）の座標
    toScreen(x, y) {
      const r = rootEl.getBoundingClientRect();
      return [r.left + st.tx + x * st.s, r.top + st.ty + y * st.s];
    },
    // 画面の座標 → 絵の座標
    toPicture(cx, cy) {
      const r = rootEl.getBoundingClientRect();
      return [(cx - r.left - st.tx) / st.s, (cy - r.top - st.ty) / st.s];
    },
    // 今見えている絵の範囲（絵の座標）
    visibleRect() {
      return { x: -st.tx / st.s, y: -st.ty / st.s, w: st.rw / st.s, h: st.rh / st.s };
    },
    setPicture({ w, h, focus: f, keepX: kx, keepTop: kt, focusTall: ft } = {}) {
      if (w) picW = w;
      if (h) picH = h;
      if (f) focus = f;
      if (Array.isArray(kx) && kx.length === 2) keepX = kx;
      if (Number.isFinite(kt)) keepTop = kt;
      if (ft && Number.isFinite(ft.x)) focusTall = { x: ft.x, y: Number.isFinite(ft.y) ? ft.y : focus.y };
      el.style.width = `${picW}px`;
      el.style.height = `${picH}px`;
      st.s = -1; // 次の layout で必ず知らせる
      layout();
    },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    layout,
    destroy() {
      ro?.disconnect();
      window.removeEventListener("resize", onResize);
      listeners.clear();
      el.remove();
    },
  };

  layout();
  return api;
}
