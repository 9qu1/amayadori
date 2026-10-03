// 4隅 → 4隅 の射影変換（ホモグラフィ）と CSS matrix3d
// 点はすべて [x, y]。4隅の順は 左上・右上・右下・左下。

// src の4点を dst の4点へ移す 3×3 行列（9要素、最後は1）
export function solveHomography(src, dst) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const h = solve(A, b);
  return [...h, 1];
}

// 連立方程式（ガウスの消去法・部分ピボット）
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) throw new Error("4隅が一直線に並んでいて変換が作れません");
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

// 行列で点を移す
export function applyHomography(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

const num = (v) => (Math.abs(v) < 1e-15 ? "0" : v.toFixed(12));

// 幅 w × 高さ h の要素（transform-origin: 0 0）を quad に重ねる matrix3d
export function rectToQuadMatrix3d(w, h, quad) {
  const H = solveHomography([[0, 0], [w, 0], [w, h], [0, h]], quad);
  const [a, b, c, d, e, f, g, k] = H;
  // CSS は列ごとに並べる
  return `matrix3d(${[a, d, 0, g, b, e, 0, k, 0, 0, 1, 0, c, f, 0, 1].map(num).join(",")})`;
}

// 4辺をそれぞれ外へ px だけ広げた quad（縁の灰色がのぞかないように）
export function expandQuad(quad, px) {
  if (!px) return quad.map((p) => [...p]);
  const n = quad.length;
  // 各辺をずらした直線（点と向き）
  const lines = [];
  for (let i = 0; i < n; i++) {
    const [x0, y0] = quad[i];
    const [x1, y1] = quad[(i + 1) % n];
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    // 時計回り（y は下向き）なので外向きの法線は (dy, -dx)
    const nx = dy / len, ny = -dx / len;
    lines.push({ x: x0 + nx * px, y: y0 + ny * px, dx, dy });
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const L1 = lines[(i - 1 + n) % n];
    const L2 = lines[i];
    const det = L1.dx * L2.dy - L1.dy * L2.dx;
    if (Math.abs(det) < 1e-9) { out.push([L2.x, L2.y]); continue; }
    const t = ((L2.x - L1.x) * L2.dy - (L2.y - L1.y) * L2.dx) / det;
    out.push([L1.x + L1.dx * t, L1.y + L1.dy * t]);
  }
  return out;
}

// quad の縦横比のめやす（上下の辺の平均 ÷ 左右の辺の平均）
export function quadAspect(quad) {
  const d = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const w = (d(quad[0], quad[1]) + d(quad[3], quad[2])) / 2;
  const h = (d(quad[0], quad[3]) + d(quad[1], quad[2])) / 2;
  return w / h;
}
