// 絵の重ねもの: 窓の雨・湯気・火・灯り・テレビ・ポスター・休憩の気分
import { bus } from "./bus.js";
import { createStage } from "./stage.js";
import { rectToQuadMatrix3d, expandQuad, quadAspect } from "./homography.js";

const CONFIG_URL = new URL("../scene-config.json", import.meta.url);
const promoUrl = (name) => new URL(`../promo/${name}`, import.meta.url).href;

// テレビのチャンネル（自作サイトの紹介）
const CHANNELS = [
  { name: "リカイド", desc: "友達の理解度チェック", url: "https://rikaido.me/", img: "tv-rikaido.jpg", dim: 0.86, glow: [255, 176, 196], c1: "#ffe7ec", c2: "#c98a9b" },
  { name: "トクマス", desc: "毎日3問のパズル", url: "https://tokumasu.net/", img: "tv-tokumasu.jpg", glow: [255, 228, 186], c1: "#f6efe2", c2: "#b9a27e" },
  { name: "ナカミド", desc: "診断ポータル", url: "https://nakamido.com/", img: "tv-nakamido.jpg", glow: [150, 140, 255], c1: "#6c5cff", c2: "#1d1a3a" },
];
// 集中の邪魔にならないよう、ゆっくり・静かに替える（砂嵐や光はなし）
const CHANNEL_SEC = 90;
const HOLD_SEC = 10; // マウスやフォーカスが離れてから、次に替わるまでの最短

// 窓の外の街の灯り（room.png から探した位置と半径。絵の座標）
const TOWN_LIGHTS = [
  [594.2, 446.8, 6.2], [780.7, 349.7, 6.0], [814.2, 348.8, 5.7], [814.5, 329.3, 5.1], [780.9, 333.1, 4.8],
  [620.2, 470.9, 5.0], [698.6, 347.6, 5.1], [780.6, 298.7, 4.7], [699.1, 315.9, 4.4], [488.9, 270.1, 4.3],
  [685.1, 437.1, 4.2], [705.9, 314.9, 4.3], [895.4, 326.8, 4.2], [698.1, 334.1, 4.2], [831.6, 329.8, 4.1],
  [639.1, 295.1, 4.2], [885.9, 302.4, 4.1], [831.6, 347.3, 4.3], [341.8, 395.5, 4.0], [243.5, 327.6, 3.9],
  [594.2, 471.2, 4.1], [743.3, 435.4, 3.8], [147.9, 465.6, 3.9], [681.3, 302.6, 3.8],
];

const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const rand = (a, b) => a + Math.random() * (b - a);
const smooth = (x) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };

// なめらかなノイズ（-1〜1くらい）
function makeNoise(seed) {
  const N = 512;
  const v = new Float32Array(N);
  let s = (seed >>> 0) || 1;
  for (let i = 0; i < N; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; v[i] = (s / 4294967296) * 2 - 1; }
  const n1 = (t) => {
    const i = Math.floor(t);
    const f = t - i;
    const u = f * f * (3 - 2 * f);
    const a = v[i & (N - 1)];
    const b = v[(i + 1) & (N - 1)];
    return a + (b - a) * u;
  };
  return (t) => n1(t) * 0.57 + n1(t * 2.13 + 31.7) * 0.29 + n1(t * 4.71 + 77.3) * 0.14;
}

function inPoly(poly, x, y) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

function div(cls, box) {
  const el = document.createElement("div");
  el.className = cls;
  if (box) place(el, box);
  return el;
}
function place(el, [x0, y0, x1, y1]) {
  el.style.left = `${x0}px`;
  el.style.top = `${y0}px`;
  el.style.width = `${x1 - x0}px`;
  el.style.height = `${y1 - y0}px`;
}

// 絵の座標で描ける canvas（実解像度は 絵の倍率 × 画素密度）
function makeLayer(cls, box) {
  const canvas = document.createElement("canvas");
  canvas.className = cls;
  canvas.setAttribute("aria-hidden", "true");
  place(canvas, box);
  const ctx = canvas.getContext("2d");
  const [x0, y0, x1, y1] = box;
  const w = x1 - x0;
  const h = y1 - y0;
  const layer = {
    canvas, ctx, box, w, h, k: 1,
    resize(k) {
      const cw = Math.max(1, Math.round(w * k));
      const ch = Math.max(1, Math.round(h * k));
      if (canvas.width !== cw) canvas.width = cw;
      if (canvas.height !== ch) canvas.height = ch;
      layer.k = k;
      layer.reset();
    },
    // 絵の座標そのままで描けるように
    reset() {
      const kx = canvas.width / w;
      const ky = canvas.height / h;
      ctx.setTransform(kx, 0, 0, ky, -x0 * kx, -y0 * ky);
    },
    clear() {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
    },
  };
  return layer;
}

function sprite(size, paint) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  paint(c.getContext("2d"), size);
  return c;
}
function softDot(rgb, inner = 0) {
  return sprite(64, (g, S) => {
    const r = S / 2;
    const gr = g.createRadialGradient(r, r, r * inner, r, r, r);
    gr.addColorStop(0, `rgba(${rgb},1)`);
    gr.addColorStop(0.45, `rgba(${rgb},0.42)`);
    gr.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = gr;
    g.fillRect(0, 0, S, S);
  });
}

// ---------------------------------------------------------------- 窓の雨
function createRain(stageEl, cfg, maskUrl, roomImg) {
  const win = cfg.window;
  const box = win.bbox;
  const [bx0, by0, bx1, by1] = box;
  const panes = win.panes || [];
  const layer = makeLayer("fx-rain", box);
  // 窓ガラスの所だけに切り抜く
  const m = `url("${maskUrl}")`;
  const clipToGlass = (el) => {
    const cs = el.style;
    cs.webkitMaskImage = m; cs.maskImage = m;
    cs.webkitMaskSize = cs.maskSize = `${cfg.image.w}px ${cfg.image.h}px`;
    cs.webkitMaskPosition = cs.maskPosition = `${-bx0}px ${-by0}px`;
    cs.webkitMaskRepeat = cs.maskRepeat = "no-repeat";
  };
  clipToGlass(layer.canvas);
  // 絵にもともと描かれた雨の筋（止まって見える）を消したガラスの下絵を、部屋の絵のすぐ上に敷く
  if (win.plate && roomImg) {
    const plate = new Image();
    plate.className = "window-plate";
    plate.alt = "";
    plate.decoding = "async";
    plate.draggable = false;
    place(plate, box);
    clipToGlass(plate);
    plate.addEventListener("load", () => plate.classList.add("is-ready"));
    plate.addEventListener("error", () => plate.remove());
    plate.src = new URL(win.plate, CONFIG_URL).href;
    roomImg.after(plate);
  }
  stageEl.appendChild(layer.canvas);

  const ctx = layer.ctx;
  const SLANT = 0.09; // 横に流れる割合（少し斜め）
  // 絵の筋は下絵で消したので、重ねる筋は少しはっきりめに
  const LAYERS = [
    { w: 0.55, a: 0.11, v: [520, 640], len: [9, 16], share: 0.5 },
    { w: 0.8, a: 0.15, v: [720, 880], len: [15, 26], share: 0.32 },
    { w: 1.15, a: 0.2, v: [980, 1250], len: [26, 42], share: 0.18 },
  ];
  const nz = makeNoise(7);
  const dropSprite = sprite(64, (g, S) => {
    const c = S / 2;
    const R = S / 2 - 3;
    // 影（光と反対の右下）
    g.fillStyle = "rgba(3, 10, 18, 0.55)";
    g.beginPath(); g.arc(c + 1.6, c + 2.4, R - 1, 0, TAU); g.fill();
    // 本体（向こうの景色が屈折して少し明るい）
    const body = g.createRadialGradient(c - R * 0.25, c - R * 0.3, R * 0.1, c, c, R);
    body.addColorStop(0, "rgba(220, 236, 244, 0.34)");
    body.addColorStop(0.7, "rgba(150, 182, 200, 0.2)");
    body.addColorStop(1, "rgba(110, 140, 160, 0.34)");
    g.fillStyle = body;
    g.beginPath(); g.arc(c - 0.8, c - 0.8, R - 2.5, 0, TAU); g.fill();
    // 下の縁の照り返し
    g.strokeStyle = "rgba(255, 228, 190, 0.32)";
    g.lineWidth = 2.2;
    g.beginPath(); g.arc(c - 0.8, c - 0.8, R - 5, Math.PI * 0.2, Math.PI * 0.8); g.stroke();
    // ハイライト（左上。部屋の灯りが映る）
    const hx = c - R * 0.36;
    const hy = c - R * 0.4;
    const hl = g.createRadialGradient(hx, hy, 0, hx, hy, R * 0.34);
    hl.addColorStop(0, "rgba(255, 246, 228, 1)");
    hl.addColorStop(0.5, "rgba(255, 240, 215, 0.55)");
    hl.addColorStop(1, "rgba(255, 240, 215, 0)");
    g.fillStyle = hl;
    g.beginPath(); g.arc(hx, hy, R * 0.34, 0, TAU); g.fill();
  });
  const bokehSprite = softDot("255, 186, 112", 0.05);

  let streaks = [];
  let drops = [];
  let runners = [];
  let trails = [];
  let maxDrops = 120;
  let sizeMul = 1;
  let minLine = 0.5;
  let nextRunner = rand(2, 5);
  let spawnAcc = 0;

  const inGlass = (x, y) => panes.length === 0 || panes.some((p) => inPoly(p, x, y));
  function randomGlassPoint(tries = 12) {
    for (let i = 0; i < tries; i++) {
      const x = rand(bx0, bx1);
      const y = rand(by0, by1);
      if (inGlass(x, y)) return [x, y];
    }
    return null;
  }
  function paneBottom(x) {
    // その x でのガラスの下の縁（だいたい）
    for (const p of panes) {
      let minX = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [px, py] of p) { minX = Math.min(minX, px); maxX = Math.max(maxX, px); maxY = Math.max(maxY, py); }
      if (x >= minX && x <= maxX) return maxY - 4;
    }
    return by1 - 6;
  }

  function newStreak(L, anywhere) {
    const len = rand(L.len[0], L.len[1]);
    return {
      L,
      x: rand(bx0 - SLANT * (by1 - by0), bx1),
      y: anywhere ? rand(by0 - len, by1) : by0 - rand(0, 80),
      v: rand(L.v[0], L.v[1]),
      len,
    };
  }
  function newDrop(x, y, r, t) {
    return { x, y, r, born: t, die: 0 };
  }
  function seedDrops(n, t) {
    for (let i = 0; i < n; i++) {
      const p = randomGlassPoint();
      if (p) drops.push(newDrop(p[0], p[1], dropSize(), t - 10));
    }
  }
  const dropSize = () => 0.85 + Math.pow(Math.random(), 1.9) * 2.5;

  function configure(s, reduced) {
    const area = (bx1 - bx0) * (by1 - by0) * s * s; // 画面での面積（CSS px²）
    const nStreak = reduced ? 0 : Math.round(clamp(area / 1500, 40, 360));
    maxDrops = Math.round(clamp(area / 1400, 60, 320));
    sizeMul = clamp(0.85 / s, 1, 2.4);
    minLine = 0.5 / s;
    // 筋の数を合わせる
    const want = [];
    for (const L of LAYERS) want.push(Math.round(nStreak * L.share));
    const next = [];
    LAYERS.forEach((L, i) => {
      const have = streaks.filter((st) => st.L === L);
      for (let j = 0; j < want[i]; j++) next.push(have[j] || newStreak(L, true));
    });
    streaks = next;
    if (drops.length > maxDrops) drops.length = maxDrops;
  }

  function startRunner(t, from) {
    let d = from;
    if (!d) {
      // 大きめの粒をひとつ選ぶ
      let best = null;
      for (let i = 0; i < 24 && drops.length; i++) {
        const c = drops[(Math.random() * drops.length) | 0];
        if (!c.die && c.y < by1 - 60 && (!best || c.r > best.r)) best = c;
      }
      d = best;
      if (!d || d.r < 1.8) {
        const p = randomGlassPoint();
        if (!p) return;
        d = newDrop(p[0], Math.min(p[1], by0 + (by1 - by0) * 0.6), rand(2.8, 3.5), t);
      } else {
        drops.splice(drops.indexOf(d), 1);
      }
    } else {
      const i = drops.indexOf(d);
      if (i >= 0) drops.splice(i, 1);
    }
    const trail = { pts: [[d.x, d.y]], end: 0, w: 0 };
    trails.push(trail);
    runners.push({ x: d.x, y: d.y, r: Math.max(d.r, 2.7), seed: rand(0, 100), moved: 0, gap: rand(5, 12), trail, lastPt: d.y, bottom: paneBottom(d.x) });
  }

  function update(dt, t, env) {
    // 筋
    for (const st of streaks) {
      st.y += st.v * dt;
      st.x += st.v * SLANT * dt;
      if (st.y - st.len > by1) Object.assign(st, newStreak(st.L, false));
    }
    // 粒がゆっくり増える
    const rate = maxDrops / (env.reduced ? 60 : 32);
    spawnAcc += rate * dt;
    while (spawnAcc >= 1) {
      spawnAcc -= 1;
      const p = randomGlassPoint();
      if (!p) continue;
      const r = dropSize();
      // 近くの粒とくっつく
      const hit = drops.find((d) => !d.die && Math.hypot(d.x - p[0], d.y - p[1]) < (d.r + r) * 0.9);
      if (hit) {
        hit.r = Math.min(4, Math.sqrt(hit.r * hit.r + r * r));
        if (!env.reduced && hit.r > 3.5 && runners.length < 3) startRunner(t, hit);
      } else {
        drops.push(newDrop(p[0], p[1], r, t));
        if (drops.filter((d) => !d.die).length > maxDrops) {
          // いちばん古い粒から蒸発させる
          const old = drops.find((d) => !d.die);
          if (old) old.die = t;
        }
      }
    }
    drops = drops.filter((d) => !d.die || t - d.die < 1.6);

    // ときどき流れ落ちる
    if (!env.reduced) {
      if (t >= nextRunner) {
        if (runners.length < 3) startRunner(t);
        nextRunner = t + rand(3.5, 9);
      }
      for (const rn of runners) {
        const gate = nz(t * 0.9 + rn.seed);
        const base = 24 + 48 * clamp((rn.r - 2) / 2, 0, 1);
        const speed = base * smooth((gate + 0.25) / 0.55); // 止まったり進んだり
        const dy = speed * dt;
        rn.y += dy;
        rn.x += nz(t * 0.7 + rn.seed * 3) * 5 * dt;
        rn.moved += dy;
        // 通り道の粒を吸い込む
        for (let i = drops.length - 1; i >= 0; i--) {
          const d = drops[i];
          if (d.die) continue;
          if (Math.abs(d.x - rn.x) < rn.r + d.r && d.y > rn.y - rn.r * 2 && d.y < rn.y + rn.r + d.r) {
            rn.r = Math.min(4.4, Math.sqrt(rn.r * rn.r + d.r * d.r * 0.8));
            drops.splice(i, 1);
          }
        }
        // 跡に小さな粒を残す
        if (rn.moved > rn.gap) {
          rn.moved = 0;
          rn.gap = rand(5, 14);
          if (Math.random() < 0.65) {
            const tr = rand(0.6, 1.1);
            drops.push(newDrop(rn.x + rand(-0.5, 0.5), rn.y - rn.r * 1.1, tr, t));
            rn.r = Math.sqrt(Math.max(0.5, rn.r * rn.r - tr * tr * 0.55));
          }
        }
        if (rn.y - rn.lastPt > 2.5) {
          rn.trail.pts.push([rn.x, rn.y]);
          rn.lastPt = rn.y;
        }
        rn.trail.w = Math.max(rn.trail.w, rn.r * 0.55);
        if (rn.y > rn.bottom) { rn.done = true; rn.trail.end = t; }
        else if (rn.r < 1.5) { rn.done = true; rn.trail.end = t; drops.push(newDrop(rn.x, rn.y, rn.r, t)); }
      }
      runners = runners.filter((rn) => !rn.done);
    }
    trails = trails.filter((tr) => !tr.end || t - tr.end < 7);
  }

  function draw(t, env) {
    layer.clear();
    // 街の灯りのにじみ（ガラスの向こう）
    for (let i = 0; i < TOWN_LIGHTS.length; i++) {
      const [x, y, r] = TOWN_LIGHTS[i];
      const n = nz(t * 0.33 + i * 7.13);
      const a = 0.13 + 0.09 * n;
      const rr = r * (1.7 + 0.25 * nz(t * 0.5 + i * 3.1)) * Math.max(1, sizeMul * 0.7);
      ctx.globalAlpha = clamp(a, 0, 1);
      ctx.drawImage(bokehSprite, x - rr + nz(t * 0.8 + i) * 0.35, y - rr, rr * 2, rr * 2);
    }
    ctx.globalAlpha = 1;
    // 雨の筋（奥・中・手前）
    ctx.lineCap = "round";
    for (const L of LAYERS) {
      const lw = Math.max(L.w, minLine);
      // 全体はうすく、下半分を少し濃く（しずくの頭）
      for (let pass = 0; pass < 2; pass++) {
        ctx.beginPath();
        let any = false;
        for (const st of streaks) {
          if (st.L !== L) continue;
          const len = pass === 0 ? st.len : st.len * 0.45;
          ctx.moveTo(st.x, st.y);
          ctx.lineTo(st.x - SLANT * len, st.y - len);
          any = true;
        }
        if (!any) continue;
        ctx.lineWidth = lw;
        ctx.strokeStyle = `rgba(206, 226, 240, ${pass === 0 ? L.a * 0.6 : L.a})`;
        ctx.stroke();
      }
    }
    // 流れた跡
    for (const tr of trails) {
      if (tr.pts.length < 2) continue;
      const fade = tr.end ? 1 - (t - tr.end) / 7 : 1;
      if (fade <= 0) continue;
      ctx.beginPath();
      ctx.moveTo(tr.pts[0][0], tr.pts[0][1]);
      for (let i = 1; i < tr.pts.length; i++) ctx.lineTo(tr.pts[i][0], tr.pts[i][1]);
      ctx.lineWidth = Math.max(tr.w * sizeMul, minLine);
      ctx.strokeStyle = `rgba(196, 220, 236, ${0.1 * fade})`;
      ctx.stroke();
    }
    // 水滴
    for (const d of drops) {
      let k = smooth((t - d.born) / 0.35);
      if (d.die) k *= 1 - smooth((t - d.die) / 1.5);
      const r = d.r * sizeMul * (0.6 + 0.4 * k);
      if (r <= 0.05) continue;
      ctx.globalAlpha = k;
      ctx.drawImage(dropSprite, d.x - r, d.y - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1;
    for (const rn of runners) {
      const r = rn.r * sizeMul;
      ctx.drawImage(dropSprite, rn.x - r, rn.y - r * 1.25, r * 2, r * 2.5);
    }
  }

  return {
    layer,
    configure,
    update,
    draw,
    seed(t) { seedDrops(Math.round(maxDrops * 0.55), t); },
    get counts() { return { streaks: streaks.length, drops: drops.length, runners: runners.length, maxDrops }; },
    get runnerPos() { return runners.map((r) => [+r.x.toFixed(1), +r.y.toFixed(1), +r.r.toFixed(2)]); },
  };
}

// ---------------------------------------------------------------- 湯気
function createSteam(stageEl, cfg) {
  const m = cfg.mug;
  const avoid = cfg.steamAvoid || [];
  const box = [Math.round(m.x - 130), Math.round(m.y - 240), Math.round(m.x + 130), Math.round(m.y + 10)];
  const layer = makeLayer("fx-steam", box);
  stageEl.appendChild(layer.canvas);
  const ctx = layer.ctx;
  const puff = softDot("255, 250, 244", 0);
  const breeze = makeNoise(21);
  const curl = makeNoise(33);
  let parts = [];
  let acc = 0;
  let alphaMul = 1;

  function configure(s) {
    alphaMul = s < 0.5 ? 1.55 : s < 0.8 ? 1.25 : 1;
  }
  function spawn() {
    parts.push({
      x: m.x + rand(-1, 1) * m.w * 0.24,
      y: m.y - 1 + rand(-2, 1.5),
      vx: rand(-2, 2),
      vy: -rand(15, 24),
      r0: rand(3, 5),
      grow: rand(4.5, 8),
      life: rand(4, 6.4),
      a0: rand(0.14, 0.23),
      seed: rand(0, 100),
      age: 0,
      gone: 0,
    });
  }
  function update(dt, t, env) {
    const rate = env.reduced ? 4 : 9;
    const amp = env.reduced ? 0.4 : 1;
    acc += rate * dt;
    while (acc >= 1) { acc -= 1; spawn(); }
    const b = breeze(t * 0.12) * 11 * amp;
    for (const p of parts) {
      p.age += dt;
      const h = m.y - p.y; // マグからの高さ
      const c = curl(t * 0.55 + p.seed) * (4 + h * 0.09) * amp;
      p.x += (b * Math.min(1, h / 70) + c + p.vx) * dt;
      p.y += p.vy * dt * (env.reduced ? 0.7 : 1);
      p.vy *= 1 - 0.06 * dt;
      // 人の頭と肩にかからないように: 入ったら右へ押して早めに消す
      if (avoid.length && (inPoly(avoid, p.x, p.y) || inPoly(avoid, p.x - p.r0 - p.age * p.grow * 0.6, p.y))) {
        p.gone = Math.min(1, p.gone + dt * 2.5);
        p.vx += 30 * dt;
      }
    }
    parts = parts.filter((p) => p.age < p.life && p.gone < 1 && p.y > box[1] + 6);
  }
  function draw() {
    layer.clear();
    for (const p of parts) {
      const f = p.age / p.life;
      const r = p.r0 + p.age * p.grow;
      const a = p.a0 * alphaMul * smooth(p.age / 0.5) * Math.pow(1 - f, 1.4) * (1 - p.gone);
      // 箱の端では消す（四角く切れないように）
      const edge = smooth((p.y - box[1]) / 40) * smooth((box[2] - p.x - r) / 30) * smooth((p.x - r - box[0]) / 30);
      const aa = a * edge;
      if (aa <= 0.002) continue;
      ctx.globalAlpha = clamp(aa, 0, 1);
      ctx.drawImage(puff, p.x - r, p.y - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1;
  }
  return { layer, configure, update, draw, get count() { return parts.length; } };
}

// ---------------------------------------------------------------- 火と灯り
function createFire(stageEl, cfg, roomImg) {
  const f = cfg.fire;
  const xs = f.quad.map((p) => p[0]);
  const ys = f.quad.map((p) => p[1]);
  const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const topR = f.topRadius || 0;

  const g = cfg.fireGlow;
  const glow = g ? div("fire-glow", [g.x - g.r, g.y - g.r, g.x + g.r, g.y + g.r]) : null;
  const light = div("fire-light", box);
  light.style.borderRadius = `${topR}px ${topR}px 4px 4px`;
  const layer = makeLayer("fx-fire", box);
  // 絵の炎そのものを揺らす層（部屋の絵のすぐ上。縁はぼかして元の絵になじませる）
  const warp = roomImg ? makeLayer("fx-flame", box) : null;
  if (warp) roomImg.after(warp.canvas);
  if (glow) stageEl.appendChild(glow);
  stageEl.appendChild(light);
  stageEl.appendChild(layer.canvas);

  const ctx = layer.ctx;
  const flameSprites = [softDot("255, 236, 170"), softDot("255, 160, 62"), softDot("214, 74, 26")];
  const sparkSprite = softDot("255, 214, 140", 0.2);
  const nFast = makeNoise(101);
  const nSlow = makeNoise(202);
  const nW1 = makeNoise(611);
  const nW2 = makeNoise(733);
  const nLift = makeNoise(877);
  let flames = [];
  let sparks = [];
  let acc = 0;
  let nextSpark = 1.5;
  const [x0, y0, x1, y1] = box;
  const cx = f.x ?? (x0 + x1) / 2;
  const baseY = Math.min(y1 - 22, (f.y ?? (y0 + y1) / 2) + 26); // 薪の上あたり

  function clipArch() {
    ctx.beginPath();
    ctx.moveTo(x0, y1);
    ctx.lineTo(x0, y0 + topR);
    ctx.arcTo(x0, y0, x0 + topR, y0, topR);
    ctx.lineTo(x1 - topR, y0);
    ctx.arcTo(x1, y0, x1, y0 + topR, topR);
    ctx.lineTo(x1, y1);
    ctx.closePath();
    ctx.clip();
  }

  // 0〜1 のゆらぎ（火の明るさ）
  let level = 0.5;
  function update(dt, t, env) {
    const amp = env.reduced ? 0.3 : 1;
    const n = nFast(t * 2.3);
    const s = nSlow(t * 0.55);
    level = 0.5 + 0.5 * clamp((n * 0.65 + s * 0.35) * 1.5, -1, 1) * amp;
    if (env.reduced) { flames.length = 0; sparks.length = 0; return; }
    acc += 30 * dt;
    while (acc >= 1) {
      acc -= 1;
      // 薪の上から、絵の炎の高さ（y550 前後）まで昇る
      flames.push({
        x: cx + 6 + (Math.random() + Math.random() - 1) * 22,
        y: baseY + rand(-4, 6),
        vx: rand(-4, 4),
        vy: -rand(48, 78) * (0.8 + level * 0.4),
        r: rand(5, 8.5),
        age: 0,
        life: rand(0.6, 1.05),
        seed: rand(0, 50),
      });
    }
    for (const p of flames) {
      p.age += dt;
      p.x += (p.vx + nFast(t * 3 + p.seed) * 14) * dt;
      p.y += p.vy * dt;
    }
    flames = flames.filter((p) => p.age < p.life);
    if (t >= nextSpark) {
      nextSpark = t + rand(0.8, 3.2);
      const k = Math.random() < 0.3 ? 2 : 1;
      for (let i = 0; i < k; i++) {
        sparks.push({ x: cx + rand(-18, 24), y: baseY - rand(0, 10), vx: rand(-8, 8), vy: -rand(40, 70), age: 0, life: rand(0.8, 1.6), seed: rand(0, 50) });
      }
    }
    for (const p of sparks) {
      p.age += dt;
      p.x += (p.vx + nFast(t * 4 + p.seed) * 22) * dt;
      p.y += p.vy * dt;
      p.vy *= 1 - 0.4 * dt;
    }
    sparks = sparks.filter((p) => p.age < p.life && p.y > y0 + 2);
  }
  // 絵の炎をゆらす: ガラスの中を1画素の横帯に分け、上ほど大きく左右にずらし、下から引き伸ばす
  const LOG_Y = 624; // 薪の上の縁（これより下は動かさない）
  function drawWarp(t, env) {
    if (!warp) return;
    const w = warp.ctx;
    warp.clear();
    const amp = env && env.reduced ? 0.25 : 1;
    const span = LOG_Y - y0;
    const lift = (3 + 4 * level) * amp; // 炎が強いほど高く伸びる
    for (let y = y0; y < LOG_Y; y++) {
      const h = (LOG_Y - y) / span; // 薪で 0・上の縁で 1
      const k = Math.pow(h, 1.15);
      const dx = (3.4 * k * (nW1(y * 0.065 + t * 3.2) * 0.8 + nW2(y * 0.17 + t * 6.5) * 0.4)) * amp;
      // 上へ流れる波で、下の画素を引き上げる（舌のように伸び縮み）
      const dy = lift * k * (0.55 + 0.45 * nLift(y * 0.04 + t * 2.4));
      const sy = Math.min(y1 - 1, y + dy);
      w.drawImage(roomImg, x0, sy, x1 - x0, 1, x0 + dx, y, x1 - x0, 1.02);
    }
  }

  function draw(t, fxIn, env) {
    // 炎の光と、床・壁の照り返し（同じゆらぎで連動）
    light.style.opacity = ((0.2 + 0.32 * level) * fxIn).toFixed(3);
    light.style.transform = `scale(${(1 + 0.03 * (level - 0.5)).toFixed(4)}, ${(1 + 0.08 * (level - 0.5)).toFixed(4)})`;
    if (glow) {
      glow.style.opacity = ((0.13 + 0.12 * level) * fxIn).toFixed(3);
      glow.style.transform = `scale(${(1 + 0.025 * (level - 0.5)).toFixed(4)})`;
    }
    drawWarp(t, env);
    layer.clear();
    if (!flames.length && !sparks.length) return;
    ctx.save();
    clipArch();
    ctx.globalCompositeOperation = "lighter";
    for (const p of flames) {
      const fr = p.age / p.life;
      const spr = flameSprites[fr < 0.3 ? 0 : fr < 0.65 ? 1 : 2];
      const r = p.r * (1 - fr * 0.55);
      ctx.globalAlpha = 0.24 * (1 - fr) * smooth(p.age / 0.08);
      ctx.drawImage(spr, p.x - r, p.y - r * 1.6, r * 2, r * 3.2);
    }
    for (const p of sparks) {
      const fr = p.age / p.life;
      const r = 1.6;
      ctx.globalAlpha = (1 - fr) * 0.9;
      ctx.drawImage(sparkSprite, p.x - r, p.y - r, r * 2, r * 2);
    }
    ctx.restore();
  }
  return { layer, warpLayer: warp, update, draw, get level() { return level; } };
}

function createLamps(stageEl, cfg) {
  const out = [];
  for (const l of cfg.lamps || []) {
    const desk = l.kind !== "candle";
    const R = l.r * (desk ? 6.5 : 7.5);
    const el = div(`lamp-glow ${desk ? "is-desk" : "is-candle"}`, [l.x - R, l.y - R, l.x + R, l.y + R]);
    stageEl.appendChild(el);
    out.push({ el, desk, n: makeNoise(desk ? 303 : 404) });
  }
  return {
    draw(t, env, mood, fxIn) {
      const amp = env.reduced ? 0.3 : 1;
      for (const L of out) {
        // ろうそくは「震え」にならないよう、ゆっくり小さく揺らす
        const v = L.desk
          ? 0.5 + 0.025 * L.n(t * 0.8) * amp + 0.14 * mood
          : 0.44 + 0.12 * L.n(t * 1.7) * amp + 0.08 * mood;
        L.el.style.opacity = (clamp(v, 0, 1) * fxIn).toFixed(3);
      }
    },
  };
}

// ---------------------------------------------------------------- テレビ
function createTV(stageEl, cfg, env) {
  const quadRaw = cfg.tv.quad;
  const quad = expandQuad(quadRaw, 0.5); // 縁の灰色がのぞかないよう 0.5px 外へ
  const W = 640;
  const H = Math.round(W / quadAspect(quadRaw));
  const unit = W / Math.hypot(quadRaw[1][0] - quadRaw[0][0], quadRaw[1][1] - quadRaw[0][1]); // 絵の1px → 要素の px

  // まわりへの照り返し（チャンネルの色）
  const cx = quadRaw.reduce((s, p) => s + p[0], 0) / 4;
  const cy = quadRaw.reduce((s, p) => s + p[1], 0) / 4;
  const gw = 430, gh = 285;
  const glows = CHANNELS.map((ch) => {
    const el = div("tv-glow", [cx - gw, cy - gh, cx + gw, cy + gh]);
    const [r, g, b] = ch.glow;
    el.style.background = `radial-gradient(closest-side, rgba(${r},${g},${b},0.62) 0%, rgba(${r},${g},${b},0.3) 40%, rgba(${r},${g},${b},0.09) 72%, rgba(${r},${g},${b},0) 100%)`;
    stageEl.appendChild(el);
    return el;
  });

  const a = document.createElement("a");
  a.className = "tv-screen";
  a.target = "_blank";
  a.rel = "noopener";
  a.style.width = `${W}px`;
  a.style.height = `${H}px`;
  a.style.transform = rectToQuadMatrix3d(W, H, quad);
  a.style.borderRadius = `${((cfg.tv.radius || 0) * unit).toFixed(1)}px`;
  const pic = document.createElement("div");
  pic.className = "tv-pic";
  const chEls = CHANNELS.map((ch) => {
    const el = div("tv-ch");
    if (ch.dim) el.style.filter = `brightness(${ch.dim})`; // 白い画面はさらに少し暗く（チャンネルで明るさをそろえる）
    const card = div("tv-card");
    card.style.setProperty("--tv-c1", ch.c1);
    card.style.setProperty("--tv-c2", ch.c2);
    card.innerHTML = `<b></b><span></span>`;
    card.querySelector("b").textContent = ch.name;
    card.querySelector("span").textContent = ch.desc;
    const img = new Image();
    img.alt = "";
    img.decoding = "async";
    img.draggable = false;
    img.addEventListener("error", () => img.classList.add("is-broken"));
    img.src = promoUrl(ch.img);
    el.append(card, img);
    pic.appendChild(el);
    return el;
  });
  // 薄型テレビなので走査線や砂嵐はなし。うっすらした映り込みと「おしらせ」だけ
  a.innerHTML = `
    <div class="tv-vignette"></div>
    <div class="tv-glare"></div>
    <span class="tv-badge" aria-hidden="true">おしらせ</span>
    <span class="tv-open" aria-hidden="true">サイトをひらく</span>
    <i class="q-corner" data-c="0" style="left:0;top:0"></i>
    <i class="q-corner" data-c="1" style="left:100%;top:0"></i>
    <i class="q-corner" data-c="2" style="left:100%;top:100%"></i>
    <i class="q-corner" data-c="3" style="left:0;top:100%"></i>`;
  a.prepend(pic);
  stageEl.appendChild(a);

  const nz = makeNoise(505);

  let idx = -1;
  let nextAt = 0.4; // 最初は少し待ってから電源が入る
  // マウスが乗っている・フォーカスがある間は替えない（読んだものと開くものが食い違わないように）
  let hover = false;
  a.addEventListener("pointerenter", () => { hover = true; });
  a.addEventListener("pointerleave", () => { hover = false; });

  function setChannel(i) {
    idx = i;
    const ch = CHANNELS[i];
    chEls.forEach((el, j) => el.classList.toggle("is-on", j === i));
    glows.forEach((el, j) => { el.dataset.on = j === i ? "1" : ""; });
    a.href = ch.url;
    a.setAttribute("aria-label", `おしらせ：${ch.name}（${ch.desc}）を新しいタブで開く`);
    a.title = `${ch.name}（${ch.desc}）— 新しいタブで開きます`;
    a.dataset.channel = String(i + 1);
  }

  const glowVals = glows.map(() => 0);
  function update(dt, t, env2, fxIn) {
    if (hover || document.activeElement === a) nextAt = Math.max(nextAt, t + HOLD_SEC);
    if (t >= nextAt) {
      // 動きを減らす設定では、最初のチャンネルのまま替えない
      if (idx < 0 || !env2.reduced) setChannel((idx + 1) % CHANNELS.length);
      nextAt = t + CHANNEL_SEC;
    }
    // 照り返し: チャンネルの色で、ほんの少し明滅（画面を暗くしたぶん控えめに）
    const on = idx >= 0 ? 1 : 0;
    const glowLevel = (0.15 + 0.01 * nz(t * 1.6)) * on;
    // 色の入れ替えはなめらかに（JS でゆっくり寄せる）
    const ease = 1 - Math.exp(-dt / 0.6);
    glows.forEach((el, j) => {
      const target = el.dataset.on ? glowLevel * fxIn : 0;
      glowVals[j] += (target - glowVals[j]) * ease;
      el.style.opacity = glowVals[j].toFixed(3);
    });
  }
  // フォーカスの枠: 画面で約2.5画素の太さになるよう、縮む倍率から逆算する
  function configure(s) {
    a.style.setProperty("--ring-w", `${clamp((2.5 * unit) / s, 4, 40).toFixed(1)}px`);
  }
  return {
    el: a,
    configure,
    update,
    next(t) { nextAt = t; hover = false; },
    get channel() { return idx; },
    get size() { return [W, H]; },
    quad,
  };
}

// ---------------------------------------------------------------- ポスター
function createPoster(stageEl, cfg) {
  const quadRaw = cfg.poster.quad;
  const quad = expandQuad(quadRaw, 0.3);
  const W = 480;
  const H = Math.round(W / quadAspect(quadRaw));
  const a = document.createElement("a");
  a.className = "poster";
  a.href = "https://tokumasu.net/";
  a.target = "_blank";
  a.rel = "noopener";
  a.setAttribute("aria-label", "おしらせ：トクマス（毎日3問のパズル）を新しいタブで開く");
  a.title = "トクマス（毎日3問のパズル）— 新しいタブで開きます";
  a.style.width = `${W}px`;
  a.style.height = `${H}px`;
  a.style.transform = rectToQuadMatrix3d(W, H, quad);
  a.innerHTML = `
    <div class="poster-inner">
      <p class="poster-kicker">毎日3問のパズル</p>
      <img class="poster-logo" alt="トクマス" draggable="false">
      <img class="poster-icon" alt="" draggable="false">
      <p class="poster-copy">今日の3問、もう解いた？</p>
      <p class="poster-search"><i>トクマス</i> で検索</p>
    </div>
    <span class="poster-badge" aria-hidden="true">おしらせ</span>
    <i class="q-corner" data-c="0" style="left:0;top:0"></i>
    <i class="q-corner" data-c="1" style="left:100%;top:0"></i>
    <i class="q-corner" data-c="2" style="left:100%;top:100%"></i>
    <i class="q-corner" data-c="3" style="left:0;top:100%"></i>`;
  const logo = a.querySelector(".poster-logo");
  logo.src = promoUrl("poster-tokumasu-logo.png");
  logo.addEventListener("error", () => { logo.replaceWith(Object.assign(document.createElement("p"), { className: "poster-copy", textContent: "トクマス" })); });
  const icon = a.querySelector(".poster-icon");
  icon.src = promoUrl("poster-tokumasu-icon.jpg");
  icon.addEventListener("error", () => icon.remove());
  stageEl.appendChild(a);
  const unit = W / Math.hypot(quadRaw[1][0] - quadRaw[0][0], quadRaw[1][1] - quadRaw[0][1]);
  // フォーカスの枠: 画面で約2.5画素の太さに
  function configure(s) {
    a.style.setProperty("--ring-w", `${clamp((2.5 * unit) / s, 4, 40).toFixed(1)}px`);
  }
  return { el: a, quad, size: [W, H], configure };
}

// ---------------------------------------------------------------- 本体
export function initScene(rootEl) {
  if (!rootEl) return null;
  if (rootEl.__amayadoriScene) return rootEl.__amayadoriScene;

  const stage = createStage(rootEl);
  const reducedMq = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  const env = { reduced: !!reducedMq?.matches };
  let moodTarget = 0;
  let mood = 0;

  const ctl = {
    stage,
    ready: null,
    tv: null,
    poster: null,
    rain: null,
    steam: null,
    setBreak(on) { moodTarget = on ? 1 : 0; },
    nextChannel() { ctl.tv?.next(sceneT); },
    get mood() { return mood; },
    get time() { return sceneT; },
  };
  rootEl.__amayadoriScene = ctl;

  // 休憩のときは部屋をわずかに暖かく明るく
  bus.on("timer:phase", (d) => {
    const p = d?.phase;
    moodTarget = p === "short" || p === "long" ? 1 : 0;
  });

  let sceneT = 0;
  ctl.ready = boot().catch((e) => {
    console.error("[scene] 絵を用意できませんでした", e);
    rootEl.classList.add("scene-failed");
    return null;
  });

  async function boot() {
    // テレビの紹介画像は先に読み込み始める（最初のチャンネルに間に合うように）
    const promoReady = Promise.all(CHANNELS.map((ch) => {
      const im = new Image();
      im.src = promoUrl(ch.img);
      return im.decode().catch(() => {});
    }));
    const res = await fetch(CONFIG_URL, { cache: "no-cache" });
    if (!res.ok) throw new Error(`scene-config.json を読めません（${res.status}）`);
    const cfg = await res.json();
    stage.setPicture({ w: cfg.image.w, h: cfg.image.h, focus: cfg.focus, keepX: cfg.keepX, keepTop: cfg.keepTop, focusTall: cfg.focusTall });

    const img = new Image();
    img.className = "room";
    img.alt = "";
    img.decoding = "async";
    img.draggable = false;
    img.width = cfg.image.w;
    img.height = cfg.image.h;
    await new Promise((ok, ng) => {
      img.onload = ok;
      img.onerror = () => ng(new Error("部屋の絵を読み込めませんでした"));
      img.src = new URL(cfg.image.src, CONFIG_URL).href;
    });
    // 紹介画像は長くても 1.5 秒だけ待つ（来なければ文字の紹介画面のまま）
    await Promise.race([promoReady, new Promise((ok) => setTimeout(ok, 1500))]);
    const el = stage.el;
    el.appendChild(img);

    // 重ねる順（下から）
    const roomWarm = div("room-warm");
    const moodEl = div("mood");
    const moodLift = div("mood-lift");
    el.append(roomWarm, moodEl, moodLift);
    const fire = cfg.fire ? createFire(el, cfg, img) : null;
    const lamps = createLamps(el, cfg);
    const rain = cfg.window ? createRain(el, cfg, new URL(cfg.window.mask, CONFIG_URL).href, img) : null;
    const steam = cfg.mug ? createSteam(el, cfg) : null;
    const poster = cfg.poster ? createPoster(el, cfg) : null;
    const tv = cfg.tv ? createTV(el, cfg, env) : null;
    Object.assign(ctl, { tv, poster, rain, steam, fire, cfg });

    const layers = [rain?.layer, steam?.layer, fire?.layer, fire?.warpLayer].filter(Boolean);
    function onStage() {
      const k = stage.scale * stage.dpr * (ctl.debugBoost || 1); // debugBoost は確かめ用（拡大鏡で細部を見る）
      for (const L of layers) L.resize(k);
      rain?.configure(stage.scale, env.reduced);
      steam?.configure(stage.scale);
      tv?.configure(stage.scale);
      poster?.configure(stage.scale);
    }
    stage.onChange(onStage);
    ctl.refresh = onStage;
    onStage();
    rain?.seed(0);
    reducedMq?.addEventListener?.("change", () => {
      env.reduced = reducedMq.matches;
      onStage();
    });
    // 確かめ用: 動きを減らす設定をまねる
    ctl.setReducedMotion = (on) => { env.reduced = !!on; onStage(); };

    // ---------- 1本の requestAnimationFrame ----------
    const fxStart = 0;
    let raf = 0;
    let last = 0;
    let inView = true;
    const roomN = makeNoise(909);
    function frame(now) {
      raf = 0;
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
      last = now;
      stepOnce(dt);
      schedule();
    }
    // 確かめ用: 画面が隠れていても時間を進められる
    ctl.step = (sec, fps = 60) => { for (let i = 0; i < Math.round(sec * fps); i++) stepOnce(1 / fps); return sceneT; };
    function stepOnce(dt) {
      sceneT += dt;
      const t = sceneT;
      const fxIn = smooth((t - fxStart) / 1.5);
      mood += (moodTarget - mood) * (1 - Math.exp(-dt / 1.3)); // 数秒かけて
      try {
        if (rain) { rain.update(dt, t, env); rain.draw(t, env); }
        if (steam) { steam.update(dt, t, env); steam.draw(t, env); }
        if (fire) { fire.update(dt, t, env); fire.draw(t, fxIn, env); }
        lamps.draw(t, env, mood, fxIn);
        tv?.update(dt, t, env, fxIn);
        const lv = fire ? fire.level : 0.5;
        const amp = env.reduced ? 0.4 : 1;
        roomWarm.style.opacity = ((0.07 + 0.035 * (lv - 0.5) * amp + 0.01 * roomN(t * 0.4) * amp) * fxIn).toFixed(3);
        moodEl.style.opacity = (0.3 * mood).toFixed(3);
        moodLift.style.opacity = (mood * 1).toFixed(3);
      } catch (e) {
        console.error("[scene] 描画", e);
      }
    }
    function schedule() {
      if (!raf && !document.hidden && inView) raf = requestAnimationFrame(frame);
    }
    function stop() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      last = 0;
    }
    document.addEventListener("visibilitychange", () => { if (document.hidden) stop(); else schedule(); });
    if ("IntersectionObserver" in window) {
      new IntersectionObserver((entries) => {
        inView = entries.some((en) => en.isIntersecting);
        if (inView) schedule(); else stop();
      }).observe(rootEl);
    }

    el.classList.add("is-loaded");
    schedule();
    bus.emit("scene:ready");
    return ctl;
  }

  return ctl;
}
