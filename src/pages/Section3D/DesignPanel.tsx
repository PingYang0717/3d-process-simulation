// 實驗頁的設計區（plan v12 §5.4、§5.6；取代 v11 的「實驗」頁籤）：
// 步驟列 ① 選結構 → ② 加變數 → ③ 看組合 → ④ 產生；每個變數一張卡（一句話、水平 chips、預設按鈕）、組合表（試算走 Worker、
// 無效的列先擋）、從哪裡開始、命名；產生時留在實驗頁、進度 k／N、可取消，完成後可「撤銷這次產生」。範本存在瀏覽器、可匯出／匯入 JSON。
import { useMemo, useRef, useState } from 'react';
import { App, Button, Dropdown, Flex, Input, Progress, Segmented, Typography } from 'antd';
import { DownOutlined, PlusOutlined } from '@ant-design/icons';
import type { Vec3 } from '../../volume/volume';
import {
  type Design,
  type DesignTemplate,
  type Factor,
  DEFAULT_NAME_TEMPLATE,
  combosOf,
  comboProblems,
  fromTemplate,
  nameOfCombo,
  opsOfCombo,
  presetLevels,
  toTemplate,
  validateLevels,
} from '../../volume/factors';
import { usePersisted } from '../../ui/persist';
import { download } from '../../ui/download';
import type { Editor } from './editor';
import { StructurePicker } from './StructurePicker';
import { FactorCard, NewFactorForm } from './FactorCard';
import { type ComboRow, ComboTable } from './ComboTable';
import { hiddenTable, palette } from './tables';

const { Text } = Typography;

/** 草稿：變數＋每個變數的水平（unit；mode 決定絕對或相對）＋組合設定（重新整理後還在）。 */
interface Draft {
  factors: Factor[];
  levels: Record<string, number[]>;
  combine: Design['combine'];
  from: Design['from'];
  nameTemplate: string;
  picks: string[];
}
const EMPTY: Draft = { factors: [], levels: {}, combine: 'full', from: 'base', nameTemplate: DEFAULT_NAME_TEMPLATE, picks: [] };
const isDraft = (v: unknown): v is Draft => !!v && typeof v === 'object' && Array.isArray((v as Draft).factors) && typeof (v as Draft).levels === 'object';
const isTemplates = (v: unknown): v is DesignTemplate[] => Array.isArray(v);

/** 步驟列：做到哪一步亮到哪一步。 */
function Steps({ at }: { at: number }) {
  const names = ['選結構', '加變數', '看組合', '產生'];
  return (
    <ol className="lab-steps" aria-label="步驟">
      {names.map((n, i) => (
        <li key={n} className={i < at ? 'done' : i === at ? 'now' : ''} aria-current={i === at ? 'step' : undefined}>
          <span className="lab-step-n">{'①②③④'[i]}</span>
          {n}
        </li>
      ))}
    </ol>
  );
}

export function DesignPanel({ ed, onMade, onOpen3D }: { ed: Editor; onMade: (ids: string[]) => void; onOpen3D: (id: string) => void }) {
  const { message, modal } = App.useApp();
  const [draft, setDraft] = usePersisted<Draft>('designDraft2', EMPTY, isDraft);
  const [templates, setTemplates] = usePersisted<DesignTemplate[]>('factorTemplates', [], isTemplates);
  const [adding, setAdding] = useState(false);
  const [face, setFace] = useState<Vec3 | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const nm = ed.nmPerVoxel;
  const set = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));
  const start = draft.from === 'active' && ed.active ? ed.active.cur : ed.orig;
  const design: Design = useMemo(
    () => ({
      factors: draft.factors.filter((f) => f.keys.length),
      levels: Object.fromEntries(draft.factors.map((f) => [f.id, draft.levels[f.id] ?? []])),
      combine: draft.combine,
      picks: draft.combine === 'manual' ? draft.picks.map((p) => JSON.parse(p) as Record<string, number>) : undefined,
      from: draft.from,
      nameTemplate: draft.nameTemplate || DEFAULT_NAME_TEMPLATE,
    }),
    [draft],
  );
  const check = useMemo(() => ({ L: start.L, dims: start.vol, nm }), [start, nm]);
  const problems = useMemo(() => Object.fromEntries(draft.factors.map((f) => [f.id, validateLevels(f, draft.levels[f.id] ?? [], check)])), [draft, check]);
  const manual = draft.combine === 'manual';
  const combos = useMemo(() => combosOf(design, nm), [design, nm]);
  const rows: ComboRow[] = useMemo(() => {
    const list = manual ? combosOf({ ...design, combine: 'full' }, nm) : combos;
    const picked = new Set(draft.picks);
    const ctx = ed.factorCtx(start);
    return list.slice(0, 400).map((c, i) => {
      const key = JSON.stringify(c);
      const p = comboProblems(design, c, check);
      let ops: ComboRow['ops'] = [];
      try {
        ops = p.errors.length ? [] : opsOfCombo(design, c, ctx);
      } catch (e) {
        p.errors.push((e as Error).message);
      }
      return { key, combo: c, name: nameOfCombo(design, c, i + 1), errors: p.errors, control: p.control || (!p.errors.length && !ops.length), picked: manual ? picked.has(key) : true, ops };
    });
  }, [design, combos, manual, draft.picks, nm, check, ed, start]);
  const included = rows.filter((r) => r.picked);
  const bad = included.filter((r) => r.errors.length);
  const ids = draft.factors.map((f) => f.id);
  const dupId = ids.find((id, i) => ids.indexOf(id) !== i);
  const fromAll = draft.from === 'all';
  const canAll = combos.length === 1 && ed.splits.length > 0;
  const step = !ed.sel.size && !draft.factors.length ? 0 : !draft.factors.length ? 1 : !combos.length ? 2 : 3;
  const generating = !!ed.genProgress;

  const updateFactor = (i: number, f: Factor, lv: number[]) => {
    const old = draft.factors[i];
    const levels = { ...draft.levels };
    if (old.id !== f.id) delete levels[old.id];
    levels[f.id] = lv;
    set({ factors: draft.factors.map((x, k) => (k === i ? f : x)), levels });
  };

  const generate = async () => {
    if (!design.factors.length || !combos.length) return;
    if (dupId) return void message.warning(`變數 id「${dupId}」重複；同一個設計裡要唯一`);
    if (bad.length) return void message.error(`有 ${bad.length} 個組合無效（紅色），先改水平`);
    if (combos.length > 200) return void message.error(`${combos.length} 個組合太多（上限 200）：改用逐一掃描或手動勾選`);
    const go = async () => {
      const made = await ed.addDesign(design);
      if (!made.length) return;
      onMade(made);
      if (fromAll) return void message.success(`已套用到 ${made.length} 個 split`);
      message.open({
        key: 'made',
        type: 'success',
        duration: 10,
        content: (
          <span>
            已產生 {made.length} 個 split
            <Typography.Link style={{ marginLeft: 10 }} onClick={() => (message.destroy('made'), onOpen3D(made[0]))}>
              在 3D 看第一個
            </Typography.Link>
            <Typography.Link style={{ marginLeft: 10 }} onClick={() => (ed.removeSplits(made), message.destroy('made'), message.info('已撤銷這次產生'))}>
              撤銷這次產生
            </Typography.Link>
          </span>
        ),
      });
    };
    if (combos.length > 50) modal.confirm({ title: `要產生 ${combos.length} 個 split`, content: '每個 split 都要重播一次，可能要一段時間（可以中途取消，已產生的留著）。繼續？', okText: '產生', cancelText: '取消', onOk: go });
    else await go();
  };

  const saveTemplate = () => {
    let name = '';
    modal.confirm({
      title: '存成範本',
      content: <Input autoFocus placeholder="例如 FEOL 閘極" onChange={(e) => (name = e.target.value)} />,
      okText: '存',
      cancelText: '取消',
      onOk: () => {
        const tpl = toTemplate(design, name || `範本 ${templates.length + 1}`, ed.L, ed.matName);
        setTemplates((all) => [...all.filter((t) => t.name !== tpl.name), tpl]);
        message.success(`已存成範本「${tpl.name}」`);
      },
    });
  };
  const loadTemplate = (tpl: DesignTemplate) => {
    try {
      const { design: d, missing } = fromTemplate(tpl, ed.L, ed.vol, ed.matName);
      set({ factors: d.factors, levels: d.levels, combine: d.combine, nameTemplate: d.nameTemplate, picks: [] });
      if (missing.length) message.warning(`${missing.join('、')} 對不到結構，請重選`);
      else message.success(`已載入範本「${tpl.name}」，直接看組合表`);
    } catch (e) {
      message.error((e as Error).message);
    }
  };
  const importFile = async (file: File) => {
    try {
      const tpl = JSON.parse(await file.text()) as DesignTemplate;
      setTemplates((all) => [...all.filter((t) => t.name !== tpl.name), tpl]);
      loadTemplate(tpl);
    } catch {
      message.error('讀不出範本 JSON');
    }
  };

  return (
    <Flex vertical gap={14} className="design-panel">
      <Flex align="center" gap={8}>
        <Steps at={step} />
        <span className="grow" />
        <Dropdown
          trigger={['click']}
          menu={{
            items: [
              { key: 'save', label: '存成範本…', disabled: !design.factors.length, onClick: saveTemplate },
              ...(templates.length ? [{ type: 'divider' as const }, ...templates.map((t) => ({ key: `t:${t.name}`, label: `載入「${t.name}」`, onClick: () => loadTemplate(t) }))] : []),
              { type: 'divider' as const },
              {
                key: 'export',
                label: '匯出 JSON',
                disabled: !design.factors.length,
                onClick: () => void download(new TextEncoder().encode(JSON.stringify(toTemplate(design, 'design', ed.L, ed.matName), null, 2)), 'design-template.json', 'application/json'),
              },
              { key: 'import', label: '匯入 JSON…', onClick: () => fileRef.current?.click() },
              { type: 'divider' as const },
              { key: 'clear', label: '清空設計', danger: true, disabled: !draft.factors.length, onClick: () => set({ factors: [], levels: {}, picks: [] }) },
            ],
          }}
        >
          <Button size="small">
            範本 <DownOutlined style={{ fontSize: 10 }} />
          </Button>
        </Dropdown>
        <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => e.target.files?.[0] && void importFile(e.target.files[0])} />
      </Flex>

      <section className="lab-sec">
        <h3>① 結構</h3>
        <StructurePicker ed={ed} face={face} />
      </section>

      {(step >= 1 || draft.factors.length > 0) && (
        <section className="lab-sec">
          <h3>② 變數</h3>
          {!draft.factors.length && !adding && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              變數＝要掃的一個量（例如閘極寬度 L<sub>g</sub>、偏移、圓頭半徑）。加一個，點下面的預設水平就會出現組合。
            </Text>
          )}
          {draft.factors.map((f, i) => (
            <FactorCard
              key={i}
              ed={ed}
              f={f}
              k={i}
              levels={draft.levels[f.id] ?? []}
              problems={problems[f.id] ?? []}
              taken={ids.filter((x) => x !== f.id)}
              onChange={(nf, lv) => updateFactor(i, nf, lv)}
              onRemove={() => set({ factors: draft.factors.filter((_, k) => k !== i) })}
              onFace={setFace}
            />
          ))}
          {dupId && <Text type="danger">變數 id「{dupId}」重複；同一個設計裡要唯一</Text>}
          {adding ? (
            <NewFactorForm
              ed={ed}
              taken={ids}
              onFace={setFace}
              onCancel={() => setAdding(false)}
              onAdd={(f) => {
                // 半徑標稱 0、缺陷大小：直接給預設 2、4、6 格（plan v12 §5.6）
                const seed = (f.op === 'round' && Math.round(f.nominal) === 0) || (f.op === 'defect' && !f.param.startsWith('center')) ? presetLevels(f, nm)[0].values : [];
                set({ factors: [...draft.factors, f], levels: { ...draft.levels, [f.id]: seed } });
                setAdding(false);
              }}
            />
          ) : (
            <Button icon={<PlusOutlined />} disabled={!ed.sel.size} onClick={() => setAdding(true)}>
              {ed.sel.size ? '加一個變數（用上面選的結構）' : '先在 ① 選結構'}
            </Button>
          )}
        </section>
      )}

      {draft.factors.length > 0 && (
        <section className="lab-sec">
          <h3>③ 組合</h3>
          <Segmented
            block
            size="small"
            value={draft.combine}
            onChange={(v) => set({ combine: v as Design['combine'] })}
            options={[
              { label: '逐一掃描', value: 'ofat' },
              { label: '全因子', value: 'full' },
              { label: '手動勾選', value: 'manual' },
            ]}
          />
          <Text type="secondary" style={{ fontSize: 12 }}>
            {draft.combine === 'ofat'
              ? `每個變數各自掃，其他維持標稱：${combos.length} 個 split`
              : draft.combine === 'full'
                ? `${design.factors.map((f) => (design.levels[f.id] ?? []).length || 0).join(' × ') || 0} = ${combos.length} 個 split`
                : `勾了 ${combos.length} 個組合（在表裡勾）`}
          </Text>
          {rows.length > 0 ? (
            <ComboTable
              rows={rows}
              factors={design.factors}
              design={design}
              start={start}
              nm={nm}
              manual={manual}
              onPick={(key, on) => set({ picks: on ? [...draft.picks, key] : draft.picks.filter((p) => p !== key) })}
              hidden={hiddenTable(ed.hidden)}
              palette={palette(ed.materials)}
            />
          ) : (
            <Text type="secondary" style={{ fontSize: 12 }}>
              還沒有組合：每個變數至少要有一個水平
            </Text>
          )}
          <Flex align="center" gap={8} wrap="wrap">
            <span style={{ fontSize: 12, color: 'var(--c-text-2)' }}>從哪裡開始</span>
            <Segmented
              size="small"
              value={draft.from}
              onChange={(v) => set({ from: v as Design['from'] })}
              options={[
                { label: '原始', value: 'base' },
                { label: '接在目前 split 之後', value: 'active', disabled: !ed.active },
                { label: '套用到所有 split', value: 'all', disabled: !canAll },
              ]}
            />
          </Flex>
          {draft.from === 'active' && ed.active && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              每個新 split＝{ed.active.name} 的 {ed.active.ops.length} 步＋這個組合。
            </Text>
          )}
          {fromAll && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              不產生新 split：對每個現有 split 各加一步（例如全部加同一個 void）；只有一個組合時可用。
            </Text>
          )}
          <Flex align="center" gap={8}>
            <span style={{ fontSize: 12, whiteSpace: 'nowrap', color: 'var(--c-text-2)' }}>命名</span>
            <Input size="small" value={draft.nameTemplate} onChange={(e) => set({ nameTemplate: e.target.value })} placeholder={DEFAULT_NAME_TEMPLATE} aria-label="命名樣板" />
          </Flex>
          <Text type="secondary" style={{ fontSize: 11 }}>
            第一個會叫「{rows.find((r) => r.picked)?.name ?? '—'}」· 可用 {'{id}'}、{'{name}'}、{'{value}'}、{'{unit}'}、{'{n}'}
          </Text>
        </section>
      )}

      {draft.factors.length > 0 && (
        <section className="lab-sec">
          <h3>④ 產生</h3>
          {generating ? (
            <Flex vertical gap={6}>
              <Progress percent={Math.round(((ed.genProgress!.done + 1) / ed.genProgress!.total) * 100)} size="small" format={() => `${ed.genProgress!.done + 1}／${ed.genProgress!.total}`} />
              <Button size="small" onClick={ed.cancelDesign}>
                取消（已產生的留著）
              </Button>
            </Flex>
          ) : (
            <Button
              type="primary"
              block
              disabled={!design.factors.length || !combos.length || !!ed.busy || (fromAll && !canAll) || bad.length > 0 || !!dupId}
              onClick={generate}
            >
              {fromAll ? `套用到 ${ed.splits.length} 個 split` : bad.length ? `有 ${bad.length} 個組合無效` : `產生 ${combos.length} 個 split`}
            </Button>
          )}
          <Text type="secondary" style={{ fontSize: 12 }}>
            每個組合用 Op 重播產生（Op 是唯一真相）；產生後留在這一頁，結果在右邊。1 格 = {nm} nm。
          </Text>
        </section>
      )}
    </Flex>
  );
}
