// 計算中的膠囊（plan v16）：文字＋進度條＋取消。進度來自 Worker 的 generator 請求（apply／chunks／layer），
// 「計算這一步」那一段沒有細進度（補平、推面是一整段純算），用跑馬燈；寫回、網格、選取層有百分比。
import { Button, Progress } from 'antd';
import { CloseOutlined } from '@ant-design/icons';
import type { Editor } from './editor';
import { progressWords, useProgress } from '../../ui/useProgress';
import { memoEd } from '../../ui/memoEd';

function BusyBarImpl({ ed }: { ed: Editor }) {
  const p = progressWords(useProgress());
  if (!ed.busy) return null;
  const queued = ed.queued;
  const main = ed.busy === '計算中…' ? (p?.text ?? '排隊中：等 Worker 做完前面的事（第一次改會先複製一份帳簿）…') : ed.busy;
  // 進度條：有百分比就畫到那裡；沒有就 active 跑馬燈（percent 給一個看得見的底）
  const percent = p?.percent ?? null;
  return (
    <div className="busy-bar" role="status" aria-live="polite">
      <span className="busy-dot" />
      <span className="busy-text">
        {main}
        {queued > 0 ? ` · 後面還排 ${queued} 步` : ''}
      </span>
      <Progress
        className="busy-progress"
        percent={percent ?? 100}
        status="active"
        showInfo={percent !== null}
        size={[120, 6]}
        strokeColor={percent === null ? 'rgba(22, 119, 255, .35)' : undefined}
        format={(v) => `${Math.round(v ?? 0)}%`}
      />
      <Button size="small" type="text" danger icon={<CloseOutlined />} onClick={ed.cancel} title="取消：清掉排隊的步驟；正在算的那一步在安全點停，已寫回的自動復原">
        取消
      </Button>
    </div>
  );
}

export const BusyBar = memoEd(BusyBarImpl, ['busy', 'queued', 'cancel'], 'BusyBar');
