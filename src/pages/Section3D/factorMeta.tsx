// 實驗變數的操作清單：每種操作一個小圖示、一句白話、預設的固定欄位（新增與「換操作」共用）。
// 之前這些散在 NewFactorForm 裡；變數卡要能直接換操作，就得抽出來。
import type { Editor } from './editor';
import { type Factor, type FactorOp, makeFactor, presetLevels } from '../../volume/factors';
import { type Vec3, VOID, kindOf } from '../../volume/volume';
import { roundFrame } from './RoundCard';
import { OP_HELP, OP_LABEL } from './opWords';
export { SIDE_NAME } from './opWords';

export const ALL_OPS: FactorOp[] = ['cd', 'push', 'round', 'level', 'dilate', 'taper', 'translate', 'defect'];

/** 一句白話（卡片上的副標、操作選單）。 */
export const OP_SHORT: Record<FactorOp, string> = {
  cd: '沿一個軸改總寬度（預設兩側一起變，也可以只動一側）',
  push: '某一面往外長、或往內縮',
  round: '頂端兩個角改成圓角',
  level: '某一面補平到指定高度（recess）',
  dilate: '整層沿表面加厚／減薄',
  taper: '側壁頂、底推不同格數',
  translate: '整塊沿一個軸平移',
  defect: '在結構裡放一塊別的材質',
};
export { OP_HELP, OP_LABEL };

/** 依材質類別排的操作清單：介電薄層 dilate 在前、閘極／金屬 cd／taper 在前。 */
export function opsFor(kind: string): FactorOp[] {
  if (kind === 'diel') return ['dilate', 'push', 'cd', 'round', 'level', 'taper', 'translate', 'defect'];
  if (kind === 'metal' || kind === 'semi') return ['cd', 'round', 'push', 'taper', 'level', 'dilate', 'translate', 'defect'];
  return ALL_OPS;
}

export function kindOfSel(ed: Editor) {
  return ed.selComps.length ? kindOf(ed.materials.find((m) => m.id === ed.selComps[0].mat) ?? { id: 0, name: '', color: '' }) : 'other';
}

/** CD 預設軸：通常是最短的水平軸。 */
export const cdAxis = (ed: Editor): 0 | 1 | 2 => {
  const b = ed.selBox;
  if (!b) return 0;
  return b.x1 - b.x0 <= b.z1 - b.z0 ? 0 : 2;
};

/**
 * 實驗的預設：相連的層一起變——薄襯層跟著推開／退回、厚的鄰居被吃掉或補上（不留空氣、不被擋住）。
 * 寫死在 template 裡，之後改全域設定也不會讓已經設計好的實驗變樣。
 */
export const TOGETHER = { policy: 'overwrite', follow: true } as const;

/** 這種操作的預設固定欄位（新增或換操作時用；之後在卡片「設定」裡改）。 */
export function templateFor(ed: Editor, op: FactorOp): { template: Record<string, unknown>; param?: string; unit: Factor['unit'] } {
  const axis = cdAxis(ed);
  const up: Vec3 = [0, -1, 0];
  switch (op) {
    case 'cd':
      return { template: { axis, anchor: 'center', ...TOGETHER }, unit: 'nm' };
    case 'push':
      return { template: { dir: up, ...TOGETHER }, unit: 'nm' };
    case 'translate':
      return { template: { axis }, unit: 'nm' };
    case 'level':
      return { template: { dir: up }, param: 'to', unit: 'nm' };
    case 'round': {
      const { axis: ra, at, scope } = roundFrame(ed);
      return { template: { axis: ra, at, scope, gesture: { corners: [{ id: 'ul' }, { id: 'ur' }], n: 2, mode: 'match' } }, unit: 'nm' };
    }
    case 'dilate':
      return { template: {}, unit: 'nm' };
    case 'taper':
      return { template: { face: [1, 0, 0], along: 1, both: true, ...TOGETHER }, param: 'bottom', unit: 'nm' };
    case 'defect':
      return { template: { shape: 'slab', center: [0.5, 0.5, 0.5], size: [20, 1, 30], mat: VOID }, param: 'size[1]', unit: 'nm' };
  }
}

/** 新變數：這種操作的預設欄位＋第一組預設水平（卡片一出現就有組合可看）。 */
export function newFactor(ed: Editor, op: FactorOp, taken: Iterable<string>, keys: string[] = [...ed.sel]): { factor: Factor; levels: number[] } {
  const t = templateFor(ed, op);
  const factor = makeFactor(ed.L, ed.vol, keys, op, t.template, ed.matName, taken, t.unit, t.param);
  return { factor, levels: presetLevels(factor, ed.nmPerVoxel)[0]?.values ?? [] };
}

/** 卡片上換操作：結構不變、自訂過的名稱留著，其餘重來（水平的意義變了，換成新操作的預設）。 */
export function switchOp(ed: Editor, f: Factor, op: FactorOp, taken: Iterable<string>): { factor: Factor; levels: number[] } {
  const next = newFactor(ed, op, taken, f.keys);
  const custom = f.name && f.name !== f.id;
  return custom ? { ...next, factor: { ...next.factor, name: f.name } } : next;
}

/** 操作的小圖示（16～20 px 線條圖；用 currentColor）。 */
export function OpGlyph({ op, size = 18 }: { op: FactorOp; size?: number }) {
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  let body: React.ReactNode;
  switch (op) {
    case 'cd':
      body = (
        <>
          <rect x="8" y="5" width="8" height="14" rx="1" />
          <path d="M2 12h4M22 12h-4M4 10l-2 2 2 2M20 10l2 2-2 2" />
        </>
      );
      break;
    case 'push':
      body = (
        <>
          <path d="M6 20V11h12v9" />
          <path d="M12 9V3M9 6l3-3 3 3" />
          <path d="M6 11h12" strokeDasharray="2 2" />
        </>
      );
      break;
    case 'round':
      body = <path d="M5 20V10a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v10" />;
      break;
    case 'level':
      body = (
        <>
          <path d="M5 20V8h14v12" />
          <path d="M3 5h18" strokeDasharray="3 2" />
          <path d="M12 5v3" />
        </>
      );
      break;
    case 'dilate':
      body = (
        <>
          <rect x="8" y="8" width="8" height="8" rx="1" />
          <rect x="4" y="4" width="16" height="16" rx="2" strokeDasharray="2.5 2" />
        </>
      );
      break;
    case 'taper':
      body = <path d="M9 4h6l4 16H5z" />;
      break;
    case 'translate':
      body = (
        <>
          <rect x="3" y="7" width="9" height="10" rx="1" />
          <path d="M14 12h7M18 9l3 3-3 3" />
        </>
      );
      break;
    case 'defect':
      body = (
        <>
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
        </>
      );
      break;
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden {...common}>
      {body}
    </svg>
  );
}
