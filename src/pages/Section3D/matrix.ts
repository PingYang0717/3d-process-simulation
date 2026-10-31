// 矩陣表、CSV、manifest（plan v11 §4.4、§4.11）：純函式，不碰 React；矩陣表與 manifest 同一份資料。
import type { Material } from '../../volume/volume';
import { kindOf } from '../../volume/volume';
import type { Op } from '../../volume/ops';
import { type Design, type Factor, deltaOf, formatLevel } from '../../volume/factors';

/** split 在矩陣表／manifest 需要的欄位（editor 的 Split 是它的超集）。 */
export interface MatrixSplit {
  id: string;
  name: string;
  ops: Op[];
  levels?: Record<string, number>;
  designId?: string;
  tags?: string[];
  blocked?: number;
  changedVoxels: number;
}

/** 所有設計裡出現過的變數（同 id 取最後一次產生的那一份）。 */
export function factorsOf(designs: Design[]): Factor[] {
  const m = new Map<string, Factor>();
  for (const d of designs) for (const f of d.factors) m.set(f.id, f);
  return [...m.values()];
}

/** 一格：「18 nm」＋小字「−2 nm」；等於標稱顯示「標稱」。 */
export function levelCell(f: Factor, v: number | undefined, nm: number): { main: string; sub: string; nominal: boolean } | null {
  if (v === undefined) return null;
  const d = deltaOf(f, v, nm);
  const unit = f.op === 'defect' && f.param.startsWith('center') ? '' : ` ${f.unit}`;
  const main = `${formatLevel(f, v, f.mode === 'relative')}${unit}`;
  const otherVx = f.mode === 'absolute' ? d : Math.round(f.nominal) + d;
  const other = f.unit === 'nm' && !(f.op === 'defect' && f.param.startsWith('center')) ? otherVx * nm : otherVx;
  const sub = `${formatLevel(f, other, f.mode === 'absolute')}${unit}`;
  return { main, sub, nominal: d === 0 };
}

const csvCell = (v: string | number) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV：一列一個 split、一欄一個變數（和 manifest 的 levels 同源）；第一列是表頭。 */
export function matrixCsv(splits: MatrixSplit[], factors: Factor[], fileOf: (s: MatrixSplit) => string): string {
  const head = ['split', 'file', ...factors.map((f) => `${f.id}${f.op === 'defect' && f.param.startsWith('center') ? '' : `_${f.unit}`}`), 'changedVoxels', 'blocked', 'designId', 'tags'];
  const rows = splits.map((s) => [s.name, fileOf(s), ...factors.map((f) => s.levels?.[f.id] ?? ''), s.changedVoxels, s.blocked ?? '', s.designId ?? '', (s.tags ?? []).join(' ')]);
  return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}

export interface ManifestInput {
  source: string;
  format: string;
  input?: Record<string, unknown>;
  materials: (Material & { source?: string })[];
  shape: number[];
  spacing: number[];
  origin: number[];
  nmPerVoxel: number;
  designs: Design[];
  splits: MatrixSplit[];
  fileOf: (s: MatrixSplit) => string;
  opText: (op: Op) => string;
  /** 對照組（原始）以外的 baseline split；省略＝'original'。 */
  baseline?: string;
}

/** manifest.json（§4.11）：既有欄位不變，多 materials[].kind、designs、baseline、splits[].levels／designId／tags／blocked。 */
export function buildManifest(m: ManifestInput) {
  return {
    source: m.source,
    format: m.format,
    ...(m.input ? { input: m.input } : {}),
    materials: m.materials.map((x) => ({ id: x.id, name: x.name, color: x.color, kind: kindOf(x), ...(x.source ? { source: x.source } : {}) })),
    shape: m.shape,
    dtype: 'uint8',
    spacing: m.spacing,
    origin: m.origin,
    nmPerVoxel: m.nmPerVoxel,
    ...(m.designs.length
      ? {
          designs: m.designs.map((d) => ({
            id: d.id,
            factors: d.factors,
            levels: d.levels,
            combine: d.combine,
            ...(d.picks ? { picks: d.picks } : {}),
            from: d.from,
            nameTemplate: d.nameTemplate,
          })),
        }
      : {}),
    baseline: m.baseline ?? 'original',
    splits: m.splits.map((s) => ({
      name: s.name,
      file: m.fileOf(s),
      changedVoxels: s.changedVoxels,
      ...(s.blocked !== undefined ? { blocked: s.blocked } : {}),
      ...(s.designId ? { designId: s.designId } : {}),
      ...(s.levels ? { levels: s.levels } : {}),
      ...(s.tags?.length ? { tags: s.tags } : {}),
      ops: s.ops.map((op) => ({ ...op, text: m.opText(op) })),
    })),
  };
}
