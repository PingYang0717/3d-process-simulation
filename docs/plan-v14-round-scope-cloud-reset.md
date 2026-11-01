# 計畫 v14：拿掉點雲、圓頭範圍與回填修正、設計區草稿不留、效能補強

> 位置：`docs/plan-v14-round-scope-cloud-reset.md`，分支 `claude/upbeat-einstein-wod16i`，接在 plan v13 之後（commit e5b37f0）。
> 出發點：2026-11-01 使用者在 ×3 範例（480×288×384，53.1 M voxels）上對 Si fin／Poly-Si 做圓頭實驗後的五個回饋（§1）。
> 範圍：3D 預覽的點雲、圓頭（profile op）的範圍與回填、設計區草稿的生命週期、結構縮圖的資料來源，以及一輪效能審查找出的熱點。**檔案格式、split 生命週期、Worker 協定都不動。**
> 狀態：已實作（M14.1～M14.6，見 §11 實作紀錄）。

---

## 目錄

0. 一句話
1. 問題總表（使用者回饋 → 根因）
2. 查證：每個問題在程式碼裡的位置
3. 效能審查：還有哪些會卡或吃記憶體
4. 目標與驗收方式
5. 設計
   - 5.1 拿掉格子點雲
   - 5.2 圓頭的範圍：只掃結構實際占的那段，文字與實際一致
   - 5.3 圓頭的回填：填「上面那層」、預設不帶襯層
   - 5.4 設計區草稿：換結構、重開頁面都是空的
   - 5.5 結構縮圖：畫產生要用的底、切片跟十字、描邊不染色
   - 5.6 效能補強
6. 每個檔案要改什麼
7. 測試清單
8. 里程碑、工作拆解、驗收
9. 風險與對策
10. 決策記錄
11. 實作紀錄

---

## 0. 一句話

把「拖完還留在畫面上的綠紅點」整個拿掉；圓頭只掃結構那一段、削掉的地方填上面的材質而不是空氣；設計區換結構就從空的開始、縮圖畫的是真正要算的那個底；順手把每次拖拉都整個陣列掃一遍的幾個地方修掉。

---

## 1. 問題總表

| # | 使用者看到的 | 根因（一句話） | 修法 |
|---|---|---|---|
| 1 | 3D 上出現綠色線條（Si fin 2 頂邊），覺得會吃記憶體 | 「格子點雲」（大範圍拖拉的替代顯示）在套用後沒收掉；拖拉中每個滑鼠事件都重新配一整批點 | 點雲整個拿掉（§5.1） |
| 2 | 設計區的 2D 縮圖和實際看到的不一樣 | 縮圖畫的是目前 split 改過的狀態，但「產生」是從原始算；切片位置取外框中點；選取用 50% 藍混色，紅色 Poly 變紫 | 畫「產生要用的底」、切片跟十字、描邊（§5.5） |
| 3 | 換了結構變數區不會重來，預設值奇怪 | 草稿存在 localStorage，變數在新增那一刻綁死 keys；預設水平是寫死的 2、4、6 格 | 不再持久化草稿；選取變了就清空；預設依結構尺寸（§5.4） |
| 4 | 3D 圓頭拖一下就很卡，還有紅色線條 | 圓頭的 scope 落到 `fullScope(vol, 'x')`＝整條 x 0～479，外框 72 萬格一定超過即時上限，每幀白算一次再退回點雲；紅線＝點雲的「要拿的格子」 | 範圍改成結構實際占的那段；文字顯示同一個範圍；拖拉改 rAF 合併（§5.2、§5.6） |
| 5 | 3D 套用圓頭後 2D 切面多了白格子（air）、形狀歪掉 | 回填規則「原始就是被削的材質 → 填空氣」；「襯層跟著搬」把 HfO₂／TiN 搬進削掉的格子、原位留空氣；加上 #4 的範圍問題，fin 穿過的片也被套了同一個手勢 | 圓頭預設填「上面那層」、預設不帶襯層（§5.3） |

---

## 2. 查證：每個問題在程式碼裡的位置

### 2.1 點雲（#1、#4 的紅線）

- 畫的地方：`views.tsx:1130-1160`。兩個 `Points`（綠 `0x52c41a`＝add、紅 `0xff4d4f`＝remove），`depthTest: false`、`renderOrder 3`，所以穿透模型看起來像線。
- 產生的地方：`cellCloud.ts`（把 profile 在參考片的 add／remove 格子沿 scope 擠出，上限 `CLOUD_MAX = 200_000` 點）。呼叫點 `index.tsx:251`（Worker 回 `none` 且非 commit）與 `index.tsx:440`（onLive 時 `makePreview` 回 false）。
- 清掉的地方只有一處：`index.tsx:427` 的 `onLive(null)`。
- 漏掉的路徑：
  - 3D 把手放開走 `onCommit`（`views.tsx:2067-2071`），**沒有** `onPreview(null)`。
  - `endLive()`（`index.tsx:314-319`）清 `livePv`、`pv`，**不清** `liveCells`。
  - commit 那一趟 Worker 回 `none` 時 `index.tsx:251` 的 `if (!committed)` 跳過，點雲原樣留著。
- 記憶體：每個滑鼠事件 `cellCloud()` 都 `decodeRle` 成物件陣列、`flatMap`、再配 `Int32Array`＋`Float32Array`＋`new BufferGeometry`（`views.tsx:1152-1158`）。3D 把手的 pointermove 沒有 rAF 合併（`views.tsx:1956-1972`；2D 的 `SliceEditor.tsx:289` 有）。

### 2.2 圓頭的範圍（#4）

- `roundFrame`（`RoundCard.tsx:21-27`）：`axis = plane ?? longestAxis(ed) ?? ed.editAxis`；Poly-Si 1 寬 288（x）、深 48（z），最長軸 x → 剖面 YZ。`scope = ed.scope.axis === axis ? ed.scope : fullScope(ed.vol, axis)`；ed.scope 的軸是 editAxis（z），不等於 x，於是落到 `fullScope(vol, 'x')`＝0～479。
- 卡片下方的字「套用到：整個結構（z 28～75）」來自 `scopeWords`（`PositionBar.tsx:13-19`），用的是 `ed.editAxis` 與 `ed.selRange`，和實際送出的 scope 不是同一個東西。
- 後果：`previewBox` 是整個結構外框（288×H×48 ≈ 72 萬格）> `LIVE_PREVIEW_CAP = 400_000`（`index.tsx:107`），每幀 Worker 算完才知道要回 `none`（`index.tsx:265-267` 的註解寫明 profile 要 Worker 判斷），然後退回點雲。
- 另外 `applyProfileMask`（`profile.ts:88-97`）對 scope 裡的每一片都整面掃一次「這片有沒有這個結構」：fullScope x 時＝480 片 × (288×384) ≈ 整個陣列讀一遍／每個 key，即使結構只占其中 48 片。

### 2.3 圓頭的回填（#5）

- `fillAt`（`kernel.ts:44-48`）：`backfill === 'orig'` 時取原始體素，**原始就是被搬的材質 → AIR(0)**。閘極頂原本就是 Poly，所以削掉的格子變成白色空氣。
- `removeCell`（`kernel.ts:155-167`）：`follow` 開著時先 `collectLiners` 把 back 方向的薄層（HfO₂、TiN，厚度 ≤ LINER_MAX）一格一格搬進來，最後一格再 `fillAt` → 又是 AIR。這就是圖 5 襯層環裡的白洞與階梯。
- `follow` 預設 true 且持久化（`editor.ts:295`）；`backfill` 預設 `'orig'`（`editor.ts:309`）。
- profile 逐片重算（`profile.ts:103-113`）：`refExact` 讓參考片用原格子，其餘每片用自己的 mask 重跑 `roundCells`。配合 2.2 的 fullScope，fin 穿過閘極的那些 x 片也各自圓一次。

### 2.4 設計區草稿（#3）

- `DesignPanel.tsx:69`：`usePersisted<Draft>('designDraft2', EMPTY)` → localStorage `se3d.v1.designDraft2`，每次 draft 變動就 `JSON.stringify` 寫一次（`persist.ts:20-26`）。
- 變數的 keys 在新增時固定：`factorMeta.tsx:70` `newFactor(... keys = [...ed.sel])`。之後 `ed.sel` 變了只影響第 1 段標題（`DesignPanel.tsx:200、240`）與 `AddFactorButton` 的 disabled，既有卡片不動。
- 預設水平：`presetLevels`（`factors.ts:618-645`）第一組——圓頭且標稱 0 → `[2, 4, 6]` 格；nm 類 → ±0.5 nm；與結構尺寸無關。`RoundCard.tsx:35` 半徑預設 6 格。

### 2.5 結構縮圖（#2）

- `StructurePicker.tsx:250`：`slabOf(ed.orig, ed.active, axis, at)`＝目前 active split 的現況；但 `draft.from` 預設 `'base'`（「從原始開始」，`DesignPanel.tsx:31、347`）。
- `at` 預設 `(range[0] + range[1]) >> 1`（`StructurePicker.tsx:243`），與 `ed.cursor` 無關。
- `structThumbRGBA`（`thumbs.ts:177-178`）：選到的 `(p + [22,119,255]) >> 1`（50% 藍），其餘 `p*0.35 + 255*0.65`。紅 `#e8604c` 混藍 ≈ 紫，和 SiN 的紫撞色。
- 標記（`drawMarks`）畫的是每個變數自己的 `f.keys`，與下拉選的結構無關。

---

## 3. 效能審查：還有哪些會卡或吃記憶體

依「每次互動會付多少」排序。前三項是這次要修的，其餘記錄下來、列入 §5.6 或之後。

| 編號 | 位置 | 問題 | 代價（×3 範例） | 這次處理 |
|---|---|---|---|---|
| P1 | `views.tsx:1956-1972` 3D 把手 pointermove | 沒有 rAF 合併：每個滑鼠事件只要 `v` 變了就 `roundOp` → `makePreview` → 送 Worker。Worker 端雖然「最多一個在飛」，但主執行緒端 `roundOp`、`cellCloud` 每事件都做 | 高頻滑鼠（120 Hz）時主執行緒每秒上百次 decodeRle＋配陣列 | 是（§5.6） |
| P2 | `profile.ts:88-97` 每片「有沒有這個結構」 | 整面掃 A×B 判斷存在；scope 是 fullScope 時等於整個陣列讀一遍／key，而且預覽與套用各付一次 | 480 × 110k ≈ 53 M 次讀／key／次 | 是：用 comp 的 bbox 先剪 scope，片在 bbox 外直接 skip（§5.6） |
| P3 | `RoundCard.tsx:25` scope 落到 fullScope | 見 2.2，連帶 previewBox 過大、每幀白算 | 每幀一次 72 萬格的 profile 試算（Worker） | 是（§5.2） |
| P4 | `cellCloud.ts` + `views.tsx:1130-1160` | 每事件配 2 × (≤200k × 3) Int32＋Float32，再 `new BufferGeometry`；舊的 dispose 但 GC 壓力大 | 每事件 ≤ 4.8 MB 暫存 | 是：整個拿掉（§5.1） |
| P5 | `RoundCard.tsx:55-58` `roundOp` 與 `roundStats` 各自 `useMemo` | 兩個 memo 各算一次參考片的 `roundCells`（同樣輸入算兩遍） | 一片的量，小 | 是：`roundStats` 改吃 `roundOp` 的結果 |
| P6 | `persist.ts:20-26` | 每次 state 變動同步 `JSON.stringify` + `localStorage.setItem`；設計區草稿每個 chip 編輯都寫 | 幾十 KB／次，同步 I/O | 部分：草稿不再持久化（§5.4）；其餘 key 改成 idle 時寫 |
| P7 | `StructurePicker.tsx:247-265` 縮圖 effect | deps 含 `L`、`ed.active`：每一步編輯都重畫（`sliceRGBA` 整面＋縮放），即使在編輯頁看不到設計區 | 一張 2～7 ms | 部分：改畫固定的底後 deps 不含 active 狀態；加 `visible` 守門 |
| P8 | `DesignPanel.tsx:92-100` `rows` useMemo | 每個組合 `JSON.stringify` 當 key＋`comboProblems`；上限 400 列 | 400 × 小 | 否（已有上限） |
| P9 | `lifecycle.ts:131、207`、`workerCore.ts:685-689` | 切到 parked split／匯出時整個陣列 `slice()`（53 MB） | 一次 O(N) memcpy，plan v9 已知且接受 | 否（記錄） |
| P10 | `views.tsx:1119、1221` EdgesGeometry | 有 `EDGE_QUADS_MAX = 60000` 上限 | 已控 | 否 |
| P11 | `index.tsx:436` onLive 第 1 級 `previewOp` cap 2,000,000 | 主執行緒算主切面那一片，cap 是「一片」的量，合理 | — | 否 |

結論：真正會「越用越卡／吃記憶體」的是 P1～P4 的組合（大結構 + 3D 把手 + 點雲），其餘是常數級。

---

## 4. 目標與驗收方式

| 目標 | 怎麼驗 |
|---|---|
| 畫面上不再有任何綠／紅點雲，套用後 3D 只剩正式網格 | `grep cellCloud src` 為空；e2e：對 Poly-Si 1 拖 3D 圓角把手放開後，scene 裡沒有 `Points` |
| 3D 圓頭在 ×3 Poly-Si 1 上拖拉：主執行緒每幀 < 4 ms，Worker 每幀 < 60 ms，不再回 `none` | `bench.ts drag`（新增 round 情境）；e2e 量 `__livePv` 非 null |
| 圓頭 scope＝結構沿剖面法線的起止；卡片文字與 `op.scope` 一致 | 單元：`roundFrame` 回 `{axis:'x', scope:{axis:'x', lo:bbox.x0, hi:bbox.x1}}`；文字測試 |
| 圓頭套用後，削掉的格子是「上面那層」的材質，不是 AIR；襯層不動 | 單元：fin＋HfO₂＋TiN＋Poly＋SiN 的小 fixture，圓頭後 AIR 計數不變、HfO₂／TiN 計數不變 |
| 設計區：換選取、重整頁面後變數區是空的 | 單元：`DesignPanel` 掛載時 draft＝EMPTY；e2e：選 A 新增變數 → 選 B → 變數 0 個 |
| 結構縮圖畫的底＝「從哪裡開始」選的那個；切片＝十字；選到的結構描邊、顏色不變 | 單元：`structThumbRGBA` 選到的像素 RGB 等於原色、邊緣像素為藍；縮圖 at 跟 `ed.cursor` |
| 既有測試全綠、`npm run typecheck`、`npm run build` 通過 | CI |

---

## 5. 設計

### 5.1 拿掉格子點雲

決策：點雲對使用者沒有幫助（看不懂、會殘留、吃資源），整個移除，不做替代顯示。超過即時上限時 3D 不畫預覽，只有主切面第 1 級預覽（這個一直都有），並在 3D 右下角狀態列顯示一行「範圍太大，放開後才會在 3D 看到結果」。

要拿掉的：

- `src/pages/Section3D/cellCloud.ts`：`cellCloud`、`CLOUD_MAX`、`CellCloud` 型別刪除。`globalIndex` 搬到 `src/volume/patch.ts`（`apply.ts`、`workerCore.ts`、`index.tsx:436` 都在用）。
- `views.tsx`：`cells` prop、`cloud` ref、兩個 effect（1130-1172）、`Points`／`PointsMaterial` import。
- `index.tsx`：`liveCells`、`setLiveCells`、外層 `WithLivePv live={liveCells}`，251／440／427 三處呼叫；`import { cellCloud, globalIndex }` 改只 import `globalIndex`。
- `previewWorker.test.ts` 若有點雲斷言，改成斷言 `none` 的回傳。
- README「大陣列的效能」段落與 HelpDrawer 提到點雲的句子改掉。

殘留問題的根治：拿掉後就沒有「沒收掉」的狀態，不必再補 `endLive` 清理。

### 5.2 圓頭的範圍

`roundFrame`（`RoundCard.tsx`）改成：

```
axis  = plane ?? longestAxis(ed) ?? ed.editAxis
at    = 現況不變（十字那片或最近有結構的片）
scope = ed.scopeMode === 'slice'  → { axis, lo: at, hi: at }
        ed.scopeMode === 'custom' && ed.scope.axis === axis → ed.scope
        其餘（整個結構）→ { axis, lo: selBox[axis].lo, hi: selBox[axis].hi }
```

也就是「整個結構」永遠是選取外框沿 `axis` 的起止，不再用 `fullScope`。3D 把手（`index.tsx:1016、1097`）與 ShapeCard 都走同一個 `roundFrame`，自然一致。

文字：`ScopeLine`（`OpCard.tsx:51-60`）目前印 `scopeWords(ed)`，改成接收 `scope` 參數，印實際要送的 `op.scope`：「套用到：整個結構（x 0～287）」。`scopeWords` 加一個 `scopeWordsOf(ed, scope)` 版本，`PositionBar` 原本的呼叫不變。

連帶：previewBox 從 72 萬格變成 Poly-Si 1 真正的外框（與原本相同，因為 profile 的 previewBox 本來就是結構外框——真正省下的是 §5.6 P2 的整面掃描與 Worker 每幀白算的「判斷」）。若外框仍 > 400k，照舊不畫 3D 預覽（只是現在不畫點雲）。

### 5.3 圓頭的回填

新增一種 `Backfill` 值：`'above'`（沿這一片的「上」方向找第一個非結構、非 AIR 的材質；找不到才退回 `'orig'` 規則）。只有 profile op 的削用它，其他 op 不動。

- `kernel.ts`：`fillAt(orig, i, movedMat, backfill, above?: () => number)`；`backfill === 'above'` 時呼叫 `above()`。
- `profile.ts:135` 的 `removeCell` 呼叫：傳入 `above = () => 沿 -v（切面的上）掃到第一個 out[j] ∉ {movedMat, AIR}`，上限 LINER_MAX+1 格，找不到回 `fillAt(... 'orig')`。
- `roundOp`（`round.ts:189`）：`backfill` 參數改為 `backfill === 'orig' ? 'above' : backfill`（使用者明確選了某個材質就照選的）。
- `follow`：圓頭預設不帶襯層。`RoundCard` 新增一個「襯層跟著」開關，預設關，不讀 `ed.follow`；3D 把手的 `roundOp` 呼叫傳 `false`。其他 op 的 follow 行為不變。
- Op 文字（`opWords.ts`）：圓頭加「· 填 SiN」或「· 填上面那層」。

為什麼不直接把全域 `backfill` 預設改掉：長／縮、移動的「填回原始」是對的（結構退回去原本就是那個材質）；只有「削掉頂部」這種形狀操作，原始材質就是自己，才會變空氣。

### 5.4 設計區草稿

- `DesignPanel.tsx:69`：`usePersisted('designDraft2', …)` 改 `useState(EMPTY)`。`factorTemplates`（使用者存的樣板）保留持久化。
- 選取變了就清空：`useEffect` 監看 `selKey = [...ed.sel].sort().join(',')`；和草稿裡所有變數的 keys 聯集不同時 → `setDraft(EMPTY)`（保留 `nameTemplate`、`combine`、`from`）。清空時若草稿有變數，顯示一行 `message.info('換了結構，變數已清空')`。
- 預設水平改依結構尺寸（`factors.ts presetLevels`）：
  - 圓頭、標稱 0：半徑 r_max = min(半寬, 半高)（`roundStats.limit` 已經算了），預設 `[⌊r_max/4⌋, ⌊r_max/2⌋, ⌊3·r_max/4⌋]` 格（最小 1 格、去重）；第二組才是「2、4、6 格」。
  - nm 類（cd、push、level、translate、dilate、taper）：步距 = max(1 格, round(尺寸 × 5%))，三個水平 ±1 步；原本的 ±0.5／1／2 nm 留在後面的選項。
  - `presetLevels` 多收一個 `size?: number`（沿該變數軸的格數），`newFactor` 從 `bboxOfKeys` 算好傳入。
- `RoundCard.tsx:35` 半徑預設：`initial?.r ?? max(1, ⌊limit/4⌋)`。

### 5.5 結構縮圖

- 底：`StructurePicker` 多收 `start: EditState`（DesignPanel 已有 `start`，`DesignPanel.tsx:88` 的 `check` 就是從它來），`slabOf(ed.orig, startSplit, …)`；`from === 'base'` 時 `startSplit = null`（原始），`'active'` 時是 `ed.active`。
- 切片：`at` 初值改成 `clamp(ed.cursor[axis], range)`，並監看 `ed.cursor`（使用者沒有自己拖過滑桿時才跟）。
- 顏色：選到的結構畫原色，外圈 1 px 選取藍描邊（`structThumbRGBA` 改：`sel` 像素不混色；`sel` 且四鄰有非 `sel` → 藍）；其餘仍淡化。
- 標記：只畫 keys 與目前選取有交集的變數；配合 §5.4 清空後，實務上就是全部。

### 5.6 效能補強

- P1：3D 把手的 pointermove 改成和 2D 一樣（`SliceEditor.tsx:289` 的做法）：事件只記 `(clientX, clientY)`，`requestAnimationFrame` 每幀最多算一次 `v`、`roundOp`、`onPreview`。
- P2：`applyProfileMask` 先把 scope 和每個 key 的 bbox（`masks` 之外多傳一個 `boxes: Map<key, BBox>`，`previewOp` 從 `s.L.comps` 拿）相交，片在 bbox 外直接 `skipped`，不做整面掃描；在 bbox 內只掃 bbox 那一塊。
- P5：`roundStats` 改成從 `roundOp` 回來的 `perKey` 算 cut／fill（`decodeRle` 後計數），`limit`／`clamped` 另外用 bbox 算，不再第二次 `roundCells`。
- P6：`usePersisted` 寫入改 `requestIdleCallback`（沒有就 `setTimeout 0`）合併，unmount 時 flush。
- P7：`StructurePicker` 的 effect 加 `if (!visible) return`（DesignPanel 只在實驗頁掛載，但實驗頁在背景 tab 時仍會因為 `L` 變動重畫；用 `IntersectionObserver` 或頁面 tab 狀態守門）。

---

## 6. 每個檔案要改什麼

| 檔案 | 改什麼 |
|---|---|
| `src/pages/Section3D/cellCloud.ts` | 刪除；`globalIndex` 搬到 `src/volume/patch.ts` |
| `src/volume/patch.ts` | 收 `globalIndex`（含測試搬移） |
| `src/volume/apply.ts`、`src/volume/workerCore.ts` | import 路徑改 |
| `src/pages/Section3D/views.tsx` | 刪 `cells` prop 與點雲兩個 effect；3D 把手 pointermove 改 rAF 合併；右下角狀態列加「範圍太大」提示 |
| `src/pages/Section3D/index.tsx` | 刪 `liveCells` 與三處呼叫、外層 `WithLivePv`；3D 把手 `roundOp` 呼叫傳 `follow=false`；`ScopeLine` 傳實際 scope |
| `src/pages/Section3D/RoundCard.tsx` | `roundFrame` 新 scope 規則；半徑預設依 limit；新增「襯層跟著」開關（預設關）；`roundStats` 改吃 op |
| `src/pages/Section3D/OpCard.tsx` | `ScopeLine` 收 `scope`，印實際範圍 |
| `src/pages/Section3D/PositionBar.tsx` | 新增 `scopeWordsOf(ed, scope)` |
| `src/pages/Section3D/opWords.ts` | 圓頭文字加回填材質 |
| `src/slice/round.ts` | `roundOp` 的 backfill 映射到 `'above'`；`roundStats` 簽名改 |
| `src/volume/volume.ts` | `Backfill` 加 `'above'` |
| `src/volume/kernel.ts` | `fillAt` 收 `above` 回呼；`removeCell` 傳遞 |
| `src/volume/profile.ts` | 削時提供 `above()`；加 bbox 剪裁（P2） |
| `src/volume/preview.ts` | `previewOp` 把每個 key 的 bbox 傳給 `applyProfileMask` |
| `src/volume/factors.ts` | `presetLevels(f, nm, size?)` 依尺寸；`validateLevels` 不變 |
| `src/pages/Section3D/factorMeta.tsx` | `newFactor` 算 `size` 傳入 |
| `src/pages/Section3D/DesignPanel.tsx` | 草稿改 `useState`；選取變了就清空；把 `start` 傳給 `StructurePicker` |
| `src/pages/Section3D/StructurePicker.tsx` | 底改 `start`；`at` 跟十字；標記過濾；visible 守門 |
| `src/pages/Section3D/thumbs.ts` | `structThumbRGBA` 改描邊 |
| `src/ui/persist.ts` | 寫入合併到 idle |
| `src/pages/Section3D/HelpDrawer.tsx`、`README.md` | 刪點雲敘述；加「圓頭填上面那層、預設不帶襯層」、「換結構變數清空」 |
| `scripts/bench.ts` | `drag` 加 round 情境（Poly-Si 1 3D 把手） |
| `scripts/e2e/m14.cjs`（新） | §4 的三個 e2e |

---

## 7. 測試清單

單元（vitest）：

1. `round.test.ts`：`roundFrame` 在「整個結構」模式下 scope＝選取外框沿 axis 的起止；`slice` 模式＝`{at, at}`；`custom` 且軸相同＝ed.scope。
2. `kernel.test.ts`：`fillAt(..., 'above', above)` 呼叫 `above()`；`above` 回 -1 時退回 `'orig'` 規則。
3. `profile.test.ts`（新 fixture：fin＋HfO₂＋TiN＋Poly＋SiN cap）：圓頭 `follow=false, backfill='above'` 後 AIR、HfO₂、TiN 計數不變，削掉的格子全是 SiN；同一 fixture 用舊規則會出現 AIR（對照，確認測試有鑑別力）。
4. `profile.test.ts`：bbox 剪裁後結果與未剪裁逐位元組相同；`report.skipped` 相同。
5. `factors.test.ts`：`presetLevels` 給 `size` 時第一組依尺寸；不給時行為同舊版。
6. `thumbs.test.ts`：`structThumbRGBA` 選到的內部像素＝原色、邊界像素＝藍；未選像素淡化。
7. `DesignPanel` 行為測試（`@testing-library/react` 已在專案內則用，否則以純函式 `nextDraft(prev, selKey)` 抽出來測）：選取 keys 與草稿不交集 → EMPTY。
8. `patch.test.ts`：`globalIndex` 搬家後測試跟著搬。

e2e（`scripts/e2e/m14.cjs`，headless Chromium）：

1. 選 Poly-Si 1 → 3D 圓角把手拖 10 格放開 → 等套用完 → scene 中 `Points` 數＝0；`__livePv` 在拖拉中非 null（表示沒有超過上限）。
2. 套用後讀 XY 中間一片，AIR 計數等於套用前。
3. 實驗頁：選 Si fin 1 加一個圓頭變數 → 回編輯頁選 Poly-Si 3 → 實驗頁變數 0 個；重整頁面後變數 0 個。

bench：`bench.ts drag round ×3`，記錄主執行緒每幀 ms 與 Worker 每幀 ms，寫進 README 效能表。

---

## 8. 里程碑、工作拆解、驗收

| 里程碑 | 內容 | 驗收 |
|---|---|---|
| M14.1 拿掉點雲＋把手 rAF | §5.1、§5.6 P1、P5 | 無 `Points`；拖拉主執行緒 < 4 ms／幀；既有測試綠 |
| M14.2 圓頭範圍與文字 | §5.2、§5.6 P2 | `roundFrame` 測試；×3 Poly-Si 1 拖拉 `__livePv` 非 null；文字＝實際 scope |
| M14.3 圓頭回填 | §5.3 | fixture 測試：無 AIR、襯層不動；HelpDrawer／README 更新 |
| M14.4 設計區草稿與預設 | §5.4 | 換選取清空；重整為空；預設依尺寸 |
| M14.5 結構縮圖 | §5.5、§5.6 P7 | 底＝start；切片跟十字；描邊 |
| M14.6 收尾 | §5.6 P6、bench、e2e、README 效能表 | `npm test`、`typecheck`、`build` 綠；m14.cjs 三項通過 |

每個里程碑一個 commit，訊息寫「v14 M14.x：…」，與 v12／v13 一致。順序固定：M14.1 → M14.2 → M14.3 可以連著做（同一批檔案）；M14.4、M14.5 互相獨立。

---

## 9. 風險與對策

| 風險 | 對策 |
|---|---|
| 拿掉點雲後，大範圍拖拉時 3D 完全沒回饋 | 狀態列一行提示＋主切面第 1 級預覽仍在；§5.2 修完後 Poly-Si 整根的外框已在上限內，實際會看到即時網格 |
| `'above'` 在頂部是 AIR 的結構（例如最上層沒有 cap）找不到材質 | 退回 `'orig'` 規則（還是 AIR），和現在一樣，不會更差；op 文字會寫「填空氣」讓人看得到 |
| 既有 split／匯出的 JSON 樣板帶 `backfill: 'orig'` 的圓頭 | `upgradeOp` 不改舊 op 的語義（重放結果不變）；只有新建的圓頭用 `'above'`。樣板載入時同樣只對新建套用 |
| 清空草稿太積極（使用者只是暫時點了別的結構看一眼） | 只在「選取 keys 與草稿所有變數 keys 無交集」時清；清之前若有變數顯示提示；樣板功能保留可以存回來 |
| bbox 剪裁（P2）漏掉 scope 內、bbox 外但 mask 有值的片 | bbox 來自 `comps[].bbox`，與 mask 同源；測試 4 逐位元組比對 |
| 3D 把手 rAF 合併後放開時最後一次 `v` 還沒算 | pointerup 先 flush 一次再 `onCommit`（2D 的 `SliceEditor` 同樣處理） |

---

## 10. 決策記錄

- **點雲整個拿掉而不是修清理時機**：使用者明確表示沒有幫助；拿掉後沒有殘留狀態可言，也省掉每事件的配置。
- **圓頭回填用新值 `'above'` 而不是改全域預設**：其他 op 的「填回原始」語義是對的；只有「削自己」才會變空氣。
- **圓頭預設不帶襯層**：襯層跟搬是為長／縮設計的（殼跟著面走）；對頂部削圓，襯層本來就不在削的方向上，跟搬只會製造洞。
- **草稿不持久化**：使用者要求「換結構或重開頁面預設就是空的」；要留的設計走「樣板」功能（仍持久化）。
- **縮圖底用 `start`**：縮圖的目的是「看會改哪裡」，必須和產生時用的底一致。
- **文字跟著 op.scope 走**：顯示層不再自己推算範圍，避免再出現「寫 z 28～75、送 x 0～479」。

---

## 11. 實作紀錄

每個里程碑一個 commit（「v14 M14.x：…」）。和計畫不同的地方與原因：

| 項目 | 計畫 | 實際 | 原因 |
|---|---|---|---|
| `globalIndex` | 從 `cellCloud.ts` 搬到 `patch.ts` | `apply.ts` 本來就有一份，兩份合成一份放 `patch.ts`，測試放 `patch.test.ts` | `cellCloud.ts` 的那份和 `apply.ts` 的重複 |
| P2／P3 的代價 | 「每幀 Worker 算完才知道要回 none」「fullScope 時每片整面掃」 | `profileBox` 本來就把外框沿法線剪到「scope ∩ 結構外框」，Worker 先判斷外框大小、0.3 ms 就回 none；整面掃描只發生在整個陣列的 `applyOp`（重播） | 量測（`bench.ts drag`）。§5.2 的收穫是範圍與文字正確、套用報告的「略過」正確；P2 的外框剪裁對重播有效 |
| ×3 拖拉的 3D 即時預覽 | 修完範圍後外框在上限內 | ×3 Poly-Si 1 外框 432×129×75＝418 萬格，仍超過 40 萬；不設上限 Worker 500 ms＋網格 300 ms | 外框本來就是結構那一段，範圍修正不會讓它變小。3D 改寫「範圍太大，放開後才會在 3D 看到結果」；×1 在上限內，e2e 驗證拖拉中有 3D 預覽 |
| 「上面那層」的方向 | 沿 −v（切面的上） | 沿 3D 的 −y；XZ 剖面（沿 y）沒有「上」，照舊 `'orig'` | XY、YZ 剖面的 v 就是 y；XZ 剖面的 v 是 z，不是上 |
| 「上面那層」的掃描上限 | LINER_MAX＋1 格 | 先越過結構自己（mask 裡、還是原材質的格子，不限格數），第一格就是上面那層；空氣＝沒有 | 角區高度＝半徑，可以超過 5 格；不限格數也不會跑出 `profileBox`（外框往上至少留 1 格） |
| 草稿 | `useState(EMPTY)` | `draft.ts` 的模組記憶體：重新整理＝空、切到編輯頁再回來還在；順手刪掉舊的 localStorage 草稿 | 實驗頁在編輯頁時會卸載，只用 `useState` 會在切頁時丟掉 |
| 清空條件 | 「keys 不同就清」與風險表「無交集才清」 | 無交集才清；沒選東西（點空白）不清 | 照風險表，比較不積極 |
| 預設水平的尺寸 | `presetLevels(f, nm, size?)`，`newFactor` 算好傳入 | `Factor.size`（`makeFactor`／`fromTemplate` 量），`presetLevels` 預設吃它 | 卡片上的預設按鈕（`LevelsEditor`）和新增時帶的第一組要一致 |
| 實驗頁圓頭變數的襯層 | 沒寫 | 預設不帶（樣板寫了 `follow` 才照樣板） | 和 3D 把手、圓頭卡片一致 |
| P7 守門 | `visible` | `IntersectionObserver`；外框用數字當 key，每一步編輯不再因 `L` 換了就重畫 | DesignPanel 只在實驗頁掛載，背景 tab 的問題本來就不存在；重畫的主因是 `L` 每步都換 |
| 單元測試位置 | 分散在 round／kernel／profile／factors／thumbs | 集中在 `src/volume/v14.test.ts`（和 v10～v12 一樣），`factors.test.ts`、`thumbs.test.ts`、`patch.test.ts` 跟著改 | 和既有慣例一致 |
| e2e「scene 裡沒有 Points」 | 數 scene 的 Points | 程式裡已沒有 `Points`（`grep`）；e2e 驗拖拉中 `__livePv` 非 null、放開後沒有殘留提示 | scene 沒有對 e2e 開放 |

量測（雲端容器、Node 22，`npx vite-node scripts/bench.ts drag 1 3`）：

| 3D 圓角把手拖 Poly-Si 1（半徑 1→16） | 主執行緒每幀（中位數／最大） | Worker 每幀（中位數／最大） | 超過即時上限 |
|---|---|---|---|
| ×1 新範圍（結構那段） | 0.5／2.5 ms | 25.4／31.3 ms | 0／15 幀 |
| ×1 舊範圍（整條 x） | 0.4／0.7 ms | 22.0／41.9 ms | 0／15 幀 |
| ×3 新範圍 | 3.7／16.5 ms | 0.3／0.8 ms（回 none） | 15／15 幀 |
| ×3 舊範圍 | 2.2／4.6 ms | 0.3／1.5 ms（回 none） | 15／15 幀 |

主執行緒的數字不含點雲；v13 每個滑鼠事件還要做一次點雲（×3 沿整條 x 擠出、配兩個最多 60 萬的陣列與一個 BufferGeometry），v14 拿掉了，且 rAF 每幀最多算一次。

e2e：`scripts/e2e/m14.cjs` 三項全過（×1：拖拉中有 3D 預覽、範圍 x 8～151、填上面那層、不帶襯層、AIR 692,400 → 692,400；換結構變數清空、切頁回來還在、重新整理為空）；`m10.cjs`、`m12.cjs`（`SKIP_X2=1`）照舊通過。

沒做到、留給之後：×3 大結構拖拉時的 3D 即時預覽（需要只算角附近幾排或分 chunk 漸進的預覽）。
