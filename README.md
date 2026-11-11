# Section Editor 3D（簡化版）

在瀏覽器裡直接改 TCAD 輸出的 3D 材質體素（`.vti`，VTK ImageData；也接受 `.npy`），改完匯出一個和輸入同格式的 `.vti`。這是 plan v17（`docs/plan-v17-simple-version.md`）的簡化版：只留**推拉一面、整塊平移、換材質**三個動作，沒有 split、沒有 2D 編輯；完整版留在 `claude/upbeat-einstein-wod16i` 分支。

最大原則：沒碰到的體素一個都不變；一步只會改變緊貼那一層的厚度，畫面事先寫出誰跟著、誰變薄、最多能推幾格。

## 開始

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # 逐體素測試（vitest）
npm run build      # 型別檢查 + 打包
```

打開就是主畫面，已經載入**簡單範例**（plan v18：沒有歡迎頁）。要用自己的檔案按頂端列的「上傳 .vti」（`.vti`／`.npy`），同一個對話框也可以換範例：**簡單範例**（160×96×128，3 根 fin × 3 根 poly 閘極，HfO₂／TiN 包著 fin、SiN 蓋在 poly 上）、**複雜範例**（`demoComplex.ts`：三根寬高不同的 fin、三根 CD 不同的閘極＋spacer、SiGe S/D epi、W 接觸窗、ILD 與幾種缺陷）。

## 怎麼用

（需要的話先上傳檔案）→ 點一個結構（3D、切面或左邊的清單；Shift／Ctrl＋點＝多選同材質）→ 按「外推／內縮」、拖 3D 上的箭頭或按鍵盤 → 匯出。

- **畫面**：左欄依材質分組的結構清單；中間是可旋轉的 3D（上）與三張唯讀切面（下，XY 正面／XZ 上視／YZ 側面，‹ › 或滾輪換片，右上角的放大鈕把那一張換成主畫面）；右欄上半是動作面板、下半是「改了哪些」、最底下一行是上一步的說明＋復原。沒選結構時面板反灰。
- **選取**：點 3D、點切面、點清單都一樣；點空白＝取消。多選只收相同材質（不同材質不加入，會提示）；面板標題旁「選全部 Poly-Si（3）」或 Ctrl+A＝選同材質全部。選到之後其他結構半透明（0.40）、選到的照材質原色加藍色輪廓線，最後選的那個結構外框六面中央各一支橘色箭頭，旁邊標「上下左右前後」。
- **材質開關**：清單的材質列整列點一下＝在 3D 顯示／隱藏（切面照常畫）；雙擊名字改名、點色塊改色；薄層材質名字後面有「薄層」標記，點它切換（自動判定錯的時候用）。
- **推拉一面**：選面（面板六顆按鈕、點 3D 上的箭頭、或方向鍵）→「上面內縮 1 格」「上面外推 1 格」；或在 3D 上順著箭頭拖＝外推、反方向＝內縮，游標旁即時顯示「上面外推 3 格（1.5 nm）」，放開完成。只動那個方向每一排最外側的表面。
- **整塊平移**：六顆方向鍵按一下搬一次，或拖箭頭；形狀與大小不變。
- **換材質**：點一下就換；結構名字跟著材質重新編號（「SiN 1 換成 SiGe（現在叫 SiGe 1）」）。換成檔案裡原本沒有的材質時，沿用來源材質的薄層設定。
- **每次 n 格**：預設 1，旁邊寫等於幾 nm；按鈕、方向鍵、＋／－都用它。
- **相鄰材質**：「跟著移動」（貼著的薄層一起動）或「留在原地」；沒有薄層貼著時「跟著移動」反灰。開關下面事先寫出「跟著移動：HfO₂、TiN／厚度會變：Poly-Si／最多可外推 5 格（到 Poly-Si 1 剩 1 格為止）」；推不動時按鈕反灰、改寫原因與解法。
- **做完之後**：最底下一行與「改了哪些」寫出每個鄰居怎麼了，都寫出幾格（「Si fin 2 上面外推 2 格（1.0 nm）· HfO₂、TiN 跟著移動 2 格 · Poly-Si 變薄 2 格」）；沒做滿再加一句為什麼。「改了哪些」一步一筆，點一筆＝選回那一組結構；「全部還原」回到原始，它本身也可以復原。
- **看改動**：3D 標題列「改後｜改前」（切面放大時這一組和復原／重做移到主切面的標題列）。
- **放大切面**（plan v18，唯讀）：每張切面右上角的放大鈕，不必先選結構；它變成主畫面，3D 與另外兩張縮到旁邊的小窗（3D 仍可轉、可點、可拖箭頭）。主切面上滾輪＝朝游標縮放（0.25～32 px／體素）、Ctrl＋滾輪＝換片、拖拉（左鍵、右鍵、中鍵都可以）＝平移、點一下＝選結構、雙擊空白＝整張放進視窗；右下角縮放列有倍率、`1:1`、`8×`、適合、對準選取。每個方向記住上次的縮放。回 3D：「← 回 3D」、小 3D 右上角的按鈕、或 Esc。
- **匯出**：一顆按鈕、一個 `.vti`。輸入是比例陣列＋FieldData 的檔時照原格式寫回（未改到的 32 KB block 連壓縮位元組都和原檔相同）；輸入是 `.npy` 或單一編號 `.vti` 時輸出 UInt8 CellData 的 `.vti`（同 Extent／Spacing／Origin）。

### 鍵盤

| 鍵 | 推拉一面 | 整塊平移 |
| --- | --- | --- |
| ↑ ↓ ← →、PgUp（後）、PgDn（前） | 選那一面 | 往那邊搬一次 |
| ＋（或 =）／－ | 外推／內縮一次 | — |

共用：Esc 取消選取（拖到一半＝取消這次拖拉；沒有選取而且有切面放大時＝回 3D 主畫面）、Ctrl+Z 復原、Ctrl+Y 或 Ctrl+Shift+Z 重做、Ctrl+A 同材質全選、F 對準選取、H 全貌。方向鍵對應的是模型的上下左右前後（和箭頭上的字一致），不是螢幕方向。游標在輸入框、或開著對話框時不作用。

3D 視角：左鍵拖＝轉視角（旋轉中心先放到游標下）、滾輪朝游標縮放、右鍵拖＝平移、雙擊模型＝對準那一點、雙擊空白＝全貌；右下角視角列（正視／上視／側視／等角／全貌／對準選取）。

## 相鄰材質規則（plan v17 §5.4）

**一步只會改變緊貼那一層的厚度，不會動到更外面的層。**

| 開關 | 誰跟著動 | 誰的厚度會變 |
| --- | --- | --- |
| 跟著移動 | 貼著的薄層（可以一層疊一層），厚度不變 | 薄層外面緊貼的那一層 |
| 留在原地 | 沒有 | 緊貼結構的那一層 |

外推一格時，對結構在那個方向每一排最外側的格子：往外一格起收一串薄層（跟著移動時），再往外那一格 `b` 要被吃掉——出界擋（到模型邊界）、空的可以、和結構同材質擋（會碰到同材質的結構）、否則 `b` 再往外一格必須和 `b` 同材質（吃掉之後那一層至少留 1 格），不是就擋。**整面一起**：有一排被擋，這一格整面不做，整個動作停在已經做完的格數。內縮一格：最外側那一格拿掉，跟著移動時外面那串薄層跟著退，空出來的由外面緊鄰的材質補上；結構在那個方向只剩 1 格厚時擋下。平移一格：要搬的集合＝結構（跟著移動時加上沿相連薄層 flood 收到的整圈，轉角也收得到），集合每個前緣做同樣的檢查，任何一格被擋整步不做；空出來的格子填「往後走到集合外的第一格」的材質。多格就是重複做一格；多選時每一格對每個結構依序做，大家停在同一格數。

**薄層**以材質判定、載入時一次（之後不變）：每一格的厚度＝穿過它的三個軸向上同材質連續段裡最短的那一段；那個材質一半以上的格子厚度 ≤ 4 格 → 薄層。空氣與空洞（VOID）不算；相鄰材質規則把空洞當成空的。

## 檔案

| 檔案 | 內容 |
| --- | --- |
| `src/volume/kernel.ts` | 核心規則：加、拿、搬（舊 policy）；相鄰材質規則的 `canTake`、`shellFlood`（整圈薄層）、`simGrowRow`（一排的一維模擬，試算與裁切範圍用）、薄層查表 |
| `src/volume/volume.ts` | Volume、材質、範例 `demoVolume(scale)`、`growMask`／`translateMask`／`setMaskMaterial`、`adjacentMasks`（相鄰材質規則的推拉與平移，逐排、可在裁切範圍裡算）、`linerTable`（薄層判定）、greedy mesh、結構標記與名稱延續（`relabel`、`relabelInPlace`） |
| `src/volume/ops.ts` | `Op`（push／translate／material；UI 產生的帶 `policy: 'adjacent'` 與當時的薄層 `liners`）、`applyOp`／`replay`（純函式，整個陣列的對照版） |
| `src/volume/preview.ts`、`apply.ts`、`patch.ts` | 一步只在外框裡算：裁切範圍（相鄰材質規則讀到哪裡就包到哪裡，不會把裁切邊當成模型邊界）、原地套用＋relabel、補丁（復原／重做原地貼） |
| `src/volume/probe.ts` | 試算：誰會跟著、誰的厚度會變、這個方向最多還能做幾格與被誰擋（推拉＝每排一維模擬；平移＝前緣沿原始陣列掃） |
| `src/volume/report.ts` | 一步的報告摘要；`stepEffects`：由補丁算每種鄰居跟著移動／變薄／變厚 |
| `src/volume/workerCore.ts`、`worker.ts`、`client.ts` | Worker：原始（`base`）與目前（`cur`）兩本帳簿；load（結構分析＋薄層判定）、fork、apply、derive（復原／重做）、probe、chunks、layer、preview、export、vti／npy 解碼 |
| `src/volume/vti.ts` | `.vti` 讀（各種編碼、zlib、比例陣列＋FieldData）寫（UInt8 CellData；同格式寫回只重壓改到的 block） |
| `src/volume/demo17.ts`、`ref/proto17.ts` | prototype 的 48×38×40 模型（y 上下顛倒）與 prototype 規則的逐格寫法（`kernel17.test.ts` 的對照） |
| `src/pages/Section3D/editor.ts` | `useEditor`：一本帳簿、選取（同材質多選）、三個動作、試算、復原／重做／全部還原、鍵盤、載入、匯出 |
| `src/pages/Section3D/index.tsx` | 版面（頂端列、左欄、中間 3D＋切面、右欄）、即時預覽 |
| `src/pages/Section3D/ActionPanel.tsx`、`StepList.tsx`、`stepWords.ts` | 右欄的動作面板、「改了哪些」、一步的白話說明（純函式） |
| `src/pages/Section3D/views.tsx`、`handles3d.ts` | `View3D`（Worker greedy mesh、選取層與輪廓線、箭頭、即時預覽網格）、`SliceView`、箭頭的純函式 |
| `src/pages/Section3D/SliceZoom.tsx`、`sliceXf.ts`、`SliceOverlay.tsx` | 放大的切面（唯讀、可縮放平移、縮放列）、視圖變換的純函式（適合／對準／朝游標縮放）、切面上的十字與範圍框（和 `SliceView` 共用） |
| `src/pages/Section3D/StructureList.tsx`、`UploadPanel.tsx`、`BusyBar.tsx` | 左欄、上傳（.vti 偵測確認／.npy）、計算中的膠囊（進度與取消） |
| `scripts/bench.ts` | `npx vite-node scripts/bench.ts [load|step|probe|export] [scale ...]` |
| `scripts/e2e/m0.cjs`、`m17.cjs`、`m18.cjs`、`perf.cjs` | 驗收與量測（Playwright，先 `npm run dev`）：載入、plan v17 的整條路徑與規則、plan v18 的開啟即主畫面與切面放大、G5 的一步時間 |
| `scripts/build-proto.mjs` | `node scripts/build-proto.mjs out.html`：esbuild 打成單一 .html（Worker 內嵌） |

## 大陣列

所有 O(N) 的事都在 Web Worker：解碼、結構分析、薄層判定、每一步（只在外框裡算、原地貼補丁）、網格（切 chunk，一步之後只重算碰到的 chunk）、試算、匯出。主執行緒只貼補丁、差量更新 diff 與體積帳。第一次改之前要把原始抄一份當「目前」的帳簿，這一份在載入後的閒置時間分段先抄好。復原／重做存補丁（最多 50 步或 256 MB）。Worker 忙的時候最多再排 3 步；計算中可以取消。

量法：`npx vite-node scripts/bench.ts step 1 3`、`node scripts/e2e/perf.cjs http://localhost:5173 1 3`。數字與沒達到的目標見 plan v17 §12。

## 匯出的檔

```python
import vtk
from vtk.util.numpy_support import vtk_to_numpy

r = vtk.vtkXMLImageDataReader()
r.SetFileName('tcad_edited.vti')
r.Update()
img = r.GetOutput()
nx, ny, nz = (e - 1 for e in img.GetDimensions())
arr = vtk_to_numpy(img.GetCellData().GetArray(0)).reshape(nz, ny, nx)  # 單一編號的 .vti；比例陣列的檔照原格式在 PointData
```
