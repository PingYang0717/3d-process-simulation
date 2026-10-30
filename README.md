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

打開後先上傳 `.vti`／`.npy`，或用內建範例（3 根 fin × 3 根 poly，160×96×128，Poly-Si 3 裡有 bamboo defect）；大範例 ×2／×3（1,570 萬／5,300 萬 voxels）用來看速度。

`.vti` 讀取支援 CellData（沒有則 PointData）、八種數值型別、ascii／inline base64／appended raw／appended base64、zlib 壓縮（header UInt32／UInt64）。整數 0～254 直接當編號，其他依值重新編號。檔案沒有材質名稱，所以載入後一律「材質 n」、自動配色；在左欄雙擊改名、點色塊改色，會寫進 manifest.json。

3D 上的拖拉只做**筆刷雕刻**：選好結構後滑鼠移到它的面上會看到筆刷圈，按住沿法線拖＝圈圈裡局部長／縮，放開才套用（橘色虛線框預覽、游標旁顯示格數）。筆刷切到「補平」時點一個面＝圈圈裡每一排補到或削到那一面（圓頭變方頭）。整面長縮、整塊移動、換材質都在右欄輸入；換材質點下去 3D 立刻變色（GPU 上先改面的顏色，Worker 的正式結果幾秒後覆蓋）。

3D 上方「現在／原始／差異」三段切換（B、D 鍵）；差異模式沒改的半透明灰、改過的實色、被拿掉的紅。「剖面」沿 X／Y／Z 任一軸剖開、剖口貼真正的切面圖，滑桿或 `,` `.` 鍵移動、「翻面」留另一半。右下角視角列（正視／上視／側視／等角／全貌／對準選取）、左下角座標軸；雙擊模型＝繞著點到的地方轉、雙擊空白＝回全貌。任一切面右上角「放大」可以放成主畫面（Esc 還原）。

「原始」永遠唯讀：直接在原始上調整會自動建立 Split 1，原始陣列不變。推面（長高／縮短）只推結構在那個方向最外側的表面，內部空洞不會被填、也不會往外蝕。

## 檔案

| 檔案 | 內容 |
| --- | --- |
| `src/volume/volume.ts` | Volume、材質（`materialsFor`、調色盤）、範例 `demoVolume(scale)`、`translateMask`、`setMaskMaterial`、`growMask`、`localMask`（圓／方筆刷）、`levelMask`（補平）、`fillAt`、`greedyMesh`、`voxelFromHit`、`encodeNpy`／`decodeNpy`、`labelComponents`、`nameComponents`、`relabel`（只重算改到的範圍）、`relabelFull`（對照用）、`maskOf` |
| `src/volume/ops.ts` | `Op`（push／translate／material／level）、`applyOp`／`replay`／`opText`／`sweepOps`（純函式，主執行緒與 Worker 共用） |
| `src/volume/vti.ts` | `decodeVti`（各種編碼、zlib 用 `DecompressionStream`）、`encodeVti`（UInt8 CellData、appended raw） |
| `src/volume/worker.ts`、`client.ts` | Worker 入口（load／put／retain／replay／mesh／diffMesh／diff／count）與主執行緒的 `call()`；原始與每個 split 目前的結果常駐在 Worker，主執行緒只送編號。`client.ts` 看到 `globalThis.__WORKER_SRC__` 就用 Blob 建 Worker（單檔 prototype 用） |
| `src/volume/zip.ts` | `zipStore`（CRC32，store only） |
| `src/pages/Section3D/editor.ts` | `useEditor`（async）：splits、選取、z 範圍、commit → Worker、undo／redo（每 split 10 步）、busy、diff／ledger、鍵盤、`loadVolume(vol, meta)` |
| `src/pages/Section3D/views.tsx` | `View3D`（Worker greedy mesh、選取層沿法線外推、差異模式兩層、三軸剖面＋剖口貼圖、命中、筆刷圈與拖拉預覽、視角預設、座標軸、即時變色 `recolor`）、`drawSlice`、`SliceView` |
| `scripts/build-proto.mjs` | `node scripts/build-proto.mjs out.html`：esbuild 打成單一 .html（Worker 內嵌） |
| `src/pages/Section3D/*.tsx` | Inspector、ChangesTab、SplitsTab、SplitBar、SweepModal、CompareView、StructureList（改名／改色）、SettingsDrawer、UploadPanel（.vti／.npy、Spacing 單位、大範例）、HelpDrawer、index（版面、匯出） |
| `src/ui/` | Swatch、StatTile、download、theme（antd 主題） |

面板不直接碰 Volume；所有改體素的路徑都經過 `useEditor` 的 `commit`，所以每一步都有 Op 記錄、都能復原、都能在別的 split 重播。

## 大陣列的效能

- **Worker 常駐狀態**：原始與每個 split 目前的結果放在 Worker，一步操作只送編號、ops 與結構清單；結果在 Worker 複製後 transfer 回來。復原用的舊步驟只在主執行緒，要用時才補送。
- **relabel 只重算改到的地方**：找出和上一步不同的外框，只重算碰到它的結構；測試驗證和整個重算逐體素相同。
- **網格**：選取層、空洞層只在外框裡做 greedy mesh；主網格保留最近 6 個（復原、看原始、切 split 不重算）。
- **點選**：three-mesh-bvh。
- **選取層不閃爍**：選取層頂點沿法線外推 0.03 voxel、不寫深度，主網格開 polygonOffset；相機 near 依陣列大小設。
- **換材質即時**：點下去先在主執行緒把現有網格裡屬於選取體素的三角形改色（三角形重心沿法線退半格反推體素），Worker 的正式網格之後覆蓋。

大範例 ×3（5,300 萬 voxels），雲端容器 4 核心、headless Chromium：長高一次（含 relabel）約 5～7 秒、重畫 3D 約 4.5 秒，「改動」數字在操作完成後 1 秒內出現（優化前長高約 26 秒）。

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
