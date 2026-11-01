# 計畫 v15：效能黑洞——每一步的固定成本、身分抖動、拖拉重算、載入與匯出的整陣列路徑

> 位置：`docs/plan-v15-performance-holes.md`，分支 `claude/upbeat-einstein-wod16i`，接在 plan v14 之後（commit fac120f）。
> 出發點：2026-11-01 對整個專案做的一輪效能盤點（三個方向平行審：Worker／體素引擎、主執行緒 3D 與 React、切面幾何／split 生命週期／匯出），每條都回到原始碼對過，`bench.ts step 1 2` 在本機重跑確認 README 已記的項目確實做掉了。本計畫只列**還剩下的**。
> 範圍：主執行緒每一步的固定成本（選取 mask、diff 外框、relabel 快照）、物件身分抖動造成的連鎖重算、2D 拖拉與每步重描、3D 拾取與繪製、`.vti` 載入與同格式匯出、zip、實驗頁的疊圖／並排／縮圖、幾個只會長不會縮的快取。**Op、manifest、補丁格式、`.vti` 輸出的內容（值）都不動；Worker 協定只加不改。**
> 狀態：M15.0～M15.7 完成（2026-11-01，HEAD b06f914 之後）；§3 表有「實測」欄、§11 有量測與紀錄，沒達到的在 §11.3。頁面層級的列待協調者跑 `perf.cjs`／`m15.cjs` 補。

---

## 目錄

0. 一句話
1. 問題總表（編號 → 位置 → 代價）
2. 查證：每一條在程式碼裡的位置與觸發路徑
3. 目標與量法
4. 原則、不做的事
5. 設計
   - 5.1 每一步的固定成本（A1～A5、C7、D1、D5）
   - 5.2 身分與 render（B1、B2、B5、B7）
   - 5.3 2D 拖拉與每步重描（B3、A4、D2、D3）
   - 5.4 3D 拾取與繪製（B4、B6）
   - 5.5 載入與匯出（C1～C4）
   - 5.6 實驗頁（C5、C6）
6. 每個檔案要改什麼
7. 測試清單
8. 里程碑、工作拆解、驗收
9. 風險與對策
10. 決策記錄
11. 實作紀錄

---

## 0. 一句話

把「每一步都付、而且愈用愈貴」的幾個 O(N)／O(touch) 掃描換成 O(補丁)；把 `scope`／`ed`／`L` 這幾個每次都換新物件的身分修穩，切斷它們帶起的 Worker 往返、把手重建與整頁 render；2D 拖拉同一個 Op 只算一次；`.vti` 解碼搬進 Worker、同格式匯出只重壓改到的 block、zip 邊寫邊丟；疊圖／並排／縮圖不再在 render 裡整片比對；復原堆疊、幾何快照、輪廓快取都改成有位元組上限。

---

## 1. 問題總表

嚴重度＝40M voxel 時的代價 × 觸發頻率。「每步」＝任何一次套用／復原／重做／排隊的步驟。

### A. 每一步都付、而且隨著編輯愈來愈貴

| # | 位置 | 問題 | 觸發 | 代價（40M） |
|---|---|---|---|---|
| A1 | `editor.ts:364` `selMask`、`volume.ts:1586` `maskOf`、`editor.ts:402` `affMask` | memo 鍵是 `L`，而 `wrap()`（`editor.ts:205`）每一步都造新的 `L`；`keepSel`（`:480`）每步換新的 `Set`。所以只要有選取，每步 `new Uint8Array(N)` 歸零＋掃選取外框；範圍不是整根時 `maskInScope` 再配第二份 N | 每步 | 10～20 ms 配置；選到基板 ×3 190 ms（README 寫成「每次點選」，實際是每步） |
| A2 | `editor.ts:189` `statsOf` → `lifecycle.ts:148` `buffersStats` → `patch.ts:155` `tightBox(dims, diff, touch)` | `touch` 是所有步驟 data box ∪ S ∪ moves 的累積聯集、只會長大；每步在主執行緒掃整個 `touch` 的 `diff`。Worker 端有 `Book.tight`（`workerCore.ts:211`）避開，主執行緒沒有 | 每步 | 相隔很遠改兩下之後每步 20～40 ms long task，剛好疊在貼補丁那一刻 |
| A3 | `volume.ts:1354-1379` `relabelInPlace` | `Smax = R ∪ 所有「碰到」結構的 bbox`，整塊 `cropBox` 成 Int32 快照。只是相鄰（基板、STI、橫跨整片的襯層）也算碰到；最後 `before` 只切 S，大半快照白做 | 貼著大層的 push／level／profile | demo ×3 基板 14M voxel → 每步 57 MB 配置＋memcpy（Worker） |
| A4 | `SliceEditor.tsx:211` `stairs`、`model.ts:280` `verifyKey`（經 `ModelStore.get`）、`handleOps.ts:40` `sliceContext` | 都吃 `L` 當依賴 → 每步重描每個已選 key 的整個 bbox，就算這一步沒碰到這一片 | 2D 模式每步 | 選到基板 ×3 10～50 ms／步 |
| A5 | `workerCore.ts:634`（`layer` 非增量）、`:540`（`mesh only.mat`）`boxOf(vol, closure)` | 空洞層掃整個陣列、每體素一個 closure call。增量路徑只在 `base === par.from` 成立 | 開 X-ray、切 split、undo 到非相鄰版本、載入後第一眼 | 100～200 ms Worker 時間才開始 mesh |
| C7 | `workerCore.ts:419` `report.blockedAt` | 無上限 `number[]` structured clone 回主執行緒；`summarize`（`report.ts:40`）到了才截 50k | 往厚材質推一整面 | 每步 clone 數百萬個數字 |
| D1 | `editor.ts:177` `HISTORY_LIMIT = 50` | 只限筆數不限位元組；一筆＝10 B／voxel × step box。README 第 77 行寫「每 split 10 步」已過期 | 大 box 的 translate／level | ×3 基板級一筆 50～200 MB → 50 筆上 GB |
| D5 | `volume.ts:733-735` `dilateMask` | 所有候選格進 JS array 用 comparator `.sort()` | 保形層 dilate | ×3 襯層百萬級候選 0.5～2 s／步 |
| — | `apply.ts:33` 與 `preview.ts:342` | 同一個 Op 算兩次 `previewBox`（profile 含 `linerReach` 迴圈） | 每步 | 小 |

### B. 每個滑鼠事件／每幀

| # | 位置 | 問題 | 代價 |
|---|---|---|---|
| B1 | `editor.ts:369-376` `scope` memo 依賴 `cursor` | `whole` 模式下每次 cursor 變都回傳值相同、身分不同的 `fullScope()`。連鎖：`index.tsx:587` `selBBox` 重算 → `views.tsx:1194` 選取層 effect 打一次 Worker `layer`（`base === sid` 回空，但仍是一對 postMessage＋`setLayer`＋兩幀）→ `views.tsx:1231` 把 6 個 `ArrowHelper`＋4 個角把手全部 dispose 重建（GPU 重傳）→ `SliceEditor.tsx:231` `sctx` 重算 `sliceContext`（基板 ×3 ≈ 18 萬格 `inside()`）→ `editor.ts:1110-1180` 所有 op factory 重建 → 每張 OpCard 的 `op` memo 與 `describeOp` 重跑 | 點切面、滾輪換片、`,` `.`、PositionBar、3D 任一次 pick 都觸發 |
| B2 | `editor.ts:1400-1544` 回傳 ~140 欄位的新物件 `ed` | 整個 `ed` 直接丟給 `StructureList`／`SplitPicker`／`EditToolbar`／`Inspector`（5 張 OpCard）／`ChangesTab`／`PositionBar`／`FloatingToolbar`，下游沒有東西能 memo。每步 `setBusy`×2、`setQueued`、`setStepSeq`、`setReport`、`setLast` 各觸發一次整頁 reconcile；`index.tsx:812` 4.1 s timer 再一次 | 最糟：`src/ui/Resizer.tsx:26-30` 沒有 rAF，拖欄寬時每個原始 pointermove 都整頁 render＋`renderer.setSize` |
| B3 | `SliceEditor.tsx:494` `tick()` → `gestures.ts:128` `gestureToOp` → `:174` `profileDelta` → `raster.ts:69` `deltaOf` | 每個 rAF 都重跑完整 gesture→Op：`inside()` 掃 key 所有 ring 的聯集 bbox、`rasterize`、兩次 BFS 各配 Int8＋Uint8、拿的 BFS 把所有外面的格子都當種子推進 JS array、`encodeRle` 排序、`edgeAmount` 再算三次；然後 `onLive`（`index.tsx:440`）再跑一次 `previewOp` 並送 Worker。但 `dragDisp` 取整，整數格之間 Op 位元組相同＝同一個 Op 算 2～4 次。「對應」開著時 `mirror.ts:118` 對主 key 再算一次 `profileDelta` | bench 只量 fin（0.5～4 ms／幀）；選到基板或整層 ×3 ≈ 15～40 ms／幀 |
| B4 | `views.tsx:248` `lazyRaycast`、`:1474` `hit()`、`:1497` `hitsAlong`、`:1524` `hitSel` | 射線穿過的每個 chunk 都在 hover／click handler 裡同步建 `MeshBVH`（64³ chunk 包圍球重疊多，一條射線 10～30 個）；一步之後碰到的 chunk 又是沒 BVH 的新 geometry；`idleBVH` 每次 `showParts` 都另起一條 idle 鏈 | 一步後第一次 pointermove 50～200 ms |
| B5 | `views.tsx:947-972` render loop；`SliceEditor.tsx:276` `useLayoutEffect` | 每幀 `tag.offsetWidth`（強制 layout）接著寫 `style.left/top` → 下一幀再強制 layout；工具列寬度每 render 量一次 | 有選取時每幀 layout thrash |
| B6 | `views.tsx:515-518` | `antialias: true` × `pixelRatio ≤ 2` → HiDPI 每 CSS px 最多 16 sample，再加 DoubleSide／透明選取層。README 把 ×2 拖拉剩下的 long task 歸給「每幀重畫 3D」，fill cost 就是這裡 | 拖拉／轉視角每幀 |
| B7 | `SliceEditor.tsx:778` hover `hitAt` 不經 rAF、`insideKey` 每次 `findIndex`；`index.tsx:369`、`SliceEditor.tsx:532`、`views.tsx:2200` listener 每 render 重掛 | 小項，但被 B2 的 render 次數放大 | — |

### C. 載入、匯出與大量 split

| # | 位置 | 問題 | 代價 |
|---|---|---|---|
| C1 | `vti.ts:732-745` `encodeVtiLike`、`:633-640` `encodeBlock`、`:615` `deflate` | 同格式匯出：每個 split × 每個比例陣列整個 inflate → `.slice()` → 改 `chg` 幾個點 → 整個重新 deflate；每 32 KB 一塊開一個 `CompressionStream`＋`Response.arrayBuffer()`、序列 await。載入端 `readBlock`（`:53-70`）同樣每塊一個 `DecompressionStream`。另外 `chg: number[]`＋整陣列 `data !== origData` 比對、`b64()`（`:603`）逐位元組 `s +=`、`xml.slice()+text+xml.slice()` 每個陣列複製整個 XML | 40M × Float32 × 8 材質 ≈ 每 split 1.3 GB inflate＋1.3 GB deflate＋39k 次 stream 建立；100 個 split 全部塞在同一條 Worker 佇列，apply／chunks／preview 全卡在後面 |
| C2 | `index.tsx:650-678` `exportAll`、`zip.ts:28-93` `zipStore`、`download.ts` | 所有 split 編完先全進 `files[]`，`zipStore` 再配一塊總長度的 `Uint8Array` 複製一次（尖峰 ≈ 2× 總量＋Blob），`crc32` 是主執行緒逐位元組 JS 迴圈；欄位 32-bit、沒有 ZIP64，超過 4 GiB 靜默 wrap 成壞檔 | 20 個 40 MB split ≈ 1.6～2.4 GB 尖峰＋~1 s UI 卡住；100 個就配置失敗或壞檔 |
| C3 | `UploadPanel.tsx:40`、`client.ts:216-218` `exportMetaIn`、`workerCore.ts:492` | 原檔 `ArrayBuffer` 主執行緒留一份（只為了 `index.tsx:603` 的一個布林值），`raw.slice(0)` 複製一次、postMessage 沒給 transfer list 又 structured clone 一次 | 2× 檔案大小常駐＋2× 瞬時；比例陣列 .vti 數百 MB～1 GB |
| C4 | `UploadPanel.tsx:24` `decodeVti` 在主執行緒 | argmax O(N·k)、ascii 走 `Float64Array(N)`（320 MB）＋整個檔解成 JS 字串 | 上傳時整頁凍結數秒到數十秒 |
| C5 | `OverlayView.tsx:30-37`、`CompareView.tsx:32-44`、`overlay.ts:27` `contourOf` | `lines` 沒 memo：每次 render 對每個 split 跑 `sliceDiff`（整片比對）；legend `onMouseEnter` 的 `setHover` 就重跑；`contourOf` 描整片而非 key 的 bbox；cache 400 筆、200 個 split 換片全部逐出；`CompareView` 每 render 對每張卡 `pairMask`＋`sliceDiff`；`overlay.ts:97` `diffPair`（24 份整陣列 mask）是死碼 | 200 split ×1 ≈ 40～80 ms／hover；×3 ≈ 0.3～0.6 s／hover、換片 20 s+ |
| C6 | `thumbs.ts:82`、`:154` | 縮圖先 `sliceRGBA` 畫整片（×3 6.6 MB）再裁 ≤ 240 px；`sliceRGBA` 已有 `patch`／`out` 參數但沒有裁切窗 | 200 split 進實驗頁 1～4 s 主執行緒時間＋GC |

### D. 只會長、不會縮的記憶體

| # | 位置 | 問題 |
|---|---|---|
| D2 | `model.ts:444-458` `ModelStore.keep()`、`:416` `snapshot` | 每次 commit／verify 深拷貝整個 model（所有 ring 的 `exact` 階梯點），`SNAP_LIMIT = 400`、只在換檔時 `clear()`；選到基板時每份 0.2～2 MB → 80～800 MB |
| D3 | `relative.ts:112-141` `ringCache` | 以 `pts.join(';')` 當 key，滿 8192 時整個 `clear()`（連 `byKey` 一起），下一幀重描風暴 |
| D4 | `volume.ts:1540-1551` 補洞 | 釋放編號時永遠搬最後一個 comp，不管它多大；搬動的 bbox 又餵進 `touch`。**不做**，見 §10 D4 |

查過沒問題、本計畫不碰的：每步協定（`apply`／`derive`／`chunks`／`layer` 都 transfer）、chunk mesher 共用 scratch、主執行緒 chunk cache 上限與 dispose、relabel flood fill 有界、`persist.ts` 小量 idle 批次、ResultGrid 虛擬化＋IntersectionObserver 縮圖、ComboTable 一次一列、Blob URL 有 revoke、parked split 只留補丁、`liveValue` 讓滑鼠移動不觸發整頁 render、three 資源生命週期。

---

## 2. 查證：每一條在程式碼裡的位置與觸發路徑

### 2.1 A1：為什麼 `selMask` 每步重算

- `wrap(owner, buf, comps, version, dims)`（`editor.ts:205`）每步回傳新的 `{ vol, L: { labels, comps }, version, owner }`——陣列身分不變、物件身分每步換（`Split` 的註解 `editor.ts:120` 明寫這是規則：靠它讓 memo 重算）。
- `selMask = useMemo(() => maskOf(L, sel, vol), [L, sel, vol])`：`L` 與 `vol` 都是每步新的。
- `keepSel`（`editor.ts:480`）：`setSel(prev => new Set([...prev].filter(...)))`——就算一個都沒濾掉也是新 `Set`。
- `maskOf`（`volume.ts:1586`）：`new Uint8Array(L.labels.length)` 再掃選取的聯集 bbox。
- `affMask = maskInScope(selMask, vol, scope, selBox)`（`editor.ts:402`）：scope 不是整段時 `new Uint8Array(mask.length)` 再複製 scope ∩ bbox。
- 消費者（都另外依賴 `vol` 或 `state`，所以 mask **身分不變也會重畫**）：`SliceEditor.tsx:321` `drawSlice`（deps 含 `vol`）、`views.tsx:1419` 剖面貼圖（含 `state`）、`SlicePreviewLayer.tsx:84`（含 `vol`）、`index.tsx:535` `slicesWith`（含 `ed.vol`）、`OpCard.tsx:247` `thicknessOf`（含 `ed.vol`）、`views.tsx:502` kick（含 `state`）。
- 不變量（`lifecycle.ts:1-3` 的註解）：一步之後 `stepTouch(step)` 外面的 data 與 labels 和改前逐位元組相同。所以 mask 只有 `stepTouch` 裡會變。

### 2.2 A2：主執行緒的 diff 外框

- `statsOf`（`editor.ts:189`）用 `WeakMap<EditState>` 快取——`cur` 每步新的，所以每步 miss。
- `buffersStats`（`lifecycle.ts:148`）→ `tightBox(dims, b.diff, b.touch)`（`patch.ts:155`）掃整個 `touch`。
- `touch` 來源：`applyOne`（`editor.ts:530`）、`stepInPlace`（`:667`）、`run`（`:489`，Worker 回的 `touch`），都是 `unionBox(buf.touch, stepTouch(step))`，從不縮。
- Worker 端 `Book` 有 `diffBox`＋`tight`（`workerCore.ts:211-229` `diffBoxOf`／`growDiffBox`）：寬鬆 union 只掃上一次貼合的 diffBox ∪ 這一步的 box。主執行緒 `SplitBuffers`（`editor.ts:105`）沒有這兩欄。
- `carryStepStats`（`patch.ts:114`）已經逐格走過補丁裡每個改變的格子——在這裡順手維護三條軸的 diff 直方圖就能 O(X+Y+Z) 得到貼合外框（§5.1 A2）。
- 同一個膨脹的 `touch` 也是 `extractPatch → changedBox`（`lifecycle.ts:40-74`，每格 5 B 比對）與 `resetScratch` 的 `copyIn`（`workerCore.ts:235-255`）的掃描範圍；A3／A4 把 S 與 moves 收小之後它才會跟著小。

### 2.3 A3：relabel 的快照

- `relabelInPlace`（`volume.ts:1326`）步驟：1 在 R±1 裡標 `touched`／`lost` → 算 `Smax`（R ∪ 所有 touched 的 bbox）→ `PS = cropBox(labels, Smax)` → 2 清掉 F（R ∪ lost 的 bbox）裡 lost 的格子與 R 裡改過的格子 → 3 flood fill F → 4 union-find → 5 類別 → 6 投票（讀 `PS`，**只在 F 裡**）→ 7 編號、被併掉的照舊結構 bbox `grow` 進 S、寫回 S → 8 補洞 → `before = PS 裁到 S`。
- `PS` 兩個讀者：步驟 6（範圍 F ⊆ Smax）、`before`（範圍 S）。S \ F 的部分是步驟 7 才併進來的結構：它們的 labels 在「寫回 S」那個迴圈之前都還沒被動過，可以直接從 `labels` 讀。所以快照只需要 F。
- 代價：demo ×3 fin 長高一步，R 幾千格、F 幾萬格，但 Smax 把 Si 基板（≈ 14M）或 STI（≈ 5.5M）整塊包進來 → 57 MB／22 MB 的 Int32 配置＋memcpy 每步。

### 2.4 A4、B3：2D 的每步與每幀

- `stairs`（`SliceEditor.tsx:211`）deps `[L, keysTag, axis, at]`：每步對每個 key `boundaryLoops` 整個 bbox。
- `ModelStore.get`（`model.ts:462`）：版本變了就 `verifyKey`（`:280`，rasterize＋O(bbox) 比對）每個 key；對不上才 `retraceKeepingHandles`。`keep()`（`:453`）每次 verify／commit 都 `snapshot()` 深拷貝（`:416`：`exact` 的每個點都複製）。
- `sctx`（`SliceEditor.tsx:231`）deps 含 `L`、`gesture?.scope`：`sliceContext`（`handleOps.ts:40`）對每個 key 掃 bbox 算 `area`（只有「對應」配對才用到）。
- `tick()`（`SliceEditor.tsx:494`）每個 rAF：`opFor` → `opOfGesture` → `gestureToOp`／`mirroredOp` → `profileDelta` → `rasterize`／`deltaOf`／`encodeRle`，再 `onLive(op)` → `index.tsx:446` `previewOp` 第 1 級 → `makePreview` 第 2 級送 Worker。`dragDisp`（`snap.ts:148,154`）取整，所以整數格之間 Op 相同。
- `deltaOf`（`raster.ts:69`）：`bfs(seed, target)` 先 `for i<W*H if seed(i) q.push(i)`——拿的那次 seed 是 `!before[i]`，整個 bbox 的外面都進 JS array；每次呼叫配 `Int8Array(W*H)`＋`Uint8Array(W*H)` ×2。
- `mirroredOp`（`mirror.ts:88`）：`main = gestureToOp(...)`（已含主 key 的 `profileDelta`），混合時 `:118` 對 `[h.key, h]` 再算一次。

### 2.5 B1、B2：身分

- `scope`（`editor.ts:369`）deps `[scopeMode, editAxis, cursor, customRange, vol]`，`whole` 時 `fullScope(vol, editAxis)` 新物件。
- 吃 `scope` 身分的：`selBBox`（`index.tsx:587`）→ 選取層 effect（`views.tsx:1194`，deps 含 `scope`、`selBBox`）、把手 effect（`:1231`，deps 含 `selBBox`）、kick（`:502`）、`SliceEditor` 的 `gesture={{ scope: ed.scope, ... }}`（`index.tsx:886`，本來就每 render 新物件）→ `sctx`、`geo={{...}}`（`:898`）、op factory（`editor.ts:1110-1180`）。
- `ed`（`editor.ts:1400`）：物件字面值；裡面很多函式是 `useEditor` 內的普通箭頭函式（`applyOne`、`commitTo`、`headText`…），每 render 新的。
- `Resizer`（`src/ui/Resizer.tsx:26`）`move` 直接 `onDrag(q - p)` → `index.tsx:1442` `setLeftW` → 整頁。
- listener：`index.tsx:369-432` 鍵盤 effect 無 deps；`SliceEditor.tsx:532-596` 同；`views.tsx:2200` SliceView wheel 依賴 `onStep`（`index.tsx:969` 每 render 新 closure）。

### 2.6 B4～B6：3D

- `lazyRaycast`（`views.tsx:248`）：球相交就 `new MeshBVH(g)`；`hit()`（`:1474`）`intersectObjects(pickables())` 對所有 chunk，`firstHitOnly = !plane`。`hitsAlong`／`hitSel` `firstHitOnly=false` 走完全部。`idleBVH`（`:258`）每次呼叫 `ric(step)` 另起一條鏈。
- render loop（`:947-972`）：`renderer.render` 之後讀 `tag.offsetWidth` 再寫 `style`。
- `new WebGLRenderer({ antialias: true })`＋`setPixelRatio(Math.min(2, dpr))`（`:515-518`）。

### 2.7 C1～C4：載入與匯出

- `UploadPanel.load`（`UploadPanel.tsx:52`）：`file.arrayBuffer()` → `inspectVti(buf)`（只解標頭與 FieldData）→ 使用者確認 → `loadVti` → `decodeVti(buf)` **在主執行緒** → `ed.loadVolume(vol, { raw: buf, fractions })` → `loadOrig`（Worker `load`，`vol.data` transfer）＋ `exportMetaIn(m.raw, ...)`（`client.ts:216`：`raw.slice(0)`、無 transfer list）。
- `decodeVti` 比例陣列路徑（`vti.ts:479-496`）：每個陣列 `readValues` → `readBytes` → `readBlock`（每塊 `inflate` 序列 await）→ argmax。
- `encodeVtiLike`（`vti.ts:701`）：整陣列 `data !== origData` 建 `changed`＋`chg`；每個比例陣列 `readBytes(h,d).slice()` → 改 `chg` → `encodeLike` → `encodeBlock`（每塊 `deflate`）→ `blockText`（inline 時 `b64`）；步驟 5 `xml = xml.slice(0,s)+text+xml.slice(e)` 每個 rep 一次；最後 `catBytes`。VTK 的壓縮格式：header `[nb, blockSize, lastSize, size_0..size_nb-1]`，每塊各自一條 zlib 流——塊與塊獨立，沒碰到的塊可以原樣複製。
- `exportAll`（`index.tsx:650`）→ `encode`（Worker `export`，`out.buffer` transfer）逐個 push 進 `files` → `zipStore(files)` → `download`。

### 2.8 C5、C6：實驗頁

- `OverlayView`（`OverlayView.tsx:30`）：`lines = splits.map(...)` 在函式主體，每 render 跑 `slabOf`（有快取）＋`contourOf`（`cache`，400 筆）＋`sliceDiff`（無快取、整片）。`hover`／`hidden`／`zoom` 都是本元件 state。
- `CompareView`（`CompareView.tsx:32-44`）：`slabs`、`diffOf`（`pairMask` 每張卡配一片）、`zoomBox`（每張卡 `sliceDiff`）都在函式主體。
- `thumbRGBA`（`thumbs.ts:82`）：`sliceRGBA(slab.vol, …)` 整片 → nearest 裁 crop。`structThumbRGBA`（`:154`）同。

---

## 3. 目標與量法

量法：`npx vite-node scripts/bench.ts <mode> [scale ...]`、`node scripts/e2e/perf.cjs <url> <scale>`、`node scripts/e2e/m15.cjs <url>`。雲端容器、Node 22、headless Chromium 軟體 WebGL，單位 ms。「現在」欄＝M15.0 量出來的實測（2026-11-01，HEAD 83d2256；指令與完整數字見 §11.2；括號內是量法上的備註）。「實測」欄＝M15.7 全部合併後重跑（2026-11-01，HEAD b06f914，同一台、同指令；`bench.ts` 已改量新路徑，完整數字見 §11.2「之後」表；✓／✗＝有沒有達到「目標」欄；頁面層級的列由協調者跑 `perf.cjs`／`m15.cjs` 補）。

| 項目 | 現在（×2 / ×3） | 目標（×2 / ×3） | 實測（×2 / ×3，M15.7） | 量法 |
| --- | --- | --- | --- | --- |
| 選到基板後每一步的 `selMask`＋`affMask`（主執行緒） | **19.5 / 47.5**（×1 2.6）；每步配 2 × N ＝ 30 / 101 MB | **< 3 / < 5**，且不配新陣列 | `bench.ts step --sel substrate` 印 selMask ms、配置位元組 | **部分 ✓**：配置 0、和 `maskOf` 逐位元組相同；poly 長高 1（stepTouch 288×8×48／432×12×72）**0.8～1.4 / 3.0～3.2** ✓；poly 縮 1（stepTouch＝整根 poly 288×85×48／432×127×72）**9～10 / 26～35** ✗（O(S) 兩遍）；換選取重建一次 14 / 47 |
| 每步 `diffBox`（主執行緒），在相隔兩角各改一次之後 | **10.3 / 34.8**（touch 撐到 X×Z 全幅後每步掃 ∝ touch；沒撐開時 1.5 / 4.9） | **< 1**（O(X+Y+Z)） | `bench.ts step --corners` 印 diffBox ms | ✓ **0.02 / 0.02**（最大 0.04；沒撐開時 0.05 / 0.03；對照 `tightBox` 10.7 / 34.8，10 步 0 次不同） |
| relabel 快照位元組（fin 在基板上長高 1） | **fin 左右搬 1（R±1 碰到基板）：48.8 MB / 143 MB／步**；poly 長高 1：4.9 / 16.4 MB／步（S 的 before 只有 0.4～23 MB） | **≤ F 的大小**（≈ R ∪ lost bbox；×3 < 2 MB） | `bench.ts step` 印 PS bytes | ✗ fin 左右搬 1：**29.3 / 23.3 MB**（基線 48.8 / 143；PF ＝ F，F 仍包含整根 fin 的 lost bbox 與 R±1 碰到的襯層）；poly 長高 1：4.5 / 15.1 MB（S ＝ F，和基線同）；A3 的省只在 S ≠ F 的步驟 |
| 一步 Worker apply（×3，fin 長高 1） | poly 長高 1：162～342；fin 左右搬 1：629～1,056（含 143 MB 快照 memcpy） | **< 500**（A3 省掉的 memcpy＋D5） | `bench.ts step 3` | ✗ fin 左右搬 1 **563～895**（基線 629～1,056；主執行緒貼補丁 25～50）；poly 長高 1 146～166、縮 1 340～460 |
| 開 X-ray／切 split 後空洞層開始 mesh 前的掃描 | `layer {mat: VOID}` 全量 129 / 234（整陣列 closure 掃描佔大半；增量 23 / 77）；頁面往返 145（×2） | **< 5**（只看 voidBox ∩ touch） | `bench.ts layer void`、`perf.cjs` `__posts.layer` 時間 | 掃描 ✓ 0（不再掃整陣列；全量 35～71 / 82～106 全是 mesh）；增量 21～38 / 80～88；**非相鄰版本（寬 touch 之後）236 / 659 ✗**（基線 84 / 208；`voidBoxOf`＝origVoidBox ∪ touch 是鬆外框，見 §11.3） |
| 點切面換 cursor 一次：Worker `layer` 請求、把手重建次數 | **1 次／（把手：待 M15.2 加 `__handleBuilds`）**；另整頁 render 4 次、20 次共 50 個 long task（×2） | **0 / 0** | `perf.cjs`：`__posts.layer` 差、`__handleBuilds` 差 | 協調者補（`perf.cjs --v15 --only=2`） |
| 拖欄寬 60 個 pointermove：整頁 render 次數 | **240**（每個 pointermove 4 次）＋ 3D 重畫 120 幀、153 個 long task（×2） | **≤ 耗時幀數**（rAF 合併，headless 約 10～20） | `perf.cjs` React Profiler commit 計數 | 協調者補（`perf.cjs --v15 --only=1`） |
| 一步之後 `Section3DPage` 以外的重 render（StructureList／Inspector／SplitPicker／EditToolbar） | 待 M15.2 加 `__renders[元件]`（整頁 `__renders` 一步 ≈ 4～6 次） | **只有讀到的欄位變了才 render**（Profiler 每步 ≤ 2 次） | `perf.cjs` `__renders` 按元件計數 | 協調者補（`__rendersBy`） |
| 2D 拖基板頂邊 60 步（×2）：主執行緒每幀、算 Op 的次數／幀數 | 頂邊（push 路徑）1.4 / 3.8 ms／幀、角節點（profile 路徑）**6.9 / 16.4 ms／幀**（p95 12.5 / 35.2）；Op 次數／幀數 **1.0**，其中位元組相同的 Op 重算 79～89%；頁面 161 幀／2.5 s、0 個 long task | **< 8 ms／幀**，Op 次數／幀數 **≤ 0.5** | `bench.ts drag2 --key substrate`、`perf.cjs` 2D 拖拉段 | ✓ 60 幀中位數 **0.0 / 0.0**（去重掉的幀只算 `gestureKey`）；真的算 Op 的幀：push 1.7 / 4.5、profile 7.0 / 15.0（p95 13.0 / 20.7；Poly 整層 12.3 / 19.1）；Op 次數／幀數 **0.22 / 0.22** ✓；位元組相同的 Op 重算 push 50% / 25%（key 含取整位移，比 Op 保守）、profile 0% |
| 2D 模式每步 `stairs`＋verify（選到基板 ×3、步驟沒碰這一片） | stairs 4.2 / 10.9 ＋ verifyKey 2.1 / 3.5 ＋ sliceContext 1.2 / 2.5（5 個 key）≈ **7.5 / 17 ms／步** | **0**（跳過） | `bench.ts drag2` 印 per-step trace 次數 | ✓ **0**：stairs 0 次（memo 看 rev）、`modelStats` traced 0／verified 0、`ModelStore.get(touched=false)` 0.0 ms、`sliceContext`（area lazy）0.0～0.1 ms |
| 一步後第一次 hover 的 BVH 建置（×2） | 10 次 hover → **20 個 long task（最長 112～159 ms）**，每次 pointermove 63～126 ms（`__bvhBuilds` 待 M15.4） | **≤ 8 ms／事件**（有預算，其餘 idle 補） | `perf.cjs` hover 段 long task、`__bvhBuilds` | 協調者補（`perf.cjs --v15 --only=3`、`__bvhStats`） |
| 有選取時轉視角每幀強制 layout 次數 | 1（程式碼推得；DEV 計數器待 M15.4） | **0** | `perf.cjs` PerformanceObserver layout-shift／手動 `getComputedStyle` 計數器（DEV 旗標） | 協調者補（ResizeObserver 標籤，程式碼推得 0） |
| HiDPI 每 CSS px 的 sample 數 | 16（dpr 2 × MSAA 4，程式碼推得；headless dpr＝1 量不到） | **≤ 9 靜止、4 拖拉中**（dpr ≤ 1.5；互動中 1.0） | 讀 `renderer.getPixelRatio()` | 程式碼：靜止 1.5² × 4 ＝ 9、拖拉中 1.0² × 4 ＝ 4（headless dpr 1 量不到；協調者補） |
| 同格式 .vti 匯出一個 split（×2，8 個 Float32 壓縮比例陣列，改 2 萬格） | **Worker 4,189 ms**（頁面，改 32k 格）；Node 11,749 ms；重壓 15,360／15,360 塊（只需 320） | **只重壓碰到的 block**：≤ 碰到 block 數 × 32 KB；×2 **< 300 ms** | `bench.ts export 2` 印 blocks 重壓／總數、ms | ✓ 重壓 **320 / 15,360**（＝碰到的 block 數；×3 384 / 51,840）；`encodeVtiLike(hint)` **280～305 / 378 ms**（×2 兩次取較好 280，目標 < 300 邊緣）；`--whole` 整陣列路徑 6,504 ms、位元組相同 |
| 匯出 20 個 split 的 zip（×2，vti1）尖峰記憶體（主執行緒） | 300 MB zip：**JS heap 尖峰 +600 MB、renderer RSS 尖峰 +840 MB**（≈ 2.8×）；`zipStore` 278 MB/s（1.08 s） | **≤ 1 個 split ＋ 32 MB**；主執行緒 CRC 0 ms | `perf.cjs` `performance.memory` 匯出前後、`bench.ts export zip` | Node `ZipWriter`：資料段不複製（61 段、arrayBuffers 增量 0）、crc32 一個 15 MB split 64 ms（頁面在 Worker）；頁面 heap 協調者補（M15.5 初測：尖峰 +147 MB、gc 後 +6 MB，見 §11.3） |
| zip > 4 GiB／> 65,535 個檔 | 壞檔（程式碼推得，未量） | **ZIP64 正確**（Node `yauzl`／Python `zipfile` 能開） | `zip.test.ts`（假大小）、e2e 不做 | 測試層級 ✓（`zip.test.ts` 假大小 ZIP64） |
| 上傳 ×2 比例陣列 .vti：主執行緒 long task、原檔常駐份數 | **7 個 long task（最長 373 ms）**，到結構分析完 3.6 s；JS heap 尖峰 +337 MB、RSS 尖峰 +486 MB（合成檔只有 1.3 MB，原檔 2 份的成本看不出來） | **解碼在 Worker、主執行緒無 > 50 ms long task；原檔 1 份（Worker）** | `perf.cjs` 上傳段、`bench.ts export` 印 Worker 常駐 | 協調者補（`perf.cjs --v15 --only=6`；`meta.hasRaw` 由 e2e m11 §0 驗） |
| 比例陣列解碼（×2，8 個 Float32 壓縮陣列） | `decodeVti` Node **7,173**（×1 1,181）；頁面主執行緒 ≈ 2.5 s（含在上面的 3.6 s 裡） | **≤ 現在的 1/3**（Promise.all 批次） | `bench.ts decode 2` | ✗ Node **4,599 / 11,592**（×1 808）＝基線的 0.64× / 0.46×（目標 ≤ 1/3）；頁面協調者補 |
| 200 個 split 疊圖：legend 滑過 60 次（×1） | **10.2 ms／次**（200 條，bench；最大 18.6）；頁面 UI 上限 12 條 0.5 ms／次 | **< 2 ms／次**（memo） | `perf.cjs` 實驗頁段、`__overlayMs` | ✓ useMemo 命中、lines **0 次重算**；快取全命中重組 lines 上限 0.3 ms／次 |
| 200 個 split 疊圖換片一次（×3） | **1,377**（描輪廓 833、整片比對 118、切片 1,366 另計）；×2 343、×1 118 | **< 1 s**（contour 只描 key bbox、diff 快取） | `bench.ts overlay 3 200` | ✓ **341**（×2 179、×1 61；描 keys 外框 vs 'full' 404 vs 524） |
| 縮圖一張（×3） | 0.8 ms、配置 0.6 MB（整片 RGBA 0.5 MB）；×2 0.5 ms | **只畫裁切窗**，< 2 ms | `bench.ts thumbs 3` | ✓ **0.4 ms**、配置 0.1 MB（只有縮圖輸出；裁切窗 RGBA 走共用暫存） |
| 復原堆疊：50 步基板級 translate 後堆疊位元組 | ×1 **253 MB**（5.1 MB／筆）；×2 2,023 MB（40.5 MB／筆）；×3 **6,828 MB**（137 MB／筆；HISTORY_LIMIT 50 筆全留） | **≤ 256 MB／split**（可設定） | `bench.ts mem --op translate-substrate` | ✓ 截後 ×2 **244 MB**（6 筆）、×3 **137 MB**（1 筆）；50 步後 Node 記憶體增量 297 / 284 MB |
| `ModelStore` 快照總位元組（基板選取、連做 50 步） | 50 份 ≈ 0.5～1.6 MB（估計；基板環只有 4 個頂點，`exact` 小）；SNAP_LIMIT 400 → ≈ 4～12 MB | **≤ 64 MB**，沒碰到這一片的版本是指標不是拷貝 | `bench.ts drag2` 印 `models.bytes()` | ✓ `store.bytes()` **0.0 MB**：實體 1 份、指標 49 份 |
| `ringCache` 滿了之後下一幀重描次數 | 全部（程式碼推得，未量） | **只重描被逐出的那一片** | `previewWorker.test.ts` | 測試層級 ✓（`previewWorker.test.ts`） |

---

## 4. 原則、不做的事

- **voxel 仍是唯一真相、結果逐位元組不變**：每一條都是「同樣的結果、少算一點」。A1／A2／A3／B3／C1／D5 都有純函式對照（`maskOf`、`tightBox`、`relabelFast`、現有 `gestureToOp`、現有 `encodeVtiLike`、comparator sort），新版必須和對照逐位元組相同（§7）。
- **Op、manifest、補丁、`.vti`／`.npy`／zip 內容不變**：zip 小檔案的位元組要和現在的 `zipStore` 完全相同（ZIP64 只在需要時加）；同格式匯出未改到的 block 現在就是原樣複製的意圖，改完之後連壓縮位元組都和原檔相同（比現在更嚴格）。
- **Worker 協定只加不改**：新增 `vtiInspect`／`vtiDecode`／`npyDecode`、`export` 回應多一個 `crc`、`apply`／`derive` 回應的 `report` 換成已摘要的 `OpReport`（欄位相同、`cells` 有上限）；既有欄位不動。
- **身分規則寫成一條，並用測試守住**：「同一個選取裡 `selMask`／`affMask` 的陣列身分不變；任何要跟著步驟重算的 memo 都必須把 `vol` 或 `L` 放進 deps」。`scope`、`gesture`、`geo`、`selBBox` 以值比較，值相同身分不變。
- **度量先行**：M15.0 先把 §3 每一列的「現在」量出來填進 §11，再動手；每個里程碑結束把那幾列填上。
- 不做：SharedArrayBuffer、第二個 Worker、indexed geometry、三角形級別的 BVH 序列化搬到 Worker（§10）、`comps` 墓碑（§10 D4）、MSAA 動態切換（WebGLRenderer 建立後不能改，§10）、虛擬化 StructureList（先 memo 每列，量了再說）。

---

## 5. 設計

### 5.1 每一步的固定成本

#### A1 `selMask`／`affMask` 原地維護

`editor.ts` 新增 `useSelMasks(L, sel, vol, scope, selBox, lastStep)`：

- 內部 `ref: { sel: Set<string>; sig: string; mask: Uint8Array | null; aff: Uint8Array | null; scopeKey: string }`。
- **選取或 vol 變了**（`sel` 的 key 簽名 `[...sel].sort().join()` 不同、或 `vol.data` 身分不同＝換檔／換 split）：整個重建，仍用 `maskOf`（O(選取 bbox)）。
- **一步之後**（`lastStep` 的 `seq` 變了、簽名相同）：只在 `box = stepTouch(lastStep.step)` 裡重算：`on[]` 由新的 `L.comps` 建，`for i in box: mask[i] = (l = labels[i]) >= 0 && on[l]`。復原／重做走同一條（`stepInPlace` 也更新 `lastStep`）。正確性靠 §2.1 的不變量：box 外 labels 沒變、comps 的 key→index 只在 S 與 moves 裡變，而這兩個都 ⊆ `stepTouch`。
- `affMask`：scope 是整段時 `aff = mask`（同一個陣列，現況）；否則維護第二個陣列，重建時 `maskInScope`，每步時同一個 box 迴圈多套一個 `inScope(i)`（scope 只看一個軸，O(1)）。scope 變了（值）就重建 aff（O(bbox)），mask 不動。
- `keepSel`：濾完沒少就回傳 `prev`。
- `maskOf`／`maskInScope` 保留當對照與重建用。
- 新函式 `patchMask(mask, labels, on, dims, box, inScope?)` 放 `volume.ts`，純函式，測試用。
- 暴露 `ed.lastStep: { seq: number; box: BBox | null } | null`（A4、D2 也用）。

#### A2 diff 外框 O(X+Y+Z)

- `patch.ts` 新增 `DiffAxes = { x: Int32Array(X); y: Int32Array(Y); z: Int32Array(Z) }`：每條軸上每一片有幾個 diff 格。`carryStepStats` 多一個參數 `axes?: DiffAxes`，在已有的「`diff[i]` 從 0→1／1→0」那一行同步 `±1` 三個直方圖（O(補丁)，不多掃）。`diffBoxOfAxes(axes): BBox | null` 找三條軸第一個與最後一個非 0（O(X+Y+Z)）。
- `SplitBuffers` 加 `axes: DiffAxes`。來源：`own`（複製原始時 `axes` 全 0）、`run`（Worker `replay` 回應多帶 `axes`，Worker 在 `fork`＋重播時用同一個 `carryStepStats` 維護）、`restoreIn`（同樣由 Worker 回）。
- `buffersStats` 改讀 `diffBoxOfAxes(b.axes)`；`tightBox` 留給測試與 `changedBox`。
- Worker `Book` 同樣加 `axes`，`diffBoxOf(b)` 改成 O(X+Y+Z)，`tight`／`diffBox` 兩欄移除（`growDiffBox` 只剩 `touch` 的 union）。`copyBook`／`resetScratch`／`pastePatch` 跟著複製／重算 axes（`pastePatch` 在補丁 box 裡重數一次，O(patch)）。
- `statsOf` 的 `WeakMap<EditState>` 快取保留（每步算一次 O(X+Y+Z) 可以忽略）。

#### A3 relabel 只快照 F

`relabelInPlace`：

1. 步驟 1 照舊算 `touched`／`lost`，但不再算 `Smax`；`F = R ∪ lost 的 bbox`（現在 S 的初值），`PF = cropBox(labels, F)`。
2. 步驟 6 的 `prow` 改用 F 的尺寸讀 `PF`（範圍本來就是 F）。
3. 步驟 7 `grow` 之後、**「寫回 S」迴圈之前**：`before = cropBox(labels, S)`（S \ F 的格子此時還是舊值），再把 F 那一塊用 `PF` 覆蓋回去（nested copy，`pasteInto(before, S, PF, F)`）。
4. 其他不動。`before` 的語意（S 裡改前的 labels）不變，`patch.test.ts`／`apply.test.ts` 的逐位元組比對直接驗。

#### A5 空洞層的外框

- Worker `load` 時在 `countAll` 同一個迴圈順手算 `origVoidBox`（`data[i] === VOID` 的 bbox）；`Book` 不必存，`voidBoxOf(b) = unionBox(origVoidBox, b.touch)`（VOID 只會在 touch 裡出現或消失）。
- `layer`／`mesh` 的 `'mat' in filter` 路徑：`box = mat === VOID ? voidBoxOf(book) : boxOf(...)`；其他材質目前沒有呼叫者（`views.tsx` 只對 VOID 用 `{mat}`），保留 `boxOf` 當 fallback。

#### C7 報告在 Worker 摘要

- `apply.ts` 的 `report.blockedAt = globalIndex(...)` 後，Worker 端直接 `summarize(report, op, dims)` 成 `OpReport`（`cells` 截 `BLOCKED_CAP`、`slices` 用全部算完才截），回應欄位 `report` 型別改成 `OpReport`；`cells` 用 `Int32Array` 並列入 transfer。主執行緒 `withReport` 不再呼叫 `summarize`（`editor.ts`），`ed.report.cells` 型別跟著改（`SliceEditor` 的 `blocked` 讀法不變）。
- `previewOp` 第 1 級（`index.tsx:446`）在主執行緒自己算，不受影響。

#### D1 復原堆疊位元組上限

- `editor.ts`：`HISTORY_LIMIT = 50` 之外加 `HISTORY_BYTES = 256 * 2 ** 20`；新增 `trimHist(hist)`：從最舊開始丟，直到 `hist.length ≤ 50 && Σ stepBytes ≤ HISTORY_BYTES`（至少留 1 筆）。`commitOne`、`commitTo`（含 `'all'`）、`redo` 推進 `hist` 的三處都經過它。
- 設定抽屜加一格「復原記憶體上限」（64／256／1024 MB，`usePersisted('histBytes')`），`trimHist` 讀它。
- README 第 77 行「每 split 10 步」→「每 split 50 步或 256 MB」。

#### D5 dilate 的排序

- `cand.sort((p,q) => best[p]-best[q] || p-q)` → 計數排序：`d2 ≤ r²` 是整數，先數每個 d2 的個數（`Int32Array(r²+2)`），前綴和，再依 `k` 遞增放入——同一個 d2 內自然是 `k` 遞增，結果和 comparator 排序完全相同。`dilate.test.ts` 已有逐體素對照。

#### `previewBox` 只算一次

- `previewOp(s, orig, op, cap, report, ringsFor, box?)`：`applyOpInPlace` 把算好的 `box` 傳進去。

### 5.2 身分與 render

#### B1 值相同身分不變

- `editor.ts` `scope`：deps 改成 `[scopeMode, editAxis, scopeMode === 'slice' ? cursor[axisIndex(editAxis)] : -1, customRange[0], customRange[1], vol]`，再包一層 `useStable(value, sameScope)`（`src/ui/stable.ts`：上一個值相等就回上一個物件）。
- `index.tsx`：`selBBox` 包 `useStable(sameBox)`；`gesture`／`geo` 改成 `useMemo`；`onStep`／`onPick` 等傳給 `SliceView`／`SliceEditor` 的 callback 改 `useCallback` 或 `useEvent`（ref-latest，見 B2）。
- `views.tsx` 把手 effect：deps 的 `selBBox` 已是穩定物件，不必再改；加 DEV 計數器 `window.__handleBuilds`（perf.cjs 用）。
- `SliceEditor` 的 `sctx` deps 的 `gesture?.scope` 隨之穩定。

#### B2 `ed` 與整頁 render

- **函式欄位穩定**：`src/ui/useEvent.ts`（`useEvent(fn)`：回傳身分永遠相同、呼叫時用最新的 `fn`）。`useEditor` 回傳物件裡所有函式型欄位都經過 `useEvent`（機械式；`commit`／`undo` 這些已是 `useCallback` 的可以留）。
- **重元件只讀自己要的欄位**：`src/ui/memoEd.ts` 的 `memoEd(Component, uses: readonly (keyof Editor)[])`：`React.memo` 加自訂比較——`uses` 列出的 `ed` 欄位逐一 `Object.is`，其他 props 淺比較。套在 `StructureList`、`SplitPicker`、`EditToolbar`、`Inspector`、`ChangesTab`、`PositionBar`、`FloatingToolbar`、`MatrixTab`、`DesignPanel`。
- **漏列欄位的保險**（DEV）：`memoEd` 在 DEV 用 `Proxy` 包 `ed` 傳進元件，render 期間讀到 `uses` 以外的欄位就 `console.error('StructureList 讀了 ed.xxx 但沒列在 uses')`，e2e 把 console error 當失敗。這樣 `uses` 不會悄悄過期。
- `Resizer`：`move` 只累積 `acc += q - p`，`requestAnimationFrame` 一次 `onDrag(acc)`；`pointerup` 時把剩下的 flush。
- `StructureList`：每一列抽成 `memo(StructRow)`，props 只有原始值（key、名稱、顏色、count、selected、hidden）與穩定 callback；群組的 `Tooltip`／`ColorPicker`／`Dropdown` 只在該群組展開時掛。
- 4.1 s 的 `tick` timer：改成只在 `hot` 會由 true 變 false 的那一刻 setState（現在就是），不動。

#### B5 不在 render loop 裡量 DOM

- `views.tsx`：`floatRef` 掛 `ResizeObserver`，寬度存 `tagW.current`；render loop 只寫 `style`。文字變了（`setHoverTag`／選取改名）ResizeObserver 自然會更新。
- `SliceEditor.tsx` `tbW`：同樣 `ResizeObserver` 在 `tbRef` 上，拿掉無 deps 的 `useLayoutEffect`。

#### B7 listener 與 hover

- `index.tsx` 鍵盤、`SliceEditor` 鍵盤：handler 放 `ref`，`useEffect(..., [])` 掛一次。`SliceView` wheel：`onStep` 經 `useEvent`。
- `SliceEditor` hover：`pointermove` 沒在拖時也只記 `latestMove`，由同一個 rAF `tick` 做 `hitAt`＋`setHover`；`insideKey` 的 `findIndex` 改查 `useMemo` 的 `Map<key, index>`。

### 5.3 2D 拖拉與每步重描

#### B3 同一個 Op 只算一次

- `gestures.ts` 新增 `gestureKey(rings, h, delta, shift): string`：region → `${du},${dv}`；edge → `${edgeAmount}`；node → `resolveNodeDrag` 後 `dragDisp(...)` 取整的位移串（`dragDisp` 本來就在 `gestureToOp` 裡算，抽出來共用、不重算）。
- `SliceEditor.tick`：`key = gestureKey(...)`；和 `lastKey.current` 相同 → 沿用 `lastOp.current`（`{op, missed}`），**不呼叫** `opFor`、**不呼叫** `onLive`；ghost 與提示文字照常用浮點 `delta` 更新。不同 → 算一次、存起來、`onLive(op)`。`press` 結束時清掉。
- `gestureToOp`：`edgeAmount` 算一次存變數；`text` 用同一個值。
- `profileDelta(rs, ring, disp, inside)`：bbox 只取「第 ring 環改前 ∪ 改後」的 bbox（其他環 before === after，差為 0）；`rasterize(after, …)` 仍傳全部多邊形（洞的奇偶規則要對），只在這個 bbox 裡光柵化；`before` 的 `inside()` 也只掃這個 bbox。
- `deltaOf`：
  - 「拿」的 BFS 種子改成「`!before` 且 4 鄰接有 `before && !after`」的格子（level 1 發現的集合與順序和原本相同：原本的種子迴圈依 index 遞增、每個種子 d=0..3，拿掉不會發現任何 target 的種子不影響發現順序）；「加」的 BFS 種子同理改成「`before` 且鄰接 `after && !before`」。
  - `dirOf`／`seen` 用模組層 scratch（依 W·H 放大、`fill` 清），不每次配。
  - 回傳的 `Cell[]` 物件不變（`encodeRle` 吃它）。
- `mirroredOp`：混合時主 key 直接用 `main.perKey[h.key]`／`main.gestures?.[h.key]`，不再對主 key 第二次 `profileDelta`。
- `index.tsx onLive`：因為只在 key 變時被叫，第 1 級 `previewOp` 與第 2 級 Worker 請求自然一起去重；另外第 2 級的 one-in-flight 邏輯不動。

#### A4 沒碰到這一片就不重描

- `SliceEditor` 接 `lastStep`（`ed.lastStep`）。新 hook `useSliceRev(L, axis, at, lastStep)`：回傳一個整數 `rev`，只在下列情況 +1：(a) `L` 身分變了但 `lastStep.seq` 沒變（換 split、換檔、重播——整片可能都不同）；(b) `lastStep.seq` 變了且 `stepTouch` 與 (axis, at) 這一片相交；(c) `at`／`axis` 變了（本來就會換 key）。
- `stairs` 的 deps 從 `[L, keysTag, axis, at]` 改成 `[rev, keysTag, axis, at]`（`L` 從 ref 讀）。
- `sctx`：`sliceContext` 的 `area` 改成 lazy（`areaOf(key)` 只在 `mirror && rings.size > 1` 的配對時才算，`counterparts` 呼叫它）；deps 的 `L` 換成 `rev`。
- `ModelStore.get(..., version, seq, touched: boolean)`：`touched === false`（這一步沒碰這一片）時不 verify，改 `alias(id, prevVersion → version)`：`snaps` 存一個指標 `{ sameAs: prevKey }`，`restore` 時解參考。幾何沒變、版本號變了的情形（沒改到任何格子）現在就是走「回到放開前的快照」，語意一致。
- `Inspector.tsx:36` 的 `modelContext` 同樣改用 lazy `area`。

#### D2 幾何快照有上限、沒變的是指標

- `ModelStore`：`snaps` 的值是 `SliceModel | { sameAs: string }`；`keep()` 時若 `m.rev` 和上一個版本快照的 `rev` 相同（這個版本沒改幾何）就存指標；位元組估算 `bytesOf(m) = Σ exact 點數 × 16 + vertices × 24 + rings loop × 8`，`SNAP_BYTES = 64 MB` 超過就從最舊的實體快照逐出（被指標參考的不逐出；指標本身幾乎不佔空間）。
- `prune(live: Set<number>)`：editor 每次 commit／undo／redo／切 split 後呼叫，`live` ＝所有 split 的 `hist`／`future`／`cur` 版本號；不在裡面的快照刪掉（版本已經回不去了）。
- `models.bytes()` 給 bench 與 DEV `window.__models`。

#### D3 輪廓快取 LRU、數值簽名

- `ringCache`：`byKey` 滿了只刪最舊的一筆（Map 插入順序，命中時重新 set 到尾端）；`byShape` 各自 LRU（上限同 `max`），不再整個 `clear()`。
- `sig()` 改 FNV-1a 32-bit × 2（兩個不同種子）over `handle` 欄位與每個 ring 的 `hole`＋`pts` 整數；命中時再對一次 `pts` 逐值相等（避免碰撞），不相等就當 miss。

### 5.4 3D 拾取與繪製

#### B4 BVH 有預算、拾取由近到遠

- `pickOrdered(ray, meshes, firstOnly)`（`views.tsx`）：先對每個 chunk 算射線與包圍球的進入距離 `tIn`（沒交的略過），依 `tIn` 排序；逐個 `raycast`，`firstOnly` 時一旦 `best.distance < 下一個的 tIn` 就停。`hit()` 用它取代 `intersectObjects(pickables())`；`hitsAlong`／`hitSel` 也用它（不 `firstOnly`，但排序讓前 8 個結構提早滿足 `break`）。
- `lazyRaycast` 的 BVH 建置加每事件預算：模組層 `bvhBudget = { until: 0 }`，事件開始時 `until = now + 8 ms`；超過預算的 chunk 這一次用 three 內建的 `Mesh.prototype.raycast`（O(三角形)，64³ chunk 幾千到一萬個三角形，< 1 ms），不建樹；idle 鏈之後補。
- `idleBVH`：單一排程（`idleHandle`），新 `showParts` 來了只是把待建清單換掉；優先建最近一步碰到的 chunk（`parents.box` 相交的）。
- DEV 計數器 `window.__bvhBuilds`（同步建的次數）。

#### B6 fill cost

- `setPixelRatio(Math.min(1.5, dpr))`；`controls` 的 `start`／`end`、把手與筆刷拖拉的 `pointerdown`／`pointerup` 之間 `setPixelRatio(1)`，結束時恢復並 `kick()`。`setSize` 不必重叫（`setPixelRatio` 內部會）。
- `antialias` 留著（§10）。

### 5.5 載入與匯出

#### C3＋C4 解碼在 Worker，原檔只留一份

- Worker 新 handler（`worker.ts` `Requests` 加）：
  - `vtiInspect: { req: { buf: ArrayBuffer }; res: VtiInspect }`——`buf` 由主執行緒 **transfer** 過來，Worker 存成 `pendingRaw`。
  - `vtiDecode: { req: { fractions?: {name; id}[]; keepRaw: boolean }; res: { vol: Volume; info: VtiInfo } }`——對 `pendingRaw` 解碼，`vol.data` transfer 回去；`keepRaw`（有比例陣列）時 `pendingRaw` 直接變成 `exportRaw`，否則丟掉。
  - `npyDecode: { req: { buf: ArrayBuffer }; res: { vol: Volume } }`。
  - 都走 `handleAsync`（`inflate` 是非同步）。
- `UploadPanel`：`file.arrayBuffer()` → `call('vtiInspect', { buf }, [buf])`（之後主執行緒的 `buf` 已 detached，`pending` 不再存 `buf`）→ 確認 → `call('vtiDecode', ...)` → `ed.loadVolume(vol, { hasRaw: true, fractions, ... })`。範例（`demoVolume`）路徑不變。
- `meta.raw: ArrayBuffer` → `meta.hasRaw: boolean`；`exportMetaIn(fractions)` 只送 `fractions`；`index.tsx:603` `like = !!(ed.meta.hasRaw && ed.meta.fractions)`。
- `vti.ts` 解碼加速（純函式，Node 測試照跑）：
  - `readBlock`：`sizes` 分批 `Promise.all`（一批 16 塊），結果照順序 `set`。
  - 比例陣列 argmax：維持 `best: Float32Array(N)`，但 `readValues` 完的陣列用完即丟（現況）；ascii 整數陣列 `parseAscii` 直接產 `Uint8Array`（值 ≤ 254 且整數時；否則退回 Float64）。
- 單檔 prototype（`scripts/build-proto.mjs`）把 Worker 原始碼一起打包，不受影響。

#### C1 同格式匯出只重壓碰到的 block

- `encodeVtiLike(orig, fractions, data, origData, mats, hint?: { diff: Uint8Array; box: BBox | null })`：有 `hint` 時只在 `box` 裡掃 `diff` 建 `chg`（`Int32Array`，倍增）；`exportOne` 傳 `book.diff`＋`diffBoxOf(book)`（parked 用補丁的 box）。
- 新函式 `patchBlocks(h, d, chg, valueOf)`（壓縮的 appended／inline 陣列）：
  1. 讀原區塊 header（`nb, blockSize, lastSize, sizes[]`）與每塊在原檔裡的位元組範圍（前綴和）。
  2. 碰到的塊集合 `T = { floor(i × size / blockSize) | i ∈ chg }`。
  3. 對 `T` 裡每塊：`inflate` → 改這塊裡的點 → `deflate`；一批 16 塊 `Promise.all`。
  4. 新 header：`sizes[k]` 只換 `T` 裡的；新 body ＝ 沒碰到的塊 `subarray` 原檔（零複製）＋新塊。回 `{ head, bodyParts: Uint8Array[] }`，不 `catBytes`。
- 未壓縮的陣列：`[原檔 subarray(0, firstChanged)][改過的區段複本][原檔 subarray(...)]`——只複製包含 `chg` 的最小連續區段（通常是 diffBox 那幾片）。
- 新材質陣列（全 0 只有 `chg` 是 1）：`T` 以外的塊全是 0 → 預先 deflate 一塊全 0 的 `blockSize` 位元組，重複引用同一份（同長度），最後一塊另算。
- 輸出組裝：整個函式回傳 `Uint8Array[]`（parts），`exportOne` 用 `catBytes` 合一次（或直接餵 zip writer 的 parts）。XML 替換也改成 parts：`[xml[0:s1], rep1, xml[e1:s2], …]`，不再 `slice + text + slice` 複製整串。
- `b64`：`b64Bytes(u): Uint8Array`——查表直接寫 latin1 位元組，不經 JS 字串；`blockText` 回 bytes，inline 的 `body` 改成 bytes part。
- ascii 新材質：`rewriteAscii` 的 `out: string[]` 改成每 64k token 一段 `join`，避免一個超大陣列；值陣列同理。
- `exportOne` 的 `data.slice()`：live 保留（async 期間帳簿可能被改）；parked／原始改成不複製（`o.data` 永遠不寫；parked 走 `patch` 時只在 `encodeVtiLike` 裡用 `valueOf(i) = inBox ? patch.data[...] : o.data[i]`）。

#### C2 zip 邊寫邊丟、ZIP64

- `zip.ts` 改成 `class ZipWriter { constructor(sink: (part: Uint8Array) => void | Promise<void>); add(name, size, crc, parts: Iterable<Uint8Array>): Promise<void>; finish(): Promise<void> }`：每個 entry 立刻寫 local header＋資料（CRC 與大小已知，不用 data descriptor），central directory 累積在記憶體（每檔 < 100 B）。`zipStore(entries)` 保留為 `ZipWriter` 的包裝（sink 收集後 `catBytes`），小檔案位元組和現在**完全相同**（有測試守）。
- ZIP64：任一 entry 大小／offset ≥ 0xFFFFFFFF 或 entry 數 ≥ 0xFFFF 時，該 entry 的 local／central header 寫 0xFFFFFFFF 並附 ZIP64 extra field（0x0001），結尾加 ZIP64 EOCD＋locator；都沒超過就和現在一樣不加（舊 zip 位元組不變）。
- sink：`showSaveFilePicker` 可用（Chromium）→ `FileSystemWritableFileStream.write`（真正串流到磁碟、尖峰＝一個 split）；否則累積成 `Blob` parts（`new Blob(parts)` 不需要一塊連續 ArrayBuffer，瀏覽器可落地）→ `download(blob)`。`download.ts` 的 artifact-viewer 退路照舊（它要整個 bytes）。
- CRC 在 Worker：`export` 回應加 `crc: number`（編碼完順手算；table-driven 40 MB ≈ 60～100 ms，在 Worker）。主執行緒不再算。
- `exportAll`：`for split: bytes = await encode(...); await writer.add(name, bytes.length, crc, [bytes]); bytes = null`——同時最多一個 split 在主執行緒；manifest 最後加。進度訊息照舊。
- 大小預估：按下匯出前用 `Σ(N × bytesPerVoxel)` 估（同格式＝`fractions.length × size × N`），> 2 GiB 時確認框多一行提示（ZIP64、瀏覽器記憶體）。

### 5.6 實驗頁

#### C5 疊圖／並排

- `overlay.ts`：`contourOf(L, vol, keys, axis, at, bbox?)`——`bbox` ＝ keys 的 comps bbox 投影到切面的聯集（從 `L.comps[i].bbox` 來，O(comps)），`boundaryLoops` 只在這裡面描。
- 快取合併：`overlayCache.get(key, make)` 的值變成 `{ loops, diff }`，key 多 `baseVersion`；上限 1,000 筆（每筆只有 loops 與一個 box，很小）。
- `OverlayView`：`lines` 進 `useMemo`，deps `[splitsKey（id|version 串）, baseVersion, axis, at, allKeysKey]`；legend 抽成 `memo(Legend)`，`hover` state 只在 Legend 裡、線條粗細用 CSS class（`data-hover`）不經父元件。
- `CompareView`：`slabs`／`diffOf`／`zoomBox` 進 `useMemo`，deps 同上；`pairMask` 結果放進 `slabs.ts` 的快取（key `${va}|${vb}|${axis}|${at}`，片大小）。
- 刪 `overlay.ts` 的 `diffPair`／`pairCache`（死碼）。

#### C6 縮圖只畫裁切窗

- `sliceRGBA(vol, axis, at, rgb, hidden, sel, diff, patch, out, crop?: UVBox)`：有 `crop` 時輸出 `W = crop 寬`、`H = crop 高`，只走 crop 的列與行（LUT 迴圈的起止改成 crop）。`drawSlice.test.ts` 加「crop 的像素 === 整片裁下來的像素」。
- `thumbRGBA`／`structThumbRGBA` 改傳 `crop`，nearest 縮放直接從 crop 緩衝取。
- `drawSlice` 主畫面：每個 canvas 持有自己的 `out` 緩衝（尺寸不變就重用），不每次配。

---

## 6. 每個檔案要改什麼

| 檔案 | 改什麼 | 條目 |
|---|---|---|
| `src/volume/volume.ts` | `relabelInPlace` 只快照 F、`before` 由 live labels＋PF 拼；`patchMask`；`dilateMask` 計數排序 | A3、A1、D5 |
| `src/volume/patch.ts` | `DiffAxes`、`carryStepStats(..., axes)`、`diffBoxOfAxes`；`tightBox` 保留 | A2 |
| `src/splits/lifecycle.ts` | `SplitStats` 來源改 `axes`；`Buffers` 型別加 `axes` | A2 |
| `src/volume/workerCore.ts` | `Book.axes`（拿掉 `diffBox`／`tight`）、`load` 算 `origVoidBox`、`layer`／`mesh` VOID 用 `voidBoxOf`、`apply`／`derive` 回 `OpReport`、`replay`／`restore` 回 `axes`、`vtiInspect`／`vtiDecode`／`npyDecode`、`export` 回 `crc`＋parts、`exportOne` parked 不複製 | A2、A5、C7、C1～C4 |
| `src/volume/worker.ts` | `Requests` 新增三個 handler、`export` res、`report` 型別 | C3、C4、C7 |
| `src/volume/client.ts` | `exportMetaIn(fractions)`、`inspectVtiIn(buf)`（transfer）、`decodeVtiIn`、`decodeNpyIn`、`previewIn` 不送 `comps`（Worker 用自己那份，見 §10） | C3、C4 |
| `src/volume/apply.ts` | `previewOp` 接 `box`；報告在這裡 `summarize` | previewBox、C7 |
| `src/volume/preview.ts` | `previewOp(..., box?)` | previewBox |
| `src/volume/report.ts` | `cells: Int32Array`；`summarize` 由 Worker 呼叫 | C7 |
| `src/volume/vti.ts` | `readBlock` 批次 inflate、`parseAscii` 整數直出 Uint8、`patchBlocks`、`encodeVtiLike(..., hint)` 回 parts、`b64Bytes`、XML parts、ascii 分段 | C1、C4 |
| `src/volume/zip.ts` | `ZipWriter`（串流、ZIP64）、`zipStore` 包裝、`crc32` 給 Worker 用 | C2 |
| `src/ui/download.ts` | 接受 `Blob`／`FileSystemWritableFileStream` sink | C2 |
| `src/ui/Resizer.tsx` | rAF 合併 | B2 |
| `src/ui/useEvent.ts`、`src/ui/stable.ts`、`src/ui/memoEd.ts` | 新檔 | B1、B2 |
| `src/pages/Section3D/editor.ts` | `useSelMasks`、`ed.lastStep`、`keepSel` 不換 Set、`scope` 值穩定、所有函式欄位 `useEvent`、`SplitBuffers.axes`、`trimHist`＋`HISTORY_BYTES`、`models.prune`、`meta.hasRaw`、`withReport` 不再 summarize | A1、A2、A4、B1、B2、D1、D2、C3 |
| `src/pages/Section3D/index.tsx` | `selBBox`／`gesture`／`geo` 穩定、callback `useEvent`、鍵盤 listener 掛一次、`exportAll` 串流、`like` 用 `hasRaw`、大小預估提示、`memoEd` 套用 | B1、B2、B7、C2、C3 |
| `src/pages/Section3D/UploadPanel.tsx` | 走 Worker 解碼、不留 `buf` | C3、C4 |
| `src/pages/Section3D/views.tsx` | `pickOrdered`、BVH 預算、單一 idle 鏈、`ResizeObserver` 量標籤、pixelRatio 1.5／互動 1.0、SliceView wheel `useEvent`、DEV 計數器 | B4、B5、B6、B7 |
| `src/pages/Section3D/SliceEditor.tsx` | `tick` 去重（`gestureKey`）、hover 進 rAF、`insideKey` 用 Map、`useSliceRev` 守 `stairs`／`sctx`／`ModelStore.get`、`tbW` 用 ResizeObserver、鍵盤 listener 掛一次 | B3、A4、B7、B5 |
| `src/pages/Section3D/handleOps.ts`、`Inspector.tsx` | `sliceContext` 的 `area` lazy | A4 |
| `src/slice/gestures.ts` | `gestureKey`、`edgeAmount` 算一次、`profileDelta` bbox 只看改的環 | B3 |
| `src/slice/raster.ts` | `deltaOf` 種子只取邊界、scratch 重用 | B3 |
| `src/slice/mirror.ts` | 主 key 用 `main` 的結果 | B3 |
| `src/slice/model.ts` | `ModelStore`：alias、位元組上限、`prune`、`bytes()`；`get(..., touched)` | A4、D2 |
| `src/slice/relative.ts` | `ringCache` LRU、數值簽名 | D3 |
| `src/pages/Section3D/StructureList.tsx` | `memo(StructRow)`、群組元件只在展開時掛 | B2 |
| `SplitPicker.tsx`、`EditToolbar.tsx`、`Inspector.tsx`、`ChangesTab.tsx`、`PositionBar.tsx`、`FloatingToolbar.tsx`、`MatrixTab.tsx`、`DesignPanel.tsx` | `memoEd(..., uses)` | B2 |
| `src/pages/Section3D/overlay.ts` | `contourOf` 有 bbox、快取值含 diff、刪 `diffPair` | C5 |
| `src/pages/Section3D/OverlayView.tsx`、`CompareView.tsx` | `useMemo`、`memo(Legend)` | C5 |
| `src/pages/Section3D/slabs.ts` | `pairMask` 快取 | C5 |
| `src/pages/Section3D/drawSlice.ts` | `sliceRGBA(..., crop)`、每 canvas 重用 `out` | C6 |
| `src/pages/Section3D/thumbs.ts`、`SplitCard.tsx` | 用 `crop` | C6 |
| `src/pages/Section3D/SettingsDrawer.tsx` | 「復原記憶體上限」 | D1 |
| `scripts/bench.ts` | `step` 加 `--sel substrate`／`--corners`／`--op translate-substrate` 與 selMask／diffBox／PS bytes／hist bytes 欄；新 `drag2`、`export`、`decode`、`overlay`、`thumbs`、`layer void` | M15.0 |
| `scripts/e2e/perf.cjs` | 新段：拖欄寬、點切面（layer 請求／把手重建）、一步後 hover、上傳 ×2 比例陣列、匯出 20 個 split、疊圖 legend 滑過 | M15.0 |
| `scripts/e2e/m15.cjs` | 新檔：§7 的 e2e 驗收 | M15.7 |
| `README.md` | 「每 split 10 步」→ 50 步或 256 MB；「大陣列的效能」加 v15 表；匯出段提 ZIP64、串流、只重壓改到的 block | M15.7 |

---

## 7. 測試清單

逐位元組對照（既有 212 個測試全部不動、全部要過）：

- `volume.test.ts`／`apply.test.ts`／`patch.test.ts`：`relabelInPlace`（只快照 F）vs `relabelFast`——既有案例＋新增「fin 在基板上長高 1」「poly 削到露出 STI」「兩個結構併成一個（merged-away 不在 F 裡）」「步驟 8 有搬動」四個，`comps`／`S`／`moves`／`before` 全部相等；另印 `PF.length` 斷言 `< Smax 舊算法的 1/10`。
- `patch.test.ts`：`carryStepStats` 維護的 `axes` → `diffBoxOfAxes` === `tightBox(dims, diff, touch)`，50 步隨機補丁含 back。
- `volume.test.ts`：`patchMask`：隨機 20 步之後原地維護的 mask === `maskOf(L, sel)` 重建；含換編號（moves）與 relabel 併結構的步驟；`affMask` 含 scope 不是整段。
- `dilate.test.ts`：計數排序 vs comparator 排序，結果陣列相等（既有逐體素測試自然涵蓋）。
- `worker.test.ts`：`apply` 回的 `report.cells` ≤ 50k、`slices` 的 `blocked` 總和 === 全部被擋數；VOID `layer` 在 X-ray 下 `boxOf` 不被呼叫（spy）且結果 chunk 集合相同；`vtiInspect`／`vtiDecode`／`npyDecode` 經 `handleAny` 與直接呼叫 `decodeVti` 結果相同；`export` 的 `crc` === `crc32(bytes)`。
- `vti.test.ts`／`vtiFrac.test.ts`：`patchBlocks` 版 `encodeVtiLike` 解回來的值 === 舊版解回來的值（所有格式：appended raw／base64、inline binary、ascii；壓縮／不壓縮；UInt32／UInt64 header）；壓縮且 `chg` 只碰 2 個 block 時，其他 block 的壓縮位元組與原檔 `subarray` 相等；`readBlock` 批次版 === 序列版；`b64Bytes` === `TextEncoder(b64)`；`parseAscii` 整數直出 === Float64 版轉 Uint8。
- `zip.test.ts`（新）：`ZipWriter` 收集結果 === 舊 `zipStore` 位元組（3 個小檔）；ZIP64：用假 entry（`size = 5 GiB`、資料只給 header 不給 body 的測試鉤子）檢查 local／central／EOCD64 欄位；65,536 個空檔的 central directory 正確（Node `yauzl` 讀回檔名）。
- `trace.test.ts`／`model.test.ts`／`raster.test.ts`（新）：`deltaOf` 新種子規則 vs 舊規則，隨機 200 組 before／after（含洞、被包住的格子）`add`／`remove` 順序與方向完全相同；`profileDelta` bbox 縮小後 === 舊版；`gestureKey` 相同 ⇔ `gestureToOp` 位元組相同（JSON）；`mirroredOp` 主 key 的 `perKey` === 單獨 `gestureToOp` 的。
- `model.test.ts`：alias 快照 `restore` 回來的 model deep-equal 原快照；`SNAP_BYTES` 超過時最舊的被逐、被 alias 參考的不逐；`prune` 後只剩 live 版本；`get(..., touched=false)` 不呼叫 `verifyKey`（spy）。
- `previewWorker.test.ts`：`ringCache` 滿 `max` 之後再放一筆只逐一筆、`stats.traced` 只 +1；簽名碰撞（人工構造同 hash 不同 pts）當 miss。
- `overlay.test.ts`：`contourOf(…, bbox)` === 無 bbox 版；快取值含 `diff` 且 key 含 baseVersion。
- `drawSlice.test.ts`：`sliceRGBA(crop)` === 整片裁下來；重用 `out` 的第二次呼叫結果相同。
- `handles.test.ts`／新 `pick.test.ts`：`pickOrdered(firstOnly)` 回的命中 === `intersectObjects` 的最近命中（隨機射線 200 條，三個 chunk 配置）。
- 身分規則（`editor` hook 測試，新 `identity.test.tsx`，`@testing-library/react` 或 `react-test-renderer`）：cursor 連點 10 次 `scope`／`selBBox` 身分不變；一步之後 `selMask` 身分不變、內容對；`keepSel` 沒濾掉時 `sel` 身分不變；`ed` 的每個函式欄位在兩次 render 之間 `Object.is`。
- `memoEd` DEV Proxy：render 期間讀了 `uses` 以外的欄位 → `console.error`（測試用 spy）。

e2e（`scripts/e2e/m15.cjs`，需 `npm run dev`）：

1. 載入 ×2 → 選基板 → 連做 5 步：每步 `__selMaskMs < 5`、`__diffBoxMs < 1`、`__posts.layer` 每步 1、頁面 `__renders.StructureList` 每步 ≤ 1。
2. 點主切面 20 次（換 cursor）：`__posts.layer` 不增、`__handleBuilds` 不增、`Section3DPage` commit 20 次但 `Inspector`／`StructureList` 0 次。
3. 拖左欄寬 60 個 pointermove：`Section3DPage` commit ≤ 20。
4. 2D 拖基板頂邊 60 步（×2）：`__ops`（算 Op 的次數）／60 ≤ 0.5；`__posts.preview` ≤ `__ops`；long task 數 ≤ v14 的一半。
5. 一步後立刻 hover 10 次：無 > 50 ms long task（軟體 WebGL 的畫幀除外：看 `__bvhBuilds` 每事件 ≤ 預算內的數量）。
6. 上傳合成的 ×2 比例陣列 .vti（8 個 Float32 zlib appended）：解碼期間主執行緒無 > 50 ms long task；`performance.memory` 增量 ≈ N × (1 + 4) ＋ 常數（原檔只在 Worker）。
7. 產生 20 個 split → 匯出全部（vti1）：主執行緒 `performance.memory` 尖峰增量 ≤ 1 個 split ＋ 32 MB；zip 用 Node `yauzl` 開、每個檔的 CRC 對；同格式匯出一個改 2 萬格的 split：Worker 花費 < 300 ms、未改 block 位元組 === 原檔。
8. 實驗頁 200 個 split 疊圖：legend 滑過 60 次 `__overlayMs` 總和 < 120 ms、`OverlayView` render 60 次但 `lines` memo 命中 60 次（`__overlayMemoHits`）。
9. 按 X（X-ray）：`__posts.layer` 的 void 請求 Worker 端耗時 < 20 ms（×2）。
10. 復原堆疊：對基板做 10 次 translate（×1 就夠）→ `__histBytes ≤ HISTORY_BYTES`，筆數隨上限縮。

---

## 8. 里程碑、工作拆解、驗收

依賴：M15.0 先；M15.1 → M15.3（A4 用 `lastStep`）；M15.2 獨立；M15.4 獨立；M15.5 獨立（C2 的 CRC 要 Worker `export` 改）；M15.6 獨立；M15.7 最後。

### M15.0 量法與基線（S）

- `bench.ts`：`step` 加旗標與新欄（selMask ms／配置位元組、diffBox ms、PS bytes、hist bytes、move bytes）、`drag2`（基板頂邊、Poly 整層、對應開著；印每幀 ms、`gestureToOp` 次數／幀數、`stairs`／verify 次數）、`export`（合成壓縮比例陣列 ×1／×2：解碼 ms、`encodeVtiLike` ms、block 重壓／總數、zip writer MB/s）、`decode`、`overlay [scale] [n]`、`thumbs`、`layer void`。
- `perf.cjs` 新段（§7 e2e 1～9 的量測版，不斷言）；DEV 計數器：`__selMaskMs`、`__diffBoxMs`、`__handleBuilds`、`__bvhBuilds`、`__ops`、`__overlayMemoHits`、`__histBytes`、`__renders[元件名]`。
- 驗收：§3 每一列的「現在」欄填進 §11.2。

### M15.1 每一步的固定成本（L）

順序：`patch.ts` axes → `workerCore.ts` Book → `lifecycle.ts` → `editor.ts` `SplitBuffers`／`useSelMasks`／`lastStep`／`trimHist` → `volume.ts` relabel F／`patchMask`／dilate → `apply.ts`／`report.ts` OpReport → VOID box。

驗收：§7 的 volume／patch／apply／worker／dilate 測試過；`bench.ts step --sel substrate 2 3`：selMask < 3／5 ms、配置 0；`--corners`：diffBox < 1 ms；PS bytes ≤ F；×3 一步 Worker apply < 500 ms；`bench.ts mem --op translate-substrate`：hist ≤ 256 MB；`bench.ts layer void` < 5 ms；e2e 1、9、10。

### M15.2 身分與 render（M）

順序：`useEvent`／`stable`／`memoEd` → `editor.ts` scope 與函式欄位 → `index.tsx` 物件與 callback → `Resizer` → 各元件 `memoEd(uses)`（DEV Proxy 跑一輪把 `uses` 補齊）→ `StructRow` → listener 與 ResizeObserver。

驗收：`identity.test.tsx` 過；e2e 2、3；`perf.cjs`：點切面 `layer` 0、把手重建 0；一步之後 `Inspector`／`StructureList`／`SplitPicker`／`EditToolbar` 各 ≤ 2 次 render；拖欄寬 commit ≤ 20；所有既有 e2e（m0～m14）行為不變；DEV console 沒有 `memoEd` 警告。

### M15.3 2D 拖拉與每步重描（M）

順序：`gestures.ts` `gestureKey`／`profileDelta` bbox → `raster.ts` 種子與 scratch → `mirror.ts` → `SliceEditor.tick` 去重＋hover rAF → `useSliceRev` → `ModelStore` alias／bytes／prune → `ringCache`。

驗收：`trace`／`model`／`raster`／`previewWorker` 測試過（含 `model.test.ts` 黃金測試不變）；`bench.ts drag2 2`：基板頂邊 < 8 ms／幀、Op 次數／幀數 ≤ 0.5、沒碰到的片 trace 0 次；`models.bytes()` 連做 50 步 ≤ 64 MB；e2e 4；`m5.cjs`／`perf.cjs` 既有 2D 段數字不退步。

### M15.4 3D 拾取與繪製（S～M）

- `pickOrdered` → BVH 預算 → 單一 idle 鏈 → ResizeObserver 標籤 → pixelRatio。
- 驗收：`pick.test.ts` 過；e2e 5；`perf.cjs` 一步後 hover 無 > 50 ms long task（headless 畫幀除外，看 `__bvhBuilds`）；轉視角每幀無強制 layout；`m0.cjs`／`m3.cjs`（點選、hover、後面的結構、對準）行為不變。

### M15.5 載入與匯出（L）

順序：`vti.ts` 批次 inflate／`patchBlocks`／parts／`b64Bytes` → Worker 三個 decode handler、`export` crc＋parts、`exportMeta` 只送 fractions → `client.ts` → `UploadPanel`／`editor.ts` `hasRaw` → `zip.ts` `ZipWriter`＋ZIP64 → `download.ts` sink → `index.tsx` `exportAll` 串流＋大小預估。

驗收：`vti`／`vtiFrac`／`zip`／`worker` 測試過；`bench.ts export 2`：block 重壓數 ＝ 碰到的 block 數、`encodeVtiLike` < 300 ms；`bench.ts decode 2` ≤ 基線 1/3；e2e 6、7；`m12.cjs` §5（parked 匯出 ≡ live 匯出）不變；舊的小 zip 位元組不變（`zip.test.ts`）。

### M15.6 實驗頁（S～M）

- `overlay.ts` bbox＋快取 → `OverlayView`／`CompareView` memo → 刪 `diffPair` → `sliceRGBA(crop)` → `thumbs.ts`／`SplitCard` → `drawSlice` 重用 `out`。
- 驗收：`overlay`／`drawSlice`／`thumbs` 測試過；`bench.ts overlay 3 200` 換片 < 1 s；`bench.ts thumbs 3` < 2 ms／張；e2e 8；`m12.cjs` §2／§4（縮圖同軸、黑線、DOM 卡片數、滑鼠移動 0 render）不變。

### M15.7 文件與收尾（S）

- `m15.cjs` 全綠；README 三處；本文件 §11 填量測、§3 表填實測欄；`docs/plan-v9-performance.md` §11.3「沒達到的」裡 ×3 點選基板 190 ms 那條標記為 v15 解決。

---

## 9. 風險與對策

| 風險 | 對策 |
|---|---|
| A1 原地維護的 mask 漏掉某種步驟（例如 `commitTo 'all'`、`run` 重播、parked → live `restore`）而過期 | 只有「選取簽名相同＋`lastStep.seq` 遞增 1」才走增量；其他一律重建。DEV 下每 20 步隨機抽一次 `maskOf` 全量比對，不同就 `console.error`＋重建（e2e 把它當失敗） |
| A2 `axes` 在 Worker 與主執行緒各維護一份，某條路徑忘了更新 | `axes` 只在 `carryStepStats` 一個地方動；`fork`／`replay`／`restore`／`pastePatch` 都在 O(patch) 重數；`worker.test.ts` 每個 handler 之後斷言 `diffBoxOfAxes === tightBox` |
| A3 `before` 拼接時 F 與 S 的座標換算錯 | 純函式對照 `relabelFast`；新增四個刻意讓 S ≠ F 的案例 |
| B2 `memoEd` 的 `uses` 漏欄位 → 畫面過期 | DEV Proxy 警告＋e2e 把 console error 當失敗；每個元件一開始先用 Proxy 跑一輪 m0～m14 把 `uses` 補齊 |
| B2 `useEvent` 把函式變成 ref-latest 之後，有人把它放進 `useEffect` deps 期待它觸發 | 只對「回傳給 UI 的事件 handler」用；`commit`／`undo` 這類已是 `useCallback` 且被 effect 依賴的維持原狀 |
| B3 去重之後 ghost 與 Op 不同步（ghost 浮點、Op 取整） | 本來就是這樣（提示文字「(+1.6, −2.3) → 取 (+2, −2)」），去重只是少算相同的 Op |
| B3 `deltaOf` 種子規則改變 BFS 順序 | §5.3 的論證＋200 組隨機對照測試；任何一組不同就回退到舊種子（保留舊版函式做 fallback 開關） |
| B4 預算內沒建到 BVH、退回三角形級 raycast 的那一幀變慢 | 預算 8 ms 只擋極端；退路是 O(tris) 不是 O(N)；idle 鏈 1～2 秒內補完 |
| B6 pixelRatio 1.5 在 Retina 上看起來比現在軟 | 靜止時 1.5（和 2 的差異肉眼難辨）、互動中 1.0；設定抽屜給「畫質：高（2）／標準（1.5）」 |
| C1 `patchBlocks` 對某種 header（UInt64、big-endian、inline base64 分行）算錯 block 範圍 | 所有格式都有既有測試；新測試斷言「未碰到 block 的壓縮位元組 === 原檔」；任何不支援的組合退回舊的整陣列路徑（保留 `encodeBlock`） |
| C2 `showSaveFilePicker` 在 artifact 檢視器／Safari 沒有 | 退回 Blob parts；artifact 檢視器退回既有的 `viewer.save`；三條路徑 e2e 各跑一次（Chromium、以旗標關掉 picker、模擬 viewer） |
| C3 解碼搬進 Worker 後上傳面板的進度文字沒東西可報 | 保留三個階段；Worker 在每個比例陣列解完 `postMessage({progress})`（可選，不在 Promise 協定裡） |
| C3 `buf` transfer 之後使用者在確認框按取消 → 想重選 | Worker 的 `pendingRaw` 留到下一次 `vtiInspect` 或 `vtiDecode`；取消就 `call('vtiDrop')`（新 handler，釋放） |
| D1 位元組上限把使用者還想要的復原步驟丟掉 | 設定可調；堆疊被截時訊息一次「復原記憶體達上限，最早的 n 步已不能復原」 |
| D2 alias 鏈太長（幾百個版本都指向同一份） | `alias` 永遠指向實體快照的 key（扁平），不鏈 |
| 一次改太多，回歸難找 | 每個里程碑獨立 commit、獨立跑全部測試與 m0～m14；§3 的表每個里程碑填一次 |

---

## 10. 決策記錄

- **D4（補洞永遠搬最後一個 comp）不做（2026-11-01 使用者同意）。** 壓緊 comps 陣列時要搬的 comp 集合是固定的（index ≥ 壓緊後長度的那些），選不了；唯一的根治是允許空位（墓碑），但 `L.comps[l]` 的索引語意遍佈 editor、UI、Worker、manifest、補丁的 `comps`（約 20 個檔案）。觸發條件（一步合併或刪掉整個結構）比一般 push 少得多；`bench.ts step` 印 move bytes 當監測，若實測每步平均 > 10 MB 再開一個計畫。
- **BVH 不搬進 Worker。** `MeshBVH.serialize` 要連 `index` 一起送、主執行緒 `deserialize` 仍要配置；有預算的懶建＋由近到遠拾取已經把「一次付清」拆散。留作選配。
- **MSAA 不動態切。** `WebGLRenderer` 的 `antialias` 建立後不能改；用 pixelRatio 控制 fill cost 就夠（16 → 9／4 sample）。
- **ZIP64 只在需要時寫。** 小 zip 位元組要和現在相同（既有 e2e 與使用者腳本可能比對）；> 4 GiB 或 > 65,535 個檔才加 ZIP64 記錄。
- **`selMask` 身分在同一個選取裡不變。** 這和 `Split` 註解的「改 buf 的同一個 tick 一定換新 cur」是同一條規則的另一面：陣列身分不變、靠 `vol`／`L` 的身分觸發重算。§7 的身分測試守住。
- **報告在 Worker 摘要。** `OpReport` 欄位不變、`cells` 有上限；`slices` 的每片被擋數在截斷前算，所以「看這些片」仍然完整。
- **`previewIn` 不再送 `comps`。** Worker 在 `apply`／`derive`／`replay`／`restore` 都算出 comps，順手存成 `compsOf.set(sid, comps)`；`preview` 用它。主執行緒的 comps 與 Worker 的逐欄相同（`worker.test.ts` 已有斷言）。
- **解碼在 Worker、原檔只留 Worker 一份。** 主執行緒只要一個 `hasRaw`。範例資料（`demoVolume`）不經這條路。
- **`contourOf` 只描 key 的 bbox。** 和 v14 §5.5 「結構縮圖畫產生要用的底」一致：輪廓是結構的輪廓，不需要整片。
- **StructureList 先 memo 每列、不虛擬化。** 幾百個結構的清單 memo 之後 reconcile 成本已可忽略；上千再說。

---

## 11. 實作紀錄

### 11.1 和計畫不同的地方

依各里程碑實作者回報整理，並對照 HEAD b06f914 的程式碼；條目編號對應 §1／§5。

**M15.1 每一步的固定成本**

- **A1 多了 `canPatchMask`**（`editor.ts`）：`nameByVotes` 可能把被併結構的 key 認領給 S 外面的編號，這時只在 box 裡補 mask 會漏。規則＝每個結構編號「選了／沒選」前後不同的，改前、改後的外框都要在 box 裡，否則整個重建（`maskOf`）。`LastStep` 多一欄 `owner`（哪本帳簿），換 split 時不會拿別本帳簿的 box 去補。DEV 下每步 1/20 機率和 `maskOf` 全量比對，不同就 `console.error` ＋ 重建。
- **A2 `restore` 回應沒帶 axes**：主執行緒 `restoreBuffers` 在補丁外框裡順手數（`recountAxes`），Worker `pastePatch` 同一個函式；Worker 協定一個欄位都沒加。
- **A3 的測試斷言改了**：「PF < 舊 Smax 的 1/10」只對刻意的案例成立（整根 fin 長高時 F 被襯層撐大，只有 1.2×）；改用 fin 局部長高（159×）與整結構換空氣（22.7×）兩個案例斷言，另外四個 S ≠ F 的案例只斷言結果和 `relabelFast` 逐位元組相同。
- **C7 `summarize` 放在 workerCore 的 `apply`／`applyParked` handler**，`applyOpInPlace` 仍回原始 Report（kernel 不知道上限）；`OpReport` 欄位不變。
- **§10「`previewIn` 不再送 `comps`」**：`compsOf` 以 owner（不是 sid）為 key；新增 `comps` handler 與 `put.comps?`，給 parked → live 與重播後主執行緒要 comps 用。

**M15.3 2D 拖拉與每步重描**

- **B3 `gestureKey` 的 edge 含取整 (du, dv) 與 single 旗標**（`recordGesture` 存的是 `Math.round(delta)`，Op 的 `gestures` 欄位跟著它）；所以 push 路徑的 key 比 Op 保守——同一個 n、不同的取整位移會算兩次相同位元組的 Op（§11.2 的「位元組相同的 Op 重算」push 列仍有 40～50%，profile 列 0%）。`deltaOfRef` 只做測試對照，沒有執行期 fallback。
- **B3 `profileDelta` 外框縮小的語意差**：「放開後 Worker 還沒回來」的 pending 視窗裡，多環 key 的其他環 pending 差不再算進 Op（舊版會）；放開前與 Worker 回來後和舊版逐格相同（`raster.test.ts` 隨機對照）。
- **A4**：`Shape.area` 改 lazy getter ＋ `areaOf`（只有「對應」配對會讀）；`ModelStore.get(..., touched)` 只在「不 pending、沒快照、cur 有模型」時跳過驗證；`verifyKey` 的 spy 改成計數器 `modelStats`；`useSliceRev` 冪等（StrictMode 第二次呼叫不會把 touched 翻成 false）；首次 lastStep 為 null 一律算 touched。限制：`stepTouch` 的 S 常比改動大很多，沿 z 看基板時幾乎每步都「碰到」這一片，省算在別的結構或 x／y 切面才明顯（A3 的 S 粒度）。
- **D2 逐出規則**改成「依版本順序找第一個可逐的：指標一律可逐、實體要沒有指標參考」，永不留懸空指標；`prune` 的 live 加 `sidOf(orig)`；順手修了 alias 還原沒接 `baseVersion` 的 bug（d2221f4 就在）。

**M15.4 3D 拾取與繪製**

- **B4** `pickOrdered` 核心是 generator `pickAlong`；BVH 預算的重設放在 host 的 capture listener（每個 pointer 事件一次）；「優先建最近一步碰到的 chunk」用 Worker `chunks` 回應的 `r.items`；多掛 `__bvhStats`。
- **B6** 降解析度在轉視角的第一次 `change`／拖拉過死區，不是 pointerdown（避免點一下閃一格）；畫質設定透過 `QUALITY_EVENT` 即時生效。

**M15.5 載入與匯出**

- **C1** `hint` 多 `dims`、`diff` 可選（parked 只有補丁外框）；未壓縮陣列用 32 KB 虛擬 block；ascii 用原檔 token 引用＋`Parts` 收集器；順手修了 big-endian 讀寫；`ZipWriter` 多同步 `entry()`／`close()`（`zipStore` 與測試走它）。
- **C2／C3** `export` 回 `{bytes, crc, stats}`、client 包成 `Uint8Array & {crc}`；parked 匯出用模組級 `exportBuf`（第一次配置、之後 O(外框)），不是零配置；`exportMeta.raw` 保留為可選；`npyDecode` 同步；`keepRaw` 一律 true、由 Worker 依 fractions 決定留不留；Blob sink 每段先包成 Blob。

**M15.6 實驗頁**

- **C5** `contourOf` 省略 bbox 時自動用 keys 外框，`'full'` 保留舊行為；`__overlayMs` 改累計；`pairMaskOf` LRU 以位元組（32 MB）為上限。
- **C6** thumbs 多一片共用裁切窗暫存（`scratchFor`）。

**M15.2 身分與 render**

- **B1／B2** index.tsx 鍵盤 listener 改掛 document capture（Esc 順序）；欄寬走 live value（`useLiveWidth`），不只 Resizer rAF；計數器名 `__rendersBy`（commit 次數）；`useEvent` 也包了 `factorCtx`／`stats`／`voxelCoord`；群組 Tooltip／ColorPicker／Dropdown 在展開或滑過標題列時才掛；hook 測試用 `react-dom/client`＋act＋測試檔內假 DOM，`useEditor` 本身的身分測試改以 e2e 探針驗。

**M15.7 量測工具**

- `bench.ts` 改量新路徑（檔頭）：`step --sel substrate` 第一步 `maskOf`、之後 `canPatchMask`＋`patchMask`，並逐位元組對照 `maskOf`＋`maskInScope`；diffBox 改 `diffBoxOfAxes` 對照 `tightBox`；PS 快照改讀 `relabelStats.snapshot`（舊的 Int32 配置 Proxy 留作對照，兩者相同）；hist 用 `trimHist`；`drag2` 以 `gestureKey` 去重、`profileDelta` 包 `raster.deltaOf` 實際計數、`ModelStore.get(touched=false)`＋`modelStats`、`store.bytes()`；`export` 傳 hint 印 `ExportStats`、`--whole` 對照位元組、zip 用 `ZipWriter`；`overlay` 用 `overlayEntry`＋`contourCache`，對照 `'full'`。
- 測試數 261 → 369。

### 11.2 量測

#### M15.0 基線（2026-11-01，HEAD 83d2256，v15 任何修改之前）

環境：雲端容器、Node 22、4 核、15 GB；頁面量測用 headless Chromium（軟體 WebGL、dpr 1，`--enable-precise-memory-info --js-flags=--expose-gc`），dev server `npx vite --port 5188`。
單位 ms；`bench.ts` 的數字是中位數（寫「～」的是每步範圍），頁面的數字是一次跑的結果。量的時候容器裡還有其他 worktree 的 dev server 與 vitest 在跑，絕對值偏保守（之後重跑比較「之後」欄時用同一台、同時段、同指令）。記憶體用 `process.memoryUsage`（Node）、`performance.memory.usedJSHeapSize`＋renderer RSS（`ps`，因為 ArrayBuffer 不一定算在 usedJSHeapSize）。
工具：`scripts/bench.ts`（新模式與旗標見檔頭）、`scripts/e2e/perf.cjs --v15`（`--only=1,…,9` 只跑幾節；舊段落在這個容器的 ×2 會在「長／縮」卡片那一步逾時，和本計畫無關，所以新段落可以單獨跑）。
沒有 hook 的項目用外部手法：relabel 的 PS 快照＝把全域 typed array 建構子與 `prototype.constructor` 換成計數 Proxy（`cropBox` 的 `new (src.constructor)(n)` 也會走到），取 apply 期間最大的一次 Int32 配置；`profileDelta` 次數＝`deltaOf` 每次配兩個 `Int8Array` 推回來；Worker 往返＝`addInitScript` 包 `Worker.prototype.postMessage`／`onmessage` 以 id 配對。
DEV 計數器（`__selMaskMs`、`__diffBoxMs`、`__handleBuilds`、`__bvhBuilds`、`__ops`、`__overlayMemoHits`、`__histBytes`、`__renders[元件]`）要等 M15.1～M15.6 在 src 掛上，perf.cjs 現在印 n/a。

| 項目 | ×1 | ×2 | ×3 | 量法指令 |
| --- | --- | --- | --- | --- |
| 每步 `selMask`＋`affMask`（選到基板；maskOf 掃選取外框配 N ＋ maskInScope 配 N） | 2.6（最大 4.4） | 19.5（最大 28.8）；配 30 MB | 47.5（最大 52.6）；配 101 MB | `bench.ts step 1 2 3 --sel substrate` |
| 每步 `diffBox`＝`tightBox` 掃整個 touch（poly 連推 10 步） | 0.2 | 1.5（touch 1.3 M 格） | 4.9（touch 4.3 M 格） | `bench.ts step 1 2 3` |
| 同上，先在基板相隔兩角各推一下（touch 撐到整個 X×Z） | 1.6 | 10.3 | 34.8（touch 31 M 格＝58%） | `bench.ts step 1 2 3 --corners` |
| relabel 的 PS 快照（apply 期間最大的 Int32 配置），poly 長高 1 | 0.6 MB | 4.9 MB | 16.4 MB（S 的 before 1.4～15 MB） | `bench.ts step 1 2 3` |
| 同上，fin 左右搬 1（R±1 碰到基板、STI、poly → Smax 全包） | 6.1 MB | 48.8 MB | **143.4 MB**（S 的 before 6.5～23 MB） | `bench.ts step 1 2 3 --op translate-fin` |
| move bytes（補洞搬最後一個 comp） | 0 | 0 | 0（這幾種步驟都沒搬） | `bench.ts step` |
| 一步 Worker apply：poly 長高 1 | 9～115 | 69～140 | 162～342 | `bench.ts step 1 2 3` |
| 一步 Worker apply：fin 左右搬 1 | — | — | 629～1,056（主執行緒貼補丁 30～53） | `bench.ts step 3 --op translate-fin` |
| 復原堆疊：10 步 poly 長高 1 的 `stepBytes` 累計 | 7.2 MB | 49.3 MB | 165.5 MB | `bench.ts step 1 2 3` |
| 復原堆疊：50 步基板級 translate | 253 MB（5.1 MB／筆） | 2,023 MB（40.5 MB／筆） | **6,828 MB**（137 MB／筆；HISTORY_LIMIT 50 筆全留） | `bench.ts mem 1 2 3 --op translate-substrate` |
| `layer {mat: VOID}` 全量（X-ray 第一次／切 split／非相鄰版本） | 61（閉包掃描 ≈ 20）／40 | 129（≈ 144）／84 | 234（≈ 492）／208 | `bench.ts layer void 1 2 3` |
| `layer {mat: VOID}` 增量（base＝上一步） | 15 | 23 | 77 | 同上 |
| 開 X-ray：頁面 `layer` 往返（含佇列） | — | 145 | — | `perf.cjs --v15 --only=9` |
| 2D 拖頂邊 60 幀（push 路徑）：主執行緒每幀（opOfGesture＋第 1 級） | 0.4 | 1.4（基板）／2.0（Poly 整層） | 3.8／5.6 | `bench.ts drag2 1 2 3` |
| 2D 拖頂邊左端角節點 60 幀（profile 路徑）：主執行緒每幀 | 2.4（p95 12.3） | 6.9（p95 12.5）／10.0（p95 24.2） | 16.4（p95 35.2）／21.2（p95 44.9，最大 133） | 同上 |
| 算 Op 的次數／幀數；profileDelta 次數／幀數；位元組相同的 Op 重算比例 | 1.0；0.85；88～94% | 1.0；0.93；79～89% | 1.0；0.95；79～84% | 同上 |
| 第 2 級（Worker preview，整根）每幀 | 33 | 447（基板 push）／189（profile） | 1,534／659 | 同上 |
| 每步（沒碰這一片，5 個 key）：stairs ＋ ModelStore.get（verify）＋ sliceContext | 1.9＋1.6＋0.4 | 4.2＋2.1＋1.2 | 10.9＋3.5＋2.5 | 同上 |
| ModelStore 快照：50 個版本（估計） | 0.5～0.9 MB | 0.5～0.9 MB | 0.8～1.6 MB | 同上 |
| 頁面 2D 拖基板頂邊 60 步 | — | 161 幀／2,474 ms（≈ 15.4 ms／幀）、0 個 long task、preview 請求 0（整根超過 LIVE_PREVIEW_CAP） | — | `perf.cjs --v15 --only=4` |
| 拖左欄寬 60 個 pointermove | — | 整頁 render 240、3D 重畫 120 幀、153 個 long task（最長 122～208）、13.8 s | — | `perf.cjs --v15 --only=1` |
| 換 cursor 20 次（`setCursor`，聚焦編輯） | — | `layer` 20 次、整頁 render 80、50 個 long task（最長 186～210） | — | `perf.cjs --v15 --only=2` |
| 一步後 hover 10 次 | — | 20 個 long task（最長 112～159）、每次 pointermove 63～126 | — | `perf.cjs --v15 --only=3` |
| `decodeVti`（8 個 Float32 zlib appended，合成） | 1,181 | 7,173 | 22,428～26,173 | `bench.ts decode 1 2 3` |
| `encodeVtiLike` 改 2 萬格（Node；碰到的 block／總 block） | 1,686（208／1,920） | 11,749（320／15,360） | 32,461（384／51,840） | `bench.ts export 1 2 3` |
| 同格式匯出一個 split（頁面 Worker，改 32k 格） | — | 4,189 | — | `perf.cjs --v15 --only=7` |
| `zipStore` 20 個 vti1（Node） | 37.5 MB，273 MB/s | 300 MB，278 MB/s（1,078 ms） | 1,013 MB，296 MB/s（3,417 ms） | `bench.ts export 1 2 3` |
| 頁面匯出 20 個 split 的 zip（vti1） | — | 300 MB／3,145 ms；JS heap 338 → 651（尖峰 940）MB、RSS 1,039 → 988（尖峰 1,877）MB | — | `perf.cjs --v15 --only=7` |
| 頁面上傳合成比例陣列 .vti | — | 偵測 162、到結構分析完 3,635、到 3D 4,783；7 個 long task（最長 373）；JS heap 109 → 120（尖峰 446）MB、RSS 284 → 470（尖峰 770）MB | — | `perf.cjs --v15 --only=6` |
| 200 個 split 疊圖換片一次（contourOf＋sliceDiff 全部） | 118（描 83、比對 12） | 343（325、61） | 1,377（833、118） | `bench.ts overlay {1,2,3} 200` |
| 200 個 split 疊圖 legend 滑過 60 次：每次 | 10.2（最大 18.6） | 42.0（最大 68.4） | 91.5（最大 198.7） | 同上 |
| 頁面實驗頁 200 個 split（UI 疊 12 條）legend 滑過 60 次 | 0.5／次（總 28 ms）、整頁 render 4 | — | — | `perf.cjs --v15 --only=8` |
| `thumbRGBA` 一張 | 1.4、配 0.1 MB | 0.5、配 0.3 MB | 0.8、配 0.6 MB（整片 RGBA 0.5 MB） | `bench.ts thumbs 1 2 3` |

和盤點時估計不同的：PS 快照比估的 57 MB 大（143 MB，Smax 把 STI 與 poly 也包進來）；`ModelStore` 快照遠小於估計（基板環只有 4 個頂點）；縮圖整片 RGBA 是 0.5 MB 不是 6.6 MB（×3 切面 480×288）；2D 拖**邊**走 push 早退很便宜，重的是節點／斜邊走 `profileDelta` 的路徑；疊圖 ×1 legend 每次 10 ms（估 40～80）。
量不到的：把手重建次數、BVH 建置次數、每幀強制 layout、各元件 render 次數（都要 DEV 計數器，M15.2／M15.4）；HiDPI sample 數（headless dpr 1）；ZIP64（程式碼推得）；`ringCache` 逐出（測試層級）；上傳時原檔常駐份數（合成檔 1.3 MB 看不出來，要用真檔）。

#### M15.7 之後（2026-11-01，HEAD b06f914，M15.0～M15.6 全部合併）

同一台容器、同一組指令、同一天重跑；`bench.ts` 已對準新路徑（§11.1 最後一節），每條新路徑都和舊路徑逐位元組／逐欄對照（selMask、diffBox、PS 快照、`--whole` 匯出），對照全部通過。量的時候容器裡同時有別的 worktree 在跑 e2e；`selMask`、`layer void`、`export ×2` 三列跑了兩次取較好的一次。欄位和基線表對齊；頁面層級的列（`perf.cjs`）由協調者補。

| 項目 | ×1 | ×2 | ×3 | 量法指令 |
| --- | --- | --- | --- | --- |
| 每步 `selMask`＋`affMask`（選到基板；第一步 `maskOf` 重建，之後 `canPatchMask`＋`patchMask`，配置 0） | 長高 0.2～0.4／縮 1.3～2.6（重建 7.8） | 長高 **0.8～1.4**／縮 1 **9～10**（重建 14；配 0） | 長高 **3.0～3.2**／縮 1 **26～35**（重建 47；配 0；對照全量 42～94） | `bench.ts step 1 2 3 --sel substrate` |
| 每步 `diffBox`＝`diffBoxOfAxes`（poly 連推 10 步；括號＝對照 `tightBox`） | 0.02（0.2） | 0.05（1.5） | 0.03（4.8） | `bench.ts step 1 2 3` |
| 同上，先在基板相隔兩角各推一下（touch 撐到 10%） | 0.03（1.6） | **0.02**（10.7） | **0.02**（34.8） | `bench.ts step 1 2 3 --corners` |
| relabel 的 PS 快照（`relabelStats.snapshot` × 4；舊法 Int32 配置相同），poly 長高 1／縮 1 | 0.1／0.6 MB | 1.4／4.5 MB | 1.4／15.1 MB（S 的 before 相同＝S ＝ F） | `bench.ts step 1 2 3` |
| 同上，fin 左右搬 1 | 3.0～3.7 MB | 24.1～29.3 MB | **6.5～23.3 MB**（基線 143.4） | `bench.ts step 1 2 3 --op translate-fin` |
| move bytes | 0 | 0 | 0 | `bench.ts step` |
| 一步 Worker apply：poly 長高 1／縮 1 | 14～27 | 60～140 | 146～166／340～460 | `bench.ts step 1 2 3` |
| 一步 Worker apply：fin 左右搬 1 | — | — | **563～895**（主執行緒貼補丁＋diff＋axes 25～50） | `bench.ts step 3 --op translate-fin` |
| 主執行緒貼補丁＋diff＋axes（poly 長高 1／縮 1） | 0.2～0.5 | 0.5～2 | 0.8～1.2／4.3～7.1 | `bench.ts step 1 2 3` |
| 復原堆疊：10 步 poly 長高 1 累計／`trimHist` 截後 | 7.2／7.2 MB（10 筆） | 49.3／49.3 MB（10 筆） | 165.5／165.5 MB（10 筆） | `bench.ts step 1 2 3` |
| 復原堆疊：50 步基板級 translate 累計／截後（上限 256 MB） | 253／253 MB（50 筆） | 2,023／**244 MB**（6 筆，丟 44） | 6,828／**137 MB**（1 筆，丟 49）；50 步後 Node 記憶體增量 284 MB | `bench.ts mem 1 2 3 --op translate-substrate` |
| `layer {mat: VOID}` 全量（X-ray 第一次；touch 空） | 57 | **35～71**（整陣列掃描已不在路徑上，剩 mesh） | **82～106** | `bench.ts layer void 1 2 3` |
| `layer {mat: VOID}` 增量（base＝上一步） | 17 | 21～38 | 80～88 | 同上 |
| `layer {mat: VOID}` 非相鄰版本（沒有 base；poly 推過一步之後，`voidBoxOf`＝原始 VOID 外框 ∪ touch） | 44 | **231～236**（基線 84） | **579～659**（基線 208） | 同上 |
| 2D 拖頂邊 60 幀（push 路徑）：60 幀中位數／真的算 Op 的幀中位數（基板／Poly 整層） | 0.0／0.6 | 0.0／1.7（Poly 2.0） | 0.0／4.5（Poly 5.2） | `bench.ts drag2 1 2 3` |
| 2D 拖頂邊左端角節點 60 幀（profile 路徑）：60 幀中位數／真的算 Op 的幀中位數（p95） | 0.0／3.6（10.5） | 0.0／**7.0（13.0）**（Poly 12.3（16.5）） | 0.0／**15.0（20.7）**（Poly 19.1（34.5）） | 同上 |
| 算 Op 的次數／幀數（`gestureKey` 去重）；profileDelta 次數／幀數（`deltaOf` 實際計數）；位元組相同的 Op 重算 | 0.12；0.30；push 50%／profile 0% | **0.22**；0.60；push 50%／profile 0% | **0.22**；0.60；push 25%／profile 0% | 同上 |
| 第 2 級（Worker preview，整根）每幀（只在 Op 變了才送） | 15～60 | 411（基板 push）／257（profile） | 1,764／755 | 同上 |
| 每步（沒碰這一片，5 個 key）：stairs 次數＋`ModelStore.get(touched=false)`＋`modelStats`＋`sliceContext` | 0 次＋0.0～0.1 ms＋traced 0／verified 0＋0.0～0.1 | **0 次＋0.0＋0／0＋0.0** | **0 次＋0.0＋0／0＋0.1** | 同上 |
| ModelStore：50 個版本 `store.bytes()`（實體／指標） | 0.0 MB（1／49） | 0.0 MB（1／49） | 0.0 MB（1／49） | 同上 |
| `decodeVti`（8 個 Float32 zlib appended，合成；`readBlock` 批次） | 808～1,117 | **4,599～6,831** | **11,592～14,290** | `bench.ts decode 1 2 3`、`export 1 2 3` |
| `encodeVtiLike(hint)` 改 2 萬格（`ExportStats` 重壓／總 block） | 147～178（208／1,920） | **280～305（320／15,360）** | 378（384／51,840） | `bench.ts export 1 2 3`、`export 2 --whole` |
| `--whole` 整陣列路徑對照（×2） | — | 6,504，位元組相同 | — | `bench.ts export 2 --whole` |
| `ZipWriter` 20 個 vti1（sink 收集；資料段不複製）／crc32 一個 split | 37.5 MB，61 段，arrayBuffers 增量 0／8～18 ms | 300 MB，61 段，增量 0／64 ms | 1,013 MB，61 段，增量 0／146 ms | `bench.ts export 1 2 3` |
| 200 個 split 疊圖換片一次（`overlayEntry` 全部；括號＝描 keys 外框 vs 'full'） | 61（79 vs 100） | 179（178 vs 232） | **341**（404 vs 524） | `bench.ts overlay {1,2,3} 200` |
| 200 個 split 疊圖 legend 滑過 60 次：每次 | useMemo 命中 0 次重算（快取全命中重組 0.3） | 0（0.4） | 0（0.4） | 同上 |
| `thumbRGBA` 一張 | 1.4（配 0.1 MB） | 0.3（0.1 MB） | **0.4（0.1 MB，只有縮圖輸出）** | `bench.ts thumbs 1 2 3` |
| 頁面層級（`layer` 請求數、把手重建、`__rendersBy`、hover long task／`__bvhStats`、拖欄寬 commit、上傳／匯出 heap、hover 60 次的 `__overlayMs`） | 協調者補 | 協調者補 | 協調者補 | `perf.cjs --v15`、`m15.cjs` |
| 測試 | 261 → **369**（44 個檔） | | | `npx vitest run` |

和基線比，一句話：每步的主執行緒固定成本（selMask 長高步、diffBox、stairs／verify、hist）與 2D 每幀都到目標；PS 快照、解碼、VOID 層非相鄰版本、Worker apply ×3 沒到（§11.3）。

### 11.3 沒達到的目標與理由

- **A1 `selMask` 在「結構縮小」的步驟 ×2 9～10 ms／×3 26～35 ms（目標 < 3／< 5）。** 配置已是 0、長高步 3 ms 達標；但 poly 縮 1 的 `stepTouch` 是整根 poly（S ＝ F ＝ 掉了體素的結構的外框，432×127×72 ＝ 3.9 M 格），`patchMask` 要在 S 裡跑兩遍（mask ＋ aff）。這是 A3 的 S 粒度，不是 A1 的問題；要再壓得把「labels 真的變了的格子」的貼合外框（Worker 在 relabel 時順手數，像 axes 那樣）放進 `LastStep`，`patchMask` 只掃它。留作選配。
- **A3 relabel 快照 fin 左右搬 1 ×3 23.3 MB（目標 ≤ F、×3 < 2 MB）。** PF 現在就等於 F（`S 的 before` 與 PS 相同），143 → 23 MB 是 F ≠ S 省下的；剩下的 23 MB 是 F 本身：fin 整根 lost bbox ∪ R±1 碰到的襯層／STI 外框。目標寫的「< 2 MB」是把 F 估成只有 R，低估了 lost bbox。要再縮只能把「掉了體素的結構」改成只重 flood fill 掉的那塊的連通範圍，涉及 relabel 的正確性論證，不在本計畫做。
- **×3 一步 Worker apply fin 左右搬 1：563～895 ms（目標 < 500）。** 比基線 629～1,056 少的就是 memcpy 的部分；剩下是 R 裡的 kernel ＋ 在 S（仍包含整個基板 bbox）裡 flood fill ＋ chunk。容器還有別的 e2e 在跑，數字偏保守，但不會壓到 500 以下。
- **A5 VOID 層「非相鄰版本」在寬 touch 之後 236／659 ms（基線 84／208）。** 第一次開 X-ray（touch 空）從 129／234 降到 35～71／82～106（掃描已不在路徑上，剩 mesh）；但沒有 base 時 `voidBoxOf`＝原始 VOID 外框 ∪ touch 是一個鬆外框，poly 推過一步之後 touch 是整根 poly，mesh 的範圍比舊版 `boxOf` 掃出來的貼合 VOID 外框大很多。切 split、復原跳好幾步會走到這條。修法：Book 裡維護貼合的 VOID 外框（每步從補丁的 before／after 差量更新，像 axes），或 `voidBoxOf` 先和「這一步 S 裡真的有 VOID 的 chunk」取交集。留作下一輪。
- **C4 解碼批次在 Node 只到 0.46～0.64×（目標 ≤ 1/3）。** `DecompressionStream` 每條 ~0.2 ms 固定成本且不並行（Node 的 zlib 綁定在同一條 thread pool 排隊），15,360 塊就是 3 s 地板；瀏覽器實測另記（協調者補）。再快要用 `node:zlib` 的同步 inflate（Node 專用）或把 block 併成更大的 chunk 再 inflate（格式不允許）。
- **C2 匯出 20 個 vti1 zip 主執行緒 heap 瞬時尖峰 +147 MB（目標 ≤ 1 個 split ＋ 32 MB ＝ 47 MB；M15.5 初測，協調者重跑後以 §3 為準）。** Blob／串流 sink 要抄每段、Worker transfer 來的 buffer 等 GC；gc 後只剩 +6 MB，所以是 GC 時機不是常駐。再壓要把 buffer transfer 回 Worker 重用，留作選配。Node 裡的 `ZipWriter` 本身不複製資料段（arrayBuffers 增量 0）。
- **C1 同格式匯出 ×2 改 2 萬格 280～305 ms（目標 < 300，邊緣）。** 重壓數已經是碰到的 block 數（320／15,360）；剩下是 320 塊 inflate ＋ deflate ＋ 原檔 1.3 MB 的 XML／appended 區塊拷貝。×3 378 ms。
- **B3 2D profile 路徑「真的算 Op 的幀」×2 7.0／×3 15.0 ms（p95 13／21）。** 每幀平均已經 < 1 ms（Op 次數／幀數 0.22），但算的那一幀本身和基線一樣（`profileDelta` 外框縮小對角節點沒幫助：角節點改的那一環就是最大的環）。頁面上是 60 幀裡的 13 幀 > 8 ms，不會掉幀到可見，不再追。
- **B3 push 路徑「位元組相同的 Op 重算」仍有 25～50%。** `gestureKey` 的 edge 含取整 (du, dv)（`RelGesture.delta` 記它），而 push 早退的 Op 不含位移，所以同一個 n、不同取整位移會算兩次相同的 Op。每次只有 0.1 ms（`opOfGesture` 本身），不值得再分兩種 key。
- **頁面層級的列**（把手重建、`__rendersBy`、hover BVH、拖欄寬 commit、上傳／匯出 heap、HiDPI sample）在 §3 標「協調者補」。
