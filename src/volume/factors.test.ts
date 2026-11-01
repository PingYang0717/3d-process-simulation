// plan v11 §4.1～§4.3：Factor／Design 的純函式。
import { describe, expect, it } from 'vitest';
import { type Design, type Factor, combosOf, defaultId, deltaOf, fromTemplate, makeFactor, measureNominal, nameOfCombo, opsOfCombo, otherColumn, parseLevels, slug, toTemplate } from './factors';
import { base, comp, matName, ofMat, vol } from './ops11.fixture';

const NM = 0.5;
const ctx = { L: base.L, vol, nmPerVoxel: NM, follow: true, backfill: 'orig' as const, policy: 'block' as const };
const poly2 = comp('Poly-Si 2');
const Lg = (): Factor => ({ ...makeFactor(base.L, vol, [poly2.key], 'cd', { axis: 2, anchor: 'center' }, matName, []), id: 'Lg', name: 'L_g' });
const off = (): Factor => ({ ...makeFactor(base.L, vol, [poly2.key], 'translate', { axis: 2 }, matName, []), id: 'off', name: 'off' });
const design = (combine: Design['combine'], picks?: Design['picks']): Design => ({
  factors: [Lg(), off()],
  levels: { Lg: [11, 12, 13], off: [-1, 0, 1] },
  combine,
  picks,
  from: 'base',
  nameTemplate: '{id}={value}{unit}',
});

describe('factors', () => {
  it('measureNominal：Poly-Si 2 的 W（z）＝24、HfO₂ 1 厚度＝2、STI 頂相對 fin 頂', () => {
    expect(Lg().nominal).toBe(24);
    const hf = ofMat(4)[0];
    expect(measureNominal(base.L, vol, { keys: [hf.key], op: 'dilate', template: {}, param: 'n' })).toBe(2);
    const sti = comp('STI SiO₂ 1');
    const fin = comp('Si fin 1');
    const rel = measureNominal(base.L, vol, { keys: [sti.key], op: 'level', template: { dir: [0, -1, 0], ref: { key: fin.key, side: 'lo' } }, param: 'offset' });
    expect(rel).toBe(sti.bbox.y0 - fin.bbox.y0);
  });
  it('combosOf：full＝3×3＝9（後面的變得快）、ofat＝5（標稱重複只留一個）、manual＝picks', () => {
    const full = combosOf(design('full'), NM);
    expect(full.length).toBe(9);
    expect(full.slice(0, 3)).toEqual([
      { Lg: 11, off: -1 },
      { Lg: 11, off: 0 },
      { Lg: 11, off: 1 },
    ]);
    const ofat = combosOf(design('ofat'), NM);
    expect(ofat.length).toBe(5);
    expect(ofat).toContainEqual({ Lg: 12, off: 0 });
    expect(combosOf(design('manual', [{ Lg: 13, off: 1 }]), NM)).toEqual([{ Lg: 13, off: 1 }]);
  });
  it('opsOfCombo：等於標稱不出 Op；絕對 → 相對換算（12 nm 標稱、13 nm → cd +2）', () => {
    const d = design('full');
    expect(opsOfCombo(d, { Lg: 12, off: 0 }, ctx)).toEqual([]);
    const ops = opsOfCombo(d, { Lg: 13, off: 1 }, ctx);
    expect(ops.map((o) => o.kind)).toEqual(['cd', 'translate']);
    expect(ops[0].kind === 'cd' && ops[0].delta).toBe(2);
    expect(ops[0].kind === 'cd' && ops[0].policy).toBe('block');
    expect(ops[1].kind === 'translate' && ops[1].d).toEqual([0, 0, 2]);
    expect(deltaOf(Lg(), 11, NM)).toBe(-2);
    expect(otherColumn(Lg(), 11, NM)).toBe(-1);
    expect(otherColumn(off(), 1, NM)).toBe(1);
  });
  it('nameOfCombo：樣板、帶號相對值、去 .0', () => {
    const d = design('full');
    expect(nameOfCombo(d, { Lg: 11, off: 1 })).toBe('Lg=11nm_off=+1nm');
    expect(nameOfCombo(d, { Lg: 11.5, off: -0.5 })).toBe('Lg=11.5nm_off=-0.5nm');
    expect(nameOfCombo(d, { Lg: 12, off: 0 })).toBe('Lg=12nm_off=0nm');
    expect(nameOfCombo({ ...d, nameTemplate: '{n}-{name}{value}' }, { Lg: 12, off: 0 }, 3)).toBe('3-L_g12_3-off0');
  });
  it('parseLevels：逗號、±、範圍、nominal ±%', () => {
    expect(parseLevels('16, 18，20', Lg(), NM)).toEqual([16, 18, 20]);
    expect(parseLevels('±2 step 1', Lg(), NM)).toEqual([10, 11, 12, 13, 14]);
    expect(parseLevels('±2 step 1', off(), NM)).toEqual([-2, -1, 0, 1, 2]);
    expect(parseLevels('−2..2 step 2', off(), NM)).toEqual([-2, 0, 2]);
    expect(parseLevels('nominal ±10%', Lg(), NM)).toEqual([10.8, 12, 13.2]);
    expect(parseLevels('abc', Lg(), NM)).toBeNull();
  });
  it('defaultId：slug、×3、中文結構名、重複加 _2', () => {
    expect(slug('Poly-Si 2')).toBe('PolySi2');
    expect(slug('HfO₂ ×3')).toBe('HfO2x3');
    expect(defaultId(base.L, [poly2.key], 'cd', { axis: 0 }, matName)).toBe('PolySi2_W');
    expect(defaultId(base.L, [poly2.key], 'cd', { axis: 2 }, matName, ['PolySi2_D'])).toBe('PolySi2_D_2');
    const hf3 = ofMat(4).slice(0, 3).map((c) => c.key);
    expect(defaultId(base.L, hf3, 'dilate', {}, matName)).toBe('HfO2x3_t');
    const zh = { ...base.L, comps: base.L.comps.map((c) => (c.key === poly2.key ? { ...c, label: '多晶矽 2' } : c)) };
    expect(defaultId(zh, [poly2.key], 'translate', { axis: 2 }, matName)).toBe('m6_2_z');
    expect(defaultId(base.L, [poly2.key], 'push', { dir: [0, -1, 0] }, matName)).toBe('PolySi2_top');
  });
  it('範本：toTemplate／fromTemplate 對回 keys、對不到的列出', () => {
    const d = design('full');
    const tpl = toTemplate(d, 'FEOL 閘極', base.L, matName);
    expect(tpl.factors[0].match).toEqual({ material: 'Poly-Si', ordinal: 2 });
    const json = JSON.parse(JSON.stringify(tpl));
    const back = fromTemplate(json, base.L, vol, matName);
    expect(back.missing).toEqual([]);
    expect(back.design.factors[0].keys).toEqual([poly2.key]);
    expect(back.design.factors[0].nominal).toBe(24);
    expect(back.design.levels.Lg).toEqual([11, 12, 13]);
    json.factors[1].match = { material: 'Poly-Si', ordinal: 9 };
    expect(fromTemplate(json, base.L, vol, matName).missing).toEqual(['off']);
  });
  it('level 相對 ref、dilate 絕對厚度、defect size 0 不出 Op', () => {
    const sti = comp('STI SiO₂ 1');
    const fin = comp('Si fin 1');
    const lv = makeFactor(base.L, vol, [sti.key], 'level', { dir: [0, -1, 0], ref: { key: fin.key, side: 'lo' } }, matName, [], 'vx');
    expect(lv.param).toBe('offset');
    const [op] = opsOfCombo({ factors: [lv], levels: {}, combine: 'full', from: 'base', nameTemplate: '' }, { [lv.id]: 6 }, ctx);
    expect(op.kind === 'level' && op.to).toBe(fin.bbox.y0 + 6);
    const hf = ofMat(4)[0];
    const dl = makeFactor(base.L, vol, [hf.key], 'dilate', {}, matName, []);
    const [dop] = opsOfCombo({ factors: [dl], levels: {}, combine: 'full', from: 'base', nameTemplate: '' }, { [dl.id]: 1.5 }, ctx);
    expect(dop.kind === 'dilate' && dop.n).toBe(1);
    const df = makeFactor(base.L, vol, [comp('Poly-Si 3').key], 'defect', { size: [20, 1, 30], center: [0.5, 0.15, 0.5] }, matName, [], 'vx');
    const dd = { factors: [df], levels: {}, combine: 'full' as const, from: 'base' as const, nameTemplate: '' };
    expect(opsOfCombo(dd, { [df.id]: 0 }, ctx)).toEqual([]);
    const [x] = opsOfCombo(dd, { [df.id]: 2 }, ctx);
    expect(x.kind === 'defect' && x.size).toEqual([20, 2, 30]);
  });
});

describe('plan v12 §5.6：水平驗證與預設', () => {
  const nm = 0.5;
  const ctx = { L: base.L, dims: vol, nm };
  it('圓頭半徑 −5 被擋、0 是不改動；預設 2、4、6 格', async () => {
    const { makeFactor, validateLevels, presetLevels } = await import('./factors');
    const p3 = base.L.comps.find((c) => c.label === 'Poly-Si 3')!;
    const f = { ...makeFactor(base.L, vol, [p3.key], 'round', { axis: 'x', at: 10 }, matName, [], 'vx'), id: 'r' };
    expect(f.mode).toBe('absolute');
    expect(f.nominal).toBe(0);
    const ps = validateLevels(f, [-5, 0, 6], ctx);
    expect(ps.find((p) => p.v === -5)).toMatchObject({ level: 'error', msg: '半徑不能小於 0' });
    expect(ps.find((p) => p.v === 0)?.level).toBe('noop');
    expect(ps.some((p) => p.v === 6)).toBe(false);
    expect(presetLevels(f, nm)[0].values).toEqual([2, 4, 6]);
  });
  it('移動超出陣列、推到 0 格、CD 寬度 0 被擋；±1 nm 預設', async () => {
    const { makeFactor, validateLevels, presetLevels, comboProblems } = await import('./factors');
    const p2 = base.L.comps.find((c) => c.label === 'Poly-Si 2')!;
    const tr = { ...makeFactor(base.L, vol, [p2.key], 'translate', { axis: 2 }, matName, [], 'vx'), id: 't' };
    expect(validateLevels(tr, [vol.Z], ctx)[0].msg).toBe('超出陣列');
    const push = { ...makeFactor(base.L, vol, [p2.key], 'push', { dir: [0, 0, 1] }, matName, [], 'vx'), id: 'p' };
    expect(validateLevels(push, [-(p2.bbox.z1 - p2.bbox.z0 + 1)], ctx)[0].msg).toBe('會把結構推到 0 格');
    const cd = { ...makeFactor(base.L, vol, [p2.key], 'cd', { axis: 2, anchor: 'center' }, matName, []), id: 'Lg' };
    expect(validateLevels(cd, [0], ctx)[0].msg).toBe('寬度會變成 0（最少 1 格）');
    const pre = presetLevels(cd, nm);
    expect(pre[1].label).toBe('±1 nm（±2 格）');
    expect(pre[1].values).toEqual([11, 12, 13]);
    const design = { factors: [cd, tr], levels: {}, combine: 'full' as const, from: 'base' as const, nameTemplate: '' };
    expect(comboProblems(design, { Lg: 12, t: 0 }, ctx)).toEqual({ errors: [], control: true });
    expect(comboProblems(design, { Lg: 0, t: 0 }, ctx).errors[0]).toContain('寬度');
  });
  it('絕對 ⇄ 相對只是顯示：格數位移不變', async () => {
    const { makeFactor, switchMode, deltaOf } = await import('./factors');
    const p2 = base.L.comps.find((c) => c.label === 'Poly-Si 2')!;
    const cd = makeFactor(base.L, vol, [p2.key], 'cd', { axis: 2, anchor: 'center' }, matName, []);
    const lv = [11, 12, 13];
    const r = switchMode(cd, lv, nm);
    expect(r.factor.mode).toBe('relative');
    expect(r.levels.map((v) => deltaOf(r.factor, v, nm))).toEqual(lv.map((v) => deltaOf(cd, v, nm)));
  });
});
