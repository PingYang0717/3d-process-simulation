import { memo, useMemo, useState } from 'react';
import { Button, ColorPicker, Input, Tooltip, Typography } from 'antd';
import { EyeInvisibleOutlined, EyeOutlined, RightOutlined } from '@ant-design/icons';
import { type Comp, type Material, isVoid } from '../../volume/volume';
import { Swatch } from '../../ui/Swatch';
import { memoEd } from '../../ui/memoEd';
import { useEvent } from '../../ui/useEvent';
import { type Editor, type SelectMode, selectModeOf } from './editor';

const { Text } = Typography;
const labelNumber = (l: string) => parseInt(l.split(' ').pop() ?? '0', 10) || 0;

/** 一列結構：點一下選取（Shift／Ctrl＋點＝多選同材質）。 */
const StructRow = memo(function StructRow({ k, label, count, selected, onSelect }: { k: string; label: string; count: number; selected: boolean; onSelect: (key: string, mode: SelectMode) => void }) {
  return (
    <button type="button" className={'item' + (selected ? ' on' : '')} onClick={(e) => onSelect(k, selectModeOf(e))}>
      <span className="item-name">{label}</span>
      <Text type="secondary" style={{ fontSize: 11 }}>
        {count.toLocaleString()}
      </Text>
    </button>
  );
});

interface GroupActs {
  onSelectOne: (key: string, mode: SelectMode) => void;
  onColor: (id: number, hex: string) => void;
  onRename: (id: number, name: string) => void;
  onToggleHidden: (id: number) => void;
  onToggleLiner: (id: number) => void;
  onToggleOpen: (id: number) => void;
  onEdit: (id: number | null) => void;
}

/**
 * 一個材質（plan v17 §5.2 R8）：整列點一下＝在 3D 顯示／隱藏，列尾眼睛常駐；隱藏的整組變灰。
 * 改名＝雙擊名字、改色＝點色塊；薄層材質的名字後面有「薄層」標記，點它切換。結構一列一個，點一下選取。
 */
const StructGroup = memo(function StructGroup({ mat, regions, selSig, hid, open, editing, acts }: { mat: Material; regions: Comp[]; selSig: string; hid: boolean; open: boolean; editing: boolean; acts: GroupActs }) {
  const selSet = useMemo(() => new Set(selSig ? selSig.split(',') : []), [selSig]);
  const expanded = open || regions.length <= 3;
  const swatch = isVoid(mat.id) ? <Swatch fill={mat.color} isVoid /> : <Swatch fill={mat.color} size={14} />;
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  return (
    <div className={'group' + (hid ? ' hid' : '')} data-mat={mat.id}>
      <div
        className={'group-head toggle' + (selSet.size ? ' some' : '')}
        role="button"
        tabIndex={0}
        title={hid ? '點一下在 3D 顯示' : '點一下在 3D 隱藏'}
        aria-pressed={!hid}
        onClick={() => acts.onToggleHidden(mat.id)}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), acts.onToggleHidden(mat.id))}
      >
        {regions.length > 3 ? (
          <Button type="text" size="small" className="group-caret" icon={<RightOutlined rotate={expanded ? 90 : 0} />} onClick={(e) => (stop(e), acts.onToggleOpen(mat.id))} aria-label="展開" />
        ) : (
          <span className="group-caret" />
        )}
        {isVoid(mat.id) ? (
          swatch
        ) : (
          <span onClick={stop}>
            <ColorPicker size="small" value={mat.color} disabledAlpha onChangeComplete={(c) => acts.onColor(mat.id, c.toHexString())}>
              <span className="swatch-hit" title="改顏色">
                {swatch}
              </span>
            </ColorPicker>
          </span>
        )}
        {editing ? (
          <Input
            size="small"
            autoFocus
            defaultValue={mat.name}
            onClick={stop}
            onBlur={(e) => {
              acts.onRename(mat.id, e.target.value.trim());
              acts.onEdit(null);
            }}
            onPressEnter={(e) => e.currentTarget.blur()}
            onKeyDown={(e) => (e.stopPropagation(), e.key === 'Escape' && acts.onEdit(null))}
            style={{ flex: 1 }}
          />
        ) : (
          <span className="group-name" onDoubleClick={(e) => (stop(e), acts.onEdit(mat.id))} title="雙擊改名">
            {mat.name}
          </span>
        )}
        {!isVoid(mat.id) && (
          <Tooltip title={mat.liner ? '薄層：推旁邊的結構時會跟著移動。點一下改成不是薄層' : '不是薄層。點一下改成薄層（推旁邊的結構時會跟著移動）'}>
            <button type="button" className={'liner-tag' + (mat.liner ? ' on' : '')} onClick={(e) => (stop(e), acts.onToggleLiner(mat.id))} aria-pressed={!!mat.liner}>
              薄層
            </button>
          </Tooltip>
        )}
        <span className="group-count">×{regions.length}</span>
        <span className="group-eye" aria-hidden>
          {hid ? <EyeInvisibleOutlined /> : <EyeOutlined />}
        </span>
      </div>
      {expanded && regions.map((c) => <StructRow key={c.key} k={c.key} label={c.label} count={c.count} selected={selSet.has(c.key)} onSelect={acts.onSelectOne} />)}
    </div>
  );
});

/** 左欄的內容：依材質分組。 */
function StructureListBody({ ed }: { ed: Editor }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<number | null>(null);
  const groups = useMemo(() => {
    const byMat = new Map<number, Comp[]>();
    ed.comps.forEach((c) => {
      if (!byMat.has(c.mat)) byMat.set(c.mat, []);
      byMat.get(c.mat)!.push(c);
    });
    return ed.materials.filter((m) => byMat.has(m.id)).map((m) => ({ mat: m, regions: [...byMat.get(m.id)!].sort((a, b) => labelNumber(a.label) - labelNumber(b.label)) }));
  }, [ed.comps, ed.materials]);
  const acts = useMemo<GroupActs>(
    () => ({
      onSelectOne: (key, mode) => ed.selectFromList(key, mode),
      onColor: (id, hex) => ed.setMaterialColor(id, hex),
      onRename: (id, name) => ed.renameMaterial(id, name),
      onToggleHidden: (id) => ed.toggleHidden(id),
      onToggleLiner: (id) => ed.toggleLiner(id),
      onToggleOpen: (id) =>
        setOpen((p) => {
          const n = new Set(p);
          if (n.has(id)) n.delete(id);
          else n.add(id);
          return n;
        }),
      onEdit: (id) => setEditing(id),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const clearSel = useEvent(() => ed.clearSel());
  const { sel, hidden } = ed;
  const sigOf = (regions: Comp[]) => regions.filter((c) => sel.has(c.key)).map((c) => c.key).join(',');
  return (
    <>
      <div className="sider-head">
        <Text strong>結構</Text>
        {sel.size > 0 ? (
          <Button type="link" size="small" onClick={clearSel} style={{ padding: 0 }}>
            取消選取（{sel.size}）
          </Button>
        ) : (
          <Text type="secondary" style={{ fontSize: 12 }}>
            點材質＝顯示／隱藏
          </Text>
        )}
      </div>
      <div className="sider-body">
        {groups.map(({ mat, regions }) => (
          <StructGroup key={mat.id} mat={mat} regions={regions} selSig={sigOf(regions)} hid={hidden.has(mat.id)} open={open.has(mat.id)} editing={editing === mat.id} acts={acts} />
        ))}
      </div>
      <div className="sider-foot">
        <span>{ed.selComps.length ? `已選 ${ed.selName}` : `${ed.vol.X}×${ed.vol.Y}×${ed.vol.Z} 格 · 1 格 = ${ed.nmPerVoxel} nm`}</span>
      </div>
    </>
  );
}

const StructureListMemo = memoEd(StructureListBody, ['comps', 'materials', 'sel', 'hidden', 'vol', 'nmPerVoxel', 'selComps', 'selName'], 'StructureList');

/** 左欄。 */
export function StructureList({ ed, width }: { ed: Editor; width: number }) {
  return (
    <aside className="sider" style={{ width }}>
      <StructureListMemo ed={ed} />
    </aside>
  );
}
