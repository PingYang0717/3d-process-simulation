# 計畫 v12：改後不標色、差異只算改到的地方、split 改成一頁

> 位置：`docs/plan-v12-splits-page.md`，分支 `claude/upbeat-einstein-wod16i`，接在 plan v11 之後（commit 053cd8c）。
> 出發點：2026-10-31 使用者試用 v11 後的三點回饋（§1），加上本文件 §2 的查證（在 commit 053cd8c 上用 Playwright 重現、量測）。2026-11-01 使用者接受 §10 全部建議，並做了第二次審查（重點：實驗頁好懂、不卡）。
> 範圍：M12.0 顏色與光照、M12.1 差異模式 chunk 化、M12.2 split 生命週期（live／parked）、M12.3 「實驗」改成一頁（設計、結果卡片、2D 縮圖、比較）、M12.4 文件。**物理 lint、量測器仍不在這一輪。**

---

## 目錄

0. 一句話
1. 問題總表
2. 查證：現況到底怎麼回事
3. 目標與驗收方式
4. 原則、不做的事
5. 設計
   - 5.1 改後＝材質原色：光照與「永不染色」的不變量
   - 5.2 差異模式 chunk 化：只算 diff 外框碰到的 chunk
   - 5.3 split 生命週期：live／parked、patch、還原
   - 5.4 「實驗」頁：設計區＋結果區，Split 列改成下拉
   - 5.5 2D 縮圖
   - 5.6 實驗表單的描述與驗證
6. 每個檔案要改什麼
7. 測試清單
8. 里程碑、工作拆解、驗收
9. 風險與對策
10. 要決定的事（附建議）

---

## 0. 一句話

「改後」永遠只畫材質原色，差別只在按「差異」時才標，而且只算 diff 外框碰到的那幾個 chunk；split 不再是一排頁籤，而是一頁「實驗」：左邊設計變數與組合、右邊每個 split 一張 2D 縮圖卡片，勾了才並排／疊圖、點了才進 3D；沒在看的 split 只留 ops＋diff 外框內的補丁＋統計＋縮圖，把 6N＋6N bytes 的帳簿還掉，split 再多也不會把記憶體吃光。Op 仍是唯一真相，重播逐體素不變。

## 1. 問題總表

| # | 使用者的話 | 查證結果（§2） | 本計畫 |
| --- | --- | --- | --- |
| P1 | 模型修改後應該保持原材質顏色，點「差異」才把差別塗紅 | 「改後」模式程式裡沒有任何染色路徑；截圖裡的紅是 Poly-Si 自己的顏色 `#e8604c` 在剛露出來的頂面被頂光打亮（光照總和最高 1.43×，會飽和成更紅）。另外發現 `r=−5 vx` 這種無效水平會悄悄產生一個什麼都沒改的 split | §5.1 光照改成永不超過 1.0×、改後／差異分離寫成測試；§5.6 水平驗證 |
| P2 | 大模型的時候，顯示差異會卡頓 | `diffMesh` 每次掃整個陣列兩遍、配兩份 `Uint16Array(N)`、對整個模型做兩次 greedy mesh（「沒改」的半透明層＝整個模型的面），主執行緒再做 `EdgesGeometry`；每個 split 第一次都要付，改隱藏／配色也重付。×2（1,570 萬）第一次 1.7 s | §5.2 差異＝主網格原地換半透明材質＋只對 diff 外框碰到的 chunk 做實色層與紅邊；增量、快取 |
| P3a | 實驗設計的地方描述不清楚、操作不直覺 | 右欄 300～560 px 裡一長條表單：id／顯示名兩個輸入框、「標稱 0 vx」、自由文字的水平語法、絕對／相對切換、命名樣板佔位符；沒有圖、沒有驗證 | §5.4、§5.6 設計區改成步驟＋變數卡＋水平 chips＋組合表；每個操作一句話與小圖；無效與無改動的組合先擋 |
| P3b | split 多的時候 tab 不好找 | `SplitBar` 一排頁籤橫向捲動，只有名字 | §5.4 Split 列改成可搜尋的下拉；實驗頁的結果區有篩選、排序、卡片／表格 |
| P3c | split 多的時候畫面很卡 | 每個改過的 split 主執行緒 6N bytes＋Worker 6N bytes（data N、labels 4N、diff N）；4,000 萬 voxels＝每個 split 480 MB，10 個就 4.8 GB。另外切 split 要整個重網格（快取只有 3 組）、「並排看」把所有 split 的切面同時畫 | §5.3 live／parked 生命週期：沒在看的 split 只留補丁；§5.5 縮圖取代整張切面；3D 只有一個實例、點了才進 |
| P3d | 想把 split 做成一頁，預設 2D、點進去才 3D | 方向正確：解決 P3b 與「切 split 就重網格」；但 P3c 的主因是記憶體，單靠「不渲染 3D」不夠，要配 §5.3 | §5.4 |

## 2. 查證：現況到底怎麼回事

方法：`npm run dev` 後用 Playwright（headless Chromium、軟體 WebGL、容器 Node 22）操作畫面：在範例上對 Poly-Si 3 用「實驗」頁籤建一個「圓頭半徑」變數、產生 split，截 3D 的改後／差異／改後，並計時；再 `demo(2)` 重做。數字有雜訊，看相對值。

### 2.1 「改後」模式的紅

- 程式裡會把格子標紅的只有三處：`workerCore.diffMesh`（`REMOVED` 紅、只在 `mode === 'diff'` 呼叫）、`drawSlice` 的 `REMOVED_RGB`（只有差異模式傳 `diff`）、`colorFn` 的 `DIFF_BIT` 混紅（`chunks` 在改後固定 `diff: false`；`preview` 的 `showDiff` 在 `index.tsx` 固定 `false`；主執行緒 `previewMesh` 傳 `null`）。改後模式沒有任何路徑會染色。
- 重現：Poly-Si 3 圓頭 r＝6／8 vx 後，上視圖裡第三根 poly 的兩條長邊出現一道偏紅的帶子，差異模式關掉再開回改後仍在。那是圓角露出來的、朝上的 Poly-Si 面：Poly-Si 的調色盤色是 `#e8604c`（很飽和的紅橙），平常頂面被 SiN 蓋住看不到；側面只有環境光（0.8×）顯得暗褐，朝上的面吃到主光（`AmbientLight 0.8 + DirectionalLight 0.85`，朝 (1, 2, 1.5) 的面 ≈ 1.43×）後 r 分量先飽和到 1，看起來就是一條「更紅」的標記。使用者截圖裡的紅條正好都在圓角新露出來的斜面與端面上。
- 順帶發現：變數「圓頭半徑」的標稱量到 0（方角），預設相對模式，填 `−5` 會產生名叫 `PolySi3_r=-5vx` 的 split，`ops: []`、`diff: 0`、被標成 `baseline`，沒有任何提示。使用者截圖的 split 就叫這個名字。

### 2.2 差異模式的成本

`diffMesh`：`changed = new Uint16Array(N)`、`ghost = new Uint16Array(N)`，掃一遍 N 分類，再對兩份各做一次全陣列 `greedyMesh`（ghost ＝整個模型的所有面），全部傳回主執行緒建兩個 geometry，改動 < 60,000 quads 時再做一次 `EdgesGeometry`（O(n log n)）。快取 key 是 `diff|sid|hidden|palette`、最多 6 組。

| 項目 | ×1（200 萬） | ×2（1,570 萬） | 4,000 萬（推算） |
| --- | --- | --- | --- |
| 按 D 到網格換上（第一次） | 342 ms | 1,731 ms | ≈ 4.5 s＋ |
| 同一 split 再按（快取） | 212～231 ms | 374～406 ms | — |
| Worker 暫存 | 8 MB | 63 MB | 160 MB |
| ghost 幾何 | 整個模型 | 整個模型 | 整個模型（和主網格一樣大，再上傳 GPU 一次） |

每個 split、每次改隱藏或配色都重付；3D 旋轉時多畫一份整個模型的半透明 DoubleSide 面。

### 2.3 split 多的時候

- **記憶體**：第一次改某個 split 時 `own()` 把原始複製進它的帳簿：主執行緒 `data`（N）＋`labels`（4N）＋`diff`（N）＝6N bytes；Worker `fork` 同樣 6N。復原堆疊另外存補丁。

  | 模型 | 每個 split | 10 個 split | 50 個 split |
  | --- | --- | --- | --- |
  | ×1（200 萬） | 24 MB | 240 MB | 1.2 GB |
  | ×2（1,570 萬） | 189 MB | 1.9 GB | 9.4 GB |
  | 4,000 萬 | 480 MB | 4.8 GB | — |

  而一個 DOE split 真正和原始不同的格子通常只有幾千到幾萬個（§2.2 的例子 3,096 格），集中在一個小外框裡。
- **切 split**：主網格 chunk 快取只留 3 組（`PARTS_CACHE`），第 4 個 split 起每次切換都要 Worker 重算整個模型的 chunk 網格再上傳；選取層、空洞層也跟著重算。
- **頁籤**：`SplitBar` 是一排 `split-tab`，`overflow-x: auto`，只顯示名字與步數；20 個以上要橫向捲、名字又長（`Lg=12nm_off=+1nm`）。
- **並排看**：`CompareView` 對每個 split 各放一個 `SliceView`（整張切面、互動層）、每次 render 對每張卡算 `sliceDiff`；疊圖對每個 split 描輪廓（有快取）。50 個 split 時一頁 50 張 canvas。
- **產生**：`addDesign` 一個一個 `replayIn`，每個都留下一本帳簿（主執行緒＋Worker），產生完 `setActiveId(made[0])` 把 3D 切過去。

## 3. 目標與驗收方式

- **顏色**：範例 Poly-Si 3 圓頭 r＝8 後，改後模式 3D 上視圖取圓角帶與側面像素，和調色盤色的色相差 < 8°、飽和度差 < 0.1；任何材質的最亮面 ≤ 調色盤色（不飽和）。改後模式的畫面裡沒有任何像素落在 `REMOVED` 紅 ±12。單元測試：改後模式 `chunks`／`layer` 的請求 `diff === false`、預覽的 `showDiff === false`（e2e 從 `window.__calls` 讀）。
- **差異模式**：×2 第一次按 D 到網格換上 < 300 ms（現 1,731）；Worker 不再配 O(N) 暫存；差異層 quad 數 ＝ 舊 `diffMesh.changed` 的 quad 數（逐面相同，`diffLayer.test.ts`）；旋轉時 draw call 增量 ＝ 改到的 chunk 數（×1 範例圓頭 ≤ 6 個）。
- **記憶體**：×2 產生 20 個 split（每個改 3,000～5,000 格）後，`performance.measureUserAgentSpecificMemory`／`bench.ts splits` 的增量 < 1 個 live 帳簿＋20 × patch（< 250 MB，現 ≈ 3.8 GB）；切到 parked split 到 3D 換上網格 < 1.5 s（×2）。
- **實驗頁**：範例上做 3×3 設計（L<sub>g</sub> × 偏移）：設計區能在不看說明的情況下完成（m12 腳本照「新使用者」路徑：選結構 → 加變數 → 點預設水平 chips → 看組合表 → 產生）；產生時留在實驗頁、進度 k／N；9 張卡片各有縮圖，縮圖上看得到差異描邊；勾 3 張 → 疊圖 3 條線；點「在 3D 看」→ 編輯頁、相機對準差異外框。200 個 split 時結果區捲動不掉幀（虛擬化：DOM 裡 ≤ 40 張卡）、滑鼠在實驗頁移動 60 次整頁 render 0 次、點卡片不觸發任何 Worker 請求。產生 20 個 split（×2）期間主執行緒 heap 增量 < 60 MB。
- **驗證**：圓頭半徑填 `−5` → 紅字「半徑不能小於 0」、產生鈕反灰；水平等於標稱的組合標「對照組（不改動）」。
- 所有既有測試與 m0～m11 e2e 仍過（split 的 Op／重播／manifest 不變）。

## 4. 原則、不做的事

不變：Op 是唯一真相、重播逐體素相同、原始唯讀、沒碰到的體素不變、所有改體素的路徑走 kernel。

新增兩條：

- **改後＝材質原色**。任何「和原始不同」的標記（紅、藍邊、混紅）只出現在差異模式、並排／疊圖、縮圖的差異描邊；主 3D 與主切面在改後模式連一個像素都不標。
- **沒在看的 split 不佔 O(N)**。parked split 的內容由「原始＋補丁」定義，補丁只有 diff 外框；任何要整個陣列的事（3D、編輯、匯出）先還原成 live 再做。

不做：3D 多實例（每張卡一個 WebGL context）、伺服器端、物理 lint、量測器、LER。

## 5. 設計

### 5.1 改後＝材質原色：光照與「永不染色」的不變量

**光照**（`views.tsx` 場景建立）：現在 `Ambient 0.8 + Key 0.85 + Fill 0.3`，朝主光的面 1.43×、背光面 0.8×，比值 1.8，飽和色會偏色。改成總和最高 1.0、最低 0.66：`HemisphereLight(天 0.62, 地 0.50)`＋`DirectionalLight 0.30`（方向不變）、去掉 fill；MeshLambert 不變。立體感靠 0.66～1.0 的落差＋深色描邊（選取外框、剖口邊已有）。所有材質（主網格、預覽網格、選取層 solid、差異層）共用同一組燈，所以預覽與正式網格顏色一致。切面（2D）本來就是調色盤色，3D 的頂面現在會和 2D 同色。

**不變量寫成測試**：`index.tsx` 的 `diffShown` 已經只在 `mode === 'diff'` 給；補一個開發模式的 `window.__calls`（Worker 請求紀錄，e2e 用），m12 腳本在改後模式操作一輪（套用、復原、切 split、換隱藏）後斷言沒有任何 `chunks`／`layer` 請求帶 `diff: true`、沒有 `preview` 帶 `showDiff: true`。

**剛套用一步想知道改到哪**（D1）：保留現有的選取框閃一下，另外在那一步的 `step.data.box` 畫橘色虛線外框 1.5 s 後淡出（設定可關）。這不是染色，不碰網格。

**說明**：HelpDrawer「怎麼看」加一行：「改後不標色；要看改了哪裡按 D（差異）或看『改了哪些』」。

### 5.2 差異模式 chunk 化：只算 diff 外框碰到的 chunk

**diff 外框**：Worker 的 `Book` 加 `diffBox: BBox | null`：`applyTo`／`derive`／`replay` 每一步 `diffBox = union(diffBox, step.data.box)`（復原也 union，寬鬆無妨）；`diffBoxOf(sid)` 回傳時在 union 裡掃一次 `b.diff` 收緊（O(外框)），快取到下一步。主執行緒 `SplitBuffers` 同樣加 `diffBox`（`carryStepStats` 回傳順手帶），`ed.diffBox` 給「對準差異」（§5.4）與縮圖（§5.5）用。

**畫法**（`views.tsx` 的主網格 effect，`mode === 'diff'` 分支整個換掉）：

1. **「沒改」的半透明層＝主網格本身**：不再向 Worker 要 ghost。進差異模式時把現有 `parts` 的材質換成 `ghostMaterial`（灰、opacity 0.38、depthWrite false、無 vertexColors），退出時換回；geometry 一個位元組都不動、不重傳、不重上傳。改過的 chunk 也還是半透明畫（實色層蓋在上面，深度正常，看起來就是實色）。
2. **改到的實色層＝一個 chunk 圖層**：沿用 `layer` handler，新增 `filter: { diff: true }`：只對 `chunksTouching(vol, g, diffBoxOf(sid))` 做 `greedyMeshChunk`，code ＝ `diff[i] ? (data[i] && !hidden[data[i]] ? data[i] : (!data[i] && orig[i] && !hidden[orig[i]] ? REMOVED : 0)) : 0`，顏色＝調色盤／`REMOVED` 紅。增量規則和選取層一樣（`parents.box`）；key ＝ `diff|hidden|palette`；主執行緒用 `setLayer`，材質 Lambert 實色、`polygonOffset`。
3. **深藍邊**：每個改到的 chunk 各自 `EdgesGeometry`，總 quads > `EDGE_QUADS_MAX` 就不描（和空洞層同一個模式）。
4. 剖面貼圖、2D 切面不變（本來就 O(一片)）。

**成本**：Worker O(diff 外框碰到的 chunk)、沒有 O(N) 暫存；主執行緒只建幾個小 geometry；每一步之後只重算碰到的 chunk。差異層快取跟著 `partsCache` 的 LRU 一起走（key 加 `|diff`）。`diffMesh` handler 與 `meshCache` 的 `diff|…` 條目刪掉（測試 `worker.test.ts` 裡用到的改成 `layer` diff）。

**並排／疊圖的 A vs B** 不變（主執行緒切面級）。

### 5.3 split 生命週期：live／parked、patch、還原

**狀態**：

```ts
interface Split {
  …現有欄位…
  /** live：有帳簿（buf、Worker 一本）；parked：只有 patch。 */
  state: 'live' | 'parked';
  buf: SplitBuffers | null;          // live 才有
  patch: SplitPatch | null;          // parked 才有（live 時 null，park 的時候才做）
  stats: SplitStats;                 // 兩種狀態都有：changedVoxels、blocked、diffBox、counts 差量、每個改到結構的 bbox
  thumbs?: Map<string, ImageBitmap>; // §5.5，LRU
}
interface SplitPatch {
  box: BBox;                 // diff 外框
  data: Uint8Array;          // box 內的 data
  labels: Int32Array;        // box 內的 labels（結構 key 在 box 外不變：relabel 只重算改到的範圍）
  comps: Comp[];             // 這個 split 的結構清單（bbox、count、key）
  countsDelta: Float64Array; // 和原始的體積帳差
  keyCounter: number;
}
```

**park(split)**（純函式 `splits/lifecycle.ts` 的 `extractPatch(buf, diffBox, comps)`）：裁 `diffBox` 內的 data／labels，記 comps 與 counts 差，丟 `buf`、丟 `hist`／`future`（復原記錄釋放，ops 保留，D3），Worker `drop([id])`。O(外框)。

**產生時直接在 Worker 做補丁，主執行緒不碰 O(N)**：現在 `replayIn` 把整本帳簿（6N bytes）傳回主執行緒；4,000 萬 voxels 一個 split 就是 240 MB 的傳輸與配置，產生 50 個就是 12 GB 的搬運。`replay` handler 加 `keep: 'live' | 'patch'`：`'patch'` 時 Worker 在一本**重複使用的 scratch 帳簿**上重播（每次先從 base memcpy 回來，不另外 fork）、算 stats、裁補丁、只傳回補丁與 stats，主執行緒拿到的就是 parked split。「套用到所有 split」（`commitTo` 對 parked split）同樣走 scratch：restore 進 scratch → 套用 → 裁補丁 → 不留帳簿。只有「第一個設為目前的 split」真的 restore 成 live。

**restore(split)**（Worker 新 handler `restore: { owner, box, data, labels, comps, keyCounter }`）：`fork` 原始那本（O(N) memcpy，4,000 萬 ≈ 240 MB，數十到一百多 ms）→ 貼 data／labels 補丁 → 在 box 內對照原始算 `diff` 與 `diffCount` → counts ＝ 原始＋差量 → 新版本號、`parents` 設 `box`。主執行緒同樣 `own()` 式複製再貼補丁。比重播快、而且不依賴重播結果（但 `lifecycle.test.ts` 驗證 restore ≡ replay 逐位元組）。

**政策**：`live` 集合 ＝ `{active}` ∪ 最近用過的 K−1 個（LRU）∪ 正在產生／匯出的暫時 live。K 依大小：N ≤ 500 萬 → 8、≤ 2,000 萬 → 3、否則 1；設定裡可改。超出的 park。`addDesign` 每產生一個就是 parked（Worker 直接回補丁，見上），縮圖在補丁回來的同一個 tick 畫；產生完第一個 split 設為目前（restore 成 live），不切頁、不切 3D（D8）。原始永遠 live（本來就是 `base`）。

**`setActiveId(parked)` 是非同步的**：先 busy 列「正在載入 {name}…」，Worker restore 回來才真的切 `cur`；切之前 `ed.cur` 仍是上一個，所以 3D 不會閃空畫面。實驗頁裡點卡片**不會**觸發這個（§5.4：點卡片只是高亮），只有「在 3D 看」、從 `SplitPicker` 選、或要編輯時才 restore。`duplicateSplit` 對 parked split ＝ 複製補丁（O(外框)），不 restore。

**parked split 的切面**（並排、疊圖、縮圖、矩陣的 W／H／D）：不還原。`slabOf(split, axis, at)`：複製原始那一片（W×H）、把 patch 和這片相交的列蓋上去，labels 同理；包成 `{X, Y, Z}` 裡法線軸長度 1 的假 Volume（`at = 0`），餵給現有的 `drawSlice`／`sliceDiff`／`contourOf`（它們只靠 dims 與 index 算，不看 `Z` 真的多長）。快取 `(version, axis, at)`。W／H／D 從 `patch.comps` 的 bbox 來，不用切面。

**parked split 的匯出**：Worker 新 handler `export: { owner|patch, format }`：base 複製＋貼補丁＋`encodeVti`／`encodeVtiLike` 在 Worker 裡做、傳回 bytes，一個一個來、進度條（plan v11 §8 本來就欠的「匯出搬進 Worker」一起做）。live split 走同一個 handler（直接用它的帳簿）。

**編輯 parked split**：任何 commit 之前先 restore（busy 列「正在載入 split…」），完成後照舊。

**3D 看 parked split**：restore → `chunks` 全量。配合 §5.4 的「點了才進 3D」與縮圖，這個成本只在使用者真的要看那個 split 的時候付一次。

### 5.4 「實驗」頁：設計區＋結果區，Split 列改成下拉

**頁面切換**：`topbar` 中央加 Segmented「編輯｜實驗」（鍵盤 `Ctrl+1`／`Ctrl+2`）。兩頁共用同一個 `useEditor`；3D（`View3D`）只在編輯頁掛載一個實例，實驗頁沒有 WebGL。右欄在實驗頁隱藏（「選取與調整」「改了哪些」是編輯頁的事）；「實驗」「矩陣」兩個右欄頁籤移進實驗頁。

**編輯頁的 Split 列** → `SplitPicker`：`原始 ▾`／`Lg=12nm_off=+1nm ▾` 一顆按鈕，點開是可搜尋的清單（名字、水平 chips、步數、live／parked 小點），`[ ]` 仍然循環；旁邊「新增 ▾」（空白／複製／去實驗頁）與「並排看」拿掉（搬到實驗頁）。`EditToolbar`、busy 列不變。

**實驗頁版面**：左 400 px「設計」（可收合成 48 px）＋右「結果」。

設計區（取代 `ExperimentTab`，拆成 `DesignPanel.tsx`、`FactorCard.tsx`、`LevelsEditor.tsx`、`ComboTable.tsx`）：

0. **空狀態與步驟列**：頁面頂端一條「① 選結構 → ② 加變數 → ③ 看組合 → ④ 產生」的步驟列，做到哪一步亮到哪一步；還沒有變數時設計區只顯示第 ① 步與一句話說明，結果區顯示「還沒有 split：在左邊定義變數，或從編輯頁直接改一刀」。範本（存／載入／匯出／匯入 JSON，v11 §4.3）保留在設計區右上角「範本 ▾」，載入範本＝直接跳到第 ③ 步。
1. **結構**：目前選取（沒有就在這裡選：下拉依材質分組、列結構名與大小，不必回 3D 點；選了會和編輯頁的選取同步）。旁邊一張 120 px 的縮圖：這個結構最長軸的切面、結構用選取藍、其他半透明。
2. **變數卡**（每個變數一張）：第一行一句話（opWords 風格）「**Poly-Si 2** 沿 z 的寬度（CD）· 現在 24 格＝12 nm」；第二行名稱（一個欄位，id 自動由名稱產生、灰字顯示，點才改）；第三行 **水平**：chips 編輯器——每個 chip 顯示 `18 nm（−2）`，可刪；下方預設按鈕用使用者的單位寫（有 nm 比例時「±0.5 nm」「±1 nm」「±10%」「3 個等距…」，括號裡附格數），與「自訂…」（才出現現在的語法輸入框，placeholder 放範例）；絕對／相對只是顯示切換（存的都是格數）。標稱量不到的操作（移動、斜度、缺陷）卡片直接寫「從 0 起」，不顯示絕對模式。軸／面／錨點等固定欄位收在卡片底下的「設定 ▾」，含 `FacePicker` 小方塊（滑過時結構縮圖上那條邊亮起）。
3. **組合**：Segmented 不變，下面改成 **組合表**（`ComboTable`）：一列一個會產生的 split、一欄一個變數、最後兩欄「改動 ≈」「被擋」；等於標稱的列標「對照組」；無效的列（負半徑、超出陣列、改動 0）標紅並寫原因。手動勾選＝這張表的核取方塊。**試算不在主執行緒**：現在的 `runTrial` 對最多 60 個組合同步跑 `previewOp`，大模型會把畫面凍住；改成送 Worker 既有的 `preview` handler（`mesh: false`），一次一個、排隊、逐列填、改了變數就取消還沒算的；表格先顯示「計算中」。
4. **從哪裡開始**、**命名**：同現在，但命名欄位旁即時顯示第一列的名字。
5. **產生**：按鈕寫「產生 9 個 split」；進度 `k／N`、可取消（取消＝已產生的留著）；完成後停在實驗頁、結果區捲到新卡片並高亮（D8），訊息帶「撤銷這次產生」（刪掉這一批，10 秒內）。

結果區（`ResultGrid.tsx`、`SplitCard.tsx`，取代 `SplitBar` 的頁籤、`CompareView` 的入口、`MatrixTab`）：

- 工具列：篩選（設計、tag、每個變數的水平）、排序（名字、產生順序、改動、每個變數）、檢視「卡片｜表格」（表格＝現在的 `MatrixTab`，欄位不變）、縮圖軸「自動｜XY｜XZ｜YZ」、「比較勾選的（並排／疊圖）」、「匯出勾選的」、「刪除勾選的」、「全選本設計」。
- **依設計分組**：預設一個設計一組，組標題寫設計的變數與時間（「L<sub>g</sub> × 偏移 · 3×3 · 14:02」）、可收合；手動改出來的 split 歸「手動」一組。排序與篩選在組內作用。
- 卡片：縮圖（§5.5）、名字、水平 chips（同設計的變數同色點）、`Δ 3,096 vx`、被擋時橘字、`baseline`／tags、live／parked 小點、核取方塊。**點卡片＝高亮（純 UI，不 restore、不切 3D）**，Shift／Ctrl 多選同勾選；「在 3D 看」（或雙擊、Enter）＝設為目前並切到編輯頁，`View3D` 對準 `diffBox`（新按鈕「對準差異」，鍵 `G`）。目前在編輯頁看的那個另外標「目前」。右鍵／⋯：重新命名、複製、刪除、接著改（＝在 3D 看）。
- **不卡的三個規定**：（a）虛擬化：列高固定，自己做簡單的視窗化（只渲染可見列 ± 2 列），DOM 裡 ≤ 40 張卡；縮圖用 `IntersectionObserver` 進視窗才畫。（b）`SplitCard` 用 `React.memo`，props 只有 `split.version`、名字、levels、stats、高亮／勾選旗標、縮圖；結果區只訂閱 `ed.splits`、`ed.designs`、`ed.activeId` 與頁面自己的 UI 狀態，**不**訂閱 `cursor`、hover、預覽這些每幀會變的值（它們本來就走 live value），所以在實驗頁移動滑鼠、3D 在背景算網格都不會重 render 200 張卡。（c）切面層的計算（`slabOf`、`sliceDiff`、縮圖）都以 `(split version, base version, axis, at)` 快取，捲回來的卡不重算。驗收：200 個 split 時實驗頁 `__renders` 在滑鼠移動 60 次後增量 0、捲動一頁 long task 0。
- **窄螢幕**：寬度 < 1100 px 時設計區變左側抽屜（和編輯頁的左欄一樣），結果區單欄。
- 並排／疊圖：`CompareView`／`OverlayView` 搬進來，對象＝勾選的 split（沒勾＝最近一次設計的全部，上限 12，超過提示先勾）；切面來源改成 `slabOf`（§5.3），不再要求 live。基準選擇、軸、自動放大不變。

**為什麼不在卡片上放 3D**：每張卡一個 WebGL context 不可行（瀏覽器 8～16 個上限、每個都要一份網格）；一個共用 context 分格畫可以，但要為每個 split 建網格，正好是 §2.3 要避免的事。縮圖＋一個 3D 實例是對的取捨（P3d）。

### 5.5 2D 縮圖

- **選片**：預設「自動」＝**同一個設計的所有 split 共用一個軸**（整個設計的 `diffBox` 聯集在三個投影裡面積最大的那個），這樣同一組卡片才能互相比；片＝各自 `diffBox` 在那個軸的中點；沒改動（對照組）就用結構最長軸、結構中點。縮圖角落標軸與片（`XY · z=64`）。頁面統一切軸時三軸各算（快取）。
- **畫法**：`slabOf` → `sliceRGBA`（傳 `diff` 片段，所以有深藍邊與紅）→ **再疊上原始在同一片的輪廓（細黑線，`contourOf` 已有快取）**，一眼看得出是長了還是縮了 → 裁到 `diffBox ∪ 改到結構的 bbox`＋8 格、長邊 ≤ 240 px、nearest 縮放 → `createImageBitmap`。純函式 `thumbs.ts` 的 `thumbOf(slab, box, diffSlab, baseLoops, palette)`，測試可比對像素。卡片縮圖下方一行圖例只出現一次（結果區頂端）：「黑線＝原始輪廓、藍邊＝改過、紅＝拿掉」。
- **快取**：split 上 `thumbs: Map<'${version}|${axis}', ImageBitmap>`，全域 LRU 300 張（每張 ≤ 240×240×4 ≈ 230 KB，上限 70 MB）。split 改了（version 變）就作廢。
- **成本**：`drawSlice` 一張 ×3 2.5 ms（plan v9），縮圖再縮一次 < 1 ms；200 張全畫 < 1 s，而且只畫進視窗的。

### 5.6 實驗表單的描述與驗證

- **一句話**：每個操作在卡片第一行用 `opWords.ts` 的詞（和 OpCard 同一套），後面接「現在 … ＝ … nm」（標稱＋單位）；OP_LABEL 加一句說明當 tooltip（例：「保形層厚度：沿表面法線整圈加厚／減薄，外面的薄層會被推開」）。
- **驗證**（`factors.ts` 新增 `validateLevels(f, levels, ctx): Problem[]`，純函式）：負半徑／負厚度、超出陣列、推面會把結構推到 0 格、`level` 的目標在結構外、缺陷大小 0；問題顯示在 chip 上（紅）與組合表（整列紅、原因）；有任何紅就不能產生。改動 ＝ 0 的組合（含對照組）標灰「不改動」，產生時仍佔一格但卡片標「對照組」。
- **round 的預設**：標稱 0 時預設絕對模式、預設 chips `2, 4, 6 格`。
- **「從哪裡開始」第三項**的長說明改成只在選到時出現的一行。
- 產生後不切 3D、不跳頁籤（D8）；訊息「已產生 9 個 split」帶「在 3D 看第一個」連結。

## 6. 每個檔案要改什麼

| 檔案 | 改什麼 |
| --- | --- |
| `src/pages/Section3D/views.tsx` | 燈光（§5.1）；差異模式：材質換 ghost、`layer` diff 圖層、每 chunk 描邊；刪 `diffMesh` 分支與 `meshCache` 的 diff 條目；`lookAtBox(diffBox)`（對準差異，鍵 G）；步驟外框閃爍；`handle` 加 `focusBox` |
| `src/volume/workerCore.ts`、`client.ts` | `Book.diffBox`、`diffBoxOf`；`layer` 的 `filter: { diff: true }`（含 `REMOVED`）；`replay` 加 `keep: 'patch'`＋scratch 帳簿；新 handler `restore`、`export`、`applyParked`（commitTo 對 parked split）；刪 `diffMesh`；`window.__calls`（DEV） |
| `src/volume/patch.ts` | `carryStepStats` 回傳 `{ diffCount, box }` 或另加 `unionBox` 工具 |
| `src/pages/Section3D/editor.ts` | `Split.state`／`patch`／`stats`／`thumbs`；`park`／`restore`／live 集合 LRU 與 K；`addDesign` 逐個 park、不切 active、進度與取消；`diffBox`；`commit` 前 `ensureLive`；匯出改走 Worker；`page: 'edit' | 'lab'` 狀態 |
| `src/splits/lifecycle.ts`（新） | `extractPatch`、`applyPatch`、`slabOf`、`liveSetFor(K, lru)`；純函式 |
| `src/pages/Section3D/thumbs.ts`（新） | `thumbOf`、選片規則、LRU |
| `src/pages/Section3D/ExperimentPage.tsx`（新） | 兩欄版面、工具列、頁面狀態（勾選、篩選、排序、檢視、縮圖軸） |
| `DesignPanel.tsx`、`FactorCard.tsx`、`LevelsEditor.tsx`、`ComboTable.tsx`、`StructurePicker.tsx`（新；由 `ExperimentTab.tsx` 拆） | §5.4 設計區（步驟列、空狀態、範本、結構下拉）、試算走 Worker、§5.6 驗證與預設 chips；`ExperimentTab.tsx` 刪 |
| `ResultGrid.tsx`、`SplitCard.tsx`、`DesignGroup.tsx`（新） | §5.4 結果區、依設計分組、虛擬化、IntersectionObserver、`React.memo` 卡片、撤銷這次產生 |
| `SplitPicker.tsx`（新，取代 `SplitBar.tsx`） | 可搜尋下拉、`[ ]`、新增 ▾ |
| `CompareView.tsx`、`OverlayView.tsx`、`overlay.ts` | 對象＝勾選的 split；切面改 `slabOf`；搬進實驗頁 |
| `MatrixTab.tsx` | 變成結果區的「表格」檢視（欄位不變、加 live／parked、縮圖欄可選） |
| `index.tsx` | 頁面切換、右欄只在編輯頁、`SplitPicker`、匯出走 Worker＋進度、`__calls` |
| `src/volume/factors.ts` | `validateLevels`、`presetLevels(f)`、round 標稱 0 的預設模式 |
| `src/pages/Section3D/opWords.ts` | 變數卡第一行的句子；OP 說明 |
| `HelpDrawer.tsx`、`README.md` | 「改後不標色」、實驗頁、live／parked、對準差異、快捷鍵 |
| `src/styles.css` | `.lab`、`.lab-design`、`.lab-grid`、`.split-card`、`.split-picker`；刪 `.splitbar`／`.split-tab` |
| `scripts/bench.ts` | `splits`（×2 產生 20 個 split 的記憶體與時間）、`diff`（按 D 的時間） |
| `scripts/e2e/m12.cjs`（新） | §8 的驗收 |

## 7. 測試清單

- `diffLayer.test.ts`：`layer` diff 的 quads（去掉 chunk 邊界重複）≡ 舊 `diffMesh.changed`（保留舊函式在 `ref/` 當對照）；只碰 `diffBox` 相交的 chunk；一步之後增量 ≡ 全量。
- `diffBox.test.ts`：apply／undo／redo／replay 後 `diffBoxOf` ⊇ 所有 diff 格、且貼合（收緊後每一面都有 diff 格）。
- `lifecycle.test.ts`：`extractPatch` → `applyPatch` 到原始複本 ≡ live 帳簿逐位元組（data、labels）；Worker `restore` ≡ `replay`（data、labels、diff、counts、comps 的 key／bbox）；`slabOf` 三軸任一片 ≡ 從完整陣列切的那一片；park 後 `ops` 與 `levels` 不變；K 政策（LRU 行為）。
- `thumbs.test.ts`：同一 split 兩次 `thumbOf` 像素相同；差異描邊像素數 > 0；原始輪廓線存在；同一設計的 split 選同一個軸；對照組選結構中點。
- `lifecycle.test.ts` 加：`replay keep:'patch'` 的補丁 ≡ live 重播後 `extractPatch`；scratch 帳簿連續重播 3 個 split 互不汙染（每個 ≡ 各自從 base 重播）；`applyParked` ≡ restore → apply → extractPatch。
- `factors.test.ts` 加：`validateLevels`（負半徑、超出、推到 0）、`presetLevels`、round 標稱 0 的預設。
- `views` 的光照：沒有單元測試，e2e 取像素（§3）。
- 既有：`worker.test.ts` 改用 `layer` diff；其餘不動。
- e2e `m12.cjs`：§0 改後無染色（`__calls`＋像素）；§1 差異模式時間與 draw call 數（×1、×2）；§2 實驗頁新使用者路徑（3×3：從空狀態開始、只靠步驟列與預設 chips）、試算不凍結（期間 `__renders` 仍在動、long task < 50 ms）、進度、停留、縮圖（軸相同、有黑線）、點卡片不 restore（Worker 沒有 `restore` 請求）、勾 3 張疊圖、在 3D 看→對準差異；§3 `−5` 被擋；§4 ×2 產生 20 個 split：主執行緒 heap 增量 < 60 MB、Worker 沒有 20 本帳簿、切 parked split 到網格換上的時間；200 個 split 的捲動（DOM 卡片數 ≤ 40、滑鼠移動 60 次 `__renders` 增量 0）；§5 parked split 匯出 zip 與 live 匯出逐位元組相同；§6 m11 的 §1～§2 在新頁面重做一遍；§7 窄螢幕（1000 px）設計區變抽屜。

## 8. 里程碑、工作拆解、驗收

### M12.0 顏色（S）

燈光；`__calls`；步驟外框閃爍；HelpDrawer 一行。驗收：§3 顏色兩條；m0～m11 全過（像素斷言的 e2e 若有要跟著調）。

### M12.1 差異模式 chunk 化（M）

`diffBox`；`layer` diff；材質換 ghost；每 chunk 描邊；刪 `diffMesh`。驗收：×2 第一次 < 300 ms、quads 相同、增量正確。

### M12.2 split 生命週期（L）

`SplitPatch`／`stats`；`extractPatch`／`applyPatch`／`slabOf`；Worker `replay keep:'patch'`＋scratch、`restore`／`export`／`applyParked`；K 政策；非同步 `setActiveId`；`addDesign` 直接拿補丁；CompareView／Overlay／Matrix 改吃 `slabOf`；匯出走 Worker＋進度。驗收：§3 記憶體兩條、lifecycle 測試、匯出逐位元組相同。這一步做完就算 UI 還是舊的頁籤，「split 多就卡」已經解掉。

### M12.3 實驗頁（L）

頁面切換；`SplitPicker`；`DesignPanel`＋變數卡＋chips＋組合表＋驗證；`ResultGrid`＋`SplitCard`＋縮圖＋虛擬化；比較搬進來；刪 `SplitBar`、`ExperimentTab`。驗收：§3 實驗頁與驗證各條；m12 §2～§3。

### M12.4 文件

README（檔案表、效能表加 v12 欄）、HelpDrawer、本文件 §11 實作紀錄。

順序：M12.0 → M12.1 → M12.2 → M12.3，各自可獨立合併；M12.2 與 M12.3 可以兩個人並行（M12.3 先用 live split 做 UI，最後接 `slabOf`）。

## 9. 風險與對策

| 風險 | 對策 |
| --- | --- |
| 調燈光後整體變暗、立體感差 | 0.66～1.0 的落差＋現有深色外框；e2e 像素斷言只管「不超過調色盤色」，明暗由截圖人工看一輪再定係數 |
| `diffBox` 寬鬆（復原後外框沒縮） | 回傳前在 union 裡掃一次收緊；外框只影響算多少 chunk，不影響正確性 |
| 主網格 parts 換材質時 `withHole` shader 的 uniform 要共用 | ghost 材質也包 `withHole`（同一個 hole 物件） |
| parked split 丟掉復原記錄，使用者回來想 Ctrl+Z | 卡片與 picker 標 parked；restore 時訊息「復原記錄已釋放，ops 仍可重播」；K 預設在小模型夠大（8）所以常用的都還是 live |
| `relabel` 在 box 外真的不改 key？ | `lifecycle.test.ts` 用 v10／v11 的黃金 Op 集驗 `patch.comps` ≡ live comps；若有例外（例如結構被切成兩段、其中一段在 box 外），`extractPatch` 把 `labelBox` 也納入 box（Worker 已經分開記 `labelBox`） |
| `slabOf` 的假 Volume 騙不過某些函式（例如用 `Z` 算 stride 的） | 只餵 `drawSlice`／`sliceDiff`／`contourOf`／`sliceHasAny`，先在測試裡逐一驗三軸 |
| 一次產生 200 個 split，縮圖＋patch 的時間 | 補丁與 stats 在 Worker 算、主執行緒只收 O(外框)；縮圖在補丁回來的同一個 tick 畫、只畫自動軸那一張，其他軸進視窗再畫 |
| 實驗頁 200 張卡跟著編輯器任何 state 一起重 render | 卡片 `React.memo`、結果區不訂閱每幀變的值（§5.4 不卡的三個規定）；e2e 量 `__renders` |
| 點卡片就 restore，大模型每點一下等一秒 | 點卡片只高亮；restore 只在「在 3D 看」、`SplitPicker` 選取、編輯時發生，且有 busy 列 |
| 試算在主執行緒凍住畫面 | 試算送 Worker、一次一個、可取消 |
| 實驗頁改動大，使用者習慣被打斷 | M12.3 之前先出 M12.2；頁面切換的快捷鍵與 `[ ]` 保留；HelpDrawer 寫對照（舊「Split 列」→ 新「Split ▾」與實驗頁） |
| 匯出搬進 Worker 後 4,000 萬點比例陣列的記憶體 | Worker 一次只處理一個 split、一個比例陣列（plan v11 §9 D18 的原則不變）；主執行緒只收 bytes |

## 10. 決策記錄（2026-11-01 與使用者確認：全部照建議）

| # | 問題 | 決定 |
| --- | --- | --- |
| D1 | 改後模式套用一步後要不要有任何提示？ | 要：橘色虛線外框閃 1.5 s（不碰網格），設定可關 |
| D2 | 光照改法 | 總和 ≤ 1.0（Hemisphere 0.62／0.50＋Directional 0.30）；不做完全無陰影 |
| D3 | parked split 丟掉復原記錄 | 是；ops 留著，重播或 restore 都能回來 |
| D4 | live 上限 K | 依大小 8／3／1，設定可改；原始與目前的永遠 live |
| D5 | 實驗頁是獨立一頁還是編輯頁的抽屜 | 獨立一頁，`Ctrl+1`／`Ctrl+2` 切；3D 只有一個實例 |
| D6 | Split 列 | 改成可搜尋下拉；頁籤列刪掉 |
| D7 | 並排／疊圖的位置 | 搬進實驗頁，對象＝勾選的 split |
| D8 | 產生後 | 留在實驗頁、不切 3D；第一個 split 設為目前（live） |
| D9 | 縮圖的軸 | 自動（同一設計共用、差異投影最大）＋頁面統一切換 |
| D10 | 卡片上要不要 3D | 不要；「在 3D 看」回編輯頁並對準差異 |
| D11 | 點卡片的意思 | 只高亮（不 restore、不切 3D）；雙擊／Enter／「在 3D 看」才切 |
| D12 | 產生時主執行緒要不要拿整本帳簿 | 不要：Worker 直接回補丁（`replay keep:'patch'`） |

第二次審查（2026-11-01，重點：實驗頁好懂、不卡）補進來的：§5.3 Worker 直接回補丁與 scratch 帳簿、非同步 `setActiveId`；§5.4 步驟列與空狀態、範本保留、結構下拉、水平預設用 nm、試算走 Worker、撤銷這次產生、依設計分組、點卡片只高亮、不卡的三個規定、窄螢幕；§5.5 同一設計共用軸、縮圖疊原始輪廓與圖例；§7、§9 對應的測試與風險。

---

## 11. 實作紀錄

2026-11-01，分支 `claude/upbeat-einstein-wod16i`，M12.0～M12.4 各一個 commit。量測環境同 §2（雲端容器、Node 22、headless Chromium 軟體 WebGL），數字有雜訊。

### 11.1 做了什麼（照里程碑）

- **M12.0 顏色**：`views.tsx` 換成 `HemisphereLight(天 0.62, 地 0.50)`＋`DirectionalLight 0.30`、去掉 fill。只換係數不夠：頂點色是調色盤的 sRGB 值，three r160 把它當線性值再做 sRGB 編碼輸出，最亮的面本來就會比調色盤亮、偏色。所以另外 `ColorManagement.enabled = false`、`renderer.outputColorSpace = LinearSRGBColorSpace`：畫面＝調色盤 × k，均勻縮放不改色相與（HSV）飽和度；Lambert BRDF 除以 π，強度乘 π。副作用是好的：剖口貼圖（CanvasTexture）也不再被 sRGB 編碼加亮，和 2D 切面同色。`client.ts` 的 `call` 在開發模式記 `window.__calls`（只留 type、diff、showDiff、filter、owner，不留陣列）。D1 的橘色虛線外框：`View3DHandle.stepBox`（`editor.last.box`＝那一步補丁外框，1 秒全亮＋0.5 秒淡出），設定「顯示 → 套用後閃一下改到的範圍」。
- **M12.1 差異模式**：`Book.diffBox`／`tight`／`touch`；`diffBoxOf` 在 union 裡掃一次 diff 收緊；新請求 `diffBox`；`layer` 加 `{ diff: true }`（材質色、被拿掉的 `REMOVED` 紅、`hidden`）。`views.tsx`：差異模式不再有獨立的 ghost 網格，主網格的材質原地換成灰 0.38（`vertexColors` 關），差異層＝`diffFill`／`diffEdges` 兩個 chunk 圖層（每 chunk 一份 `EdgesGeometry`，總 quads 超過 `EDGE_QUADS_MAX` 不描）。刪掉 `diffMesh` handler 與 `meshCache`；舊函式留在 `ref/diffMeshOld.ts` 當對照。
- **M12.2 生命週期**：`src/splits/lifecycle.ts`（純函式）。Worker：`replayPatch`（scratch 帳簿：只把上一次 `touch` 的範圍從原始貼回、再貼 src 的 `touch`，O(外框)）、`restore`（`parents` 記成「從原始、改了 box」）、`applyParked`、`exportMeta`＋`export`（非同步，`worker.ts` 改成接 Promise）。主執行緒 `editor.ts`：`Split.state`／`patch`／`stats`／`seq`、`SplitBuffers.touch`、`parkOne`、`ensureLive`、`enforceK`（`toPark`：目前的與 pinned 不 park，其他照 LRU 留到 K）、非同步 `setActiveId`、`addDesign` 直接拿補丁、`commitTo` 對 parked 走 `applyParked`、`exportBytes`。`slabs.ts`：任何 split 的一片（快取 96 MB）；並排、疊圖、縮圖都吃它。網格：`chunks` 多帶 `alts`（主執行緒快取裡同畫法的版本），restore 回來的 split 從原始那一組增量（原始那一組釘在快取裡）。
- **M12.3 實驗頁**：`ExperimentPage`、`DesignPanel`、`FactorCard`、`LevelsEditor`、`ComboTable`、`StructurePicker`、`ResultGrid`、`SplitCard`、`thumbs.ts`、`SplitPicker`；刪 `SplitBar.tsx`、`ExperimentTab.tsx`（類別色盤搬到 `colors.ts`）。`factors.ts` 加 `validateLevels`、`comboProblems`、`presetLevels`、`evenLevels`、`switchMode`、`lockedNominal`；`opWords.ts` 加 `factorWords`、`OP_LABEL`、`OP_HELP`。`MatrixTab` 變成表格檢視（`ids`、`onRow`、live／parked 欄）。頁面狀態 `ed.page`（存 localStorage）、Ctrl+1／Ctrl+2；實驗頁裡編輯用的鍵（方向鍵、復原、`[ ]`、B／D／E）不動模型。視角列「對準差異」與 G 鍵。
- **M12.4**：README（實驗頁、改後原色、差異 chunk 化、生命週期、檔案表、v12 效能表）、HelpDrawer（第 5 段改寫成「Split 與實驗頁」、匯出另成一段、快捷鍵）、`bench.ts diff|splits`、`scripts/e2e/m12.cjs`；`m9.cjs`、`m11.cjs` 改走新的 Split ▾ 與實驗頁（流程與斷言不變；m11 §2 的 A vs B 改比這一片，見下）。

### 11.2 和計畫不一樣的地方

| # | 計畫 | 實作 | 為什麼 |
| --- | --- | --- | --- |
| 1 | 只改燈光係數 | 另外關色彩管理、線性輸出 | 見 11.1 M12.0：不關的話「最亮的面 ≤ 調色盤色」做不到 |
| 2 | 光照最低 0.66 | 朝下的面 0.50（地光），側面 0.56＋主光 | 照 D2 的係數算出來的；看起來立體感足夠，沒再調 |
| 3 | `replay` 加 `keep: 'patch'` | 另一個請求 `replayPatch` | 回傳形狀完全不同，分開型別比較乾淨；`replay`（live）留著給 `addSplit` |
| 4 | 差異層跟 `partsCache` 一起快取 | 不快取，再按 D 重算差異層 | 只算 diff 外框碰到的 chunk，×2 再按一次 220～250 ms，快取的效益不大 |
| 5 | 補丁＝diff 外框 | 補丁＝「data 或 labels 和原始不同」的外框（在 `touch` 裡收緊） | §9 的 relabel 風險直接解掉：`touch` union 了每一步的 data 外框、relabel 的 S、換編號的結構外框，所以補丁外面 data 與 labels 都和原始逐位元組相同（`lifecycle.test.ts` 驗） |
| 6 | parked split 沒有 `buf` | 另外留一個 `cur` 殼（comps 與版本號是自己的，陣列是原始的） | 很多地方要 comps（矩陣的 W／H／D、名字、levels）；讀陣列的地方全改走 `slabOf`／`statsOf`／`exportBytes` |
| 7 | 縮圖軸＝差異投影面積最大；片＝diff 外框中點 | 軸＝diff 外框最長那一軸當法線；片＝改最多的那一片 | 實測（m12、截圖）：沿 z 改 CD／偏移的 poly，投影最大的是 XY，切到的是整片截面、看不出寬度；中點又常落在沒改到的內部。改成沿最長軸切，改動方向落在切面上；同一設計仍共用一個軸 |
| 8 | 對照組 parked | 對照組借用原始（live、沒有帳簿） | 不佔記憶體也不必 restore |
| 9 | — | 修 `overlay.ts` 的 `sliceGeom` YZ 方向（u／v 對調） | 縮圖的原始輪廓畫歪才發現；v11 的 YZ 疊圖、`sliceDiff` 也受影響。`overlay.test.ts` 加三軸對 `sliceRGBA` 的對照 |
| 10 | m11 §2「split 3 的差異＝兩者 diff」 | 改比「這一片」的差異 | 並排是切面級（parked 不還原），卡片上顯示「這片 n 格不同」 |

### 11.3 驗收（§3）

| 項目 | 目標 | 結果 |
| --- | --- | --- |
| 改後模式帶 diff 標記的請求（套用、復原、重做、切 split、換隱藏） | 0 | 0（m12 §0） |
| 改後 3D 畫面「拿掉的紅」±12 的像素 | 0 | 0 |
| Poly-Si 面（內部像素）比調色盤亮的 | 0 | 0；色相差 0.2°（目標 < 8°）；只看 4 鄰居同色的像素，反鋸齒的邊會和背景混色 |
| ×2 第一次按 D 到差異層換上 | < 300 ms | 224（bench）／243 ms（e2e）；舊 1,707 |
| 差異層 quad 數 ≡ 舊 `diffMesh.changed` | 逐面相同 | 單位面集合相同（`diffLayer.test.ts`；chunk 邊界會多切幾刀，quad 數 864 vs 528） |
| 差異層 chunk 數 | ×1 圓頭 ≤ 6 | ×1 推面 10 個、translate 20 個（m12 用推面）；圓頭沒有單獨量 |
| ×2 20 個 split 後 heap 增量 | < 250 MB | ＋213 MB（e2e，每個改 3～30 萬格；Node bench 219 MB）；舊 ≈ 3.6 GB |
| ×2 產生期間主執行緒 heap | < 60 MB | 最高 ＋226 MB：包含最後一個 restore 成 live 的帳簿（94 MB）與 20 個大補丁（每個 ≈ 7 MB）；計畫假設每個只改 3,000～5,000 格，這組改得多，沒有另外量小補丁的情形 |
| ×2 切到 parked split 到網格換上 | < 1.5 s | 440～590 ms（從原始的網格增量；改成增量前 1.8 s） |
| 實驗頁 200 個 split：DOM 卡片 | ≤ 40 | 20（捲動中 32） |
| 滑鼠移動 60 次整頁 render | 0 | 整頁 0、卡片 0 |
| 捲動一頁的 long task | 0 | ✗ 捲 10 頁有 6～7 個、最長 85～100 ms：縮圖一次畫一張、每張之間讓出主執行緒，軟體 WebGL 的容器裡一張縮圖（切一片＋描輪廓）仍要幾十 ms；真機會短很多，但沒有量 |
| 點卡片 Worker 請求 | 0 | 0 |
| 新使用者 3×3 路徑、進度、停留、縮圖同軸與黑線、勾 3 張疊圖、在 3D 看 | 全部 | 全部（m12 §2）；試算期間長任務 1 個、最長 ≈ 90 ms（主執行緒逐列數改動格數） |
| 圓頭 −5 | 紅字、產生鈕反灰 | 「半徑不能小於 0」、「有 1 個組合無效」反灰（m12 §3） |
| parked 匯出 ≡ live 匯出 | 逐位元組 | 相同（m12 §5） |
| 窄螢幕 1000 px | 設計區變抽屜 | 是（m12 §7） |
| 既有測試 | 全過 | vitest 247／247；e2e m0、m2、m3、m5、m9、m10、m11、m12 全過 |

### 11.4 沒做或留到下一輪

- 捲動中的 long task 沒壓到 0（見上表）；可以把縮圖搬進 Worker（OffscreenCanvas）。
- 「產生期間主執行緒 heap < 60 MB」只在大補丁的情況量過。
- 差異層沒有快取（11.2 #4）。
- 物理 lint、量測器仍不在這一輪（§0）。
