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

**聚焦編輯（plan v10，主要的改法）**：主畫面預設是 3D，用來看、選、轉；瀏覽時 3D 上怎麼拖都只轉視角。選好結構按 **E**（或雙擊它、右鍵「編輯 {結構}」、上方編輯工具列「3D 把手」）進入聚焦編輯：其他結構半透明、選取用材質原色、相機對準、範圍設成整根。結構上長出**面把手**（選取外框六面中央的橘色箭頭：沿箭頭拖＝那一面整面長／縮）與**角把手**（剖面四個角的紫色菱形：往內拖＝圓角半徑、點一下開圓頭面板）；只有按在把手上才是編輯，其他地方一律轉視角。再按 E＝**2D 剖面**：主畫面換成放大的切面，3D 與另外兩張切面縮到右側小窗；再按 E 回瀏覽（D9），Esc 隨時離開，選取與範圍都留著。編輯工具列另有「筆刷」頁籤（局部長／縮、局部方頭）。2D 剖面的方向自動選結構最長那一軸的法線（fin 沿 z → XY 正面；poly 沿 x → YZ 側面），頁籤可換、換過之後沿用；主切面跳到十字那一片（那一片沒有這個結構就跳到最近的一片），並自動放大到選取。主切面滾輪朝游標縮放（0.25×～32×）、右鍵／中鍵／空白鍵＋左鍵拖平移、雙擊空白適合視窗；換片用 Ctrl＋滾輪、`,` `.`、PgUp／PgDn、位置列。聚焦中右鍵（點在結構上）：對準這裡、{方向}長／縮…、方頭、圓頭…、換材質、在這個面上看 2D 剖面。

**卡片：先看再套用（plan v10）**：所有數值操作都是同一種卡片——第一行一句話（「Poly-Si 2 頂面 y 40 → 37（長高 3 格 = 1.5 nm）· 襯層跟著 · 整根」，`opWords.ts`）、參數、下方「套用到：整根 ▾」與「套用」。改參數 150 ms 後走既有的拖拉預覽管線畫出結果（3D 即時網格、主切面淡綠／淡紅），按「套用」（Enter）才 commit；點別處、Esc、收合就收掉。右欄（長／縮、方頭／圓頭、移動、材質、選到的節點／邊）、上方編輯工具列與 2D 浮動列開的是同一張卡片（`OpCard.tsx`）。方向用六面小方塊（`FacePicker.tsx`，滑過時 3D 選取外框那一面亮橘色＋箭頭）。卡片、把手、右鍵、方向鍵都呼叫同一個產生 Op 的函式（`editor.ts` 的 `pushOp`／`levelOp`／`translateOp`／`materialOp`、`handles3d.ts`）。

**圓頭（plan v10）**：`slice/round.ts`。參數：哪些角（外圓角／內圓角＝貼著側壁往外填）、半徑 r（上限＝半寬／半高）、不對稱（寬 ru／肩高 rv）、方圓度 n（超橢圓指數：1 斜切、2 圓、8 方）、對齊形狀／只削／只填。存成 `profile` Op 的 `rounds`：每一片用自己的外框重算（不會 fallback），之後和 profile 一樣先拿再加、由近到遠、要 4 鄰接、kernel 規則、襯層跟著；只改角的區域，L 形缺的角不會被填。方頭（每一排補到最外側那一點）在同一張卡片右上角切換。

**拖剖面（plan v7 M2、v10）**：2D 剖面的主切面描出已選結構的輪廓（含內環），角上有節點。靠近節點＝拖節點、靠近邊＝推邊（沿到角為止的整段邊、平滑後的法線）、在結構裡面＝整塊搬（節點與邊都在範圍內時比距離）。拖節點預設依局部形狀：兩邊都是軸向直邊＝**矩形角**（相鄰的水平邊整條沿 v、垂直邊整條沿 u 平移，放開後仍是直角）、否則＝**單點**；Alt＋拖＝自由衰減（左右兩節點之間依 cos 跟著走，舊版的預設）、Shift＝單點／一小段，按住 V／E／R 只抓一種（`slice/snap.ts`，`RelGesture.drag`；舊 Op 沒這欄＝衰減，重播不變）。拖的時候輪廓自交會轉紅提示。每拖一下主切面就是這一片的結果（第 1 級），範圍 × 外框 ≤ 40 萬格時 3D 與小切面也即時（第 2 級），放開＝一步、立刻套用到範圍。手勢對到 Op：橫跨整個結構的最外側直邊 → `push`；整塊搬 → `translate`（帶殼）；其他（節點、斜邊、圓弧、部分邊）→ `profile`（每片：先拿再加、由近到遠、要和結構 4 鄰接才填，規則走 `kernel.ts`）。訊息帶格數、被擋的片數（「看這些片」跳過去、被擋的格子標紅）、略過的片數。大操作（預設 400 萬格）先確認；Worker 忙時排隊。`slice/trace.ts`（描輪廓）、`slice/raster.ts`（光柵化與差）、`slice/gestures.ts`（熱區、拖法、手勢 → Op）、`volume/profile.ts`。

**友善化（plan v7 M3）**：選取外框旁的浮動工具列（和上方編輯工具列同一組：長／縮、方頭／圓頭、移動、材質、對應）；主切面右鍵選單（角附近有「圓角（左上）…」）；點節點或邊選成把手後右欄出現它的卡片（`handleOps.ts`，和拖拉同一個 Op；節點可選拖法）；第一次用左下角三行提示；頁籤提示這個方向能改什麼；多選時對應到長得一樣的結構（`slice/mirror.ts`：正規化座標配對，保險條件同材質、長寬比 ≤ 20%、面積 ≤ 30%）。訊息格式「{結構} {動作} · 已套用到{範圍}（{軸} {lo}～{hi}）· {格數} 格 · …被擋住 · 看這些片 · 復原」。

**相對式套用（plan v7 M4）**：`profile` Op 另外記下手勢（`gestures`：把手種類、正規化到結構這一片外框的位置、位移），每一片先描自己的輪廓、找同一個節點／邊重做；對不到的片退回參考片的絕對座標，報告記下片數（`slice/relative.ts`，`relative.test.ts`：偏移 1 格的 fin 推斜邊往外 3，每片多的格數相同、沒有被擋）。

**持久幾何層（plan v8）**：進入 2D 編輯時把已選結構的剖面描一次成有頂點 id 的幾何（`slice/model.ts` 的 `SliceModel`），之後拖節點、推邊、搬區域、右欄數值、方向鍵都改這份幾何，不再每一步從 voxel 重描：連拖同一個節點，節點還是那一個、從上一次放開的位置出發；斜邊拖完是一條直線（主輪廓畫頂點連線，8× 以上下面淡淡疊著 voxel 真正的邊界）。拖的時候橘色輪廓跟手（浮點，`slice/snap.ts` 的 `dragDispFloat`），裡面淡綠／淡紅是放開後會加／拿的格子、斜線是會被擋住的（主切面的單片預覽，`SlicePreviewLayer.tsx` 只重畫那一塊），提示「(+1.6, −2.3) → 取 (+2, −2)」；pointermove 用 requestAnimationFrame 合併。放開時幾何先用整數位移更新（不等 Worker），Op 照舊（rasterize → deltaOf → profile）；Worker 回來後只驗證「幾何光柵化 === 這一片 voxel」，對不上（被擋住、3D 那邊改了這片）以 voxel 為準重描、舊節點 ≤ 1.5 格對應沿用 id，訊息「幾何已對齊到實際結果」。每個版本留一份幾何快照，Ctrl+Z／Y 時節點回到那時的位置。幾何改過的結構，profile Op 多帶 `refExact`：參考片用 Op 裡的絕對格子（看到的＝commit 的），其他片照舊相對式；剛描好的幾何產生的 Op 和 v7 逐欄相同（`model.test.ts` 黃金測試）。profile 的即時預覽外框改成只包加／拿的格子＋結構這一段＋實際襯層要讀到的格數（`preview.ts` 的 `profileBox`），拖 fin 節點時 3D 也即時；還是超過 40 萬格時 3D 畫加／拿格子沿範圍擠出的點雲（`cellCloud.ts`，概略）。設定裡可以改回「階梯」輪廓與「邊拖邊吸附」。實作紀錄與量測：`docs/plan-v8-geometry-layer.md`。

**範圍（Scope）**：取代以前只能沿 z 的「要改哪裡」。一個軸＋起止索引，軸＝主切面的法線；三種模式：整個結構（預設）、此片、自訂一段（滑桿上標結構起止與旁邊結構的起止）。每張卡片下方「套用到：整根 ▾」點開就是範圍控制；位置列只顯示。所有 Op 存 `scope: {axis, lo, hi}`；舊的 `zRange: [a, b]` 讀進來會轉成 `scope: {axis: 'z', lo: a, hi: b}`（`upgradeOp`），重播逐體素相同（`scope.test.ts`）。

**3D 視角（plan v10）**：滾輪自己接（OrbitControls 的 zoomToCursor 會把旋轉中心帶跑）：朝游標下的實際表面縮放，旋轉中心放在那個面的深度；沒打到東西就朝現在的中心縮放、中心不動。左鍵旋轉前中心先放到游標下；雙擊模型＝對準那一點（動畫）。中心跑到模型（放大 25%）外、退得太遠或整個模型都在畫面外 → 自動拉回模型中心（只轉頭）。極點留 0.02 rad，上視也能繼續拖。開發模式 `window.__controls`。

**筆刷（聚焦編輯的一個工具）**：編輯工具列切到「筆刷」才有。選好結構後滑鼠移到它的面上會看到筆刷圈與法線箭頭（半徑、圓／方在工具列），按住沿法線拖＝圈圈裡局部長／縮，拖的時候 3D 與切面就顯示結果，放開才套用（橘色虛線框是範圍、游標旁顯示格數與 nm）。先拖過 8px 才算拖拉；正對著面看時改用垂直位移估算；拖到一半按 Esc 取消。切到「局部方頭」時點一個面＝圈圈裡每一排補到或削到那一面。換材質點下去 3D 立刻變色（GPU 上先改面的顏色，Worker 的正式結果幾秒後覆蓋）。

**即時預覽**：每一步（卡片的預覽與套用、把手、方向鍵、筆刷）送 Worker 之前，主執行緒先把這一步會動到的小塊裁下來（選取外框 ∩ 筆刷範圍，沿法線多留 |n|＋襯層），用同一組純函式算一次並 greedy mesh，主網格同一範圍用 shader 挖掉、疊上這塊小網格，切面與剖面貼圖也蓋上同一份結果；Worker 的正式網格到了就收掉。裁切範圍內逐體素和正式結果相同（`preview.test.ts`）。範圍超過 600 萬 voxels（例如整個基板）就不預覽、只畫橘色塊；拖拉中的即時預覽上限 40 萬。

滑過結構會顯示外框與名稱；同一處 1.5 秒內再點一次＝選它後面的結構（右鍵選單也列出）。3D 標題列只放「怎麼看」：**改後／改前／差異**三段切換（B、D 鍵；改後不染色，差異模式沒改的半透明、改過的實色加深藍邊 `#003a8c`、被拿掉的紅）、「剖面」（沿 X／Y／Z 任一軸剖開、剖口貼真正的切面圖，預設跟著十字，鎖頭解開才固定；`,` `.` 鍵移動、「翻面」留另一半）、「顯示」（空洞透視、材質半透明、2D 輪廓、2D 吸附）、復原／重做。右下角視角列（正視／上視／側視／等角／全貌／對準選取，鍵盤 1／2／3／4／H／F）、左下角座標軸；右鍵拖平移；雙擊空白＝回全貌（選取保留）。`?` 打開說明（依任務寫，含改名對照表）。任一切面右上角的按鈕＝用這個方向進 2D 剖面。

原始模型永遠唯讀：直接在原始上調整會自動建立 Split 1，原始陣列不變。長／縮只推結構在那個方向最外側的表面，內部空洞不會被填、也不會往外蝕。「丟掉所有改動」在右欄「改了哪些」頁籤底部。

## 檔案

| 檔案 | 內容 |
| --- | --- |
| `src/volume/volume.ts` | Volume、材質（`materialsFor`、調色盤）、範例 `demoVolume(scale)`、`translateMask`、`setMaskMaterial`、`growMask`、`localMask`（圓／方筆刷）、`levelMask`（補平）、`fillAt`、`greedyMesh`、`voxelFromHit`、`encodeNpy`／`decodeNpy`、`labelComponents`、`nameComponents`、`relabel`（只重算改到的範圍）、`relabelFull`（對照用）、`maskOf` |
| `src/volume/ops.ts` | `Op`（push／translate／material／level，都帶 `scope`）、`upgradeOp`（舊 zRange → scope）、`applyOp`／`replay`／`opText`／`sweepOps`（純函式，主執行緒與 Worker 共用） |
| `src/volume/scope.ts` | `Scope`（軸＋起止）、`scopeBox`／`clipBox`／`inScope`／`clampScope`／`fullScope` |
| `src/volume/preview.ts` | `previewBox`／`previewOp`：一步操作會動到的裁切範圍與範圍內的結果（即時預覽用，主執行緒） |
| `src/volume/vti.ts` | `decodeVti`（各種編碼、zlib 用 `DecompressionStream`）、`encodeVti`（UInt8 CellData、appended raw） |
| `src/volume/workerCore.ts`、`worker.ts`、`client.ts` | Worker 本體（每個 split 一本帳簿：load／fork／put／drop／apply／derive／replay／chunks／layer／preview／diffMesh；diff、count 留給測試）、Worker 入口與主執行緒的 `call()`；主執行緒只送版本號、owner 與小資料。`client.ts` 看到 `globalThis.__WORKER_SRC__` 就用 Blob 建 Worker（單檔 prototype 用） |
| `src/volume/zip.ts` | `zipStore`（CRC32，store only） |
| `src/pages/Section3D/editor.ts` | `useEditor`（async）：splits、選取、範圍（`scope`／`scopeMode`／`editAxis`）、聚焦編輯（`focus`）與自動放大設定、commit → Worker、undo／redo（每 split 10 步）、busy、diff／ledger、鍵盤、`loadVolume(vol, meta)` |
| `src/pages/Section3D/views.tsx` | `View3D`（Worker greedy mesh、選取層沿法線外推、差異模式兩層、三軸剖面＋剖口貼圖、命中、筆刷圈與拖拉預覽、即時預覽網格＋主網格挖洞 shader、視角預設、座標軸、即時變色 `recolor`）、`drawSlice`、`SliceView`。按下用 capture 階段的原生事件判斷筆刷，OrbitControls 才不會記到一個收不到放開的指標 |
| `scripts/build-proto.mjs` | `node scripts/build-proto.mjs out.html`：esbuild 打成單一 .html（Worker 內嵌） |
| `src/pages/Section3D/*.tsx` | Inspector、ChangesTab、SplitsTab、SplitBar、SweepModal、CompareView、StructureList（改名／改色）、SettingsDrawer、UploadPanel（.vti／.npy、Spacing 單位、大範例）、HelpDrawer、index（版面、匯出） |
| `src/pages/Section3D/OpCard.tsx`、`FacePicker.tsx`、`RoundCard.tsx`、`opWords.ts`、`EditToolbar.tsx`、`handles3d.ts` | plan v10：預覽 → 套用的卡片、六面小方塊、圓頭面板、一句話、編輯工具列（瀏覽／3D 把手／2D 剖面／筆刷＋五顆操作按鈕）、3D 把手的純函式（`handles.test.ts`） |
| `src/slice/round.ts` | 圓頭：每片的目標形狀 → 加／拿的格子、`roundOp`、`roundStats`、`roundOutline`（`round.test.ts`） |
| `src/pages/Section3D/SliceEditor.tsx` | 2D 編輯的主切面：縮放、平移、換片、縮放列（1:1／8×／適合／對準選取）、自動放大到選取 |
| `src/pages/Section3D/PositionBar.tsx` | 位置列（第幾片、套用到哪裡、「這一片沒有…跳到最近的一片」）與範圍控制 `ScopeControl`（右欄共用）、自動選切面方向 |
| `src/pages/Section3D/views.lazy.tsx` | `View3D`／`SliceView`／`SliceEditor` 的 lazy 包裝：three.js 等載入檔案後才抓，歡迎頁不用等 |
| `scripts/e2e/m0.cjs`、`m2.cjs`、`m3.cjs`、`m5.cjs`、`m9.cjs`、`m10.cjs`、`perf.cjs` | 驗收與量測（Playwright）：`npm run dev` 後 `node scripts/e2e/m5.cjs`；`perf.cjs` 另外量 2D 拖拉 60 步的 long task；`npx vite-node scripts/bench.ts drag 1 2 3` 量拖拉每幀的計算 |
| `src/slice/` | 2D 剖面編輯的純函式：`trace.ts`（描輪廓、簡化、角）、`raster.ts`（光柵化、前後差＋方向碼）、`gestures.ts`（熱區、手勢 → Op）、`snap.ts`（拖法：浮點 ghost 與放開時的整數位移）、`model.ts`（持久幾何層：建立、位移、驗證、重描保留 id、每版本快照）、`relative.ts`、`mirror.ts` |
| `src/pages/Section3D/SlicePreviewLayer.tsx`、`cellCloud.ts` | 主切面的預覽層（只重畫預覽那一塊，拖拉中淡綠／淡紅）；超過即時預覽上限時 3D 的加／拿格子點雲 |
| `src/volume/kernel.ts`、`apply.ts`、`patch.ts`、`chunks.ts`、`profile.ts`、`report.ts` | 核心規則、只在外框裡算（`applyOpInPlace` 原地）、補丁（`applyStepInPlace`、`carryStepStats`）、chunk 網格、profile Op、一步的報告 |
| `src/volume/previewMesh.ts`、`meshBuilder.ts`、`src/pages/Section3D/drawSlice.ts`、`tables.ts`、`src/ui/liveValue.ts` | 預覽網格（Worker 與主執行緒共用）、網格建構器、LUT 版切面像素、送 Worker 的畫法表、不經整頁 state 的即時值（plan v9） |
| `src/ui/` | Swatch、StatTile、download、theme（antd 主題；色票和 `styles.css` 的 `:root` 變數對齊）、persist（`usePersisted`：欄寬、筆刷、襯層跟推、nm 比例存 localStorage；`overlayOpen`：Modal／Drawer 開著時單鍵快捷鍵不動 3D） |

面板不直接碰 Volume；所有改體素的路徑都經過 `useEditor` 的 `commit`，所以每一步都有 Op 記錄、都能復原、都能在別的 split 重播。

## 大陣列的效能

plan v9（`docs/plan-v9-performance.md`）之後：

- **每本帳簿只有一份**：原始是 owner `base`（永遠不寫），每個 split 第一次改的時候複製一次原始（主執行緒與 Worker 各一次，`own`／`fork`），之後每一步原地貼補丁，不再整個陣列影印。Worker 用 `heads`（owner → 版本號）記每本帳簿現在是哪一版；畫面要網格時送版本號，過期的版本 Worker 回錯誤、主執行緒丟掉等新的。復原／重做也是原地貼「改前」／「改後」，逐位元組相同（`patch.test.ts`）。複製 split 時兩本各自一份（`worker.test.ts`、`scripts/e2e/m9.cjs`）。
- **一步只在外框裡算**（`apply.ts`）：裁下這一步會動到的範圍（`previewBox`），在裡面跑同一組純函式，找出真正改到的外框 R；先裁「改前」再貼，原地 relabel（`relabelInPlace`：任何寫入之前先把 R ∪ 碰到的結構外框裡的舊 labels 裁下來當快照）。純函式 `applyOpLocal`／`relabelFast`／`applyStep` 都是「複製後呼叫原地版」的包裝，和 `applyOp` 逐體素相同（`apply.test.ts`）。
- **核心規則一套**（`kernel.ts`）：加（空氣填、薄襯層推開、厚的擋住）、拿（襯層跟退）、搬（可帶殼）；`growMask`／`levelMask`／`translateMask` 都呼叫它。
- **diff 與體積帳差量更新**：主執行緒與 Worker 各自在補丁外框裡更新（`carryStepStats`），不互傳、不快取整份 mask；每一步只送 `apply`、`chunks`（有選取再加 `layer`）。
- **網格切 chunk**（`chunks.ts`）：3,000 萬以下 32³、以上 64³；一步之後只重算和補丁外框相交的 chunk。chunk 網格快取在主執行緒（最近 3 組，沒動到的 chunk 在多組間共用），看原始（B）、切 split、復原到快取裡的版本不必再跟 Worker 要。BVH 等射線真的碰到那個 chunk 才建（閒置時補建）。
- **選取層、空洞層也切 chunk**：選取層的 key 是選了哪些結構（key 不隨 relabel 換編號）＋範圍，每一步只重算 relabel 範圍 S 碰到的 chunk；選到基板也只在第一次付全量。
- **拖拉第 2 級預覽在 Worker**：主執行緒每幀只算主切面這一片（第 1 級）；整個範圍的預覽與預覽網格在 Worker（同時最多一個在飛、永遠送最新的）。每片的輪廓同一次拖拉只描一次，輪廓一模一樣的片共用一份、只重做一次手勢。
- **畫面層不重 render**：滑鼠所在的格子、3D 的 hover 說明、拖拉中每幀換的預覽與點雲都走 live value（`ui/liveValue.ts`），只有用到的小元件重 render；主切面上滑鼠移動整頁 render 0 次。剖口貼圖用同一張 canvas 與同一個貼圖物件；切面像素用 LUT（`drawSlice.ts`，和舊版逐位元組相同）。
- **只在有變化時重畫 3D**：鏡頭動、動畫、滑鼠、會改畫面的 props、Worker 結果到了才畫；沒剖開時只畫正面。
- **Worker 忙時排隊**：最多再排 3 步，依序接在前一步的結果後面；再多就提示「還在算前面的步驟」。排隊中按 Ctrl+Z 先清掉排隊的步驟。
- **選取層不閃爍**：選取層頂點沿法線外推 0.03 voxel、不寫深度，主網格開 polygonOffset；相機 near 依陣列大小設。
- **換材質即時**：點下去先在主執行緒把現有網格裡屬於選取體素的三角形改色，Worker 的正式網格之後覆蓋（主網格快取同時作廢）。

量法：`npx vite-node scripts/bench.ts [step|mem|drag|draw] [scale ...]`、`node scripts/e2e/perf.cjs <url> <scale>`（端到端，需要 `npm run dev`）。雲端容器、Node 22、headless Chromium 軟體 WebGL（單位 ms，有雜訊）：

| 項目 | v8 | v9 |
| --- | --- | --- |
| 一步「長高 1」整陣列複製（`bench.ts step`） | ×2 每步 6 次（≈ 150 MB） | 0（只有第一次改 split 時 own 一次） |
| 主執行緒貼補丁（×1／×2／×3） | 10／65～80／950～1,170 | 0.2～2／0.3～3／0.8～11 |
| Worker 一步：外框裡算＋relabel（×2／×3） | 180～320／710～760 | 90～350／540～960 |
| 50 步後記憶體增量（×2，`bench.ts mem`） | 最多 50 份 diff mask（≈ 785 MB） | 10～17 MB（補丁 247 MB 在復原堆疊裡） |
| 選到基板後每一步的選取層（×2） | 每步整個外框重做（≈ 0.9 s） | 60～90 個 chunk，110～190 ms（第一次全量 830～950 ms） |
| 端到端「長高 1」按下 → 換上正式網格（`perf.cjs`，×1／×2） | 600～1,100／1,050～1,230 | 420～680／480～960 |
| 復原 → 換上網格（×1／×2） | 250／470 | 175／225 |
| B 切 20 次（×1） | 每次送 chunks（20 次） | 只有第一次（1 次），geometry 數不漲 |
| 拖拉第 2 級（Worker，fin 整根，`bench.ts drag` ×1） | 主執行緒 50～60 ms／幀 | Worker 10 ms／幀（有輪廓快取） |
| 2D 拖節點 60 步（`perf.cjs` ×1） | 11.5 s、long task 63 | 5.0～5.3 s、long task 5～7 |
| 2D 拖節點 60 步（`perf.cjs` ×2） | 14.4 s、long task 161 | 10.6 s、long task 104（剩下的多是軟體 WebGL 每幀重畫 3D） |
| 主切面上滑鼠移動 60 次（`perf.cjs`） | 每次整頁 render | 整頁 render 0 次 |
| drawSlice 一張（×3，480×384 那一面） | 33 ms | 2.5 ms |
| 點選一個結構的掃描（×3，poly／基板） | 484／534 | 76／190 |

沒達到 plan v9 §2 目標的：×3 一步（apply＋chunk ≈ 0.8～1.2 s，目標 < 1 s）、×2 拖 fin 整根的第 2 級（外框 170 萬格超過即時上限 40 萬，在 Worker 也要 130 ms，所以照舊畫點雲）、drawSlice ×3 仍 2～7 ms（目標 < 1 ms；沿 x 的切面是跨 plane 讀記憶體）、×3 點選基板 190 ms（目標 < 50 ms；結果陣列仍是整個陣列大小，見 plan v9 §10）。

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
