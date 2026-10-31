# 計畫 v9：效能——每本帳簿只有一份、每一步只碰改到的地方、拖拉不卡主執行緒

> 位置：`docs/plan-v9-performance.md`，分支 `claude/upbeat-einstein-wod16i`，接在 plan v8 M5～M8 之後。
> 出發點：2026-10-31 對 2D／3D 運算的全面審視（下方 §1 是問題總表）。目標是**一次把所有找到的效能問題處理完**，
> 之後不再有「每次都還有要改的地方」：每一條問題都對應到一個里程碑、一個檔案清單、一條驗收，§6 另有必查名單避免漏網。

---

## 目錄

0. 一句話
1. 問題總表（審視結果 → 編號）
2. 目標與量法
3. 原則、不做的事
4. 設計
   - 4.1 單本帳簿：主執行緒
   - 4.2 單本帳簿：Worker 協定
   - 4.3 原地 relabel
   - 4.4 diff 與體積帳在主執行緒差量更新
   - 4.5 拖拉第 2 級預覽搬到 Worker、每片輪廓快取
   - 4.6 圖層 chunk 化、chunk 快取搬到主執行緒、BVH 懶建
   - 4.7 畫面層：不重 render、不重畫
   - 4.8 微觀與載入
5. 每個檔案要改什麼
6. 必查名單（避免漏網）
7. 測試清單
8. 里程碑、工作拆解、驗收
9. 風險與對策
10. 決策記錄

---

## 0. 一句話

同一個 split 的體素與結構編號在主執行緒和 Worker 各只有**一份**，每一步原地貼補丁、復原貼回「改前」，不再整個陣列影印；
diff 與體積帳在主執行緒自己差量更新，不再每步跟 Worker 要整份；拖拉時「整根跟著動」的第 2 級預覽搬到 Worker 做、
每片輪廓只描一次；藍色選取層與 VOID 層也切 chunk 只重算髒的；BVH 等滑鼠真的點到才建；畫面層不因為滑鼠移動重 render 整頁。

## 1. 問題總表（審視結果 → 編號）

名詞：**主執行緒**＝瀏覽器畫面那條線（React、three.js、canvas、事件），**Worker**＝`src/volume/worker.ts` 那條獨立計算線；
兩邊記憶體不共用，資料要過 `postMessage`（複製或 transfer）。N＝體素數（範例 ×1 2.0M、×2 15.7M、×3 53M）。

| # | 問題 | 在哪 | 影響 | 里程碑 |
| --- | --- | --- | --- | --- |
| P1 | 每一步做 6 次整個陣列複製：Worker `data.slice()`、`relabelFast` 的 `P.slice()`（4N）、`carryStats` 的 `mask.slice()`、`diff` handler 的 `mask.slice()`；主執行緒 `applyStep` 的 `data.slice()`＋`labels.slice()`（4N） | `apply.ts:44`、`volume.ts:1029`、`worker.ts:108,382`、`patch.ts:84,89` | ×3 光 memcpy ≈ 1.6 s／步；Worker 常駐 orig＋from＋to 三份 | M9.1 |
| P2 | 主執行緒 `diffCache` 以版本號為 key，`pruneCaches` 把 hist／future 裡的版本都算活的 → 最多留 50 份 N 位元組的 mask | `editor.ts:129–144,291–303` | ×2 50 步 ≈ 785 MB；×3 2.6 GB | M9.1 |
| P3 | 拖拉第 2 級預覽（整個 scope）每幀在 rAF 裡跑：profile 帶 gestures 時**每片重新 `traceRings`**，再對整個預覽盒做主執行緒 `greedyMesh`；`bench.ts drag` 只量第 1 級 | `index.tsx:282`、`profile.ts:90–101`、`relative.ts:96`、`views.tsx:870–930` | 一幀 100–200 ms，拖拉掉到個位數 fps；沒有數字 | M9.2 |
| P4 | 選取層每一步在整個「選取外框 ∩ scope」裡重做 greedy mesh，沒有快取；選到基板＝每步一次全陣列 greedy mesh | `views.tsx:957–980`、`worker.ts:323–341` | ×2 每步多 ~0.9 s，排在主網格後面 | M9.3 |
| P5 | 每個 chunk 的 `MeshBVH` 在主執行緒同步建 | `views.tsx:236,786` | 整個網格換掉時卡一段（×2 480 chunk） | M9.3 |
| P6 | Worker chunk 快取每次 serve 都 `.slice()` 三個陣列再 transfer；4 組快取 | `worker.ts:290–294` | 全量回傳時整個網格再複製一遍、記憶體兩倍 | M9.3 |
| P7 | 主切面 pointermove → `onHover` 新陣列 → `setSliceHover` → 整個 `Section3DPage` 重 render；`View3D` 的 `useEffect(kick)` 沒有依賴再多畫兩幀；`SliceEditor` 自己 `setHoverUV`／`setHover` 每 move 重 render、render 裡重算所有環的 `pathOf` 字串 | `index.tsx:167,598`、`views.tsx:435`、`SliceEditor.tsx:661–667,790–802` | 每次滑鼠移動一次整頁 render | M9.4 |
| P8 | 被擋格子用 React `<rect>` 逐格畫，`blockedLive` 依賴 `preview`，拖拉中每幀 reconcile 最多 4000 個 | `SliceEditor.tsx:596–626,783–785,806–808` | 拖拉中每幀數千 DOM 節點 | M9.4 |
| P9 | 剖面貼圖 effect 依賴 `preview`：拖拉每幀整張 `drawSlice`＋`new CanvasTexture`＋`new PlaneGeometry`＋`new EdgesGeometry`；兩張小切面 `SliceView` 收到 `preview` 也整張重畫 | `views.tsx:992–1031,1664–1666` | 每幀 3 張整片重畫＋貼圖上傳 | M9.4 |
| P10 | 點一下選取三次全陣列掃描：`maskOf`、`maskInScope`（`scopeMode='slice'` 時每次換片都做）、`slicesWith` | `volume.ts:1202`、`editor.ts:31,51,249,287`、`index.tsx:313,324,335` | ×3 一次點選 100–200 ms | M9.4 |
| P11 | `drawSlice` 每像素 `toVoxel` 配陣列、`hidden.has`、`rgb.get`；描紅邊每像素配 `[[1,0],…]`、每個邊緣像素一次 `fillRect` | `views.tsx:265–322` | 一次狀態變化呼叫 4–5 次 | M9.4 |
| P12 | `growMask` 每一步 \|n\| 配 3–4 個外框大小的陣列（含不必要的 `m = new Uint8Array(m)`）；`levelMask` 內層 `coord()` 每 voxel new 一個 Vec3、`inZ` 沒有提出迴圈 | `volume.ts:342–376,492–523` | 拖拉中每幀 | M9.5 |
| P13 | `greedyMesh`／`greedyMeshChunk` 用 `number[]` push 再轉 Float32Array，每個 quad 配 `faces`／`p0..p3`／`tris`／`nn`／顏色 tuple | `volume.ts:180–269`、`chunks.ts:50–154` | 範例 quad 少量不出；真實資料襯層多時明顯 | M9.5 |
| P14 | `greedyMeshChunk` 每個 chunk 配一塊 66³ 的 Uint16（575 KB），全量重建 ×3 ≈ 115 MB GC 流量 | `chunks.ts:59` | GC 抖動 | M9.5 |
| P15 | 預覽三角形搬回全域座標時 `[b.x0-1,…][j%3]` 每個分量配陣列 | `views.tsx:918–924` | 每幀 | M9.2（併入 Worker 版） |
| P16 | `decodeVti` 整個檔案先 `TextDecoder` 成字串只為找標頭；`ascii` 走 `split(/\s+/).map(Number)`；UInt8 也逐格 `Number()` | `vti.ts:110–112,154,173–177` | 載入記憶體 2×、ascii 大檔爆記憶體 | M9.5 |
| P17 | 主網格 `DoubleSide`，剖面關著時也畫背面 | `views.tsx:548` | GPU 多一半 fragment | M9.5 |
| P18 | `voidEdges = new EdgesGeometry(...)` 沒有 quad 數上限保護 | `views.tsx:948` | VOID 多時卡 | M9.5 |
| P19 | `profileBox` 用 `${u},${v}` 字串 Set；`applyProfileMask` 的 `at()` 每次呼叫 `to3D` 配陣列（4 鄰居 × 每格 × 每輪） | `preview.ts:160–166`、`profile.ts:57–60` | 熱迴圈配置 | M9.5 |

量測基準（這台雲端容器、`npx vite-node scripts/bench.ts`）：
×2 poly 長高 1：外框裡算＋relabel 610 ms、主執行緒貼補丁 164 ms；`Uint8Array(15.7M).slice()` 20 ms、`Int32Array(15.7M).slice()` 86 ms；
×3：data 87 ms、labels 647 ms。`bench.ts drag` 單片預覽每幀中位數 1.2／3.7／5.4 ms（×1／×2／×3）。

## 2. 目標與量法

| 項目 | 現在（×2 / ×3） | 目標（×2 / ×3） | 量法 |
| --- | --- | --- | --- |
| 一步 1 格 push，按下 → 正式網格換上（JS 時間） | ≈ 0.9 s / 未量（估 3 s+） | < 400 ms / < 1 s | `perf.cjs`（`__meshAt`）、`bench.ts step` |
| 一步裡整個陣列的 memcpy 次數 | 6 次 | **0 次**（只有第一次改 split 時複製 orig 一次） | `bench.ts step` 印「複製位元組」 |
| 50 步後主執行緒記憶體增量 | 50 × N（diff mask） | < 補丁總量 ＋ 20 MB | `perf.cjs` 讀 `performance.memory`、`bench.ts mem` |
| Worker 常駐 | orig ＋ from ＋ to | orig ＋ 每個 split 一份 | `bench.ts mem`（`process.memoryUsage`） |
| 拖節點，主執行緒每幀（第 1 級＋事件） | 3.7 / 5.4 ms（第 2 級另加 100–200 ms） | < 8 / < 12 ms，且第 2 級不在主執行緒 | `bench.ts drag`（加第 2 級、分開印） |
| 拖節點，第 2 級每幀（Worker） | 未量 | 有快取 < 40 ms（×2，fin 256 片） | `bench.ts drag` |
| 選到基板後每一步選取層的成本 | 全陣列 greedy mesh | ∝ 髒 chunk 數（和主網格同級） | `bench.ts step` 印 layer 請求時間 |
| 整個網格換上時主執行緒 long task | 有（BVH） | 無 > 50 ms | `perf.cjs` PerformanceObserver |
| 主切面上滑鼠移動 | `Section3DPage` 每 move render 一次 | 0 次（只有小元件 render） | React Profiler／`perf.cjs` 計 commit 數 |
| `drawSlice` 480×384 一張 | 未量（估 3–5 ms） | < 1 ms | `bench.ts draw` |

## 3. 原則、不做的事

- **voxel 仍是唯一真相、沒碰到的體素一個都不變**：原地改只是不再影印，改到的格子集合和現在逐體素相同（測試 §7）。
- **純函式保留當對照**：`applyOp`／`relabelFast`／`applyStep`／`greedyMesh` 的純版本留著給測試，原地版本必須和它逐位元組相同。
- **Op、manifest、補丁格式不變**：`Step`／`Op`／`.vti`／`manifest.json` 不動，舊 manifest 重播結果不變。
- **一次做完**：每一條 P1～P19 都有里程碑；做完一個里程碑就把 §1 表的那幾行劃掉，§8 驗收全綠才算結束。
- 不做：SharedArrayBuffer（需要 COOP/COEP 標頭，部署環境不一定給）、第二個 Worker、indexed geometry（列為選配，見 §10）。

## 4. 設計

### 4.1 單本帳簿：主執行緒

**資料模型**

```ts
// editor.ts
interface SplitBuffers {
  data: Uint8Array;        // 這個 split 的體素（唯一一份）
  labels: Int32Array;      // 結構編號
  diff: Uint8Array;        // 和 orig 不同的格子（N）
  diffCount: number;
  counts: Float64Array;    // 256 格材質體積
}
interface Split { id; name; ops; cur: EditState; hist; future; buf: SplitBuffers | null }  // null＝還借用 orig（沒改過）
interface EditState { vol; L; version?: number; owner: string }  // owner：'base' 或 split id
```

- `cur.vol.data`／`cur.L.labels` 永遠指向 `buf`（或 orig）。每一步 `cur` 換成**新物件**（新 `version`、新 `comps`），buffer 身分不變。
- `own(split)`：第一次要改之前（`commitOne`、`duplicateSplit`）把 orig 的 data／labels 複製進來、diff 配零、counts 複製 orig 的；
  同時送 Worker `fork`。這是整個流程裡**唯一**的整陣列複製。
- `applyStepInPlace(buf, step, dir)`：`pasteArr` 進 `buf.data`、`moveLabel`＋`pasteArr` 進 `buf.labels`，回傳新的 wrapper
  `{ vol: { X, Y, Z, data: buf.data }, L: { labels: buf.labels, comps } }`。`patch.ts` 的純 `applyStep` 留給測試。
- 會改 buffer 的入口只有四個：`commitOne`（apply）、`undo`、`redo`、`resetAll`；`addSplit(ops)`／`addSweep`（replay）建立新 buffer。
  **規則：改 buffer 內容的同一個 tick 一定產生新的 `cur` wrapper**，所以所有以 `vol`／`L`／`cur`／`state` 身分當 deps 的 memo／effect
  仍會在每一步重跑（名單 §6.4），不需要逐一改；要審的是反方向——有沒有人抓著舊 wrapper 以為內容沒變（§6.4 逐條確認）。
- `duplicateSplit`：來源 `own` 後，四個 buffer 各複製一份給新 split（現在是共用 `cur`，原地改之後會互相污染，**必改**）。
- `resetAll`：釋放 `buf`、`cur` 回到借用 orig；Worker `drop`。`removeSplit`：同。
- `HistEntry` 不變（補丁＋版本號）。`retain` 改成 `drop {owners}`，主執行緒的 `resident` 集合改成「owner → head 版本」。

**為什麼不會壞**

- 復原／重做只貼 `before`／`after`，補丁裡就是當時改前改後的完整內容，貼回去逐位元組相同（測試：連做 20 步、全部 undo、全部 redo，
  每一步的 data／labels 都和純函式版本相同）。
- 多個 split 各自一本，互不影響；orig 永遠不被寫（`own` 之後才寫，寫的是複本）。
- 即時預覽 `pv` 以 `base` 版本號判斷有效，`previewOp(ed.cur, …)` 讀的是現在的 buffer——和現在一樣。
- `ModelStore` 的快照是幾何，不是陣列。

### 4.2 單本帳簿：Worker 協定

Worker 內部：`buffers: Map<owner, { data, labels, diff, diffCount, counts }>`、`heads: Map<owner, sid>`（這本帳簿現在是哪個版本）、
`parents: Map<sid, { from, box: R, labelBox: S }>`（chunk／圖層算髒的用）。orig 是 owner `'base'`，永遠不寫。

| 請求 | 內容 | 取代 |
| --- | --- | --- |
| `load {sid, vol}` | 不變；另回 `counts`（orig 的體積帳，主執行緒不再 `count`） | — |
| `fork {owner, from}` | 複製 `from`（通常 orig）的四個 buffer 成 `owner` 的；`heads[owner] = from` | — |
| `apply {owner, from, to, comps, op, …}` | 斷言 `heads[owner] === from`；原地算（§4.3）；`heads[owner] = to`；`parents[to]`；`carryStats` 原地；回 `step`／`report` | 現在的 `apply` |
| `derive {owner, from, to, step, dir}` | 斷言 head；原地貼；`heads[owner] = to`；`parents[to]` | 現在的 `derive` |
| `replay {owner, to, ops, …}` | `fork` 自 orig 後逐 op 走原地 `apply`（不再用純 `replay`）；回 data／labels／diff／counts **一次性複本** transfer 給主執行緒 | 現在的 `replay` |
| `drop {owners}` | 釋放 | `retain` |
| `put {owner, sid, vol, labels}` | 主執行緒補送（只在 head 對不上時；理論上不會發生，留著當保險） | `put` |
| `chunks {sid, key, hidden, diff, palette, base?}` | `sid → owner` 查 head；`base === sid` 回空、`base === parents[sid].from` 回髒 chunk、否則全部；**不再快取、不再 `.slice()`**，算完直接 transfer | `chunks` |
| `layer {sid, key, filter, hidden, palette, tint, inflate, base?}` | `filter: { comps, scope, box } \| { mat }`；chunk 化的選取層／VOID 層（§4.6） | `mesh { only }` |
| `preview {sid, op, cap, hidden, palette, showDiff, seq}` | Worker 端第 2 級預覽（§4.5）；回 `{ box, data, blockedAt(全域 index), mesh }` | 主執行緒 `makePreview` |
| `diffMesh` | 不變 | — |
| `diff {sid}`、`count {sid}` | 保留給測試與保險；UI 每步不再呼叫 | — |

`client.ts`：`ensure(s)` 改成「`heads[s.owner] === sidOf(s)` 才算常駐，否則 `put`」；`applyIn`／`deriveIn`／`replayIn` 帶 `owner`；
`retain` → `drop`；版本號仍全域遞增（快取 key 不變）。任何請求碰到不在 `heads` 的 sid → Worker 回錯誤，主執行緒 `put` 後重送一次。

### 4.3 原地 relabel

現在的 `relabelFast(prevVol, prev, moved, next, …, R)` 同時需要「改前」（`a = prevVol.data`、`P = prev.labels`）和「改後」（`b`、`labels = P.slice()`）。
原地版本 `relabelInPlace(labels, prevComps, before: DataPatch, next, moved, matName, newKey)`：

1. 改前的 data 只在 R 裡被讀（`a[i] !== b[i]`）→ 用 `before.before`（補丁的「改前」裁片）代替 `a`。
2. 第 1 步算出 `touched`／`lost` 後，先定 `Smax = R ∪ ⋃ bbox(touched)`（≥ 最終的 S，因為被併掉的照舊結構也是 touched），
   在**任何寫入之前** `PS = cropArr(labels, Smax)` 當舊值快照；之後所有讀 `P[i]` 的地方（第 6 步投票、`moved`）改讀 `PS`。
3. 其餘步驟（清掉、flood fill、union-find、投票、編號、壓緊）直接寫 `labels`。
4. `Step.labels.before` ＝ `PS` 在最終 S 裡的子裁片（S ⊆ Smax，不必再從原陣列裁）；`after` ＝ 改完後在 S 裡裁。
5. 純函式 `relabelFast` 改成「複製 labels → 呼叫原地版」的包裝，現有 relabel 測試一行不動就能驗證原地版相同。

`applyOpLocal` 同理：`previewOp` 在裁切盒裡算 → `R = diffInBox` → `before = cropArr(buf.data, R)` → **再** `pasteArr` 進 `buf.data` →
`relabelInPlace` → 組 Step。順序很重要：before 一定在貼之前裁。

### 4.4 diff 與體積帳在主執行緒差量更新

- `applyOne`／`undo`／`redo` 貼完補丁後，在 R 裡：`now = data[i] !== orig[i]; count += now - diff[i]; diff[i] = now`；
  `counts[before[i]]--; counts[after[i]]++`（undo 時 before／after 對調）。就是 `carryStats` 搬到主執行緒，O(補丁)。
- `ed.diff` ＝ 目前 split 的 `{ mask: buf.diff, count }`，`useMemo` 依賴 `cur`（每步新 wrapper）。**注意**：`buf.diff` 身分不變，
  所以所有以 `diff`／`diffMask` 陣列身分當 deps 的 effect（§6.4）要確認同一個 deps 裡有 `vol`／`version`，否則不會重畫。
- `useSplitDiffs` 改成同步讀 `s.buf`；`exportAll` 的 `changedVoxels` 讀 `buf.diffCount`；`ledger` 用 `buf.counts` 與 orig counts。
- 刪掉 `diffCache`／`countCache`／`pruneCaches`、每步的 `call('diff')`／`call('count')`。
- `replay` 之後 Worker 回一次 diff／counts 複本（它在原地 apply 時順手算好了）。
- Worker 仍自己維護 diff／counts（chunk 標紅、`diffMesh` 要用），兩邊各自差量更新，不互傳。

### 4.5 拖拉第 2 級預覽搬到 Worker、每片輪廓快取

**為什麼搬到 Worker**：拖拉期間 Worker 是閒的（沒有 apply），狀態又已常駐，不必傳陣列；主執行緒只剩第 1 級（單片，已量過幾 ms）。

- `index.tsx onLive(op)`：第 1 級不變（主執行緒單片 `previewOp`，含 `blockedAt`）。第 2 級改成 `live2.request(op)`：
  ```
  pending = op; if (!inflight) send()
  send(): inflight = true; seq++; call('preview', { sid, op, cap, hidden, palette, showDiff, seq })
    .then(r => { inflight = false; if (r.seq === seq && r.sid === sidOf(ed.cur) && dragging) setPv({ ...r, base: sid, committed: false });
                 if (pending !== sentOp) send(); })
  ```
  同時最多一個在飛、永遠送最新的 op、結束拖拉後晚到的結果丟掉。放開時的 committed 預覽（`previewHook`）走同一條，
  且在 `apply` 之前送出（FIFO，Worker 先回預覽再算 apply）。
- Worker `preview` handler：`previewOp(state, orig, op, cap, report, ringsFor)` → `data` 裁片 ＋ `blockedAt` 換成全域 index ＋
  `mesh`（把 `views.tsx:870–930` 的「盒子外擴一圈 greedy mesh、只留重心在盒內的三角形、搬回全域座標」搬成純函式
  `volume/previewMesh.ts`，P15 一併修掉；diff 混紅用 Worker 自己的 orig）。回傳全部 transfer。
- **每片輪廓快取**：`applyProfileMask(…, ringsFor?)`、`relativeCells(inside, …, g, pre?)`。Worker 端 `previewRings: Map<string, { rings: Ring[]; handle: Handle | null }>`，
  key＝`${sid}|${axis}|${t}|${key}|${gestureSig}`（`gestureSig` ＝ kind＋ref＋shift＋hole，拖同一個把手時不變）；sid 變就清空。
  一次拖拉裡每片只描一次，之後每幀剩 `dragDisp`／`editRing`／`rasterize`／`deltaOf`／kernel。
  快取正確的前提：裁切盒在切面上包住結構整個外框（有 gestures 時 `profileBox` 已經這樣做）——加一個斷言。
- `View3D` 的 preview effect：有 `preview.mesh` 就直接 `toGeometry`，不再主執行緒 `greedyMesh`。主執行緒保留 `previewOp` 只為第 1 級與測試。
- `cellCloud`（超過上限的點雲）不變。`LIVE_PREVIEW_CAP` 先維持 40 萬，M9.2 量完再決定是否放寬（Worker 不卡畫面，上限可以用 Worker 每幀時間來定）。
- `bench.ts drag` 加印：第 1 級每幀、第 2 級每幀（無快取／有快取）、預覽網格每幀。

### 4.6 圖層 chunk 化、chunk 快取搬到主執行緒、BVH 懶建

**圖層 chunk 化（P4）**

- Worker `layer` 請求和 `chunks` 同一套：`filter` 決定 `code(i)`（選取：`labels[i]` 在 comps 內且在 scope 內 → 1；VOID：`data[i] === mat` → 1），
  `greedyMeshChunk` 後對每個頂點套 `inflate`。
- 髒 chunk：`parents[sid].labelBox`（＝relabel 的 S，⊇ R）——選取層看的是 labels，改到的範圍是 S 不是 R。`apply`／`derive` 都要記 `labelBox`。
- key 換了（換選取、換 scope、換 inflate）→ 全量，但只跑 `chunksTouching(clipBox(box, scope))` 裡的 chunk，不是全部；
  之後每一步只回髒的。這樣選到基板也只付一次 ∝ 基板大小的成本，每步 ∝ 髒 chunk。
- 主執行緒 `View3D`：`parts` 一般化成 `Layer { group, parts: Map<k, Mesh>, shown: { sid, key } | null, material }` × 3（main／sel／void），
  `setParts(layer, items, full)` 共用；選取層 effect 依賴不變，但送 `base = layer.shown.sid`。

**chunk 快取搬到主執行緒（P6）**

- Worker 刪掉 `chunkCache` 與 `copy()`，算完直接 transfer。
- 主執行緒 `partsCache: Map<'${sid}|${key}', Map<k, Mesh>>`，LRU 3，只放主網格層。切回快取裡有的 `(sid, key)`（看原始 B、切 split、復原）直接換 group，
  不呼叫 Worker；沒有才送 `chunks`（`base` 照舊）。增量更新時 `new Map(prev)` 再換髒的，沒動到的 chunk 的 `Mesh` 在多個快取項目間共用；
  釋放 geometry 前檢查沒有任何快取項目或目前層還引用它（`disposeIfOrphan`）。
- 記憶體：主執行緒最多 3 份主網格（現在是 Worker 4 份＋主執行緒 1 份）。

**BVH 懶建（P5）**

- `toGeometry` 算 `boundingBox`；`setParts` 不建 BVH。
- `rayParts(ray)`：把射線轉到體素座標，過濾 `ray.intersectsBox(part.geometry.boundingBox)` 的 chunk，對這幾個 `ensureBVH(part)`（第一次才 `new MeshBVH`），
  再 `intersectObjects`。`hit`／`hitsAlong`／`occluded` 都走它；`ghostMesh`（差異模式）同樣懶建。
- 選配：`requestIdleCallback` 在閒置時每次補建一個尚未建的 BVH（可用旗標關掉，量過再決定）。

### 4.7 畫面層：不重 render、不重畫

| # | 改法 | 檔案 |
| --- | --- | --- |
| P7 | `index.tsx` 的 `sliceHover` 與 3D `hover` 文字不再是 `Section3DPage` 的 state：做一個 `useLiveValue()`（ref ＋ 訂閱）給 `HoverReadout`／`PaneFoot` 小元件各自 `useSyncExternalStore`，整頁不 render。`SliceEditor` 的 `hoverUV` 方塊改用 ref 直接改 `<rect>` 的 x／y／display（和 ghost 一樣）；`setHover(h)` 只在 kind／key／ring／index 變時才 set。`View3D` 的 `useEffect(kick)` 改成依賴會改畫面的 props（`state, selMask, selBBox, clip, preview, cursor, mode, hidden, materials, cells, xray, translucent`）。 | `index.tsx`、`SliceEditor.tsx`、`views.tsx`、新 `ui/liveValue.ts` |
| P7 | 環的 path 字串 `useMemo([rings, outline])`、階梯 path `useMemo([stairs])`、`groupPts` 結果 memo；節點 `<rect>` 列表 memo 於 `[rings, hover, handle, showAll, zoom]` | `SliceEditor.tsx` |
| P8 | `blockedHere`／`blockedLive` 各合成**一條** `<path d="M u v h1 v1 h-1 z …">`（memo），hatch pattern 當 fill；上限 4000 不變 | `SliceEditor.tsx` |
| P9 | 剖面貼圖：一個常駐 canvas ＋ 一個 `CanvasTexture`，更新只 `drawSlice` 進同一個 canvas 後 `needsUpdate = true`；`PlaneGeometry`／`EdgesGeometry` 只在 `(axis, W, H)` 變時重建；effect 拆兩個：幾何／位置 `[clip, dims]`，貼圖內容 `[clip, vol, rgb, hidden, selMask, diffMask, mode, preview]`，且 `preview` 變時若 `clip.at` 不在預覽盒的那一軸範圍內就 return | `views.tsx` |
| P9 | `SliceView`（小切面）拆成底圖 canvas ＋ `SlicePreviewLayer`（重用），底圖 deps 不含 `preview` | `views.tsx`、`SlicePreviewLayer.tsx` |
| P10 | `maskOf(L, keys, bbox?)`、`maskInScope(mask, vol, scope, bbox)`、`slicesWith(mask, vol, axis, bbox)` 都只掃選取結構的 union bbox（結果陣列仍配 N，掃描 O(bbox)）；`editor.ts` 把 `selBox` 傳進去 | `volume.ts`、`editor.ts`、`index.tsx` |
| P11 | `drawSlice` 重寫：三個 `Uint8Array(256)` LUT（材質色，隱藏材質折成淡灰）＋ 三個「混藍」LUT；依軸特化成三個內迴圈（索引用 `i0 += su` 遞增，不呼叫 `toVoxel`／`idx`）；預覽盒用列區間判斷而不是每像素判斷；diff 描邊在同一個 `ImageData` 裡做 4 鄰居判斷後直接寫紅，最後一次 `putImageData`。輸出必須和舊版逐像素相同（測試 §7） | `views.tsx` → 拆到 `pages/Section3D/drawSlice.ts` |

### 4.8 微觀與載入

| # | 改法 | 檔案 |
| --- | --- | --- |
| P12 | `growMask`：兩個外框大小的 buffer ping-pong（`cur`／`out` 交換），`front`／`face`／`shift` 共用 scratch（`fill(0)`），刪掉每步的 `m = new Uint8Array(m)`（第 0 步已經複製過）；**讀寫語意不變**（仍讀上一步、寫這一步）。`levelMask`／`outerFace`：座標內聯計算不配 Vec3，`inZ` 在 scope 軸 ≠ 掃描軸時提到欄位層級一次判斷 | `volume.ts` |
| P13 | `MeshBuilder`：可成長的 Float32Array ×3（倍增），`emitQuad(d, u, v, t, i, j, w, h, sign, r, g, b)` 直接寫入，不配中間陣列；`greedyMesh` 與 `greedyMeshChunk` 共用；`colorOf` 每面一次照舊 | `volume.ts`、`chunks.ts`、新 `volume/meshBuilder.ts` |
| P14 | `greedyMeshChunk` 的 padded codes 用模組層 scratch（依需要放大，用前 `fill(0)` 需要的長度） | `chunks.ts` |
| P16 | `decodeVti`：先在 bytes 裡找 `<AppendedData` 的位置（逐位元組比對 ASCII），只 `TextDecoder` 前面那段；`ascii` 用逐位元組的數字掃描器（不 split）；UInt8 且全部 ≤ 254 時 `out.set(values)`；`direct` 檢查用型別化迴圈不經 `Number()` | `vti.ts` |
| P17 | 主網格／預覽網格材質 `side` 跟著 `clip`：剖面開 → `DoubleSide`，關 → `FrontSide`（`needsUpdate`） | `views.tsx` |
| P18 | `voidEdges` 加和差異模式相同的 quad 上限（> 60,000 不描邊） | `views.tsx` |
| P19 | `profileBox` 的 `addAt` 改 `Set<number>`（`(v << 16) \| (u & 0xffff)`，或 Uint8 格）；`applyProfileMask` 的 `at()` 預先算 `ua`／`va`／`a` 三個 stride，不呼叫 `to3D` | `preview.ts`、`profile.ts` |

## 5. 每個檔案要改什麼

| 檔案 | 改動 | 里程碑 |
| --- | --- | --- |
| `src/volume/patch.ts` | `applyStepInPlace`；`cropArr`／`pasteArr` 不變；純 `applyStep` 改成包裝 | M9.1 |
| `src/volume/volume.ts` | `relabelInPlace`（`relabelFast` 變包裝）；`maskOf` 加 bbox；`growMask`／`levelMask`／`outerFace` 配置；`greedyMesh` 用 `MeshBuilder` | M9.1／M9.4／M9.5 |
| `src/volume/apply.ts` | `applyOpInPlace(buf, …)`：裁前先裁 before、貼、原地 relabel、組 Step；純 `applyOpLocal` 變包裝 | M9.1 |
| `src/volume/worker.ts` | 新協定（§4.2）：`buffers`／`heads`／`parents.labelBox`、`fork`／`drop`／`layer`／`preview`，刪 `chunkCache`／`copy`，`replay` 走原地 | M9.1／M9.2／M9.3 |
| `src/volume/client.ts` | `owner`、`heads`、`forkIn`／`dropOwners`／`previewIn`／`layerIn`；`ensure` 改判斷 | M9.1／M9.2／M9.3 |
| `src/volume/ops.ts` | `EditState.owner`；純 `applyOp`／`replay` 不變 | M9.1 |
| `src/volume/preview.ts` | `previewOp(…, ringsFor?)`；`profileBox` 數字 key；斷言「有 gestures 時盒子包住結構外框」 | M9.2／M9.5 |
| `src/volume/profile.ts` | `applyProfileMask(…, ringsFor?)`；`at()` 不配陣列 | M9.2／M9.5 |
| `src/slice/relative.ts` | `relativeCells(…, pre?: { rings, handle })` | M9.2 |
| `src/volume/previewMesh.ts`（新） | 盒子外擴一圈 greedy mesh、濾三角形、搬回全域（從 `views.tsx` 搬出） | M9.2 |
| `src/volume/meshBuilder.ts`（新） | 可成長 Float32Array 建構器 | M9.5 |
| `src/volume/chunks.ts` | `greedyMeshChunk` 用 `MeshBuilder`、scratch codes；`layer` 用的 `code` 工廠 | M9.3／M9.5 |
| `src/volume/vti.ts` | 標頭只解前段、ascii 掃描器、UInt8 快路徑 | M9.5 |
| `src/pages/Section3D/editor.ts` | `SplitBuffers`、`own`、原地 `applyOne`／`undo`／`redo`／`resetAll`／`duplicateSplit`／`removeSplit`、diff／counts 差量、刪 `diffCache`／`countCache`、`useSplitDiffs` 同步、`maskInScope`／`slicesWith` 加 bbox | M9.1／M9.4 |
| `src/pages/Section3D/index.tsx` | `live2` 排程器、`sliceHover`／`hover` 改 live value、`exportAll` 讀 `buf.diffCount` | M9.1／M9.2／M9.4 |
| `src/pages/Section3D/views.tsx` | `Layer` 一般化、`partsCache`、BVH 懶建、preview 用 Worker 的 mesh、剖面貼圖重用、`SliceView` 分層、`kick` deps、`side` 跟 clip、`voidEdges` 上限；`drawSlice` 搬到 `drawSlice.ts` | M9.2／M9.3／M9.4／M9.5 |
| `src/pages/Section3D/drawSlice.ts`（新） | LUT 版 `drawSlice` | M9.4 |
| `src/pages/Section3D/SliceEditor.tsx` | hover 不進 state、path memo、blocked 合成 path | M9.4 |
| `src/pages/Section3D/SlicePreviewLayer.tsx` | 給 `SliceView` 共用（props 不變） | M9.4 |
| `src/pages/Section3D/CompareView.tsx`、`SplitsTab.tsx`、`ChangesTab.tsx` | `useSplitDiffs` 同步版、`ed.diff` 新形狀 | M9.1 |
| `src/ui/liveValue.ts`（新） | `useLiveValue`／`useSyncExternalStore` 小工具 | M9.4 |
| `scripts/bench.ts` | `step`（每步全流程＋複製位元組）、`drag`（第 1／2 級分開、有無快取）、`mem`、`draw`、`layer` | M9.0 |
| `scripts/e2e/perf.cjs` | long task 觀測、`performance.memory`、React commit 計數、50 步記憶體 | M9.0 |
| `README.md`、`docs/plan-v9-performance.md` | 量測結果、協定變更 | M9.5 |

## 6. 必查名單（避免漏網）

做 M9.1 時逐條確認，確認一條劃一條。

**6.1 整個陣列的 `.slice()`（目標：M9.1 之後只剩 ✔ 的幾個）**

| 位置 | 處置 |
| --- | --- |
| `worker.ts:108` `carryStats` `d.mask.slice()` | 原地更新 owner 的 diff |
| `worker.ts:120` `carryStats` `c.slice()` | 原地更新 owner 的 counts |
| `worker.ts:212` `load` `labels.slice()` | ✔ 保留（主執行緒要一份 orig labels，一次） |
| `worker.ts:293` chunk `copy()` | 刪（P6） |
| `worker.ts:319–320` `replay` 複本 | ✔ 保留（新 split 一次） |
| `worker.ts:382` `diff` handler | UI 不再呼叫；handler 留給測試 |
| `volume.ts:901` `relabelCore` `prev.labels.slice()` | 只有純 `relabel`／測試用，不動 |
| `volume.ts:1029` `relabelFast` `P.slice()` | 改 `cropArr(labels, Smax)` |
| `apply.ts:44` `s.vol.data.slice()` | 原地貼 |
| `patch.ts:84,89` `applyStep` | `applyStepInPlace` |
| `volume.ts:944,1139` `comps.slice()` | 小陣列，不動 |

**6.2 所有 `call('…')`（目標：每一步只剩 `apply`＋`chunks`＋（有選取時）`layer`）**

`client.ts:71 put`、`:82 load`、`:92 replay`、`:104 retain→drop`、`:113 apply`、`:125 derive`；`editor.ts:135 count`（刪）、`:297 diff`（刪）；
`views.tsx:780 diffMesh`（留）、`:800 chunks`（改）、`:943 mesh VOID`（→ layer）、`:973 mesh 選取`（→ layer）；新增 `fork`、`preview`。

**6.3 `selMask`／`affMask` 的讀者（P10 改 bbox 掃描時介面不變，但每一個都跑一次確認結果相同）**

`editor.ts:249,287`（產生）、`views.tsx:292`（drawSlice 混藍）、`:412–413`（`selRef`，筆刷判斷）、`:1004`（剖面貼圖）、`:1665`（小切面）、
`SliceEditor.tsx:286,750`、`SlicePreviewLayer.tsx:76`、`index.tsx:313,324,335`（`slicesWith`）、`:532`（`recolor`）、`:586,667,856`（傳下去）、`CompareView.tsx:99`（null）。

**6.4 以 `vol`／`L`／`cur`／`state`／`diff` 身分當 deps 的地方（原地改之後 wrapper 每步都換，仍會重跑；要確認的是「同一個 deps 裡的陣列身分不變時仍正確」）**

| 位置 | deps | 確認 |
| --- | --- | --- |
| `editor.ts:244,246,248,249` `compByKey`／`selComps`／`selIdx`／`selMask` | `[L, sel]` | L wrapper 每步新 → 重算 ✔ |
| `editor.ts:261,287` `scope`／`affMask` | `[…, vol]`／`[selMask, scope, vol]` | ✔ |
| `editor.ts:331` diff／counts effect | `[cur, origState, diffOf]` | 整段刪除（§4.4） |
| `editor.ts:351` `changedKeys` | `[L, origByKey]` | ✔ |
| `editor.ts:885` `voxelCoord` | `[vol]` | 只用維度 ✔ |
| `PositionBar.tsx:44` ticks | `[…, ed.vol, …]` | 只用維度 ✔ |
| `SliceEditor.tsx:204,287,610,626` | `[L, …]`／`[vol, …, selMask, diff]` | `diff` 身分不變但 `vol` 每步新 ✔；`got`（`geo.models.get`）吃 `version` ✔ |
| `views.tsx:813,953,980` 主網格／VOID／選取 | `[state, …]` | ✔（`state` 每步新） |
| `views.tsx:1031` 剖面貼圖 | `[clip, vol, …, diffMask, …]` | `diffMask` 身分不變、`vol` 每步新 ✔；P9 拆 effect 後保留 `vol` |
| `views.tsx:1666` 小切面 | `[vol, …, diff, preview, …]` | ✔；P9 分層後底圖 deps 保留 `vol` |
| `SlicePreviewLayer.tsx:84` | `[vol, …]` | ✔ |
| `index.tsx:193` 預覽收掉 | `[ed.busy, ed.cur, pv]` | ✔ |
| `index.tsx:389` `diffShown` | `ed.diff.count ? ed.diff.mask : null` | `ed.diff` 每步新 wrapper（`useMemo([cur])`）✔ |
| `views.tsx:767` 場景建立 | `[vol.X, vol.Y, vol.Z]` | 閉包裡的 `vol` 只用維度 ✔（`recolorGeometry` 的 `voxelFromHit` 只看維度） |

**6.5 抓著舊 wrapper 的地方（原地改之後內容會變）**

- `useEditor.applyOne` 的 `from`：只在 `appliedText`／`headText` 用 `from.L.comps` 與維度 ✔；`entry.version = sidOf(from)` ✔。
- `undo` 的 `prev = applyStep(act.cur, …)` → 改成原地後 `prev` 是新 wrapper ✔；`keepSel(prev)` 只看 comps ✔。
- `duplicateSplit`／`resetAll`／`addSplit(無 ops)` 共用 orig 或他人的 `cur`：**改成 §4.1 的 own／借用規則**。
- `pv`／`dragPv` 的 `data` 是裁片複本 ✔。
- `ModelStore` 快照是幾何 ✔。
- `CompareView` 的 `cards[].vol`：各 split 自己的 buffer ✔；`orig` 永不寫 ✔。
- Worker：`store.get(from)` 在 `apply` 之後不再被需要（head 已前進）；`derive` 的 `!store.has(to)` 判斷改成 head 比對。

## 7. 測試清單

| 測試 | 內容 |
| --- | --- |
| `patch.test.ts`（新） | `applyStepInPlace` fwd 後 data／labels 逐位元組 === 純 `applyStep`；back 後 === 原狀；20 步 → 全 undo → 全 redo 每一步都相同 |
| `apply.test.ts`（加） | `applyOpInPlace` 對 §12 既有的每一種 Op，結果 === `applyOp`；Step 與純 `applyOpLocal` 的 Step 逐欄相同（含 `labels.before`＝改前在 S 的裁片） |
| `volume.test.ts`（加） | `relabelInPlace` 包裝成 `relabelFast` 後既有 relabel 測試全過；`maskOf(L, keys, bbox)` === `maskOf(L, keys)`；`growMask`／`levelMask` 改配置後結果不變（既有測試） |
| `worker.test.ts`（加） | FakeWorker 下：`own` 只送一次 `fork`；每步只送 `apply`＋`chunks`（有選取再加 `layer`），沒有 `diff`／`count`；head 對不上時 `put` 一次並重送；`drop` 名單正確；`duplicateSplit` 之後兩個 split 改其中一個另一個不變 |
| `editor` 差量（新 `stats.test.ts`） | 隨機 30 步（含 undo／redo／reset）後主執行緒 `diff.mask`／`count`／`counts` === 全量 `diffMask`／`countArray` |
| `preview.test.ts`（加） | `previewOp` 帶 `ringsFor` 快取 === 不帶；同一次拖拉連續 10 個 delta 用同一份快取結果都相同；Worker `preview` 回的 `blockedAt` 是全域 index |
| `previewMesh.test.ts`（新） | 搬出的純函式 === 原 `views.tsx` 邏輯（用一份參考實作比對頂點集合） |
| `chunks.test.ts`（加） | `layer` 的選取 chunk 合起來 === `meshInBox`（頂點集合相同，含 inflate）；髒 chunk 用 `labelBox` 時，換編號但沒改體素的結構也會重畫 |
| `drawSlice.test.ts`（新） | LUT 版對範例三個軸、有無選取、有無 diff、有無預覽盒、有隱藏材質 → `ImageData` 逐位元組 === 舊版（舊版留在測試裡當參考） |
| `meshBuilder.test.ts`（新） | `greedyMesh` 新舊版本頂點／法線／顏色陣列逐元素相同 |
| `vti.test.ts`（新） | appended raw／base64／壓縮／ascii 小檔：新舊解碼相同；UInt8 快路徑相同 |
| e2e `perf.cjs` | 見 §2 的每一列；`m2.cjs`／`m3.cjs`／`m5.cjs` 既有驗收全過 |

## 8. 里程碑、工作拆解、驗收

### M9.0 量法與基線（S）

- `bench.ts step [scale]`：載入 → 選 poly → 連做 10 步「長高 1」：每步印 apply（Worker 端純計算）、主執行緒貼補丁、chunk、layer、**複製位元組數**（在 `cropArr`／`slice` 包一層計數器，只在 bench 開）；最後印 `process.memoryUsage()` 差。
- `bench.ts drag`：第 1 級、第 2 級（整個 scope）、預覽網格，三個分開印中位數／p95。
- `bench.ts draw`：`drawSlice` 三個軸各 20 次。
- `perf.cjs`：`PerformanceObserver('longtask')`、`performance.memory`（Chrome 旗標 `--enable-precise-memory-info`）、React Profiler commit 計數（dev 模式 `__REACT_DEVTOOLS_GLOBAL_HOOK__` 或在 `Section3DPage` 包 `<Profiler>` 只在 `?perf` 下）。
- 驗收：三個腳本跑得出 §2「現在」欄的數字並寫進本文件。

### M9.1 單本帳簿（XL）

順序：`patch.ts` → `volume.ts relabelInPlace` → `apply.ts` → `worker.ts`／`client.ts` 新協定 → `editor.ts`（own／原地／差量 diff、counts）→ UI 讀 `ed.diff`／`useSplitDiffs` 的地方 → §6 名單逐條劃掉。

驗收：
- §7 的 `patch`／`apply`／`volume`／`worker`／`stats` 測試全過；既有 112 個測試不動全過。
- `bench.ts step ×2`：複製位元組 ＝ 0（第一次 own 除外）；一步 < 400 ms；×3 < 1 s。
- `bench.ts mem`：50 步後主執行緒增量 < 補丁總量 ＋ 20 MB；Worker 常駐 ＝ orig ＋ 每 split 一份。
- 手測：兩個 split 各改、複製 split 後各改、回到原始、復原到底再重做到底、看原始 B、並排比較——結果與改前一致。

### M9.2 拖拉第 2 級到 Worker（M）

- `previewMesh.ts` 搬出 → `preview`／`relativeCells` 的 `ringsFor` → Worker `preview` handler ＋ 輪廓快取 → `index.tsx live2` → `View3D` 吃 `preview.mesh`。
- 驗收：`bench.ts drag ×2`：主執行緒每幀 < 8 ms；Worker 第 2 級有快取 < 40 ms（無快取的數字也印出來）；
  `perf.cjs` 拖 60 步：主執行緒 long task 數比 M9.0 基線少（目標 ≤ 5，扣掉 React dev 的）；3D 小窗在拖拉中有變化；放開後 commit 的格子 === 第二層顯示的格子（`m5.cjs`）。

### M9.3 圖層 chunk 化、chunk 快取搬家、BVH 懶建（L）

- Worker `layer`／`parents.labelBox` → `View3D Layer` 一般化 → 刪 Worker `chunkCache`、主執行緒 `partsCache` → BVH 懶建。
- 驗收：`chunks.test.ts` 過；`bench.ts step` 選基板時每步 layer 時間 ∝ 髒 chunk（印 chunk 數）；B 切原始再切回不送 `chunks`；
  `perf.cjs` 整個網格換上時無 > 50 ms long task；點選、hover、右鍵「後面的結構」、對準選取（`occluded`）行為不變（`m0.cjs`／`m3.cjs`）。

### M9.4 畫面層（M）

- `liveValue` → `index.tsx`／`SliceEditor.tsx` hover 不進 state → path memo／blocked 合成 path → 剖面貼圖重用 → `SliceView` 分層 → `drawSlice.ts` LUT 版 → `maskOf`／`maskInScope`／`slicesWith` bbox。
- 驗收：`drawSlice.test.ts` 逐位元組相同；`bench.ts draw` < 1 ms／張（480×384）；`perf.cjs`：主切面上 60 次 pointermove，`Section3DPage` commit 0 次；
  剖面開著拖拉每幀不重建貼圖物件（計數器）；點選基板（×3）主執行緒 < 50 ms。

### M9.5 微觀、載入、文件（S）

- P12～P19 依 §4.8；README「效能」段與本文件 §2 填上最終數字；plan v7 §8 與 v8 的量測表加一列 v9。
- 驗收：`meshBuilder.test.ts`／`vti.test.ts` 過；既有測試全過；`npm run build` 過；`bench.ts` 三種模式數字寫進 §2。

## 9. 風險與對策

| 風險 | 對策 |
| --- | --- |
| 原地改和 React 的「值不變就不重算」互相打架：某個 memo 抓著舊 buffer 內容 | §4.1 規則「改內容必換 wrapper」＋ §6.4／6.5 逐條確認 ＋ `stats.test.ts` 隨機序列；開發模式加一個 `Object.freeze`-式的 dev 檢查：每步結束後比對 `cur.vol.data === buf.data` |
| `duplicateSplit`／`resetAll`／`addSplit` 共用 buffer 造成互相污染 | §4.1 own／借用規則；`worker.test.ts` 專門一條 |
| 原地 relabel 讀到已被改寫的舊值 | `Smax` 快照在任何寫入之前；純 `relabelFast` 包裝版跑既有測試 |
| Worker head 與主執行緒不同步（例如一步失敗） | `apply` 失敗時 Worker 不改 head、主執行緒不貼；任何對不上 → 錯誤 → `put` 補送 → 重送一次；e2e 故意讓一步失敗（超大 Op 被拒）確認恢復 |
| Worker `preview` 晚到蓋掉新狀態 | `seq`＋`sid` 雙重檢查；拖拉結束 `dragging=false` 一律丟掉 |
| 輪廓快取在裁切盒沒包住結構時給錯環 | `profileBox` 斷言＋測試「快取 === 不快取」 |
| 主執行緒 `partsCache` 的 geometry 釋放漏掉或釋放到還在用的 | `disposeIfOrphan` 走所有快取項目＋目前層；e2e 切 20 次 B 看 `renderer.info.memory.geometries` 不漲 |
| BVH 懶建讓第一次 hover 卡一下 | 只建射線碰到的幾個 chunk（通常 1–3 個）；選配 idle 預建 |
| `drawSlice` LUT 版顏色差一個位元 | 測試逐位元組比對；混藍用 `>> 1` 與舊版相同算式 |
| `growMask` ping-pong 改錯讀寫對象 | 既有 `volume.test.ts` 的推面／襯層測試逐體素比對 |
| `.vti` 標頭掃描在非 ASCII 標頭失敗 | 找不到 `<AppendedData` 時退回整檔解碼（舊路徑） |

## 10. 決策記錄

- **第 2 級預覽放 Worker 而不是 `requestIdleCallback`**：拖拉期間 Worker 閒置且狀態已常駐；idle callback 仍佔主執行緒、Safari 沒有、長任務還是會卡 pointer。
- **chunk 快取放主執行緒而不是 Worker**：資料本來就要在主執行緒（GPU），Worker 多留一份只為了「切回去不重算」，改成主執行緒 LRU 3 份、零複製。
- **選取層走 chunk 而不是只加快取**：只加快取仍要在選取改變時全量算一次整個外框；chunk 化之後每步 ∝ 髒 chunk，和主網格一致。
- **`selMask`／`affMask` 保留陣列介面、只改成 bbox 掃描**：改成 predicate 要動 13 個讀者（§6.3），收益只有省一次 N 位元組配置（calloc 很快）；列為之後選配。
- **保留 non-indexed 6 頂點／quad**：indexed 省 22% 資料但要改 BVH／recolor／預覽濾三角形的假設；量過 M9.5 之後再決定（選配）。
- **不用 SharedArrayBuffer**：需要 COOP/COEP，部署環境不保證；原地補丁已經把每步的跨執行緒資料降到補丁大小。
- **純函式一律保留**：`applyOp`／`replay`／`relabelFast`／`applyStep`／`greedyMesh` 當測試對照，原地版本都以「包裝＝純版」驗證。
