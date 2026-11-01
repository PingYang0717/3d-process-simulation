import { type MouseEvent, memo, useMemo, useState } from 'react';
import { Button, ColorPicker, Dropdown, Input, Tooltip, Typography } from 'antd';
import { EditOutlined, EyeInvisibleOutlined, EyeOutlined, RightOutlined } from '@ant-design/icons';
import { type Comp, type Material, type MaterialKind, isVoid, kindOf } from '../../volume/volume';
import { Swatch } from '../../ui/Swatch';
import { memoEd } from '../../ui/memoEd';
import { useEvent } from '../../ui/useEvent';
import { type Editor, type SelectMode, selectModeOf } from './editor';

const { Text } = Typography;
/** 材質類別的中文名（plan v11 §4.10）。 */
const KIND_NAME: Record<MaterialKind, string> = { semi: '半導體', diel: '介電', metal: '金屬', void: '空洞', other: '其他' };
const labelNumber = (l: string) => parseInt(l.split(' ').pop() ?? '0', 10) || 0;

/** 一列結構（plan v15 B2）：props 只有原始值與穩定 callback，選取、每一步只有變到的列重 render。 */
const StructRow = memo(function StructRow({
  k,
  label,
  count,
  selected,
  changed,
  onSelect,
}: {
  k: string;
  label: string;
  count: number;
  selected: boolean;
  changed: boolean;
  onSelect: (key: string, mode: SelectMode) => void;
}) {
  return (
    <button type="button" className={'item' + (selected ? ' on' : '')} onClick={(e) => onSelect(k, selectModeOf(e))}>
      <span className="item-name">{label}</span>
      {changed && <span className="chg-dot" title="和原始不同" aria-label="已改" />}
      <Text type="secondary" style={{ fontSize: 11 }}>
        {count.toLocaleString()}
      </Text>
    </button>
  );
});

interface GroupActs {
  onSelectKeys: (keys: string[], mode: SelectMode) => void;
  onSelectOne: (key: string, mode: SelectMode) => void;
  onColor: (id: number, hex: string) => void;
  onRename: (id: number, name: string) => void;
  onKind: (id: number, kind: MaterialKind) => void;
  onToggleHidden: (id: number) => void;
  onToggleOpen: (id: number) => void;
  onEdit: (id: number | null) => void;
}

/**
 * 一個材質群組：標題列＋展開的列。props 是原始值（選取、已改用群組內的 key 簽名）與穩定 callback，
 * 選取變了只有牽涉到的群組重 render。Tooltip／ColorPicker／Dropdown 只在群組展開（或滑過標題列）時掛，收合的大群組不付 antd 的成本。
 */
const StructGroup = memo(function StructGroup({
  mat,
  regions,
  selSig,
  chgSig,
  hid,
  open,
  editing,
  acts,
}: {
  mat: Material;
  regions: Comp[];
  /** 群組裡已選的 key（排序、逗號相接）。 */
  selSig: string;
  /** 群組裡和原始不同的 key。 */
  chgSig: string;
  hid: boolean;
  open: boolean;
  editing: boolean;
  acts: GroupActs;
}) {
  const [hot, setHot] = useState(false);
  const selSet = useMemo(() => new Set(selSig ? selSig.split(',') : []), [selSig]);
  const chgSet = useMemo(() => new Set(chgSig ? chgSig.split(',') : []), [chgSig]);
  const all = regions.length > 0 && selSet.size === regions.length;
  const some = selSet.size > 0;
  const only = regions.length === 1 ? regions[0] : null;
  const expanded = open || regions.length <= 3;
  const live = expanded || hot;
  const changed = chgSet.size;
  const swatch = isVoid(mat.id) ? <Swatch fill={mat.color} isVoid /> : <Swatch fill={mat.color} size={14} />;
  const kindBtn = (
    <Button type="text" size="small" className="kind-btn" aria-label="材質類別">
      {KIND_NAME[kindOf(mat)].slice(0, 2)}
    </Button>
  );
  return (
    <div className={'group' + (hid ? ' hid' : '')}>
      <div className={'group-head' + (all ? ' on' : some ? ' some' : '')} onPointerEnter={() => setHot(true)} onPointerLeave={() => setHot(false)}>
        {!only && regions.length > 3 ? (
          <Button type="text" size="small" className="group-caret" icon={<RightOutlined rotate={expanded ? 90 : 0} />} onClick={() => acts.onToggleOpen(mat.id)} aria-label="展開" />
        ) : (
          <span className="group-caret" />
        )}
        {isVoid(mat.id) ? (
          swatch
        ) : live ? (
          <Tooltip title="改顏色">
            <ColorPicker size="small" value={mat.color} disabledAlpha onChangeComplete={(c) => acts.onColor(mat.id, c.toHexString())}>
              <span className="swatch-hit">{swatch}</span>
            </ColorPicker>
          </Tooltip>
        ) : (
          <span className="swatch-hit">{swatch}</span>
        )}
        {editing ? (
          <Input
            size="small"
            autoFocus
            defaultValue={mat.name}
            onBlur={(e) => {
              acts.onRename(mat.id, e.target.value.trim());
              acts.onEdit(null);
            }}
            onPressEnter={(e) => e.currentTarget.blur()}
            onKeyDown={(e) => e.key === 'Escape' && acts.onEdit(null)}
            style={{ flex: 1 }}
          />
        ) : (
          <button
            type="button"
            className="group-name"
            onClick={(e: MouseEvent) =>
              acts.onSelectKeys(
                regions.map((c) => c.key),
                selectModeOf(e),
              )
            }
            onDoubleClick={() => acts.onEdit(mat.id)}
            title={(only ? '選取' : '選取這個材質的全部結構') + '；雙擊改名'}
          >
            {mat.name}
          </button>
        )}
        {changed > 0 &&
          (live ? (
            <Tooltip title={only ? '和原始不同' : `已改 ${changed} 塊`}>
              <span className="chg-dot" aria-label="已改" />
            </Tooltip>
          ) : (
            <span className="chg-dot" aria-label="已改" title={only ? '和原始不同' : `已改 ${changed} 塊`} />
          ))}
        {!only && <span className="group-count">×{regions.length}</span>}
        <span className="group-acts">
          {!isVoid(mat.id) &&
            (live ? (
              <Dropdown
                trigger={['click']}
                menu={{
                  selectable: true,
                  selectedKeys: [kindOf(mat)],
                  items: (Object.keys(KIND_NAME) as MaterialKind[]).map((k) => ({ key: k, label: KIND_NAME[k] })),
                  onClick: ({ key }) => acts.onKind(mat.id, key as MaterialKind),
                }}
              >
                <Tooltip title="材質類別（換材質時「合理」清單用）">{kindBtn}</Tooltip>
              </Dropdown>
            ) : (
              kindBtn
            ))}
          {live ? (
            <Tooltip title="改名稱">
              <Button type="text" size="small" icon={<EditOutlined />} onClick={() => acts.onEdit(mat.id)} aria-label="改名稱" />
            </Tooltip>
          ) : (
            <Button type="text" size="small" icon={<EditOutlined />} onClick={() => acts.onEdit(mat.id)} aria-label="改名稱" />
          )}
          {live ? (
            <Tooltip title={hid ? '顯示' : '隱藏（看裡面用）'}>
              <Button type="text" size="small" className={hid ? 'show' : ''} icon={hid ? <EyeInvisibleOutlined /> : <EyeOutlined />} onClick={() => acts.onToggleHidden(mat.id)} aria-label="顯示／隱藏" />
            </Tooltip>
          ) : (
            <Button type="text" size="small" className={hid ? 'show' : ''} icon={hid ? <EyeInvisibleOutlined /> : <EyeOutlined />} onClick={() => acts.onToggleHidden(mat.id)} aria-label="顯示／隱藏" />
          )}
        </span>
      </div>
      {!only && expanded && regions.map((c) => <StructRow key={c.key} k={c.key} label={c.label} count={c.count} selected={selSet.has(c.key)} changed={chgSet.has(c.key)} onSelect={acts.onSelectOne} />)}
    </div>
  );
});

/** 左欄的內容（memoEd）：依材質分組；點材質名選整組；點色塊改色、雙擊改名；> 3 塊的材質預設收合。 */
function StructureListBody({ ed }: { ed: Editor }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<number | null>(null);
  const groups = useMemo(() => {
    const byMat = new Map<number, Comp[]>();
    ed.comps.forEach((c) => {
      if (!byMat.has(c.mat)) byMat.set(c.mat, []);
      byMat.get(c.mat)!.push(c);
    });
    return ed.materials
      .filter((m) => byMat.has(m.id))
      .map((m) => ({ mat: m, regions: [...byMat.get(m.id)!].sort((a, b) => labelNumber(a.label) - labelNumber(b.label)) }));
  }, [ed.comps, ed.materials]);
  // 群組的 callback 身分不變（ed 的 handler 已是 useEvent；這裡再包一層是為了 setOpen／setEditing）
  const acts = useMemo<GroupActs>(
    () => ({
      onSelectKeys: (keys, mode) => ed.selectKeys(keys, mode),
      onSelectOne: (key, mode) => ed.selectKeys([key], mode),
      onColor: (id, hex) => ed.setMaterialColor(id, hex),
      onRename: (id, name) => ed.renameMaterial(id, name),
      onKind: (id, kind) => ed.setMaterialKind(id, kind),
      onToggleHidden: (id) => ed.toggleHidden(id),
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
  const { sel, hidden, changedKeys } = ed;
  const sigOf = (regions: Comp[], set: Set<string>) => regions.filter((c) => set.has(c.key)).map((c) => c.key).join(',');

  return (
    <>
      <div className="sider-head">
        <Text strong>結構</Text>
        {sel.size > 0 ? (
          <Button type="link" size="small" onClick={clearSel} style={{ padding: 0 }}>
            清除選取（{sel.size}）
          </Button>
        ) : (
          <Text type="secondary" style={{ fontSize: 12 }}>
            點色塊改色、雙擊改名
          </Text>
        )}
      </div>
      <div className="sider-body">
        {groups.map(({ mat, regions }) => (
          <StructGroup key={mat.id} mat={mat} regions={regions} selSig={sigOf(regions, sel)} chgSig={sigOf(regions, changedKeys)} hid={hidden.has(mat.id)} open={open.has(mat.id)} editing={editing === mat.id} acts={acts} />
        ))}
      </div>
      <div className="sider-foot">
        <span>
          {ed.vol.X}×{ed.vol.Y}×{ed.vol.Z} voxels · 1 vx = {ed.nmPerVoxel} nm
        </span>
      </div>
    </>
  );
}

const StructureListMemo = memoEd(StructureListBody, ['comps', 'materials', 'sel', 'hidden', 'changedKeys', 'vol', 'nmPerVoxel'], 'StructureList');

/** 左欄：寬度在外層（拖欄寬時只有這個 aside 重 render，清單本身 memo）。 */
export function StructureList({ ed, width }: { ed: Editor; width: number }) {
  return (
    <aside className="sider" style={{ width }}>
      <StructureListMemo ed={ed} />
    </aside>
  );
}
