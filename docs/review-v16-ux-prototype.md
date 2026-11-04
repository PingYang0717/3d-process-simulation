# v16 UX 審查與 prototype（四個回報問題）

回報：1) 排版跑掉、一直出現 scroll bar；2) 2D 拖不出想要的形狀（方頭）；3) 右鍵／方向說明看不懂、XYZ 抽象；4) 3D 套用方頭整個卡住。
四個都成立，根因都在程式裡。本文記錄證據、改了什麼、量到什麼；量測腳本見 §5。

## 1. 排版：整頁捲軸

**根因**
- `.canvas-area` 是 `.stage`（直欄 flex）的子項，沒有 `min-height: 0`，flex 的 `min-height: auto` 讓它不能縮到比內容的 min-content 小；
  2D 編輯時它又是 `grid-template-rows: repeat(3, minmax(0, 1fr))`，`fr` 軌在容器高度不定時會撐到內容的 max-content，三格疊起來就超過可用高度。
- `html, body` 沒有 `overflow: hidden`，所以直接長出視窗捲軸。
- 右欄選到一個結構時一次疊五張完整卡片（長／縮、方頭／圓頭、移動、材質、缺陷），內容 2,142 px，右欄永遠在捲；和視窗捲軸疊在一起就是「兩條 scroll bar」。

**實測（Playwright，×3 範例）**

| 視窗 | 改前 document 高 / 視窗高 | 改後 |
|---|---|---|
| 1920×937 瀏覽 | 975 / 937（整頁捲軸） | 937 / 937 |
| 1536×730 瀏覽 | 751 / 730 | 730 / 730 |
| 1280×720 瀏覽 | 933 / 720 | 720 / 720 |
| 1920×937 進 2D 剖面 | 1176 / 937 | 937 / 937 |
| 1366×625 進 2D 剖面 | 861 / 625 | 625 / 625 |
| 右欄內容高（選 Si fin 3） | 2,142 px | 957 px |

**改動**：`styles.css`（`html, body { overflow: hidden }`、`.canvas-area { min-height: 0; overflow: hidden }`、`.slice-pane { overflow: hidden }`）；`Inspector.tsx` 操作卡片改成手風琴（一次只掛一張，預設開「長／縮」）。

## 2. 2D 拖不出方頭

**根因**（用 demoVolume 的 XY 切面跑真實的描邊／拖拉流程驗證）
- 範例 fin 頂部本來就削掉兩格角；拖拉只會把斜角拉長，不會變平。
- 推頂邊不會變成 `push`（整面平移）而是 `profile`：`gestures.ts` 只在邊跨滿整個外框寬度時才給 push；斜段被線性內插再 raster，2 階斜角變 4 階。
- Douglas-Peucker 簡化讓左右兩個對稱斜角得到不同的節點集：左上是「矩形角」、右上不是；預設自由形變關閉時右上根本抓不到。
- ghost 線畫的是平滑斜邊，raster 後的階梯只在 zoom ≥ 8 才疊出來：所見非所得。
- 真正能做出平頂的是「方頭」（level）操作，但 2D 右鍵選單拿不到面法線，所以 3D 有的「方頭」項目 2D 沒有；工具列卡片預設開在「圓頭」。

**改動**
- 2D 右鍵：離選取外框哪一條邊最近就當那一面（`index.tsx onSliceMenu`），選單多出「{那一面}長／縮…」「方頭（{那一面}補平）…」。
- 「方頭／圓頭」卡片預設開在方頭；右鍵「方頭」改成開卡片先預覽（之前是直接套用，和「先看再套用」原則相反）。
- 2D 拖拉本體（對稱節點、Shift 鎖軸、按兩下斜角＝方角、所見即所得 ghost、提示）見 `src/slice/*`、`SliceEditor.tsx` 的改動。

## 3. 方向與把手說明

**根因**
- 「前／後」和相機相反：體素 +z 叫「後」，但預設視角與「正視」的相機都在 +z 看向 −z，正對著你的那一面叫「後面」（`FacePicker.tsx` 的註解自己承認）。
- 「上」是 y 索引變小；角落 gizmo 的 y 箭頭指向下；卡片寫「頂面 y 90 → 89（長高 1 格）」數字變小卻叫長高。
- 同一個面有四套名字：頂面／y− 面／往上／頂部 Y／上。
- 把手顏色（橘箭頭、紫菱形、黃＝hover）和軸顏色無關，畫面上沒有圖例。
- 面選取小方塊是靜態等角圖、不跟相機；點選後 3D 不會持續標示那一面，只有 hover 才亮。
- 卡片描述是模板拼的，術語密（法線、最外側的表面、每一排補到、參照面＋偏移、厚的鄰居不吃）。

**改動**
- +z 改名「前」（朝向你）、−z「後」：`volume.ts DIRECTIONS`、`opWords.ts`、`FacePicker.tsx`（看得到的三面＝上、右、前）。
- 卡片開著時 3D 選取外框（與 2D 的那一條邊）**一直亮著要動的那一面**，滑過小方塊暫時換面、離開回到選的面（`OpCard.tsx useFaceHighlight`）。
- 卡片說明句前加小方塊圖示（`FaceGlyph`）：塗橘的那一面＋箭頭（往外、往內）或補平線，和 3D 亮面同色；文案改白話（「把頂面整面往外推 1 格（往上）；只動最外層表面，形狀不變」）。
- 3D 面把手照軸上色（x 紅、y 綠、z 藍，和 gizmo 一樣），畫面左上加圖例（箭頭＝整面長縮、菱形＝圓角、黃＝抓到的、顏色＝軸）。
- 說明抽屜補「右鍵點一下」「方向怎麼看」。

## 4. 套用方頭卡頓

**實測（×3 範例，選 Si fin 2，3D 把手模式按「套用方頭」）**

| | 主執行緒 long task | rAF 最大斷層 |
|---|---|---|
| 改前第一次 | 2,106 ms 立刻發生，之後 986 ms | 2,183 ms、1,183 ms |
| 改前第二次 | 零碎 60～200 ms | 250 ms |
| 改後第一次 | 見 §5 的 `apply3d-after.log` | |

CPU profile 把第一次的 2.5 s 全部指到 `own()`（`editor.ts`）：第一次在原始上改動會自動建立 Split 1，在 click handler 裡、任何 await 之前同步做
`data.slice()`（53 MB）＋`labels.slice()`（Int32，212 MB）＋`new Uint8Array` diff（53 MB）＝318 MB 的配置加複製；接著 `useSelMasks` 因 `vol.data` 身分變了全量重建 `maskOf`。

**改動**：載入完就在 idle 時分段先抄好這一份（每次 ≤ 6 ms），`own()` 直接拿；用掉再抄一份備著。
**還沒做**：單一 Worker 嚴格 FIFO（preview → fork → apply → chunks → layer）每步仍 1.5～5 s 沒有進度與取消；`changedCount` 對補丁多跑一次重複掃描；chunk 幾何一次全上 GPU。

## 5. 量測腳本（scratchpad，不在 repo）

- `audit.cjs`：各視窗尺寸的 document 溢出與 scroller 清單。
- `apply3d.cjs`：×3 套用方頭的 long task／rAF 斷層／evaluate 停頓。
- `prof.cjs`：CDP Profiler 看第一次套用的 self/total time。
- `visual.cjs`、`menu2d.cjs`：改後的截圖與 2D 右鍵 → 方頭流程。
