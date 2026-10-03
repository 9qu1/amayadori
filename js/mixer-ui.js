// 音量つまみの画面。initMixer(rootEl, audio) で rootEl の中身を作る
// 見出しの横に「消音」ボタン（main.js の上の道具のボタンと同じ働き。状態は audio.onState でそろう）

const ICONS = {
  rain: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6.6 14.5h10a3.4 3.4 0 0 0 .5-6.77 5 5 0 0 0-9.6.9A2.95 2.95 0 0 0 6.6 14.5z"/><path d="M8.5 17.5 7.6 20M12.5 17.5l-.9 2.5M16.5 17.5l-.9 2.5"/></svg>',
  fire: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21c-3.3 0-6-2.4-6-5.7 0-2.5 1.5-4.2 3-5.8.3 1.6 1.1 2.6 2.1 3.1-.4-3.3 1.1-6.2 3.4-7.6-.2 2.5.9 4 2 5.4 1 1.3 1.5 2.6 1.5 4.6 0 3.4-2.7 6-6 6z"/><path d="M12 21c-1.4 0-2.5-1.1-2.5-2.5 0-1.2.8-2.1 1.7-2.9.2.9.7 1.4 1.3 1.6.1-.9.6-1.7 1.2-2.2.5.9 1 1.8 1 3 0 1.7-1.2 3-2.7 3z"/></svg>',
  typing: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="6.5" width="19" height="11" rx="2"/><path stroke-width="2" d="M6.5 10h.01M9.5 10h.01M12.5 10h.01M15.5 10h.01M18 10h.01M6.5 13h.01M9.5 13h.01M12.5 13h.01M15.5 13h.01M18 13h.01"/><path d="M8.5 15.3h7"/></svg>',
  // ノートと鉛筆
  pages: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M15 12.5V5a1.5 1.5 0 0 0-1.5-1.5h-8A1.5 1.5 0 0 0 4 5v14a1.5 1.5 0 0 0 1.5 1.5H10"/><path d="M7 3.5v17M9.5 8h3M9.5 11h3"/><path d="m13.2 20.6.6-2.8 5.6-5.6a1.5 1.5 0 0 1 2.1 2.1L15.9 20z"/></svg>',
  master: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5h3.4L12 6v12l-4.6-3.5H4z"/><path d="M15.5 9.5a3.5 3.5 0 0 1 0 5M18 7a7 7 0 0 1 0 10"/></svg>',
  // 消音中（スピーカーに ×）
  muted: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5h3.4L12 6v12l-4.6-3.5H4z"/><path d="m15.5 9.5 5 5M20.5 9.5l-5 5"/></svg>',
};

// iPhone・iPad の Safari は、つまみの丸をつかまないと動かない（線を触っても値が変わらない）。
// そこで、線を軽く叩いたらその位置へ、線から横に引いたらそのまま追う。縦に動いたらページのスクロールに任せる。
// 丸の上で触ったときは何もしない（いつもどおりブラウザが動かす）。thumb は丸の直径（mixer.css と同じ 22px）
const IS_IOS = (() => {
  try {
    return /iP(hone|ad|od)/.test(navigator.userAgent || "") || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  } catch { return false; }
})();
export function fixTrackTouch(input, thumb = 22) {
  const SLOP = 6; // これより動いたら「叩いた」ではない（px）
  const num = (x, d) => (Number.isFinite(Number(x)) && x !== "" ? Number(x) : d);
  const range = () => ({ min: num(input.min, 0), max: num(input.max, 100), step: num(input.step, 1) || 1 });
  // 丸の中心が動ける幅（両端は丸の半径ぶん内側）
  const geo = () => { const r = input.getBoundingClientRect(); return { left: r.left + thumb / 2, w: Math.max(1, r.width - thumb) }; };
  const valueAt = (x) => {
    const { min, max, step } = range(), g = geo();
    const p = Math.max(0, Math.min(1, (x - g.left) / g.w));
    return Math.max(min, Math.min(max, min + Math.round((p * (max - min)) / step) * step));
  };
  const set = (x, end) => {
    const v = String(valueAt(x));
    if (input.value !== v) {
      input.value = v;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    if (end) input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  let s = null;
  input.addEventListener("touchstart", (e) => {
    s = null;
    if (e.touches.length !== 1 || input.disabled) return;
    const t = e.touches[0], { min, max } = range(), g = geo();
    const cx = g.left + ((Number(input.value) - min) / (max - min || 1)) * g.w;
    if (Math.abs(t.clientX - cx) <= thumb / 2 + 4) return; // 丸の上
    s = { x: t.clientX, y: t.clientY, drag: false };
  }, { passive: true });
  input.addEventListener("touchmove", (e) => {
    if (!s) return;
    const t = e.touches[0];
    const dx = t.clientX - s.x, dy = t.clientY - s.y;
    if (!s.drag) {
      if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
      if (Math.abs(dy) >= Math.abs(dx)) { s = null; return; } // 縦：スクロールに任せる
      s.drag = true;
    }
    if (e.cancelable) e.preventDefault(); // 横に引いている間はページを動かさない
    set(t.clientX, false);
  }, { passive: false });
  input.addEventListener("touchend", (e) => {
    if (!s) return;
    const t = e.changedTouches[0];
    const tap = Math.abs(t.clientX - s.x) < SLOP && Math.abs(t.clientY - s.y) < SLOP;
    if (s.drag || tap) set(t.clientX, true);
    s = null;
  });
  input.addEventListener("touchcancel", () => { s = null; });
}

// 3つの大きさがそろうように（録音版。全体 80% で 60 秒の大きさが -24.5〜-24.8 LUFS。既定は -24.7。
// 10/3 に雨と焚き火を 3dB 下げた。その前は -21.6〜-22.3、既定 -21.7）
const PRESETS = [
  { key: "night", label: "雨の夜", vol: { rain: 0.75, fire: 0, typing: 0, pages: 0 } },
  { key: "hearth", label: "暖炉のそば", vol: { rain: 0.6, fire: 0.6, typing: 0, pages: 0 } },
  { key: "work", label: "作業の音", vol: { rain: 0.64, fire: 0, typing: 0.85, pages: 0.55 } },
];

export function initMixer(rootEl, audio) {
  if (!rootEl || !audio) return;
  const uid = "mx" + Math.random().toString(36).slice(2, 7);
  const sounds = audio.sounds || [];
  const canMute = typeof audio.setMuted === "function";
  const pct = (v) => Math.round((Number(v) || 0) * 100);

  const rowHtml = (id, label, value, aria, cls = "") => `
    <li class="mx-row ${cls}" data-id="${id}">
      <span class="mx-icon" aria-hidden="true">${ICONS[id] || ""}</span>
      <label class="mx-label" for="${uid}-${id}">${label.replace("を", "を<wbr>")}<span class="mx-badge" hidden>読み込み中…</span></label>
      <input class="mx-range" id="${uid}-${id}" type="range" min="0" max="100" step="1" value="${value}" aria-label="${aria}">
      <output class="mx-val" for="${uid}-${id}">${value}</output>
    </li>`;

  const wrap = document.createElement("div");
  wrap.className = "mx";
  wrap.innerHTML = `
    <div class="mx-head">
      <h2 class="mx-title">音</h2>
      <button type="button" class="mx-mute" aria-pressed="false" title="すべての音を消す（M キー）" ${canMute ? "" : "hidden"}>
        <span class="mx-mute-icon" aria-hidden="true">${ICONS.master}</span><span class="mx-mute-text">消音</span>
      </button>
      <span class="mx-mute-tag" hidden>消音中</span>
      <span class="mx-status" role="status" aria-live="polite"></span>
    </div>
    <ul class="mx-list">
      ${sounds.map((s) => rowHtml(s.id, s.label, pct(audio.getVolume(s.id)), `${s.label}の音量`)).join("")}
    </ul>
    <ul class="mx-list mx-master-list">
      ${rowHtml("master", "全体", pct(audio.getMaster()), "全体の音量", "mx-master")}
    </ul>
    <div class="mx-presets" role="group" aria-label="おすすめの組み合わせ">
      <span class="mx-sub">おすすめ</span>
      ${PRESETS.map((p) => `<button type="button" class="mx-preset" data-preset="${p.key}" aria-pressed="false">${p.label}</button>`).join("")}
    </div>
    <p class="mx-hint">はじめて上げた音は、鳴るまで少しかかることがあります。<span class="mx-hint-more">タイピングとノートと鉛筆はときどき鳴る音です（つまみを動かすと1回鳴ります）。</span></p>
    <p class="mx-credit">音: Joseph SARDIN（<a href="https://bigsoundbank.com/" target="_blank" rel="noopener">BigSoundBank.com</a>・CC0）</p>`;
  rootEl.replaceChildren(wrap);

  const $ = (s) => wrap.querySelector(s);
  const statusEl = $(".mx-status");
  const rows = {};
  wrap.querySelectorAll(".mx-row").forEach((li) => {
    rows[li.dataset.id] = { li, input: li.querySelector(".mx-range"), out: li.querySelector(".mx-val"), badge: li.querySelector(".mx-badge") };
    if (IS_IOS) fixTrackTouch(rows[li.dataset.id].input);
  });

  const paint = (id, v) => {
    const r = rows[id];
    if (!r) return;
    r.input.value = String(v);
    r.input.style.setProperty("--p", `${v}%`);
    r.out.textContent = String(v);
    r.li.classList.toggle("is-on", v > 0);
  };
  const syncPresets = () => {
    for (const btn of wrap.querySelectorAll(".mx-preset")) {
      const p = PRESETS.find((x) => x.key === btn.dataset.preset);
      const hit = p && sounds.every((s) => Math.abs(audio.getVolume(s.id) - (p.vol[s.id] ?? 0)) < 0.015);
      btn.setAttribute("aria-pressed", hit ? "true" : "false");
    }
  };

  for (const s of sounds) {
    const r = rows[s.id];
    paint(s.id, pct(audio.getVolume(s.id)));
    r.input.addEventListener("input", () => {
      const v = Number(r.input.value);
      paint(s.id, v);
      audio.setVolume(s.id, v / 100);
      syncPresets();
    });
  }
  {
    const r = rows.master;
    paint("master", pct(audio.getMaster()));
    r.input.addEventListener("input", () => {
      const v = Number(r.input.value);
      paint("master", v);
      audio.setMaster(v / 100);
    });
  }
  wrap.querySelectorAll(".mx-preset").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      if (e.detail > 0) btn.blur(); // マウスで押したらフォーカスを外す（あとのスペースがタイマーに届くように）
      const p = PRESETS.find((x) => x.key === btn.dataset.preset);
      if (!p) return;
      for (const s of sounds) {
        const v = p.vol[s.id] ?? 0;
        audio.setVolume(s.id, v);
        paint(s.id, pct(v));
      }
      syncPresets();
    });
  });
  syncPresets();

  // 消音（つまみの値はそのまま。戻すのは押した操作の中で＝止めていた音の処理を再開できるように）
  const muteBtn = $(".mx-mute");
  const muteIcon = $(".mx-mute-icon");
  const muteText = $(".mx-mute-text");
  const muteTag = $(".mx-mute-tag");
  let shownMuted = null;
  const paintMute = (on) => {
    if (on === shownMuted) return;
    shownMuted = on;
    muteBtn.setAttribute("aria-pressed", on ? "true" : "false");
    muteText.textContent = on ? "音を戻す" : "消音";
    muteBtn.title = on ? "音を戻す（M キー）" : "すべての音を消す（M キー）";
    muteIcon.innerHTML = on ? ICONS.muted : ICONS.master;
    muteTag.hidden = !on;
    wrap.classList.toggle("is-muted", on);
  };
  if (canMute) {
    paintMute(!!(audio.isMuted && audio.isMuted()));
    muteBtn.addEventListener("click", (e) => {
      if (e.detail > 0) muteBtn.blur(); // マウスで押したらフォーカスを外す（あとのスペースがタイマーに届くように）
      audio.setMuted(!(audio.isMuted && audio.isMuted()));
    });
  }

  const update = (st) => {
    if (!st) return;
    // 上の小さな知らせ
    let msg = "";
    if (st.error) msg = st.error;
    else if (st.loadError) msg = "読み込めませんでした（再読み込みしてください）";
    else if (st.started && !st.resuming && !st.muted && st.ctxState !== "running") msg = "音が止まっています。画面を一度タップすると戻ります";
    else if (st.preparing) {
      const cur = sounds.find((s) => s.id === (st.loading ?? st.building));
      msg = cur ? `読み込み中…（${cur.label}）` : "読み込み中…";
    }
    statusEl.textContent = msg;
    statusEl.hidden = !msg;
    statusEl.classList.toggle("is-error", !!(st.error || st.loadError));
    // 行ごとの読み込み中・失敗（その場に小さく出す。音量 0 の音は裏で先読みすることがあるので、待ちの印は出さない）
    for (const s of sounds) {
      const r = rows[s.id];
      const k = st.sounds ? st.sounds[s.id] : "ready";
      const on = st.vol ? st.vol[s.id] > 0 : true;
      const wait = st.started && on && (k === "waiting" || k === "loading" || k === "building");
      const bad = st.started && k === "error";
      r.badge.hidden = !(wait || bad);
      r.badge.textContent = bad ? "読み込めません" : "読み込み中…";
      r.li.classList.toggle("is-preparing", wait);
      r.li.classList.toggle("is-error", bad);
    }
    // ほかの場所から音量が変わったとき（つまみを動かしている最中は上書きしない）
    if (st.vol) {
      for (const s of sounds) {
        const r = rows[s.id];
        if (document.activeElement !== r.input && Number(r.input.value) !== pct(st.vol[s.id])) paint(s.id, pct(st.vol[s.id]));
      }
      syncPresets();
    }
    if (Number.isFinite(st.master) && document.activeElement !== rows.master.input && Number(rows.master.input.value) !== pct(st.master)) paint("master", pct(st.master));
    if (canMute) paintMute(!!st.muted);
  };
  if (typeof audio.onState === "function") audio.onState(update);
  else statusEl.hidden = true;
}
