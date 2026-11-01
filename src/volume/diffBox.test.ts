// plan v12 §5.2：Worker 的 diff 外框。apply／undo／redo／replay 後 diffBox ⊇ 所有 diff 格、而且貼合（每一面都有 diff 格）。
import { describe, expect, it } from 'vitest';
import { type BBox, MATERIALS } from './volume';
import { handle, inspect } from './workerCore';
import type { Op } from './ops';
import type { Step } from './patch';
import { base, comp, vol } from './ops11.fixture';

const matNames = Object.fromEntries(MATERIALS.map((m) => [m.id, m.name]));

/** 掃整個 diff 的外框（對照）。 */
function scanBox(diff: Uint8Array | null): BBox | null {
  if (!diff) return null;
  let b: BBox | null = null;
  for (let z = 0, i = 0; z < vol.Z; z++)
    for (let y = 0; y < vol.Y; y++)
      for (let x = 0; x < vol.X; x++, i++)
        if (diff[i]) {
          if (!b) b = { x0: x, x1: x, y0: y, y1: y, z0: z, z1: z };
          else {
            b.x0 = Math.min(b.x0, x);
            b.x1 = Math.max(b.x1, x);
            b.y0 = Math.min(b.y0, y);
            b.y1 = Math.max(b.y1, y);
            b.z0 = Math.min(b.z0, z);
            b.z1 = Math.max(b.z1, z);
          }
        }
  return b;
}

describe('diffBox（plan v12 §5.2）', () => {
  it('apply → 復原 → 重做 → replay：每一步 diffBox ≡ 掃整個 diff 的外框', () => {
    handle('load', { sid: 1, vol: { ...vol, data: vol.data.slice() } });
    handle('fork', { owner: 's1', src: 'base', sid: 10 });
    const poly = comp('Poly-Si 3');
    const full = { axis: 'z' as const, lo: 0, hi: vol.Z - 1 };
    const ops: Op[] = [
      { kind: 'push', keys: [poly.key], scope: full, dir: [0, -1, 0], n: 2, follow: true, backfill: 'orig' },
      { kind: 'translate', keys: [poly.key], scope: full, d: [3, 0, 0], backfill: 'orig' },
    ];
    const check = (sid: number) => {
      const b = handle('diffBox', { sid })[0];
      const owner = [...inspect().heads].find(([, h]) => h === sid)![0];
      expect(b).toEqual(scanBox(inspect().books.get(owner)!.diff));
    };
    check(10);
    let cs = base.L.comps;
    const steps: Step[] = [];
    let sid = 10;
    for (const op of ops) {
      const r = handle('apply', { owner: 's1', from: sid, to: sid + 1, comps: cs, op, matNames, keyCounter: 1000 })[0] as { step: Step };
      steps.push(r.step);
      cs = r.step.labels?.compsAfter ?? cs;
      sid++;
      check(sid);
    }
    // 復原兩步：回到原始，外框是 null（寬鬆的 union 收緊後沒有格子）
    handle('derive', { owner: 's1', from: 12, to: 20, step: steps[1], dir: 'back' });
    check(20);
    handle('derive', { owner: 's1', from: 20, to: 21, step: steps[0], dir: 'back' });
    check(21);
    expect(handle('diffBox', { sid: 21 })[0]).toBeNull();
    handle('derive', { owner: 's1', from: 21, to: 22, step: steps[0], dir: 'fwd' });
    check(22);
    handle('replay', { owner: 's2', src: 'base', from: 1, to: 30, comps: base.L.comps, ops, matNames, keyCounter: 1000 });
    check(30);
    expect(handle('diffBox', { sid: 30 })[0]).not.toBeNull();
  });
});
