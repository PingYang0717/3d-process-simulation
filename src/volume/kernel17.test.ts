// plan v17 §7：相鄰材質規則（kernel17）。用 prototype 的同一個 48×38×40 模型（demo17，y 上下顛倒）。
// 每一步都走三條路逐體素比對：applyOp（整個陣列）、applyOpLocal（裁切範圍，Worker 的路徑）、ref/proto17（prototype 的逐格寫法）。
import { describe, expect, it } from 'vitest';
import { type Labeled, type Vec3, type Volume, MATERIALS, initialLabeled, linerTable, maskOf } from './volume';
import { type EditState, type Op, adjacentDir, applyOp, isAdjacent, matNameOf } from './ops';
import { applyOpLocal } from './apply';
import { previewBox } from './preview';
import { fullScope } from './scope';
import { demo17Volume, D17 } from './demo17';
import { refAdjacent } from './ref/proto17';
import type { Report } from './kernel';

const vol0 = demo17Volume();
const matName = matNameOf(MATERIALS);
let keyN = 0;
const ctx = { orig: vol0, matName, newKey: () => `n${keyN++}` };
const L0 = initialLabeled(vol0, matName);
const base: EditState = { vol: vol0, L: L0 };
const liners = linerTable(vol0);
const { X, Y } = D17;

const UP: Vec3 = [0, -1, 0];
const LEFT: Vec3 = [-1, 0, 0];
const RIGHT: Vec3 = [1, 0, 0];
const AIR = 0, SI = 1, STI = 2, FIN = 3, HFO = 4, TIN = 5, POLY = 6, SIN = 7;

/** 某個材質、外框 x0 = x0（、z0 = z0）的結構 key。 */
const keyOf = (L: Labeled, mat: number, x0?: number, z0?: number) => {
  const c = L.comps.find((c) => c.mat === mat && (x0 === undefined || c.bbox.x0 === x0) && (z0 === undefined || c.bbox.z0 === z0));
  if (!c) throw new Error(`找不到結構 ${mat} ${x0} ${z0}`);
  return c.key;
};
const push = (keys: string[], dir: Vec3, n: number, follow: boolean): Op => ({ kind: 'push', keys, scope: fullScope(D17), dir, n, follow, backfill: 'outer', policy: 'adjacent', liners });
const move = (keys: string[], d: Vec3, follow: boolean): Op => ({ kind: 'translate', keys, scope: fullScope(D17), d, backfill: 'outer', follow, policy: 'adjacent', liners });

const diff = (a: Uint8Array, b: Uint8Array) => {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
};

/** 套一步：三條路逐體素相同；回傳裁切路徑的狀態與報告。 */
function run(s: EditState, op: Op): { s: EditState; r: Report } {
  const loc = applyOpLocal(s, op, ctx);
  const full = applyOp(s, op, ctx);
  expect(diff(loc.state.vol.data, full.vol.data)).toBe(0);
  if (isAdjacent(op)) {
    const { dir, n } = adjacentDir(op);
    const masks = [...new Set(op.keys)].map((k) => maskOf(s.L, new Set([k]))!);
    const ref = refAdjacent(s.vol, masks, op.kind, dir, n, op.follow, op.liners);
    expect(diff(loc.state.vol.data, ref.data)).toBe(0);
    expect(loc.report.done ?? 0).toBe(ref.done);
    // 被擋的原因：好幾排同時被擋時，兩邊掃描的順序不同，只比有沒有被擋
    expect(!!loc.report.stop).toBe(!!ref.stop);
  }
  return { s: loc.state, r: loc.report };
}

/** (x, z) 那一直排由上（y = 0）往下的材質段：[[材質, 格數], …]。 */
function stack(v: Volume, x: number, z: number): [number, number][] {
  const out: [number, number][] = [];
  for (let y = 0; y < Y; y++) {
    const m = v.data[(z * Y + y) * X + x];
    const last = out[out.length - 1];
    if (last && last[0] === m) last[1]++;
    else out.push([m, 1]);
  }
  return out;
}
/** (y, z) 那一橫排由左（x = 0）往右的材質段。 */
function rowX(v: Volume, y: number, z: number): [number, number][] {
  const out: [number, number][] = [];
  for (let x = 0; x < X; x++) {
    const m = v.data[(z * Y + y) * X + x];
    const last = out[out.length - 1];
    if (last && last[0] === m) last[1]++;
    else out.push([m, 1]);
  }
  return out;
}

const FIN1_X = 13; // fin 1 中間
const GATE_Z = 10; // 閘極 1 裡面
const fin1 = keyOf(L0, FIN, 11);
const fin2 = keyOf(L0, FIN, 31);
const poly1 = keyOf(L0, POLY, 4, 8);

describe('kernel17：相鄰材質規則（plan v17 §5.4、§7）', () => {
  it('原始模型：fin 上面依序是 HfO₂ 1 → TiN 1 → Poly 6 → SiN 3 → 空氣', () => {
    expect(stack(vol0, FIN1_X, GATE_Z)).toEqual([[AIR, 6], [SIN, 3], [POLY, 6], [TIN, 1], [HFO, 1], [FIN, 15], [SI, 6]]);
  });

  it('10. 薄層判定：HfO₂、TiN、SiN 是薄層，其餘不是', () => {
    expect(liners).toEqual([HFO, TIN, SIN]);
  });

  it('1. fin 上面跟著移動外推 2：HfO₂、TiN 各上移 2、厚度仍 1；Poly 6 → 4；SiN 不變', () => {
    const { s, r } = run(base, push([fin1], UP, 2, true));
    expect(r.done).toBe(2);
    expect(r.stop).toBeNull();
    expect(stack(s.vol, FIN1_X, GATE_Z)).toEqual([[AIR, 6], [SIN, 3], [POLY, 4], [TIN, 1], [HFO, 1], [FIN, 17], [SI, 6]]);
    // 閘極外面上方是空氣：一樣長 2
    expect(stack(s.vol, FIN1_X, 0)).toEqual([[AIR, 15], [FIN, 17], [SI, 6]]);
  });

  it('2. 連推：第 5 格後 Poly 剩 1 格、第 6 格整面擋下（閘極外也沒長）', () => {
    const { s, r } = run(base, push([fin1], UP, 8, true));
    expect(r.done).toBe(5);
    expect(r.stop).toMatchObject({ why: 'last', mat: POLY });
    expect(stack(s.vol, FIN1_X, GATE_Z)).toEqual([[AIR, 6], [SIN, 3], [POLY, 1], [TIN, 1], [HFO, 1], [FIN, 20], [SI, 6]]);
    expect(stack(s.vol, FIN1_X, 0)).toEqual([[AIR, 12], [FIN, 20], [SI, 6]]);
  });

  it('3. 被擋後先把兩根 Poly 的上面各外推 2（SiN 跟著），fin 又可以再推 2', () => {
    let s = run(base, push([fin1], UP, 5, true)).s;
    const p1 = keyOf(s.L, POLY, 4, 8);
    const p2 = keyOf(s.L, POLY, 4, 24);
    const r1 = run(s, push([p1, p2], UP, 2, true));
    expect(r1.r.done).toBe(2);
    s = r1.s;
    expect(stack(s.vol, FIN1_X, GATE_Z)).toEqual([[AIR, 4], [SIN, 3], [POLY, 3], [TIN, 1], [HFO, 1], [FIN, 20], [SI, 6]]);
    const r2 = run(s, push([keyOf(s.L, FIN, 11)], UP, 5, true));
    expect(r2.r.done).toBe(2);
    expect(r2.r.stop).toMatchObject({ why: 'last', mat: POLY });
  });

  it('4. fin 上面留在原地：一格都不做，被 HfO₂ 擋', () => {
    const { s, r } = run(base, push([fin1], UP, 3, false));
    expect(r.done).toBe(0);
    expect(r.stop).toMatchObject({ why: 'last', mat: HFO });
    expect(diff(s.vol.data, vol0.data)).toBe(0);
  });

  it('5. Poly 上面留在原地外推 5：只做 2，SiN 3 → 1', () => {
    const { s, r } = run(base, push([poly1], UP, 5, false));
    expect(r.done).toBe(2);
    expect(r.stop).toMatchObject({ why: 'last', mat: SIN });
    expect(stack(s.vol, FIN1_X, GATE_Z)).toEqual([[AIR, 6], [SIN, 1], [POLY, 8], [TIN, 1], [HFO, 1], [FIN, 15], [SI, 6]]);
  });

  it('6. Poly 上面跟著移動外推到模型邊界：edge', () => {
    const { s, r } = run(base, push([poly1], UP, 10, true));
    expect(r.done).toBe(6);
    expect(r.stop).toMatchObject({ why: 'edge' });
    expect(stack(s.vol, FIN1_X, GATE_Z)).toEqual([[SIN, 3], [POLY, 12], [TIN, 1], [HFO, 1], [FIN, 15], [SI, 6]]);
  });

  it('7a. 內縮、跟著移動：薄層跟著退、外面那層（Poly）變厚', () => {
    const { s, r } = run(base, push([fin1], UP, -2, true));
    expect(r.done).toBe(2);
    expect(stack(s.vol, FIN1_X, GATE_Z)).toEqual([[AIR, 6], [SIN, 3], [POLY, 8], [TIN, 1], [HFO, 1], [FIN, 13], [SI, 6]]);
    expect(stack(s.vol, FIN1_X, 0)).toEqual([[AIR, 19], [FIN, 13], [SI, 6]]);
  });

  it('7b. 內縮、留在原地：緊貼那層（HfO₂）變厚', () => {
    const { s } = run(base, push([fin1], UP, -1, false));
    expect(stack(s.vol, FIN1_X, GATE_Z)).toEqual([[AIR, 6], [SIN, 3], [POLY, 6], [TIN, 1], [HFO, 2], [FIN, 14], [SI, 6]]);
  });

  it('7c. 內縮到剩 1 格就停（min）', () => {
    const sin1 = keyOf(L0, SIN, 4, 8);
    const { s, r } = run(base, push([sin1], UP, -5, true));
    expect(r.done).toBe(2);
    expect(r.stop).toMatchObject({ why: 'min' });
    expect(stack(s.vol, FIN1_X, GATE_Z)).toEqual([[AIR, 8], [SIN, 1], [POLY, 6], [TIN, 1], [HFO, 1], [FIN, 15], [SI, 6]]);
  });

  it('8. fin 往左平移（跟著）：整圈 HfO₂／TiN 含轉角一起搬；左邊 Poly 變薄、右邊變厚；到 Poly 剩 1 格停', () => {
    const { s, r } = run(base, move([fin1], [-6, 0, 0], true));
    expect(r.done).toBe(4);
    expect(r.stop).toMatchObject({ why: 'last', mat: POLY });
    const yMid = 22; // 閘極裡、fin 側面那一段
    expect(rowX(s.vol, yMid, GATE_Z)).toEqual([[AIR, 4], [POLY, 1], [TIN, 1], [HFO, 1], [FIN, 6], [HFO, 1], [TIN, 1], [POLY, 14], [TIN, 1], [HFO, 1], [FIN, 6], [HFO, 1], [TIN, 1], [POLY, 5], [AIR, 4]]);
    // STI 裡那一段：左邊 STI 變薄、右邊補上 STI
    expect(rowX(s.vol, 29, GATE_Z)).toEqual([[STI, 7], [FIN, 6], [STI, 18], [FIN, 6], [STI, 11]]);
    // 頂上的轉角：HfO₂、TiN 跟著搬（fin 頂上每一格仍貼著 HfO₂）
    const top = stack(s.vol, 7, GATE_Z);
    expect(top).toEqual([[AIR, 6], [SIN, 3], [POLY, 6], [TIN, 1], [HFO, 1], [FIN, 15], [SI, 6]]);
    for (let x = 7; x <= 12; x++) {
      for (let z = 8; z <= 15; z++) {
        let y = 0;
        while (s.vol.data[(z * Y + y) * X + x] !== FIN) y++;
        expect(s.vol.data[(z * Y + y - 1) * X + x]).toBe(HFO);
      }
    }
  });

  it('9. 多選兩根 fin 往右推：各自的右面都動；其中一根先被擋時兩根停在同一格數', () => {
    const { s, r } = run(base, push([fin1, fin2], RIGHT, 6, true));
    expect(r.done).toBe(4);
    expect(r.stop).toMatchObject({ why: 'last', mat: POLY });
    expect(rowX(s.vol, 22, GATE_Z)).toEqual([[AIR, 4], [POLY, 5], [TIN, 1], [HFO, 1], [FIN, 10], [HFO, 1], [TIN, 1], [POLY, 6], [TIN, 1], [HFO, 1], [FIN, 10], [HFO, 1], [TIN, 1], [POLY, 1], [AIR, 4]]);
  });

  it('11. plan v19：fin 右面外推 3（跟著）：蓋在上面的 HfO₂／TiN 也往右伸 3 格，轉角仍包著', () => {
    const { s, r } = run(base, push([fin1], RIGHT, 3, true));
    expect(r.done).toBe(3);
    // fin 頂上那兩排（y = 16 是 HfO₂、y = 15 是 TiN）：原本 HfO₂ x 10–17、TiN x 9–18
    expect(rowX(s.vol, 16, GATE_Z)).toEqual([[AIR, 4], [POLY, 5], [TIN, 1], [HFO, 11], [TIN, 1], [POLY, 7], [TIN, 1], [HFO, 8], [TIN, 1], [POLY, 5], [AIR, 4]]);
    expect(rowX(s.vol, 15, GATE_Z)).toEqual([[AIR, 4], [POLY, 5], [TIN, 13], [POLY, 7], [TIN, 10], [POLY, 5], [AIR, 4]]);
    // 再上面一排是 Poly：不動
    expect(rowX(s.vol, 14, GATE_Z)).toEqual(rowX(vol0, 14, GATE_Z));
    // fin 頂上每一格仍貼著 HfO₂
    for (let x = 11; x <= 19; x++) expect(stack(s.vol, x, GATE_Z)).toEqual([[AIR, 6], [SIN, 3], [POLY, 6], [TIN, 1], [HFO, 1], [FIN, 15], [SI, 6]]);
    // 內縮回來＝原始
    const back = run(s, push([keyOf(s.L, FIN, 11)], RIGHT, -3, true));
    expect(diff(back.s.vol.data, vol0.data)).toBe(0);
  });

  it('12. plan v19：fin 上面外推 2（跟著）：兩側側壁的 HfO₂／TiN 一起長高 2 格；旁邊的 Poly 那一排不動', () => {
    const { s } = run(base, push([fin1], UP, 2, true));
    expect(stack(vol0, 10, GATE_Z)).toEqual([[AIR, 6], [SIN, 3], [POLY, 6], [TIN, 1], [HFO, 11], [STI, 5], [SI, 6]]);
    expect(stack(s.vol, 10, GATE_Z)).toEqual([[AIR, 6], [SIN, 3], [POLY, 4], [TIN, 1], [HFO, 13], [STI, 5], [SI, 6]]);
    expect(stack(s.vol, 9, GATE_Z)).toEqual([[AIR, 6], [SIN, 3], [POLY, 4], [TIN, 14], [STI, 5], [SI, 6]]);
    expect(stack(s.vol, 8, GATE_Z)).toEqual(stack(vol0, 8, GATE_Z));
    // 留在原地：旁邊的排不動（被 HfO₂ 擋，一格都不做）
    expect(run(base, push([fin1], UP, 2, false)).r.done).toBe(0);
  });

  it('外推的裁切範圍沿法線包住會讀到的每一格；平移包住整圈薄層', () => {
    // fin 頂在 y = 17：推 2 格最遠讀到 Poly 第 2 格下面那一格（y = 17 − 1 − 2 − 2）再留 2 格
    const b = previewBox(base, push([fin1], UP, 2, true))!;
    expect(b.y0).toBeLessThanOrEqual(12);
    expect(b.y0).toBeGreaterThan(0);
    const t = previewBox(base, move([fin1], [-2, 0, 0], true))!;
    expect(t.x0).toBeLessThanOrEqual(9 - 4);
    expect(t.z0).toBeLessThanOrEqual(8);
  });
});

/** 一排（沿軸 a）的材質序列（連續同材質合成一段，空氣拿掉）。 */
function seqs(v: Volume, a: number): string[] {
  const dims = [v.X, v.Y, v.Z];
  const st = [1, v.X, v.X * v.Y];
  const [u, w] = [0, 1, 2].filter((k) => k !== a);
  const out: string[] = [];
  const p = [0, 0, 0];
  for (p[u] = 0; p[u] < dims[u]; p[u]++)
    for (p[w] = 0; p[w] < dims[w]; p[w]++) {
      p[a] = 0;
      const base = (p[2] * v.Y + p[1]) * v.X + p[0];
      const s: number[] = [];
      for (let t = 0; t < dims[a]; t++) {
        const m = v.data[base + t * st[a]];
        if (m !== AIR && s[s.length - 1] !== m) s.push(m);
      }
      out.push(s.join(','));
    }
  return out;
}

describe('kernel17 性質測試：隨機 200 步', () => {
  it('每一步三條路相同；外推與平移不會讓任何一排少掉或多出一層', () => {
    let rnd = 12345;
    const rand = (n: number) => {
      rnd = (rnd * 1103515245 + 12345) & 0x7fffffff;
      return rnd % n;
    };
    const DIRS: Vec3[] = [UP, [0, 1, 0], LEFT, RIGHT, [0, 0, 1], [0, 0, -1]];
    let s = base;
    let moved = 0;
    for (let step = 0; step < 200; step++) {
      const comps = s.L.comps.filter((c) => c.mat !== SI);
      const c = comps[rand(comps.length)];
      const same = s.L.comps.filter((x) => x.mat === c.mat && x.key !== c.key);
      const keys = rand(4) === 0 && same.length ? [c.key, same[rand(same.length)].key] : [c.key];
      const dir = DIRS[rand(6)];
      const n = 1 + rand(8);
      const follow = rand(3) !== 0;
      const kind = rand(3);
      const op = kind === 2 ? move(keys, dir.map((v) => v * n) as Vec3, follow) : push(keys, dir, kind === 0 ? n : -n, follow);
      const a = dir[0] ? 0 : dir[1] ? 1 : 2;
      const before = seqs(s.vol, a);
      const { s: next, r } = run(s, op);
      if (kind !== 1) expect(seqs(next.vol, a)).toEqual(before);
      if (r.done) moved++;
      s = next;
    }
    expect(moved).toBeGreaterThan(20);
  }, 120_000);
});
