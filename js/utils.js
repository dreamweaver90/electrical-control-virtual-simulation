/**
 * 虚拟接线仿真系统 — 工具函数
 */
export const DIR = {
  up: { angle: -90 }, down: { angle: 90 }, left: { angle: 180 }, right: { angle: 0 },
};

export function degToRad(d) { return d * Math.PI / 180; }

/** 点到线段最短距离（导线 hit-test） */
export function pointToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/**
 * 折线拐点圆角化（手动敷设导线）：把每个中间拐点替换成一段与相邻两边相切的圆弧，
 * 返回**加密折线**点列（首末点 = 原首末点；拐点本身不再出现在结果里 → 画布上不显示尖角/点标记）。
 *
 * 几何：拐点 P 处两条边的单位向量 a（指向来点）/ b（指向去点），夹角 θ = ∠APB；
 *   切点距拐点 t = r / tan(θ/2)，按相邻段长收敛到 ≤ 半段长（短段不会出现过切/自交）；
 *   实际半径 r' = t·tan(θ/2)（被段长缩短时同步缩小，圆心沿角平分线 √(t²+r'²) 处，
 *   由 Rt△P-A-C 在 A 点直角保证圆弧与两边相切）。
 * θ 接近 π（直行）或接近 0（折返）时不圆角，原样保留拐点。
 *
 * @param {Array<{x:number,y:number}>} pts 折线点列（面板逻辑坐标）
 * @param {number} [radius] 目标圆角半径（px，缺省 18）
 * @returns {Array<{x:number,y:number}>} 圆角化后的折线点列
 */
export function roundCorners(pts, radius) {
  const src = Array.isArray(pts) ? pts : [];
  const r0 = (radius === undefined || radius === null) ? 18 : Number(radius);
  if (src.length < 3 || !(r0 > 0)) return src.map(p => ({ x: p.x, y: p.y }));

  const out = [{ x: src[0].x, y: src[0].y }];
  for (let i = 1; i < src.length - 1; i++) {
    const p0 = src[i - 1], p1 = src[i], p2 = src[i + 1];
    let ax = p0.x - p1.x, ay = p0.y - p1.y;
    let bx = p2.x - p1.x, by = p2.y - p1.y;
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la < 1e-6 || lb < 1e-6) { out.push({ x: p1.x, y: p1.y }); continue; }
    ax /= la; ay /= la; bx /= lb; by /= lb;
    const ang = Math.acos(Math.max(-1, Math.min(1, ax * bx + ay * by)));   // π = 直行 / π/2 = 直角 / 0 = 折返
    if (ang > Math.PI - 1e-3 || ang < 2e-2) { out.push({ x: p1.x, y: p1.y }); continue; }

    const tanHalf = Math.tan(ang / 2);
    const t = Math.min(r0 / tanHalf, la / 2, lb / 2);   // 切点距拐点距离（按段长收敛）
    if (t < 0.5) { out.push({ x: p1.x, y: p1.y }); continue; }
    const r = t * tanHalf;
    const A = { x: p1.x + ax * t, y: p1.y + ay * t };   // 入边切点
    const B = { x: p1.x + bx * t, y: p1.y + by * t };   // 出边切点

    let mx = ax + bx, my = ay + by;                     // 角平分线方向（指向圆心）
    const lm = Math.hypot(mx, my);
    if (lm < 1e-9) { out.push(A, B); continue; }        // 数值退化：两切点直连
    const dc = Math.sqrt(t * t + r * r);
    const cx = p1.x + mx / lm * dc, cy = p1.y + my / lm * dc;

    const a0 = Math.atan2(A.y - cy, A.x - cx);
    const a1 = Math.atan2(B.y - cy, B.x - cx);
    let da = a1 - a0;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    const steps = Math.max(2, Math.ceil(Math.abs(da) / (Math.PI / 24)));   // 每 7.5° 取一点
    out.push(A);
    for (let k = 1; k < steps; k++) {
      const a = a0 + da * k / steps;
      out.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
    }
    out.push(B);
  }
  out.push({ x: src[src.length - 1].x, y: src[src.length - 1].y });
  return out;
}

/** 字符串→[0,1)浮点数（稳定随机偏移）。
 *  FNV-1a 哈希：短字符串也充分扩散（Java 风格 h<<5-h 对短串不溢出 → 值偏 0，分布集中） */
export function hashToNum(s) {
  let h = 2166136261;                       // FNV offset basis
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);             // FNV prime（32 位溢出）
  }
  return ((h >>> 0) % 2147483647) / 2147483647;
}

/** #rrggbb → "rgba(r,g,b,a)" 字符串（主题配置注入 CSS 变量用）；非法输入返回 null */
export function hexToRgba(hex, alpha) {
  if (typeof hex !== 'string') return null;
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 'rgba(' + r + ',' + g + ',' + b + ',' + (alpha !== undefined ? alpha : 1) + ')';
}
