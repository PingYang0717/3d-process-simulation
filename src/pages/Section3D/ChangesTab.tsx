import { Alert, Button, Empty, Flex, Popconfirm, Table, Typography } from 'antd';
import { DeleteOutlined } from '@ant-design/icons';
import { bboxDims, isVoid } from '../../volume/volume';
import { MatLabel, Swatch } from '../../ui/Swatch';
import { Section } from '../../ui/Stat';
import { signed } from '../../ui/format';
import type { Editor } from './editor';
import { matOf } from './Inspector';
import { memoEd } from '../../ui/memoEd';

const { Text } = Typography;

/** 右欄「改了哪些」：原始 → 現在；最底下「丟掉所有改動」（plan v10 D8）。 */
function ChangesTabImpl({ ed }: { ed: Editor }) {
  const total = ed.vol.data.length;
  const nm = ed.nmPerVoxel;
  const fromTo = (a: number, b: number) => `${a} → ${b}（${signed(b - a)} vx，${signed((b - a) * nm, 1)} nm）`;
  const changed = ed.comps
    .filter((c) => ed.changedKeys.has(c.key))
    .map((c) => {
      const o = ed.origByKey.get(c.key);
      const mat = matOf(ed, c.mat);
      const lines: string[] = [];
      if (!o) lines.push('原本沒有這塊（新出現）');
      else {
        if (o.mat !== c.mat) lines.push(`材質 ${ed.matName(o.mat)} → ${mat.name}`);
        const was = bboxDims(o.bbox);
        const now = bboxDims(c.bbox);
        if (was.h !== now.h) lines.push(`高 ${fromTo(was.h, now.h)}`);
        if (was.w !== now.w) lines.push(`寬 ${fromTo(was.w, now.w)}`);
        if (was.d !== now.d) lines.push(`深 ${fromTo(was.d, now.d)}`);
        if (was.y !== now.y && was.h === now.h)
          lines.push(`頂部 y ${was.y} → ${now.y}（往${now.y < was.y ? '上' : '下'} ${Math.abs(now.y - was.y)} vx）`);
        if (was.x !== now.x && was.w === now.w) lines.push(`x ${was.x} → ${now.x}`);
        if (was.z !== now.z && was.d === now.d) lines.push(`z ${was.z} → ${now.z}`);
        if (!lines.length) lines.push('局部形狀改了（外框尺寸沒變）');
        if (o.mat === c.mat && o.count === c.count) lines.push('體積與材質不變：被旁邊的結構推著走');
      }
      return { c, mat, lines, delta: c.count - (o?.count ?? 0) };
    });
  // 同材質、同樣改法的（例如 9 個 TiN 襯層全都「高 −1」）折成一列，清單才不會被襯層灌爆
  type Row = (typeof changed)[number];
  const groups: { key: string; rows: Row[] }[] = [];
  const byKey = new Map<string, Row[]>();
  changed.forEach((r) => {
    const k = `${r.c.mat}|${r.lines.join('|')}`;
    if (!byKey.has(k)) {
      byKey.set(k, []);
      groups.push({ key: k, rows: byKey.get(k)! });
    }
    byKey.get(k)!.push(r);
  });
  type Line = { kind: 'one'; r: Row } | { kind: 'many'; rows: Row[] };
  const rows = groups.flatMap<Line>((g) =>
    g.rows.length >= 3 ? [{ kind: 'many', rows: g.rows }] : g.rows.map((r): Line => ({ kind: 'one', r })),
  );
  const gone = ed.orig.L.comps.filter((c) => !ed.compByKey.has(c.key));
  const volumes = ed.ledger.filter((r) => r.before !== r.after);

  const warnings: string[] = [];
  const nowPer = new Map<number, number>();
  ed.comps.forEach((c) => nowPer.set(c.mat, (nowPer.get(c.mat) ?? 0) + 1));
  const wasPer = new Map<number, number>();
  ed.orig.L.comps.forEach((c) => wasPer.set(c.mat, (wasPer.get(c.mat) ?? 0) + 1));
  nowPer.forEach((n, mat) => {
    if (n > (wasPer.get(mat) ?? 0)) warnings.push(`${ed.matName(mat)} 被切成 ${n} 塊（原本 ${wasPer.get(mat) ?? 0} 塊）`);
  });
  if (gone.length) warnings.push(`${gone.map((c) => c.label).join('、')} 已經不存在`);

  if (!ed.diff.count)
    return <Empty style={{ paddingTop: 40 }} image={Empty.PRESENTED_IMAGE_SIMPLE} description="還沒有改動，匯出的陣列會和原始一模一樣" />;

  return (
    <Flex vertical gap={20}>
      <div className="stat-grid">
        <div className="stat">
          <div className="stat-label">改動體素</div>
          <div className="stat-value">{ed.diff.count.toLocaleString()}</div>
          <div className="stat-sub">佔全部 {((ed.diff.count / total) * 100).toFixed(2)}%</div>
        </div>
        <div className="stat">
          <div className="stat-label">改到的結構</div>
          <div className="stat-value">{changed.length}</div>
          <div className="stat-sub">輸出 shape 不變</div>
        </div>
      </div>
      {warnings.length ? (
        <Alert
          type="warning"
          showIcon
          message={
            <ul className="warn-list">
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          }
        />
      ) : (
        <Alert type="success" showIcon message="沒有結構被切斷或消失；沒碰到的體素一個都不變" />
      )}
      <Section title="改了哪些（原始 → 現在）">
        {rows.map((row) => {
          if (row.kind === 'one') {
            const { c, mat, lines, delta } = row.r;
            return (
              <button type="button" className="change-item" key={c.key} onClick={() => ed.selectKeys([c.key])}>
                <Swatch fill={mat.color} isVoid={isVoid(mat.id)} />
                <span className="change-name">
                  {c.label}
                  {lines.map((l, i) => (
                    <small key={i}>{l}</small>
                  ))}
                </span>
                <span className={'change-d' + (delta > 0 ? ' up' : delta < 0 ? ' dn' : '')} title="體積增減（voxel）">
                  {delta ? signed(delta) : '±0'}
                </span>
              </button>
            );
          }
          const first = row.rows[0];
          const total = row.rows.reduce((s, r) => s + r.delta, 0);
          return (
            <button type="button" className="change-item carried" key={`g-${first.c.key}`} onClick={() => ed.selectKeys(row.rows.map((r) => r.c.key))}>
              <Swatch fill={first.mat.color} isVoid={isVoid(first.mat.id)} />
              <span className="change-name">
                {first.mat.name} ×{row.rows.length}
                <small>{row.rows.map((r) => r.c.label.replace(first.mat.name, '').trim()).join('、')}；每個都一樣：</small>
                {first.lines.map((l, i) => (
                  <small key={i}>{l}</small>
                ))}
                <small>點一下全選這 {row.rows.length} 個。</small>
              </span>
              <span className={'change-d' + (total > 0 ? ' up' : total < 0 ? ' dn' : '')} title="體積增減合計（voxel）">
                {total ? signed(total) : '±0'}
              </span>
            </button>
          );
        })}
        <Text type="secondary" style={{ fontSize: 12 }}>
          右邊的數字是體積增減。3D 上方切到「原始」（鍵盤 B）可以前後對照；切面上紅框是改到的體素。
        </Text>
      </Section>
      {volumes.length > 0 && (
        <Section title="各材質體積（voxel）">
          <Table
            size="small"
            className="dim-table"
            pagination={false}
            dataSource={volumes.map((r) => ({ ...r, key: r.id }))}
            columns={[
              { title: '材質', key: 'name', render: (_, r) => <MatLabel mat={matOf(ed, r.id)} /> },
              { title: '原始', dataIndex: 'before', align: 'right', render: (v: number) => v.toLocaleString() },
              { title: '現在', dataIndex: 'after', align: 'right', render: (v: number) => v.toLocaleString() },
              {
                title: '增減',
                key: 'd',
                align: 'right',
                render: (_, r) => <span className={r.after > r.before ? 'up' : 'dn'}>{signed(r.after - r.before)}</span>,
              },
            ]}
          />
        </Section>
      )}
      <Text type="secondary" style={{ fontSize: 12 }}>
        匯出在右上角「匯出」。
      </Text>
      <Popconfirm
        title="丟掉這個 split 的所有改動？"
        description="回到和原始一模一樣，這個 split 的步驟也會清掉，不能復原。"
        okText="丟掉"
        okButtonProps={{ danger: true }}
        cancelText="取消"
        onConfirm={ed.resetAll}
      >
        <Button danger block icon={<DeleteOutlined />} disabled={!ed.diff.count || !!ed.busy}>
          丟掉所有改動
        </Button>
      </Popconfirm>
    </Flex>
  );
}

export const ChangesTab = memoEd(ChangesTabImpl, ['busy', 'changedKeys', 'compByKey', 'comps', 'diff', 'ledger', 'matName', 'materials', 'nmPerVoxel', 'orig', 'origByKey', 'resetAll', 'vol'], 'ChangesTab');
