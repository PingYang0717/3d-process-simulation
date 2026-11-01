// plan v15 B3：deltaOf 的 BFS 種子只取邊界格、scratch 重用——結果（add／remove 的集合、順序、方向碼）和舊寫法逐格相同。
import { describe, expect, it } from 'vitest';
import { deltaOf, deltaOfRef } from './raster';

/** 可重現的亂數（mulberry32）。 */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 一張 W×H 的圖：幾個隨機矩形的聯集（結構），可能挖洞、撒雜訊。 */
function blob(r: () => number, W: number, H: number, opts: { holes: boolean; noise: number }) {
  const m = new Uint8Array(W * H);
  const rects = 1 + Math.floor(r() * 3);
  for (let k = 0; k < rects; k++) {
    const u0 = Math.floor(r() * (W - 2));
    const v0 = Math.floor(r() * (H - 2));
    const u1 = Math.min(W - 1, u0 + 1 + Math.floor(r() * (W / 2)));
    const v1 = Math.min(H - 1, v0 + 1 + Math.floor(r() * (H / 2)));
    for (let v = v0; v <= v1; v++) for (let u = u0; u <= u1; u++) m[v * W + u] = 1;
  }
  if (opts.holes)
    for (let k = 0; k < 2; k++) {
      const u0 = Math.floor(r() * W);
      const v0 = Math.floor(r() * H);
      const w = Math.floor(r() * 4);
      const h = Math.floor(r() * 4);
      for (let v = v0; v < Math.min(H, v0 + h); v++) for (let u = u0; u < Math.min(W, u0 + w); u++) m[v * W + u] = 0;
    }
  for (let i = 0; i < W * H; i++) if (r() < opts.noise) m[i] ^= 1;
  return m;
}

describe('deltaOf 邊界種子 vs 舊種子（plan v15 B3）', () => {
  it('隨機 200 組 before／after（含洞、雜訊、被包住的格子）：add／remove 順序與方向完全相同', () => {
    const r = rng(20261101);
    let nonEmpty = 0;
    let enclosed = 0;
    for (let k = 0; k < 200; k++) {
      const W = 4 + Math.floor(r() * 20);
      const H = 4 + Math.floor(r() * 20);
      const before = blob(r, W, H, { holes: k % 2 === 0, noise: k % 5 === 0 ? 0.05 : 0 });
      // after：從 before 出發再亂改（同一塊附近），也混幾組完全獨立的
      const after = k % 7 === 0 ? blob(r, W, H, { holes: true, noise: 0.1 }) : before.slice();
      if (k % 7 !== 0) {
        const n = 1 + Math.floor(r() * 4);
        for (let j = 0; j < n; j++) {
          const u0 = Math.floor(r() * W);
          const v0 = Math.floor(r() * H);
          const w = 1 + Math.floor(r() * 5);
          const h = 1 + Math.floor(r() * 5);
          const val = r() < 0.5 ? 1 : 0;
          for (let v = v0; v < Math.min(H, v0 + h); v++) for (let u = u0; u < Math.min(W, u0 + w); u++) after[v * W + u] = val;
        }
        // 被包住的格子：結構正中間挖一格（和外面不相連的 remove）、外面孤立加一格（和結構不相連的 add）
        if (k % 3 === 0) {
          const c = Math.floor(H / 2) * W + Math.floor(W / 2);
          if (before[c]) {
            after[c] = 0;
            enclosed++;
          }
          if (!before[0]) after[0] = 1;
        }
      }
      const u0 = Math.floor(r() * 50) - 25;
      const v0 = Math.floor(r() * 50) - 25;
      const a = deltaOf(before, after, u0, v0, W, H);
      const b = deltaOfRef(before, after, u0, v0, W, H);
      expect(a.add).toEqual(b.add);
      expect(a.remove).toEqual(b.remove);
      if (a.add.length || a.remove.length) nonEmpty++;
    }
    expect(nonEmpty).toBeGreaterThan(150);
    expect(enclosed).toBeGreaterThan(10);
  });

  it('連續呼叫（scratch 重用）：第二次結果不受第一次殘留影響；大小變大時 scratch 放大', () => {
    const W = 6;
    const H = 5;
    const a = new Uint8Array(W * H);
    const b = new Uint8Array(W * H);
    for (let v = 1; v < 4; v++) for (let u = 1; u < 4; u++) a[v * W + u] = 1;
    for (let v = 1; v < 4; v++) for (let u = 2; u < 5; u++) b[v * W + u] = 1;
    const first = deltaOf(a, b, 0, 0, W, H);
    // 更大的一張（放大 scratch），再回來小的一張
    const big = new Uint8Array(40 * 40).fill(1);
    deltaOf(new Uint8Array(40 * 40), big, 0, 0, 40, 40);
    const again = deltaOf(a, b, 0, 0, W, H);
    expect(again).toEqual(first);
    expect(again).toEqual(deltaOfRef(a, b, 0, 0, W, H));
    expect(first.add.length).toBe(3);
    expect(first.remove.length).toBe(3);
  });
});
