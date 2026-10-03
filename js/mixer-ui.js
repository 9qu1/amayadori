// 音量つまみの画面。initMixer(rootEl, audio) で rootEl の中身を作る
// opts.showLock: true で「ロック中も流す」を iPhone 以外でも出す（確認用）

const ICONS = {
  rain: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6.6 14.5h10a3.4 3.4 0 0 0 .5-6.77 5 5 0 0 0-9.6.9A2.95 2.95 0 0 0 6.6 14.5z"/><path d="M8.5 17.5 7.6 20M12.5 17.5l-.9 2.5M16.5 17.5l-.9 2.5"/></svg>',
  fire: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21c-3.3 0-6-2.4-6-5.7 0-2.5 1.5-4.2 3-5.8.3 1.6 1.1 2.6 2.1 3.1-.4-3.3 1.1-6.2 3.4-7.6-.2 2.5.9 4 2 5.4 1 1.3 1.5 2.6 1.5 4.6 0 3.4-2.7 6-6 6z"/><path d="M12 21c-1.4 0-2.5-1.1-2.5-2.5 0-1.2.8-2.1 1.7-2.9.2.9.7 1.4 1.3 1.6.1-.9.6-1.7 1.2-2.2.5.9 1 1.8 1 3 0 1.7-1.2 3-2.7 3z"/></svg>',
  typing: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="6.5" width="19" height="11" rx="2"/><path stroke-width="2" d="M6.5 10h.01M9.5 10h.01M12.5 10h.01M15.5 10h.01M18 10h.01M6.5 13h.01M9.5 13h.01M12.5 13h.01M15.5 13h.01M18 13h.01"/><path d="M8.5 15.3h7"/></svg>',
  pages: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 6c2.8-1.1 5.8-1 8.5.9 2.7-1.9 5.7-2 8.5-.9v12.5c-2.8-1.1-5.8-1-8.5.9-2.7-1.9-5.7-2-8.5-.9z"/><path d="M12 6.9v12.5"/></svg>',
  master: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5h3.4L12 6v12l-4.6-3.5H4z"/><path d="M15.5 9.5a3.5 3.5 0 0 1 0 5M18 7a7 7 0 0 1 0 10"/></svg>',
};

// 3つの大きさがそろうように（録音版。全体 80% で 60 秒の大きさが -21.6〜-22.3 LUFS。既定は -21.7）
const PRESETS = [
  { key: "night", label: "雨の夜", vol: { rain: 0.75, fire: 0, typing: 0, pages: 0 } },
  { key: "hearth", label: "暖炉のそば", vol: { rain: 0.6, fire: 0.6, typing: 0, pages: 0 } },
  { key: "work", label: "作業の音", vol: { rain: 0.64, fire: 0, typing: 0.85, pages: 0.55 } },
];

const LOCK_TEXT = {
  off: "",
  waiting: "「はじめる」を押すと切り替わります",
  building: "ロック中用の音を作っています…",
  playing: "画面を消しても流れます",
  error: "うまく切り替えられませんでした。もう一度お試しください",
};

export function initMixer(rootEl, audio, opts = {}) {
  if (!rootEl || !audio) return;
  const uid = "mx" + Math.random().toString(36).slice(2, 7);
  const sounds = audio.sounds || [];
  const showLock = !!(opts.showLock || audio.lockSupported);
  const pct = (v) => Math.round((Number(v) || 0) * 100);

  const rowHtml = (id, label, value, aria, cls = "") => `
    <li class="mx-row ${cls}" data-id="${id}">
      <span class="mx-icon" aria-hidden="true">${ICONS[id] || ""}</span>
      <label class="mx-label" for="${uid}-${id}">${label.replace("を", "を<wbr>")}<span class="mx-badge" hidden>準備中</span></label>
      <input class="mx-range" id="${uid}-${id}" type="range" min="0" max="100" step="1" value="${value}" aria-label="${aria}">
      <output class="mx-val" for="${uid}-${id}">${value}</output>
    </li>`;

  const wrap = document.createElement("div");
  wrap.className = "mx";
  wrap.innerHTML = `
    <div class="mx-head">
      <h2 class="mx-title">音</h2>
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
    <div class="mx-lock" ${showLock ? "" : "hidden"}>
      <label class="mx-switch">
        <input class="mx-switch-input" type="checkbox" role="switch" aria-describedby="${uid}-locknote">
        <span class="mx-switch-ui" aria-hidden="true"></span>
        <span class="mx-switch-text">ロック中も流す（アイフォン向け）</span>
      </label>
      <p class="mx-note" id="${uid}-locknote">画面を消しても音が止まりにくくなります。音量を変えると、少しおくれて反映されます。ロック中は、タイマーの合図は鳴らず、休憩中に音を下げることもしません。</p>
      <p class="mx-lock-state" aria-live="polite"></p>
    </div>
    <p class="mx-credit">音: Joseph SARDIN（<a href="https://bigsoundbank.com/" target="_blank" rel="noopener">BigSoundBank.com</a>・CC0）</p>`;
  rootEl.replaceChildren(wrap);

  const $ = (s) => wrap.querySelector(s);
  const statusEl = $(".mx-status");
  const rows = {};
  wrap.querySelectorAll(".mx-row").forEach((li) => {
    rows[li.dataset.id] = { li, input: li.querySelector(".mx-range"), out: li.querySelector(".mx-val"), badge: li.querySelector(".mx-badge") };
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

  // ロック中も流す
  const lockBox = $(".mx-lock");
  const lockInput = $(".mx-switch-input");
  const lockState = $(".mx-lock-state");
  if (showLock && typeof audio.setLockMode === "function") {
    lockInput.checked = !!(audio.getLockMode && audio.getLockMode());
    // iOS の決まりで、切り替えは操作の中（change の中）で呼ぶ
    lockInput.addEventListener("change", () => audio.setLockMode(lockInput.checked));
  } else {
    lockBox.hidden = true;
  }

  const update = (st) => {
    if (!st) return;
    // 上の小さな知らせ
    let msg = "";
    if (st.error) msg = st.error;
    else if (st.loadError) msg = "読み込めませんでした（再読み込みしてください）";
    else if (st.started && !st.resuming && st.ctxState !== "running" && !(st.lock && st.lock.status === "playing")) msg = "音が止まっています。画面を一度タップすると戻ります";
    else if (st.preparing) {
      const cur = sounds.find((s) => s.id === (st.loading ?? st.building));
      msg = cur ? `読み込み中…（${cur.label}）` : "読み込み中…";
    }
    statusEl.textContent = msg;
    statusEl.hidden = !msg;
    statusEl.classList.toggle("is-error", !!(st.error || st.loadError));
    // 行ごとの読み込み中・失敗（音量 0 の音は上げられるまで読み込まないので、待ちの印は出さない）
    for (const s of sounds) {
      const r = rows[s.id];
      const k = st.sounds ? st.sounds[s.id] : "ready";
      const on = st.vol ? st.vol[s.id] > 0 : true;
      const wait = st.started && on && (k === "waiting" || k === "loading" || k === "building");
      const bad = st.started && k === "error";
      r.badge.hidden = !(wait || bad);
      r.badge.textContent = bad ? "読み込めませんでした" : "読み込み中";
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
    if (showLock && st.lock) {
      lockInput.checked = !!st.lock.on;
      lockState.textContent = st.lock.on ? LOCK_TEXT[st.lock.status] || "" : "";
      lockState.hidden = !lockState.textContent;
      lockBox.classList.toggle("is-error", st.lock.status === "error");
    }
  };
  if (typeof audio.onState === "function") audio.onState(update);
  else statusEl.hidden = true;
}
