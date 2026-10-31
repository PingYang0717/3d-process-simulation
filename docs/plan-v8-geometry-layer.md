# 計畫 v8：2D 編輯改成持久幾何層——實作紀錄

> 計畫本文：[計畫 v8：2D 編輯改成持久幾何層](https://claude.ai/artifact/RVpk8vWcmmSuuFPHGNqZwr)（2026-10-31）。
> 分支 `claude/upbeat-einstein-wod16i`，接在 plan v7.3 M0～M4 之後。這份只記實作的對應、和計畫不同的地方與量測。

## 一句話

進入 2D 編輯時把已選結構的剖面描一次成有頂點 id 的幾何（`SliceModel`），拖節點、推邊、搬區域都改這份幾何；
拖的時候 ghost 跟手（浮點）、旁邊同時標出放開後的格子，放開才取整、用原本的 rasterize → deltaOf → profile Op 寫回 voxel；
寫回後不重描，只驗證「幾何光柵化 === voxel」。voxel 仍是唯一真相，對不上一律以 voxel 為準重描（節點 id 保留）。

## 里程碑對應

| 里程碑 | 內容 | 檔案 | 驗收 |
| --- | --- | --- | --- |
| M5 | profile 的緊外框（§7.7） | `src/volume/preview.ts`（`profileBox`、`linerReach`） | `preview.test.ts`：五種手勢在有／無襯層的結構上，緊外框內與 `applyOp` 逐體素相同、外框外零改動 |
| M5 | 把手用 id（§5.1） | `SliceEditor.tsx`、`handleOps.ts`（`PickedHandle.vid`） | 併在 M7 做（幾何層的頂點 id），沒有另做暫時版 |
| M6 | 浮點 ghost、放開才吸附（§7.2、§5.2） | `src/slice/snap.ts`（`dragDispFloat`、`dragDisp`、`snapAmount`）、`SliceEditor.tsx`（rAF、ghost 用 ref 寫 SVG） | `m5.cjs`：32× 每步 0.3 格，ghost 變了 10 次、座標有小數；放開後這一片的格子和放開前第二層逐格相同 |
| M6 | 設定「拖拉吸附」「輪廓顯示」（§5.4） | `editor.ts`（`snapMode`、`outlineStyle`，存 localStorage）、`SettingsDrawer.tsx` | — |
| M7 | 幾何層 | `src/slice/model.ts`、`model.test.ts` | 黃金測試：剛建立的幾何 ≡ v7 `traceRings`，所有把手的 Op 逐欄相同；連拖三次 id 不變、座標累加；被擋住→重描後幾何 === voxel、拖的節點 id 還在 |
| M7 | 主輪廓畫幾何線、≥ 8× 疊階梯、只畫節點、V 顯示全部、加刪節點走幾何層 | `SliceEditor.tsx` | `m5.cjs` |
| M7 | 數值輸入、方向鍵、浮動工具列走同一份幾何 | `handleOps.ts`（`modelContext`、`commitGesture`、`resolveHandle`）、`Inspector.tsx`、`FloatingToolbar.tsx` | `m5.cjs`：右欄 y − 2 和拖拉產生完全相同的 Op；`m3.cjs` 仍過 |
| M8 | 切面分層 canvas（預覽層只重畫那一塊） | `SlicePreviewLayer.tsx` | — |
| M8 | 超過即時預覽上限時 3D 畫加／拿格子的點雲 | `cellCloud.ts`、`views.tsx`（`Points`） | `perf.cjs`：×2 拖節點時 3D 小窗有即時變化 |
| M8 | 量法 | `scripts/bench.ts drag`、`scripts/e2e/perf.cjs` 拖拉段 | 見下 |

## 和計畫不同的地方

- **Op 多一個可選欄位 `refExact`**（`ProfileOp`）。profile Op 的相對式套用（v7 M4）在參考片也會「重描 voxel 再重做手勢」；
  幾何層持久之後，參考片重描出來的輪廓和幾何不一樣，第二次拖同一個節點時參考片會差幾格（「看到的≠commit 的」）。
  所以幾何改過的結構，Op 加 `refExact: true`：參考片用 Op 裡的絕對 add／remove，其他片照舊相對式。
  剛描好的幾何不加（Op 與 v7 逐欄相同，黃金測試）；舊 manifest 沒有這一欄，重播不變。`profile.ts` 只改了這一行判斷。
- **緊外框沒有降到 5 萬格以下**：相對式手勢每一片要描整個剖面才找得到同一個把手，所以切面上至少要包結構本身的外框
  （×1 的 fin 是 12×40，乘 128 片就 6 萬）。省下的是四周固定的 17 格（改成這一段實際的襯層要讀到的格數）：
  拖 fin 1 節點從 453,376 格降到 188,800 格，進得了 40 萬格的即時預覽上限。
- **驗證失敗（§7.5）的 a、b 兩種都走「重描＋舊節點 ≤ 1.5 格對應、id 沿用」**，沒有做「只重描受影響的那一段」的 realign。
  訊息一律「幾何已對齊到實際結果」，對不到的節點與自訂節點數量另外說。
- **復原用「每個版本一份幾何快照」**（`ModelStore` 裡依版本號存），沒有把快照塞進 `editor.ts` 的 hist：
  復原／重做回到某個版本時直接還原那時的幾何；沒有快照（換 split、3D 那邊改了這片）就驗證、對不上再重描。
  效果相同（Ctrl+Z 到底節點回到原位，`m5.cjs`）。
- **加／刪節點不進 Ctrl+Z**（它們不改體素，不是一步）；換片、換方向後再回來還在（幾何層 LRU 8 片）。
- **「對應」（多選）時只有拖的那個結構的幾何立刻更新**，其他結構等 Worker 回來驗證，對不上就重描（id 保留）。
- **點雲用 `THREE.Points`（一格一點）而不是一格一個方塊**：headless 軟體繪圖下 InstancedMesh 方塊每幀 ~190 ms。
- **小切面（`SliceView`）仍用 `drawSlice` 畫預覽**；只有主切面拆成底圖＋預覽層。
- e2e 驗收腳本命名 `scripts/e2e/m5.cjs`（計畫寫的檔名），內容涵蓋 M6／M7 的驗收項目。
  驗收的三次拖拉改成「往上 2」：往右上拖會把整條右邊連到底角一起斜過去，推進 fin 底部的 STI 而被擋住（那是 §4.3 的情境，幾何會對齊、新角會變節點）。

## 量測（雲端容器、headless Chromium 軟體繪圖、`npm run dev`）

| 項目 | v7 | v8 |
| --- | --- | --- |
| 拖 fin 1 節點的 profile 外框（×1） | 453,376 格（> 40 萬，拖拉中 3D 不動） | 188,800 格（3D 即時預覽） |
| 拖拉每幀主執行緒計算（`bench.ts drag`，×1／×2／×3 中位數） | — | 1.2／3.7／5.6 ms（目標 ×2 < 8 ms） |
| ×2 拖節點 60 步（`perf.cjs`） | 12.3 s、long task 135、3D 不動 | 14.8 s、long task 165、3D 點雲即時 |

×2 的 long task ≤ 2（§8.4 驗收）在這個環境量不到：開發版 React 每幀重 render 整頁、加上 headless 的軟體 WebGL，
v7 本來就是 135 個。拖拉的計算本身（幾何、snap、光柵化、單片預覽）每幀 3.7 ms；要在有 GPU 的瀏覽器、正式打包上再量一次。
