import { memo, useMemo, useRef, useState } from 'react';
import { Button, ColorPicker, Input, Tooltip, Typography } from 'antd';
import { DoubleLeftOutlined, EyeInvisibleOutlined, EyeOutlined, RightOutlined } from '@ant-design/icons';
import { type Comp, type Material, isVoid } from '../../volume/volume';
import { LockIcon, type OpenCtx } from './LockUi';
import { Swatch } from '../../ui/Swatch';
import { memoEd } from '../../ui/memoEd';
import { useEvent } from '../../ui/useEvent';
import { type Editor, type SelectMode, selectModeOf } from './editor';

const { Text } = Typography;
const labelNumber = (l: string) => parseInt(l.split(' ').pop() ?? '0', 10) || 0;

/** 一列結構：點一下選取（Shift／Ctrl＋點＝多選同材質）；右鍵＝固定／解除固定；已固定的列尾有鎖。 */
const StructRow = memo(function StructRow({ k, label, count, selected, locked, acts }: { k: string; label: string; count: number; selected: boolean; locked: boolean; acts: GroupActs }) {
  return (
    <button type="button" className={'item' + (selected ? ' on' : '') + (locked ? ' lock' : '')} onClick={(e) => acts.onSelectOne(k, selectModeOf(e))} onContextMenu={(e) => (e.preventDefault(), acts.onCtx([k], e.clientX, e.clientY))}>
      <span className="item-name">{label}</span>
      <Text type="secondary" style={{ fontSize: 11 }}>
        {count.toLocaleString()}
      </Text>
      <span className={'lk' + (locked ? ' on' : '')} role="button" title={locked ? `解除固定 ${label}` : `固定 ${label}`} onClick={(e) => (e.stopPropagation(), acts.onLock([k], locked))}>
        <LockIcon on={locked} />
      </span>
    </button>
  );
});

interface GroupActs {
  onSelectOne: (key: string, mode: SelectMode) => void;
  onColor: (id: number, hex: string) => void;
  onRename: (id: number, name: string) => void;
  onToggleHidden: (id: number) => void;
  /** 固定／解除固定（locked＝目前全部都固定了 → 解除）。 */
  onLock: (keys: string[], locked: boolean) => void;
  onCtx: OpenCtx;
  onToggleOpen: (id: number) => void;
  onEdit: (id: number | null) => void;
}

/**
 * 一個材質（plan v17 §5.2 R8）：整列點一下＝在 3D 顯示／隱藏，列尾眼睛常駐；隱藏的整組變灰。
 * 改名＝雙擊名字、改色＝點色塊；列尾的鎖＝整個材質固定／解除。結構一列一個，點一下選取、右鍵固定。
 */
const StructGroup = memo(function StructGroup({ mat, regions, selSig, lockSig, hid, open, editing, acts }: { mat: Material; regions: Comp[]; selSig: string; lockSig: string; hid: boolean; open: boolean; editing: boolean; acts: GroupActs }) {
  const selSet = useMemo(() => new Set(selSig ? selSig.split(',') : []), [selSig]);
  const lockSet = useMemo(() => new Set(lockSig ? lockSig.split(',') : []), [lockSig]);
  const keys = regions.map((c) => c.key);
  const allLocked = lockSet.size === regions.length;
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
        onContextMenu={(e) => (e.preventDefault(), acts.onCtx(keys, e.clientX, e.clientY))}
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
        <span className="group-count">×{regions.length}</span>
        <span className="group-eye" aria-hidden>
          {hid ? <EyeInvisibleOutlined /> : <EyeOutlined />}
        </span>
        {!isVoid(mat.id) && (
          <span className={'lk' + (allLocked ? ' on' : lockSet.size ? ' part' : '')} role="button" title={allLocked ? `解除固定全部 ${mat.name}` : `固定全部 ${mat.name}`} onClick={(e) => (stop(e), acts.onLock(keys, allLocked))}>
            <LockIcon on={lockSet.size > 0} />
          </span>
        )}
      </div>
      {expanded && regions.map((c) => <StructRow key={c.key} k={c.key} label={c.label} count={c.count} selected={selSet.has(c.key)} locked={lockSet.has(c.key)} acts={acts} />)}
    </div>
  );
});

/** 左欄的內容：依材質分組。 */
function StructureListBody({ ed, onCtx }: { ed: Editor; onCtx: OpenCtx }) {
  const ctx = useEvent(onCtx);
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
  const edRef = useRef(ed);
  edRef.current = ed;
  const acts = useMemo<GroupActs>(
    () => ({
      onSelectOne: (key, mode) => ed.selectFromList(key, mode),
      onColor: (id, hex) => ed.setMaterialColor(id, hex),
      onRename: (id, name) => ed.renameMaterial(id, name),
      onToggleHidden: (id) => ed.toggleHidden(id),
      onLock: (keys, locked) => edRef.current.setLock(keys, locked ? null : edRef.current.lastKeep),
      onCtx: ctx,
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
  const lockSigOf = (regions: Comp[]) => regions.filter((c) => ed.lockMap.has(c.key)).map((c) => c.key).join(',');
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
          <StructGroup key={mat.id} mat={mat} regions={regions} selSig={sigOf(regions)} lockSig={lockSigOf(regions)} hid={hidden.has(mat.id)} open={open.has(mat.id)} editing={editing === mat.id} acts={acts} />
        ))}
      </div>
      <div className="sider-foot">
        <span>{ed.selComps.length ? `已選 ${ed.selName}` : `${ed.vol.X}×${ed.vol.Y}×${ed.vol.Z} 格 · 1 格 = ${ed.nmPerVoxel} nm`}</span>
      </div>
    </>
  );
}

const StructureListMemo = memoEd(StructureListBody, ['comps', 'materials', 'sel', 'hidden', 'vol', 'nmPerVoxel', 'selComps', 'selName', 'lockMap'], 'StructureList');

/** 左欄。 */
export function StructureList({ ed, width, onCollapse, onCtx }: { ed: Editor; width: number; onCollapse?: () => void; onCtx: OpenCtx }) {
  return (
    <aside className={'sider' + (onCollapse ? ' can-fold' : '')} style={{ width }}>
      {onCollapse && (
        <Tooltip title="收合結構清單" placement="right">
          <Button type="text" size="small" className="fold" icon={<DoubleLeftOutlined />} onClick={onCollapse} aria-label="收合結構清單" />
        </Tooltip>
      )}
      <StructureListMemo ed={ed} onCtx={onCtx} />
    </aside>
  );
}
