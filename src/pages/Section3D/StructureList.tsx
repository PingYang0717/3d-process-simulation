import { useMemo, useState } from 'react';
import { Button, ColorPicker, Input, Tooltip, Typography } from 'antd';
import { EditOutlined, EyeInvisibleOutlined, EyeOutlined, RightOutlined } from '@ant-design/icons';
import { type Comp, isVoid } from '../../volume/volume';
import { Swatch } from '../../ui/Swatch';
import { type Editor, selectModeOf } from './editor';

const { Text } = Typography;
const labelNumber = (l: string) => parseInt(l.split(' ').pop() ?? '0', 10) || 0;

/** 左欄：依材質分組；點材質名選整組；點色塊改色、雙擊改名；> 3 塊的材質預設收合。 */
export function StructureList({ ed, width }: { ed: Editor; width: number }) {
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

  return (
    <aside className="sider" style={{ width }}>
      <div className="sider-head">
        <Text strong>結構</Text>
        {ed.sel.size > 0 ? (
          <Button type="link" size="small" onClick={ed.clearSel} style={{ padding: 0 }}>
            清除選取（{ed.sel.size}）
          </Button>
        ) : (
          <Text type="secondary" style={{ fontSize: 12 }}>
            點色塊改色、雙擊改名
          </Text>
        )}
      </div>
      <div className="sider-body">
        {groups.map(({ mat, regions }) => {
          const all = regions.every((c) => ed.sel.has(c.key));
          const some = regions.some((c) => ed.sel.has(c.key));
          const only = regions.length === 1 ? regions[0] : null;
          const hid = ed.hidden.has(mat.id);
          const expanded = open.has(mat.id) || regions.length <= 3;
          const changed = regions.filter((c) => ed.changedKeys.has(c.key)).length;
          return (
            <div key={mat.id} className={'group' + (hid ? ' hid' : '')}>
              <div className={'group-head' + (all ? ' on' : some ? ' some' : '')}>
                {!only && regions.length > 3 ? (
                  <Button
                    type="text"
                    size="small"
                    className="group-caret"
                    icon={<RightOutlined rotate={expanded ? 90 : 0} />}
                    onClick={() =>
                      setOpen((p) => {
                        const n = new Set(p);
                        if (n.has(mat.id)) n.delete(mat.id);
                        else n.add(mat.id);
                        return n;
                      })
                    }
                    aria-label="展開"
                  />
                ) : (
                  <span className="group-caret" />
                )}
                {isVoid(mat.id) ? (
                  <Swatch fill={mat.color} isVoid />
                ) : (
                  <Tooltip title="改顏色">
                    <ColorPicker
                      size="small"
                      value={mat.color}
                      disabledAlpha
                      onChangeComplete={(c) => ed.setMaterialColor(mat.id, c.toHexString())}
                    >
                      <span className="swatch-hit">
                        <Swatch fill={mat.color} size={14} />
                      </span>
                    </ColorPicker>
                  </Tooltip>
                )}
                {editing === mat.id ? (
                  <Input
                    size="small"
                    autoFocus
                    defaultValue={mat.name}
                    onBlur={(e) => {
                      ed.renameMaterial(mat.id, e.target.value.trim());
                      setEditing(null);
                    }}
                    onPressEnter={(e) => e.currentTarget.blur()}
                    onKeyDown={(e) => e.key === 'Escape' && setEditing(null)}
                    style={{ flex: 1 }}
                  />
                ) : (
                  <button
                    type="button"
                    className="group-name"
                    onClick={(e) => ed.selectKeys(regions.map((c) => c.key), selectModeOf(e))}
                    onDoubleClick={() => setEditing(mat.id)}
                    title={(only ? '選取' : '選取這個材質的全部結構') + '；雙擊改名'}
                  >
                    {mat.name}
                  </button>
                )}
                {changed > 0 && (
                  <Tooltip title={only ? '和原始不同' : `已改 ${changed} 塊`}>
                    <span className="chg-dot" aria-label="已改" />
                  </Tooltip>
                )}
                {!only && <span className="group-count">×{regions.length}</span>}
                <span className="group-acts">
                  <Tooltip title="改名稱">
                    <Button type="text" size="small" icon={<EditOutlined />} onClick={() => setEditing(mat.id)} aria-label="改名稱" />
                  </Tooltip>
                  <Tooltip title={hid ? '顯示' : '隱藏（看裡面用）'}>
                    <Button
                      type="text"
                      size="small"
                      className={hid ? 'show' : ''}
                      icon={hid ? <EyeInvisibleOutlined /> : <EyeOutlined />}
                      onClick={() => ed.toggleHidden(mat.id)}
                      aria-label="顯示／隱藏"
                    />
                  </Tooltip>
                </span>
              </div>
              {!only &&
                expanded &&
                regions.map((c) => (
                  <button
                    type="button"
                    key={c.key}
                    className={'item' + (ed.sel.has(c.key) ? ' on' : '')}
                    onClick={(e) => ed.selectKeys([c.key], selectModeOf(e))}
                  >
                    <span className="item-name">{c.label}</span>
                    {ed.changedKeys.has(c.key) && <span className="chg-dot" title="和原始不同" aria-label="已改" />}
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      {c.count.toLocaleString()}
                    </Text>
                  </button>
                ))}
            </div>
          );
        })}
      </div>
      <div className="sider-foot">
        <span>
          {ed.vol.X}×{ed.vol.Y}×{ed.vol.Z} voxels · 1 vx = {ed.nmPerVoxel} nm
        </span>
      </div>
    </aside>
  );
}
