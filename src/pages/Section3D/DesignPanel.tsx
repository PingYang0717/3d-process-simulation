// 實驗頁的設計區（plan v12 §5.4、§5.6）：
// ① 結構（下拉＋可換視角的預覽，預覽上標出每個變數會改的地方）→ ② 變數（一張卡一句話，操作可直接換、值可直接改）
// → ③ 組合（三種方式各一句說明、組合表寫清楚每列狀態）→ ④ 產生（黏在底下）。
// 產生時留在實驗頁、進度 k／N、可取消，完成後可「撤銷這次產生」。範本存在瀏覽器、可匯出／匯入 JSON。
import { useEffect, useMemo, useRef, useState } from 'react';
import { App, Button, Dropdown, Input, Progress, Segmented, Typography } from 'antd';
import { CheckOutlined, DownOutlined, FolderOpenOutlined } from '@ant-design/icons';
import type { Vec3 } from '../../volume/volume';
import { type Design, type DesignTemplate, type Factor, DEFAULT_NAME_TEMPLATE, combosOf, comboProblems, fromTemplate, nameOfCombo, opsOfCombo, toTemplate, validateLevels } from '../../volume/factors';
import { usePersisted } from '../../ui/persist';
import { download } from '../../ui/download';
import type { Editor } from './editor';
import { type Mark, StructurePicker } from './StructurePicker';
import { AddFactorButton, FactorCard } from './FactorCard';
import { type ComboRow, ComboTable } from './ComboTable';
import { hiddenTable, palette } from './tables';
import { CATEGORY } from './colors';
import { whoText } from './opWords';

const { Text } = Typography;

import { type Draft, loadDraft, nextDraft, saveDraft } from './draft';
const isTemplates = (v: unknown): v is DesignTemplate[] => Array.isArray(v);

type StepState = 'done' | 'now' | 'todo';

const COMBINE_HINT: Record<Design['combine'], string> = {
  ofat: '一次只動一個變數，其他維持現在的值：變數多時 split 最少',
  full: '每個變數的每個值都互相搭配：看得到交互作用，但數量是相乘',
  manual: '從全因子的清單裡勾你要的那幾個',
};

/** 一個段落：圓形步驟數字（做完 ✓、做到這步實心、還沒到空心）＋標題＋右邊一句摘要。 */
function Sec({ n, title, state, meta, children }: { n: number; title: string; state: StepState; meta?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className={`lab-sec ${state}`} aria-current={state === 'now' ? 'step' : undefined}>
      <header className="lab-sec-head">
        <span className="lab-sec-n" aria-hidden>
          {state === 'done' ? <CheckOutlined /> : n}
        </span>
        <h3>{title}</h3>
        {meta !== undefined && meta !== '' && <span className="lab-sec-meta">{meta}</span>}
      </header>
      <div className="lab-sec-body">{children}</div>
    </section>
  );
}

/** 標籤在左的一列（從哪裡開始、命名）。 */
const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="dp-row">
    <span className="dp-row-label">{label}</span>
    <div className="dp-row-body">{children}</div>
  </div>
);

export function DesignPanel({ ed, onMade, onOpen3D, onOpenStructure, title = true }: { ed: Editor; onMade: (ids: string[]) => void; onOpen3D: (id: string) => void; onOpenStructure: () => void; title?: boolean }) {
  const { message, modal } = App.useApp();
  // 草稿不持久化（plan v14 §5.4）：重新整理＝空的；切頁回來還在（draft.ts 的模組記憶體）
  const [draft, setDraft] = useState<Draft>(loadDraft);
  useEffect(() => saveDraft(draft), [draft]);
  // 換成和變數無關的結構：變數清空（掛載時也檢查：在編輯頁換了選取再回來）
  const selKey = [...ed.sel].sort().join(',');
  useEffect(() => {
    const n = nextDraft(draft, ed.sel);
    if (n === draft) return;
    setDraft(n);
    message.info('換了結構，變數已清空');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey]);
  const [templates, setTemplates] = usePersisted<DesignTemplate[]>('factorTemplates', [], isTemplates);
  const [face, setFace] = useState<Vec3 | null>(null);
  const [hot, setHot] = useState<string | null>(null);
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
  const st = (i: number): StepState => (i < step ? 'done' : i === step ? 'now' : 'todo');
  const generating = !!ed.genProgress;
  const levelCounts = design.factors.map((f) => (design.levels[f.id] ?? []).length || 0);
  const marks: Mark[] = draft.factors.map((f, k) => ({ f, color: CATEGORY[k % CATEGORY.length], hot: hot === f.id }));

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

  const comboMeta =
    draft.combine === 'ofat'
      ? `逐一掃描 · ${combos.length} 個`
      : draft.combine === 'full'
        ? `${levelCounts.join(' × ') || 0} = ${combos.length} 個`
        : `勾了 ${combos.length} 個`;
  const firstName = rows.find((r) => r.picked)?.name;
  const who = ed.sel.size ? whoText(ed.L, [...ed.sel], ed.matName) : null;
  const summary = !who ? '先選一個結構' : !draft.factors.length ? `${who} · 還沒有變數` : `${who} · ${draft.factors.length} 個變數 · ${combos.length} 個 split`;

  return (
    <div className="design-panel">
      <header className="dp-head">
        {title && (
          <div className="dp-title-wrap">
            <span className="dp-title">設計</span>
            <span className="dp-summary">{summary}</span>
          </div>
        )}
        <span className="grow" />
        <Dropdown
          trigger={['click']}
          placement="bottomRight"
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
          <Button size="small" type="text" icon={<FolderOpenOutlined />} className="dp-tpl">
            範本 <DownOutlined className="dp-caret" />
          </Button>
        </Dropdown>
        <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => e.target.files?.[0] && void importFile(e.target.files[0])} />
      </header>

      <Sec n={1} title="結構" state={st(0)} meta={ed.sel.size > 1 ? `${ed.sel.size} 個` : undefined}>
        <StructurePicker ed={ed} face={face} marks={marks} onOpen3D={onOpenStructure} start={draft.from === 'active' ? ed.active : null} />
      </Sec>

      <Sec n={2} title="變數" state={st(1)} meta={draft.factors.length ? `${draft.factors.length} 個` : undefined}>
        {!draft.factors.length && (
          <Text type="secondary" className="dp-hint">
            一個變數＝要掃的一個量（寬度、圓頭半徑、偏移…）。加了之後，上面的預覽會標出它改哪裡，下面會列出會產生的 split。
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
            onHot={setHot}
          />
        ))}
        {dupId && (
          <Text type="danger" className="dp-hint">
            變數 id「{dupId}」重複；同一個設計裡要唯一
          </Text>
        )}
        <AddFactorButton ed={ed} taken={ids} disabled={!ed.sel.size} onAdd={(f, lv) => set({ factors: [...draft.factors, f], levels: { ...draft.levels, [f.id]: lv } })} />
      </Sec>

      {draft.factors.length > 0 && (
        <Sec n={3} title="組合" state={st(2)} meta={comboMeta}>
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
          <Text type="secondary" className="dp-hint combine-hint">
            {COMBINE_HINT[draft.combine]}
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
            <Text type="secondary" className="dp-hint">
              還沒有組合：每個變數至少要有一個值
            </Text>
          )}
          <div className="dp-form">
            <Row label="起點">
              <Segmented
                size="small"
                value={draft.from}
                onChange={(v) => set({ from: v as Design['from'] })}
                options={[
                  { label: '原始', value: 'base' },
                  { label: '接在目前 split 後', value: 'active', disabled: !ed.active },
                  { label: '套用到所有', value: 'all', disabled: !canAll },
                ]}
              />
              {draft.from === 'active' && ed.active && (
                <Text type="secondary" className="dp-hint">
                  每個新 split＝{ed.active.name} 的 {ed.active.ops.length} 步＋這個組合
                </Text>
              )}
              {fromAll && (
                <Text type="secondary" className="dp-hint">
                  不產生新 split：對每個現有 split 各加一步（只有一個組合時可用）
                </Text>
              )}
            </Row>
            <Row label="命名">
              <Input size="small" value={draft.nameTemplate} onChange={(e) => set({ nameTemplate: e.target.value })} placeholder={DEFAULT_NAME_TEMPLATE} aria-label="命名樣板" className="dp-mono" />
              <Text type="secondary" className="dp-hint">
                {firstName ? `第一個會叫「${firstName}」` : '—'} · 可用 <code>{'{id}'}</code> <code>{'{name}'}</code> <code>{'{value}'}</code> <code>{'{unit}'}</code> <code>{'{n}'}</code>
              </Text>
            </Row>
          </div>
        </Sec>
      )}

      {draft.factors.length > 0 && (
        <footer className={`dp-foot ${st(3)}`}>
          <div className="lab-sec-head">
            <span className="lab-sec-n" aria-hidden>
              4
            </span>
            <h3>產生</h3>
            <span className="lab-sec-meta">
              {fromAll ? '套用到現有 split' : draft.from === 'active' ? `接在 ${ed.active?.name ?? '目前'} 之後` : '從原始開始'} · 1 格 = {nm} nm
            </span>
          </div>
          {generating ? (
            <div className="dp-gen">
              <Progress percent={Math.round(((ed.genProgress!.done + 1) / ed.genProgress!.total) * 100)} size="small" format={() => `${ed.genProgress!.done + 1}／${ed.genProgress!.total}`} />
              <Button size="small" onClick={ed.cancelDesign}>
                取消（已產生的留著）
              </Button>
            </div>
          ) : (
            <Button
              type="primary"
              size="large"
              block
              className="dp-go"
              disabled={!design.factors.length || !combos.length || !!ed.busy || (fromAll && !canAll) || bad.length > 0 || !!dupId}
              onClick={generate}
            >
              {fromAll ? `套用到 ${ed.splits.length} 個 split` : bad.length ? `有 ${bad.length} 個組合無效` : `產生 ${combos.length} 個 split`}
            </Button>
          )}
        </footer>
      )}
    </div>
  );
}
