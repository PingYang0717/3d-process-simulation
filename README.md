# Section Editor 3D

在瀏覽器裡直接改 TCAD 輸出的 3D 材質陣列（np.array，uint8 材質編號，shape `(Z, Y, X)`），改完匯出同 shape、同 dtype 的 `.npy` 去 retrain；同一個輸入可以同時養多個 split（例如 poly 長高 1／2／3 nm），並排看、一次匯出 zip。

最大原則：沒碰到的體素一個都不變；每個操作都直接改體素，不經過任何幾何近似。

## 開始

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # 逐體素測試（vitest）
npm run build      # 型別檢查 + 打包
```

打開後先上傳 `.npy`，或用內建範例（3 根 fin × 3 根 poly，160×96×128，Poly-Si 3 裡有 bamboo defect）。

「原始」永遠唯讀：直接在原始上調整會自動建立 Split 1，原始陣列不變。推面（長高／縮短）只推結構在那個方向最外側的表面，內部空洞不會被填、也不會往外蝕。

## 檔案

| 檔案 | 內容 |
| --- | --- |
| `src/volume/volume.ts` | Volume、材質、範例、`buildFaces`、`translateMask`、`setMaskMaterial`、`growMask`、`fillAt`、`encodeNpy`／`decodeNpy`、`labelComponents`、`initialLabeled`、`relabel`、`maskOf` |
| `src/volume/zip.ts` | `zipStore`（CRC32，store only） |
| `src/pages/Section3D/editor.ts` | `applyOp`／`replay`／`opText`／`sweepOps`（純函式）與 `useEditor`：splits、選取、z 範圍、commit／undo／redo、鍵盤 |
| `src/pages/Section3D/views.tsx` | `View3D`（three.js、射線點選、選取網格、剖開、小標籤）、`SliceView`（ImageData、十字、z 框） |
| `src/pages/Section3D/*.tsx` | Inspector、ChangesTab、SplitsTab、SplitBar、SweepModal、CompareView、StructureList、SettingsDrawer、UploadPanel、HelpDrawer、index（版面） |
| `src/ui/` | Swatch、StatTile、download、theme（antd 主題） |

面板不直接碰 Volume；所有改體素的路徑都經過 `useEditor` 的 `commit`，所以每一步都有 Op 記錄、都能復原、都能在別的 split 重播。

## 匯出

- 目前 split：`原檔__split名.npy`
- 全部：`原檔__splits.zip`，每個 split 一個 `.npy` ＋ `manifest.json`（source、shape、dtype、nmPerVoxel、每個 split 的檔名、改動體素數、ops 與白話描述）

```python
import json, zipfile, io, numpy as np
z = zipfile.ZipFile('tcad__splits.zip')
m = json.loads(z.read('manifest.json'))
arrs = {s['name']: np.load(io.BytesIO(z.read(s['file']))) for s in m['splits']}
```
