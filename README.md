# Section Editor 3D

在瀏覽器裡直接改 TCAD 輸出的 3D 材質體素（`.vti`，VTK ImageData，材質編號放 CellData；也接受 `.npy`），包含在 3D 上拖拉面；改完匯出同 Extent／Spacing／Origin 的 `.vti` 去 retrain。同一個輸入可以同時養多個 split（例如 poly 長高 1／2／3 nm），並排看、一次匯出 zip。目標規模 4,000 萬 voxel：所有 O(N) 運算都在 Web Worker。

最大原則：沒碰到的體素一個都不變；每個操作都直接改體素，不經過任何幾何近似。

## 開始

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # 逐體素測試（vitest）
npm run build      # 型別檢查 + 打包
```

打開後先上傳 `.vti`／`.npy`，或用內建範例（3 根 fin × 3 根 poly，160×96×128，Poly-Si 3 裡有 bamboo defect）；大範例 ×2／×3（1,570 萬／5,300 萬 voxels）用來看速度。範例裡 **Si fin** 是沿 z 延伸的三條細長矽脊（上視圖裡直的那三條，頂角有斜切），**Poly-Si** 是沿 x 橫跨三根 fin 的閘極（橫的那三條），HfO₂／TiN 是閘極裡包著 fin 的薄襯層。上視圖切在 fin 高度以內時 fin 連續、poly 被 fin 隔開；切到 fin 頂以上就是 poly 連續。

`.vti` 讀取支援 CellData（沒有則 PointData）、八種數值型別、ascii／inline base64／appended raw／appended base64、zlib 壓縮（header UInt32／UInt64）。整數 0～254 直接當編號，其他依值重新編號。檔案沒有材質名稱，所以載入後一律「材質 n」、自動配色；在左欄雙擊改名、點色塊改色，會寫進 manifest.json。

**2D 編輯（主要的改法）**：主畫面預設是 3D，用來看、選、轉。選好結構按 3D 上方「2D 編輯」（或 E）：主畫面換成放大的切面，3D 與另外兩張切面縮到右側小窗；Esc 或「回 3D」回來，選取與範圍都留著。方向自動選結構最長那一軸的法線（fin 沿 z → XY 正面；poly 沿 x → YZ 側面），頁籤可換、換過之後沿用；主切面跳到十字那一片（那一片沒有這個結構就跳到最近的一片），並自動放大到選取。主切面滾輪朝游標縮放（0.25×～32×）、右鍵／中鍵／空白鍵＋左鍵／Alt＋左鍵拖平移、雙擊空白適合視窗；換片用 Ctrl＋滾輪、`,` `.`、PgUp／PgDn、位置列。拖輪廓改剖面是下一階段（plan v7 M2）。

**拖剖面（plan v7 M2）**：2D 編輯的主切面描出已選結構的輪廓（含內環），角上有節點。靠近節點＝拖節點（左右兩節點之間依 cos 衰減跟著走）、靠近邊＝推邊（沿到角為止的整段邊、平滑後的法線）、在結構裡面＝整塊搬；Shift 只動一點／一小段，按住 V／E／R 只抓一種。每拖一下主切面就是這一片的結果（第 1 級），範圍 × 外框 ≤ 40 萬格時 3D 與小切面也即時（第 2 級），放開＝一步、立刻套用到範圍。手勢對到 Op：橫跨整個結構的最外側直邊 → `push`；整塊搬 → `translate`（帶殼）；其他（節點、斜邊、圓弧、部分邊）→ `profile`（每片：先拿再加、由近到遠、要和結構 4 鄰接才填，規則走 `kernel.ts`）。訊息帶格數、被擋的片數（「看這些片」跳過去、被擋的格子標紅）、略過的片數。大操作（預設 400 萬格）先確認；Worker 忙時排隊。`slice/trace.ts`（描輪廓）、`slice/raster.ts`（光柵化與差）、`slice/gestures.ts`（熱區、拖法、手勢 → Op）、`volume/profile.ts`。

**友善化（plan v7 M3）**：選取外框旁的浮動工具列（方頭、往外推、移動、材質、VOID、對應；文字帶範圍詞）；主切面右鍵選單；點節點或邊選成把手後右欄可以打數字（`handleOps.ts`，和拖拉同一個 Op）；第一次用左下角三行提示；頁籤提示這個方向能改什麼；多選時對應到長得一樣的結構（`slice/mirror.ts`：正規化座標配對，保險條件同材質、長寬比 ≤ 20%、面積 ≤ 30%）。訊息格式「{結構} {動作} · 已套用到{範圍}（{軸} {lo}～{hi}）· {格數} 格 · …被擋住 · 看這些片 · 復原」。

**相對式套用（plan v7 M4）**：`profile` Op 另外記下手勢（`gestures`：把手種類、正規化到結構這一片外框的位置、位移），每一片先描自己的輪廓、找同一個節點／邊重做；對不到的片退回參考片的絕對座標，報告記下片數（`slice/relative.ts`，`relative.test.ts`：偏移 1 格的 fin 推斜邊往外 3，每片多的格數相同、沒有被擋）。

**範圍（Scope）**：取代以前只能沿 z 的「要改哪裡」。一個軸＋起止索引，軸＝主切面的法線；三種模式：整個結構（預設）、此片、自訂一段（滑桿上標結構起止與旁邊結構的起止）。位置列與右欄是同一個狀態。所有 Op 存 `scope: {axis, lo, hi}`；舊的 `zRange: [a, b]` 讀進來會轉成 `scope: {axis: 'z', lo: a, hi: b}`（`upgradeOp`），重播逐體素相同（`scope.test.ts`）。

**3D 雕刻（進階，預設關）**：設定裡「在 3D 上雕刻」或 3D 標題列的「3D 雕刻：關」打開。關著時 3D 上怎麼拖都只轉視角。打開後 3D 上的拖拉是**筆刷雕刻**：選好結構後滑鼠移到它的面上會看到筆刷圈與法線箭頭（半徑、圓／方在工具列），按住沿法線拖＝圈圈裡局部長／縮，拖的時候 3D 與切面就顯示結果，放開才套用（橘色虛線框是範圍、游標旁顯示格數與 nm）。先拖過 8px 才算拖拉，手抖不會改到；正對著面看時改用垂直位移估算；格數上限是選取外框在該軸的長度；拖到一半按 Esc 取消。轉視角：左鍵拖在非選取處、中鍵拖、或 Alt＋左鍵拖；筆刷切到「關閉」時怎麼拖都只轉視角。筆刷切到「補平」時點一個面＝圈圈裡每一排補到或削到那一面；整根要變方頭用右欄「補平（圓頭變方頭）」（每一排補到最外側那一點；薄襯層跟著外推、厚的鄰居不吃）。整面長縮、整塊移動、換材質都在右欄輸入；換材質點下去 3D 立刻變色（GPU 上先改面的顏色，Worker 的正式結果幾秒後覆蓋）。

**即時預覽**：每一步（按鈕、方向鍵、筆刷）送 Worker 之前，主執行緒先把這一步會動到的小塊裁下來（選取外框 ∩ 筆刷範圍，沿法線多留 |n|＋襯層），用同一組純函式算一次並 greedy mesh，主網格同一範圍用 shader 挖掉、疊上這塊小網格，切面與剖面貼圖也蓋上同一份結果；Worker 的正式網格到了就收掉。裁切範圍內逐體素和正式結果相同（`preview.test.ts`）。範圍超過 600 萬 voxels（例如整個基板）就不預覽、只畫橘色塊；拖拉中的即時預覽上限 40 萬。

滑過結構會顯示外框與名稱；同一處 1.5 秒內再點一次＝選它後面的結構（右鍵選單也列出）。3D 上方「現在／原始／差異」三段切換（B、D 鍵）；差異模式沒改的半透明、改過的實色加紅邊、被拿掉的紅。「剖面」沿 X／Y／Z 任一軸剖開、剖口貼真正的切面圖，位置和十字分開（「對齊十字」可同步），滑桿或 `,` `.` 鍵移動、「翻面」留另一半。右下角視角列（正視／上視／側視／等角／全貌／對準選取，鍵盤 1／2／3／4／H／F）、左下角座標軸；滾輪朝游標縮放、右鍵拖平移；雙擊模型＝繞著點到的地方轉、雙擊空白＝回全貌（選取保留）。`?` 打開快捷鍵一覽。任一切面右上角「放大」可以放成主畫面（Esc 還原）。

「原始」永遠唯讀：直接在原始上調整會自動建立 Split 1，原始陣列不變。推面（長高／縮短）只推結構在那個方向最外側的表面，內部空洞不會被填、也不會往外蝕。

## 檔案

| 檔案 | 內容 |
| --- | --- |
| `src/volume/volume.ts` | Volume、材質（`materialsFor`、調色盤）、範例 `demoVolume(scale)`、`translateMask`、`setMaskMaterial`、`growMask`、`localMask`（圓／方筆刷）、`levelMask`（補平）、`fillAt`、`greedyMesh`、`voxelFromHit`、`encodeNpy`／`decodeNpy`、`labelComponents`、`nameComponents`、`relabel`（只重算改到的範圍）、`relabelFull`（對照用）、`maskOf` |
| `src/volume/ops.ts` | `Op`（push／translate／material／level，都帶 `scope`）、`upgradeOp`（舊 zRange → scope）、`applyOp`／`replay`／`opText`／`sweepOps`（純函式，主執行緒與 Worker 共用） |
| `src/volume/scope.ts` | `Scope`（軸＋起止）、`scopeBox`／`clipBox`／`inScope`／`clampScope`／`fullScope` |
| `src/volume/preview.ts` | `previewBox`／`previewOp`：一步操作會動到的裁切範圍與範圍內的結果（即時預覽用，主執行緒） |
| `src/volume/vti.ts` | `decodeVti`（各種編碼、zlib 用 `DecompressionStream`）、`encodeVti`（UInt8 CellData、appended raw） |
| `src/volume/worker.ts`、`client.ts` | Worker 入口（load／put／retain／replay／mesh／diffMesh／diff／count）與主執行緒的 `call()`；原始與每個 split 目前的結果常駐在 Worker，主執行緒只送編號。`client.ts` 看到 `globalThis.__WORKER_SRC__` 就用 Blob 建 Worker（單檔 prototype 用） |
| `src/volume/zip.ts` | `zipStore`（CRC32，store only） |
| `src/pages/Section3D/editor.ts` | `useEditor`（async）：splits、選取、範圍（`scope`／`scopeMode`／`editAxis`）、3D 雕刻與自動放大設定、commit → Worker、undo／redo（每 split 10 步）、busy、diff／ledger、鍵盤、`loadVolume(vol, meta)` |
| `src/pages/Section3D/views.tsx` | `View3D`（Worker greedy mesh、選取層沿法線外推、差異模式兩層、三軸剖面＋剖口貼圖、命中、筆刷圈與拖拉預覽、即時預覽網格＋主網格挖洞 shader、視角預設、座標軸、即時變色 `recolor`）、`drawSlice`、`SliceView`。按下用 capture 階段的原生事件判斷筆刷，OrbitControls 才不會記到一個收不到放開的指標 |
| `scripts/build-proto.mjs` | `node scripts/build-proto.mjs out.html`：esbuild 打成單一 .html（Worker 內嵌） |
| `src/pages/Section3D/*.tsx` | Inspector、ChangesTab、SplitsTab、SplitBar、SweepModal、CompareView、StructureList（改名／改色）、SettingsDrawer、UploadPanel（.vti／.npy、Spacing 單位、大範例）、HelpDrawer、index（版面、匯出） |
| `src/pages/Section3D/SliceEditor.tsx` | 2D 編輯的主切面：縮放、平移、換片、縮放列（1:1／8×／適合／對準選取）、自動放大到選取 |
| `src/pages/Section3D/PositionBar.tsx` | 位置列（第幾片、套用到哪裡、「這一片沒有…跳到最近的一片」）與範圍控制 `ScopeControl`（右欄共用）、自動選切面方向 |
| `src/pages/Section3D/views.lazy.tsx` | `View3D`／`SliceView`／`SliceEditor` 的 lazy 包裝：three.js 等載入檔案後才抓，歡迎頁不用等 |
| `scripts/e2e/m0.cjs`、`m2.cjs`、`perf.cjs` | 驗收與量測（Playwright）：`npm run dev` 後 `node scripts/e2e/m2.cjs` |
| `src/slice/` | 2D 剖面編輯的純函式：`trace.ts`（描輪廓、簡化、角）、`raster.ts`（光柵化、前後差＋方向碼）、`gestures.ts`（熱區、拖法、手勢 → Op） |
| `src/volume/kernel.ts`、`apply.ts`、`patch.ts`、`chunks.ts`、`profile.ts`、`report.ts` | 核心規則、只在外框裡算、補丁、chunk 網格、profile Op、一步的報告 |
| `src/ui/` | Swatch、StatTile、download、theme（antd 主題；色票和 `styles.css` 的 `:root` 變數對齊）、persist（`usePersisted`：欄寬、筆刷、襯層跟推、nm 比例、標紅存 localStorage；`overlayOpen`：Modal／Drawer 開著時單鍵快捷鍵不動 3D） |

面板不直接碰 Volume；所有改體素的路徑都經過 `useEditor` 的 `commit`，所以每一步都有 Op 記錄、都能復原、都能在別的 split 重播。

## 大陣列的效能

- **Worker 常駐狀態**：原始與每個 split 目前的結果放在 Worker，用版本號（`EditState.version`，全域遞增；改名不換號）當編號與 diff／計數／網格快取的 key；一步操作只送編號、Op 與結構清單。
- **一步只在外框裡算**（`apply.ts`）：裁下這一步會動到的範圍（`previewBox`），在裡面跑同一組純函式，找出真正改到的外框，回傳補丁（外框＋前後資料）；主執行緒拿補丁貼到目前陣列做出新版本。和 `applyOp` 逐體素相同（`apply.test.ts`）。
- **核心規則一套**（`kernel.ts`）：加（空氣填、薄襯層推開、厚的擋住）、拿（襯層跟退）、搬（可帶殼）；`growMask`／`levelMask`／`translateMask` 都呼叫它，和改寫前的實作逐體素相同（`kernel.test.ts`）。
- **relabel 吃外框**（`relabelFast`）：只看改到的外框（多留 1 格）裡有體素的結構；掉了體素的才重新 flood fill，只長出來的整塊照舊、新體素用 union-find 接上；名稱與 key 用同一套投票，和整個重算相同。沒碰到的結構編號不變，labels 補丁只有重新標記的範圍。
- **復原存補丁**：每個 split 50 步，只存改到的外框那麼大；復原／重做在主執行緒貼補丁，Worker 同時從目前版本做出同一個版本。
- **網格切 chunk**（`chunks.ts`）：3,000 萬以下 32³、以上 64³；Worker 快取每個版本的 chunk 網格，一步之後只重算和補丁外框相交的 chunk，主執行緒只換那幾個 Mesh（各自一棵 BVH）。差異模式、改隱藏、改顏色才整個重算。
- **diff 與體積帳用差量**：Worker 依上一版在補丁外框裡更新。
- **只在有變化時重畫 3D**：鏡頭動、動畫、滑鼠、React 更新、Worker 結果到了才畫，靜止時不佔主執行緒。
- **Worker 忙時排隊**：最多再排 3 步，依序接在前一步的結果後面；再多就提示「還在算前面的步驟」。排隊中按 Ctrl+Z 先清掉排隊的步驟。
- **點選**：three-mesh-bvh。
- **選取層不閃爍**：選取層頂點沿法線外推 0.03 voxel、不寫深度，主網格開 polygonOffset；相機 near 依陣列大小設。
- **換材質即時**：點下去先在主執行緒把現有網格裡屬於選取體素的三角形改色（三角形重心沿法線退半格反推體素），Worker 的正式網格之後覆蓋。

量法：`npx vite-node scripts/bench.ts 1 2 3`（Worker 核心）、`node scripts/e2e/perf.cjs <url> <scale>`（端到端）。雲端容器、Node 22（單位 ms，會有雜訊）：

| 範例 | 舊：整個陣列重播 | 新：外框裡算＋relabel | 主執行緒貼補丁 | 重算的 chunk | 舊：整個網格重畫 |
| --- | --- | --- | --- | --- | --- |
| ×1（197 萬） | 170～280 | 90～110 | 10～30 | 10/60 個，70～180 | 240～300 |
| ×2（1,570 萬） | 580～800 | 180～230 | 65～80 | 16～30/480 個，30～250 | 1,100～1,200 |
| ×3（5,300 萬） | 2,400～2,500 | 710～760 | 950～1,170 | 12～16/240 個，120～220 | 5,600 |

端到端（headless Chromium、軟體 WebGL）：「長高 1 格」按下到換上正式網格，×1 約 0.65～0.85 s、×2 約 1.1～1.6 s；剩下的大多是軟體繪圖（profile 裡的 native 時間），有 GPU 的瀏覽器會快很多。plan 的目標（1,800 萬 < 200 ms）在這個容器裡沒有達到：主要卡在 ×2 以上 relabel 要複製整份 labels（Int32，4 bytes／voxel）與主執行緒貼補丁時的同樣複製。

## 匯出

- 目前 split：`原檔__split名.vti`（同 Extent／Spacing／Origin、UInt8 CellData），或 `.npy`
- 全部：`原檔__splits.zip`，每個 split 一個 `.vti`（或 `.npy`）＋ `manifest.json`（source、format、materials（id／name／color）、shape、dtype、spacing、origin、nmPerVoxel、每個 split 的檔名、改動體素數、ops 與白話描述）

```python
import json, zipfile, io
import vtk
from vtk.util.numpy_support import vtk_to_numpy

z = zipfile.ZipFile('tcad__splits.zip')
m = json.loads(z.read('manifest.json'))
for s in m['splits']:
    r = vtk.vtkXMLImageDataReader()
    r.ReadFromInputStringOn()
    r.SetInputString(z.read(s['file']))
    r.Update()
    img = r.GetOutput()
    nx, ny, nz = (e - 1 for e in img.GetDimensions())
    arr = vtk_to_numpy(img.GetCellData().GetArray(0)).reshape(nz, ny, nx)
```
