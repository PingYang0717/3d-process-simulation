# 計畫 v7.3：主畫面是 3D，切到 2D 剖面編輯；3D 雕刻可開關；每一步只算改到的地方

> 位置：`docs/plan-v7-2d-first.md`，分支 `claude/upbeat-einstein-wod16i`。
> 對應現況：plan v6／prototype v11 ＋ 已合併的「即時預覽」「筆刷關閉」「補平成方頭」（commit 65a5ffb）。
> 2D 編輯的操作形式參考 [process-simulation](https://github.com/PingYang0717/process-simulation)（PNG 剖面編輯器）。
> v7.2 → v7.3 的差別：**主畫面維持 3D**，要改的時候按「2D 編輯」切過去、Esc 回來（§5.1）；其餘不變。

---

## 目錄

0. 一句話
1. 名詞
2. 現況盤點（這份計畫從哪裡出發）
3. 目標、原則、不做的事
4. 使用情境（照著點一遍）
5. 介面規格
6. 互動：聰明游標的狀態與手勢
7. 範圍（Scope）、逐片規則、Op
8. 效能：每一步只處理改到的地方
9. 程式結構與每個檔案要改什麼
10. 演算法細節
11. 匯出格式
12. 測試清單
13. 里程碑、工作拆解、驗收腳本
14. 風險與對策
15. 已定案的預設與決策記錄

---

## 0. 一句話

打開來是 3D，用來看、選、轉；選到結構按「2D 編輯」，主畫面換成放大的切面，像改 PNG 一樣拖結構的剖面，每拖一下就立刻套用到你設定的那一段（預設整根），不對就復原，Esc 回 3D；3D 上直接雕刻是進階功能，要在設定裡打開；Worker 每一步只處理改到的那一塊，3D 只重畫碰到的 chunk，300×300×200 以上也能一步幾十毫秒。

## 1. 名詞

| 名詞 | 意思 |
| --- | --- |
| 體素（voxel） | 陣列裡的一格，值是材質編號（0 = 空氣，254 = VOID）。 |
| 結構 | 同材質、6 鄰接相連的一塊體素，例如「Si fin 1」。左欄清單列的就是它。 |
| 切面／片 | 沿某一軸取一層得到的 2D 圖。XY 正面＝沿 z 切，XZ 上視＝沿 y，YZ 側面＝沿 x。「第幾片」＝那一軸的索引。 |
| 剖面 | 一個結構在某一片上的形狀（可能是一塊、多塊、有洞）。 |
| 法線軸 | 切面垂直的那個軸。XY 正面的法線軸是 z。 |
| Scope | 「只有這個範圍裡的體素可以被改」：一個軸＋起止索引。取代現在的 zRange。 |
| Op | 一步操作的紀錄（push／translate／material／level／profile），可重播、可復原、寫進 manifest。 |
| 襯層（liner） | 貼在結構外面的薄層（HfO₂、TiN），厚度 ≤ LINER_MAX（4 格）。推面時跟著走。 |
| follow | 「襯層一起推」設定。 |
| backfill | 拿掉體素後填什麼：'orig'（原始陣列那一格）或指定材質。 |
| 補丁（patch） | 一步改動的外框＋外框內改前、改後的資料。 |
| chunk | 3D 網格切成的小方塊（32³ 或 64³），一步只重算碰到的。 |
| Split | 同一個原始模型的一種情境，各自記一串 Op。 |

## 2. 現況盤點（這份計畫從哪裡出發）

程式（`src/`）

| 檔案 | 現在做什麼 | 這份計畫會怎麼動它 |
| --- | --- | --- |
| `volume/volume.ts` | Volume、材質、範例、`growMask`／`levelMask`／`translateMask`／`setMaskMaterial`／`localMask`、greedy mesh、連通標記、`relabel` | 四個改體素函式改成共用一套核心（§7.2）；`translateMask` 加 follow；新增 chunk 版 greedy mesh |
| `volume/ops.ts` | `Op` 型別、`applyOp`、`replay`、`opText` | `zRange` → `scope`；新增 `profile`；`opText` 支援 profile |
| `volume/preview.ts` | 一步會動到的外框、外框內先算（本輪新增） | 外框計算搬到 Worker 共用（§8.2）；2D 單片即時用它的 2D 版 |
| `volume/worker.ts`、`client.ts` | Worker 常駐狀態、replay、mesh、diff、count；用陣列身分當 key | 版本號；`apply` 回補丁＋chunk；`undo`／`redo` 用補丁；chunk 網格快取 |
| `pages/Section3D/editor.ts` | `useEditor`：splits、選取、zRange、commit、undo、鍵盤 | scope 狀態；手勢→Op；排隊；版本號 |
| `pages/Section3D/views.tsx` | `View3D`（筆刷、剖面、即時預覽網格與挖洞）、`drawSlice`、`SliceView` | `View3D` 改 chunk Mesh；`SliceView` 升級成 `SliceEditor`（縮放、輪廓、手勢） |
| `pages/Section3D/index.tsx` | 版面、工具列、匯出、右鍵選單 | 「2D 編輯」進出與編輯狀態的版面；位置列；浮動工具列；3D 標籤 |
| `pages/Section3D/Inspector.tsx` | 尺寸、材質、要改哪裡、長高縮短、補平、移動 | 「要改哪裡」改成 Scope 控制；加節點／邊／區域的數值輸入 |
| `pages/Section3D/SettingsDrawer.tsx` | 襯層、回填、nm、標紅 | 加「在 3D 上雕刻」「選到結構自動放大」 |

測試：`volume.test.ts`、`v10.test.ts`、`v11.test.ts`、`preview.test.ts`，共 44 個，都是逐體素比對。

效能（×3 範例 5,300 萬 voxel，4 核心 headless Chromium）：長高一次含 relabel 5～7 s、重畫 3D 4.5 s；本輪的即時預覽讓畫面在 50～600 ms 內先變，但正式結果與體積帳仍要等。

操作：3D 上左鍵拖已選結構的面＝筆刷；右欄輸入整面長縮、移動、換材質、方頭；切面只能看與點選。

## 3. 目標、原則、不做的事

目標

- poly 補方頭、fin 加寬、spacer 變薄、recess 變深這類「剖面不變、沿一個軸拉長」的調整，在 2D 上一筆完成，可以打數字，做完立刻看到整段結果與哪裡被擋住。
- 3D 是看的：轉、縮、剖面、前後對照。3D 雕刻是進階功能，預設關閉。
- 1,800 萬 voxel（300×300×200）的檔案，一步從放開滑鼠到 3D 更新完成 < 200 ms；5,300 萬 < 500 ms。

不變的原則

- 沒碰到的體素一個都不變；每個操作直接改體素，不經過幾何近似。2D 多邊形只是「指定要改哪些格子」的工具，不是模型。
- 原始唯讀；**每一個手勢就是一個 Op**，立刻套用、可重播、可復原、寫進 manifest。沒有「先畫再按套用」的中間狀態。
- 輸出 shape／dtype／spacing／origin 與原始相同。

不做的事（明確排除）

- 不把結構轉成參數化幾何再重新體素化。
- 不做觸控（手機、平板）操作；觸控板要能用（§5.2 的平移與 Alt＋拖）。
- 不做多人同時編輯、不做伺服器端。
- 不改載入與第一次標記結構的流程（一次性，維持現狀）。
- 不自動判斷「哪些片屬於同一段」；範圍由使用者設，預設整根。

## 4. 使用情境（照著點一遍）

每個情境都寫「做什麼 → 看到什麼」，M2／M3 驗收時照這個走。

### 4.1 三根 fin 一起補方頭（最主要的情境）

1. 載入檔案。主畫面是 3D（和現在一樣），下面三張小切面。
2. 左欄點材質「Si fin」→ 三根 fin 都選到，3D 上三根整根藍色。按 3D 工具列的「2D 編輯」（或按 E）→ 主畫面換成 XY 正面的切面編輯器（fin 最長的方向是 z，所以自動選法線是 z 的 XY），3D 縮到右側小窗。主切面自動放大到三根 fin；位置列寫「套用到：整個結構（z 0～127）」。
3. 三根 fin 外框旁出現浮動工具列。按「方頭（整根）」。
4. 立刻：主切面三根 fin 的斜角填平；3D 與兩張小切面在 0.2 s 內跟上；右下訊息「Si fin ×3 方頭 · 已套用到整根（z 0～127）· 3 根共 2,304 格 · 復原」。右欄尺寸「高 H」標橘、顯示 +2。
5. 左下訊息如果有「4 片有 12 格被 Poly-Si 擋住 · 看這些片」，點它跳到第一片，被擋的格子標紅；再點跳下一片。
6. 按 Esc（或「回 3D」）：主畫面換回 3D，轉一圈看結果。選取、範圍都還在。
7. 匯出。manifest 裡這一步是一個 `level` Op，文字「Si fin ×3 補平到 y = 30（15.0 nm）」。

### 4.2 只在閘極之間把 fin 加寬 2 格

1. 選 Si fin 2。位置列範圍切到「自訂」，拖滑桿到 z 38～52（閘極 1 與 2 之間）；滑桿上有結構起止與三個閘極的刻度（以同一片上其他結構的 z 範圍當刻度）。
2. 游標靠近 fin 左邊，變雙箭頭；往左拖 2 格放開（拖的時候游標旁顯示「往左 2 vx（1.0 nm）· 連帶 0 層」）。
3. 這是一條和軸平行的整段邊，所以產生 `push`（dir 往左、n 2、scope z 38～52）。3D 上只有那一段變寬，其他片不動。
4. 再對右邊做一次。或者在右欄「往外推」填 2、方向「左右」一次做完。

### 4.3 spacer（TiN）在閘極側壁變薄 1 格

1. 切到 XZ 上視頁籤（頁籤上寫「上視 XZ · TiN 可改 z」）。選 TiN 1。
2. 位置列範圍「整個結構」（沿 y）。
3. 靠近閘極側壁那條邊，往內推 1 格。follow 關掉（這裡要的是變薄，不是帶著 poly 走）→ 狀態列「防穿層」。
4. 產生 `push`（dir 往 z 負向、n −1、scope y 整段）。

### 4.4 recess 深 3 格（削掉 fin 頂）

1. XY 正面選 Si fin 1，範圍自訂到要 recess 的 z 段。
2. 靠近頂邊，往下推 3。follow 開，HfO₂／TiN 跟著降。
3. 產生 `push`（dir 往下、n −3）。訊息「已套用到 z 40～80 · 復原」。

### 4.5 把一支閘極往左搬 2 格

1. XZ 上視選 Poly-Si 2（連同 SiN 2 一起選：Shift＋點）。
2. 游標放在 poly 裡面，四箭頭，往左拖 2 格。follow 開：HfO₂／TiN 殼一起搬。
3. 產生 `translate`（d [−2,0,0]、follow）。空出來的地方回填原始。

### 4.6 拖節點修圓角（profile）

1. XY 正面選 Si fin 1，8× 放大到頂角。
2. 靠近角上的節點，十字，拖到想要的位置。左右兩節點之間的輪廓跟著平滑變形。
3. 放開→ `profile`（add／remove 兩組格子，scope 整根）。訊息同上。這是唯一走新 Op 的手勢。

### 4.7 回頭檢查與匯出

- 按 B 看原始、D 看差異（和現在一樣）。「改動」頁籤列每一步，點一步選到那個結構。
- 任何時候 Ctrl+Z；一個手勢＝一步。
- 匯出 zip：每個 split 一個 `.vti` ＋ manifest.json（§11）。

## 5. 介面規格

### 5.1 版面：兩個狀態，預設是 3D

**看（預設，和現在一樣）**：主畫面 3D，下面三張小切面。3D 工具列多一顆「2D 編輯」按鈕（快捷鍵 E）；沒選取時按鈕是灰的，提示「先選一個結構」。

```
┌ 頂端列：檔名 · 尺寸 │ 上傳 │ 匯出 │ 設定 │ ? ───────────────────────────────┐
├ Split 列（現有）──────────────────────────────────────────────────────────┤
│ 左欄        │ 3D  已選 Si fin ×3   [2D 編輯 (E)] [長高][縮短][材質▾] [3D 雕刻：關] │ 右欄   │
│ 結構清單    │ ┌──────────────────────────────────────────────────────┐ │ 選取與 │
│             │ │  3D（轉、縮、剖面、前後對照；點一下選取）              │ │ 調整   │
│             │ └──────────────────────────────────────────────────────┘ │        │
│             │ [XY 正面 z=64]        [XZ 上視 y=48]        [YZ 側面 x=80]  │        │
└─────────────┴──────────────────────────────────────────────────────────┴────────┘
```

**編輯（按「2D 編輯」進入，Esc 或「回 3D」離開）**：主畫面換成切面編輯器，3D 和另外兩張切面縮成右側小窗。

```
├ Split 列 ─────────────────────────────────────────────────────────────────┤
│ 左欄        │ [回 3D (Esc)]  [XY 正面] [XZ 上視] [YZ 側面]   │ 小窗 1：3D  [3D 雕刻：關] │
│ 結構清單    │ 位置列：z = 64 ◀ ▶ [64] 32.0 nm │ 範圍：整個結構 (z 0～127) ▾ │ 小窗 2：XZ 上視  │
│             │ ┌──────────────────────────────────┐ │ 小窗 3：YZ 側面    │
│             │ │  主切面（可縮放、可拖輪廓）        │ │                    │
│             │ │  浮動工具列貼在選取外框旁          │ │ 右欄：選取與調整   │
│             │ │  左下：提示與拖動中狀態            │ │  尺寸 / 材質 /     │
│             │ │  右下：1:1 8× 適合 對準選取        │ │  範圍（同位置列）/ │
│             │ └──────────────────────────────────┘ │  數值調整          │
└─────────────┴──────────────────────────────────────┴────────────────────┘
```

進出的規則

- 進入時主切面的方向自動選：**已選結構最長的那一軸當法線**（fin 最長在 z → XY 正面；poly 最長在 x → YZ 側面，剖面就是高 × 閘極長度）。多選時取第一個。可以用頁籤改，改過的方向在這個 session 裡記住。
- 進入時主切面跳到十字所在的那一片；如果那一片沒有這個結構，跳到最近有的一片。自動放大到選取。
- 離開時選取、範圍、十字都保留；下次進入回到上次的方向與縮放。
- 每次載入新檔案都從 3D 開始（不記住「上次在 2D」）。
- 編輯狀態裡 3D 小窗照常可以轉、縮、點選（點選會換主切面的結構與片）。小窗上的「放大」會換回 3D 大，等於「回 3D」。
- 寬 < 1200：左欄變抽屜（現有）；小窗欄改成主畫面下方一排。
- 「並排比較」（CompareView）維持，兩個狀態都能開。

### 5.2 主切面（編輯狀態）

- 滾輪＝朝游標縮放（0.25×～32×）；右鍵拖或空白鍵＋左鍵拖＝平移；雙擊空白＝適合視窗。
- 換片：◀ ▶、位置列輸入框、`,` `.`、PgUp／PgDn、Ctrl＋滾輪。**編輯狀態裡滾輪不再換片**；看的狀態下方三張小切面維持現在的行為（滾輪換片）。
- 右下縮放列：1:1／8×／適合視窗／對準選取。設定「選到結構自動放大到它」預設開。
- 底圖：和現在 `drawSlice` 一樣（材質色、隱藏材質淡灰、選取混藍、差異描紅邊），上面疊 SVG 編輯層（輪廓、節點、框選、浮動工具列）。
- 橘色十字維持；十字位置和「第幾片」解耦（點切面設十字，不換片）。
- 這一片沒有已選結構：位置列顯示「這一片沒有 Si fin 1 · 跳到最近的一片（z = 14）」。
- 這一片不在範圍內：輪廓改灰色虛線，位置列顯示「這一片不在範圍內（z 40～80）」，拖動仍可（會套用到範圍，不會套到這一片）。

### 5.3 位置列

```
z = 64  ◀ ▶ [ 64 ]  32.0 nm   │   套用到： (●) 整個結構 (z 0～127)   ( ) 此片   ( ) 自訂 [====|-------|====]  z 40～80 · 41 片 · 20.5 nm   │   排隊 2 步
```

- 三個模式是一個 Segmented。自訂時出現雙把手滑桿，軌道上標：結構起止（藍）、同一片上其他結構的起止（淡灰刻度，游標滑過顯示名稱，例如 Poly-Si 1 z 14～38）。
- 模式記在 localStorage；自訂端點是絕對座標，換結構時夾到它的範圍裡。
- 右端顯示 Worker 排隊數（§7.6），沒有排隊時不顯示。

### 5.4 浮動工具列（選到結構時貼在外框右上）

| 按鈕 | 做什麼 | 產生的 Op |
| --- | --- | --- |
| 方頭（整根／此片／z a～b）▾ | 沿選的方向（預設上）每一欄補到最外側 | `level`（radius null） |
| 往外推… | 開小窗：方向（上下左右／已選邊的法線）、格數（負＝往內）、nm 即時換算 | `push` |
| 移動… | 開小窗：Δ 兩軸 | `translate` |
| 材質 ▾ | 換材質 | `material` |
| 設為 VOID | | `material` |
| 對應 ●／○ | 多選時，是否同步改長得一樣的結構（§7.7） | — |

按鈕文字帶範圍詞，範圍改了文字跟著改。

### 5.5 右欄「選取與調整」

- 尺寸（現有）。
- 材質（現有）。
- **範圍**：和位置列同一個控制（同一個 React 元件、同一個狀態）。
- **數值調整**：
  - 選到結構：長高／縮短（現有 PushRow，改吃 scope）、往外推、方頭、移動（現有）。
  - 選到節點：X、Y 輸入（Enter 套用）、「回到原位」。
  - 選到邊：長度（唯讀）、往外推 N、Shift 單段。
  - 所有輸入和拖拉產生完全相同的 Op。

### 5.6 設定抽屜新增

- 在 3D 上雕刻（進階）：開關，預設關。說明文字「關著時 3D 上怎麼拖都只轉視角；打開後已選結構的面上左鍵拖＝筆刷」。
- 選到結構時自動放大到它：預設開。
- 大操作確認門檻：預設 400 萬格（進階，可調）。

### 5.7 訊息文字（固定格式）

- 成功：`{結構} {動作} · 已套用到{範圍詞}（{軸} {lo}～{hi}）· {格數} 格 · 復原`
  例：「Si fin 1 頂邊往外 3 vx · 已套用到整根（z 0～127）· 1,152 格 · 復原」
- 有被擋：上一行之後加 `· {n} 片有 {m} 格被 {材質} 擋住 · 看這些片`
- 跳過：`· {n} 片沒有這個結構，略過`
- 大操作：對話框「這一步會改到約 {N} 萬格（整個 {結構}），可能要幾秒。繼續？」
- 排隊：位置列「排隊 {n} 步」；超過 3 步時新手勢被拒，訊息「還在算前面的步驟，請稍等」。

### 5.8 快捷鍵（完整表，含解掉的衝突）

| 鍵 | 主切面 | 3D |
| --- | --- | --- |
| 滾輪 | 縮放 | 縮放 |
| Ctrl＋滾輪、`,` `.`、PgUp／PgDn | 換片 | 剖面前後一片（現有） |
| 右鍵拖、空白＋左鍵拖 | 平移 | 右鍵拖平移 |
| 左鍵拖 | 依游標位置：拖節點／推邊／搬區域／框選 | 轉視角（3D 雕刻開著且在已選面上＝筆刷） |
| 中鍵拖、Alt＋左鍵拖 | 平移 | 轉視角 |
| 方向鍵 | 選到節點／邊：推 1 格（Shift 10）；只選結構：整塊移動 1 格 | 整塊移動 1 格（現有） |
| Shift＋拖 | 節點：只動這一點；邊：只推單一小段 | — |
| V／E／R（按住） | 只抓節點／邊／區域 | — |
| Delete | 刪除節點（只是不再當把手，形狀不變） | — |
| 雙擊邊 | 新增節點 | 繞那點轉（現有） |
| E | 回 3D | 進入 2D 編輯（要有選取） |
| Esc | 拖到一半＝取消；否則先清把手，再回 3D（選取保留） | 現有（先關選單，再清選取） |
| B／D、F／H／1～4、[ ]、Ctrl+Z／Y／A、? | 現有 | 現有 |

## 6. 互動：聰明游標的狀態與手勢

### 6.1 狀態機

```
idle ──游標移動──▶ hover(kind ∈ {node, edge, region, none})
hover ──左鍵按下──▶ pressed(kind, start)
pressed ──移動 < 4 px 放開──▶ click：node/edge → 選把手；region → 選結構（Shift 加選、Ctrl 切換）；none → 清把手（再一次清選取）
pressed ──移動 ≥ 4 px──▶ dragging(kind)
dragging ──移動──▶ 算這一片的新形狀 → 即時畫（§7.5 第 1 級）→ 若外框×範圍 ≤ 40 萬格，也更新 3D 與小切面
dragging ──放開──▶ 轉成 Op（§6.3）→ commit → idle
dragging ──Esc──▶ 丟掉 → idle
```

- 熱區（螢幕像素，不隨縮放變）：節點 8 px、邊 6 px；優先順序節點 > 邊 > 區域。按住 V／E／R 只看一種。
- 節點只在已選結構上顯示；角畫方塊、其他圓點；按住 V 顯示全部輪廓點。
- 拖動中游標旁顯示：節點「(x, y)」；邊「往{方向} {n} vx（{nm}）· 連帶 {k} 層」或「已擋住」；區域「Δx Δy」。
- 第一次使用：選到結構後左下角三行「靠近點可以拖 · 靠近邊可以推 · 在裡面可以搬」，成功放開一次後寫 localStorage 不再顯示。

### 6.2 拖動規則

- 節點：它與左右節點之間的輪廓依 cos 衰減跟著走（參考專案 `falloffWeights`）；Shift 只動這一點。
- 邊：從按到的小段沿環往兩側走到「角」為止（`smoothEdgeGroup`，角＝夾角 ≥ 50°），整段沿平滑後的法線推；兩端的角是錨點；Shift 只推單一小段。
- 區域：整個剖面（含內環）在平面上位移；多選時每個結構各自位移。
- 連帶襯層（follow 開）：貼在外面、厚度 ≤ 4 格、厚度變化 ≤ 1 格的薄層跟著位移，最多 3 層。
- 防穿層（follow 關）：位移逐步縮小到與鄰居至少留 1 格。
- 所有頂點夾在切面範圍內、取整數格。

### 6.3 手勢 → Op

| 手勢結果 | 判斷 | Op |
| --- | --- | --- |
| 推了一條邊，而且這條邊整段和軸平行、位移整數 n | 邊的所有頂點同一軸座標相同，位移只有一軸 | `push {dir, n, scope}` |
| 搬了整個剖面，位移整數 (dx, dy) | 區域拖動 | `translate {d, scope, follow}` |
| 按了方頭 | — | `level {dir, to, local:{radius:null}, scope, follow}` |
| 其他（節點、斜邊、圓弧、部分邊、Shift 單段） | — | `profile {add, remove, scope, at, follow, backfill}` |

同一個手勢在多選時，對應開著就對每個結構各做一次（§7.7），合成一個 Op（keys 多個）。

## 7. 範圍（Scope）、逐片規則、Op

### 7.1 Scope

```ts
export interface Scope { axis: Axis; lo: number; hi: number }  // 含端點
```

- 取代所有 Op 的 `zRange`。意義不變＝「只有 scope 裡的體素可以被改」（推面時新格子落在 scope 外就不寫）。
- 舊 Op 讀進來（重播、manifest）：`zRange: [a, b]` → `scope: {axis:'z', lo:a, hi:b}`。
- 一個狀態（`useEditor` 裡的 `scope` + `scopeMode`），兩處顯示。
- 模式：整個結構（預設；選取改變時重算）、此片、自訂。scope 的軸＝目前主切面的法線軸；切頁籤時軸跟著換、模式不變。

### 7.2 四條逐片規則＝一套核心

新增 `volume/kernel.ts`，所有改體素的函式都呼叫它；規則只寫一次：

```ts
/** 在一片（或一條線）上，把 cells 變成 mat。回傳 {filled, pushed, blocked}。 */
addCells(vol, out, cells: {i: number; dir: Vec3}[], mat, follow, scopeTest): Report
/** 拿掉 cells（只拿屬於 mask 的），回填；follow 時外側薄層跟退。 */
removeCells(vol, orig, out, cells: {i: number; dir: Vec3}[], mask, backfill, follow, scopeTest): Report
/** 搬 mask ∩ scope 到 +d；follow 時殼一起搬。 */
moveCells(vol, orig, out, mask, d, backfill, follow, scopeTest): Report
```

1. **加**：空氣 → 填；薄襯層且 follow → 沿 dir 把襯層整列推開再填（`collectLiners`）；厚的別的材質 → 不動，blocked++。
2. **拿**：只拿 mask 裡的；回填 backfill；follow 時外側薄層沿 dir 退一格、最外面回填（本輪 `levelMask` 削平的做法）。
3. **搬**：follow 時殼（每個邊界格沿外法線 `collectLiners` 收到的格子）一起搬；落點覆蓋，空出回填。`translateMask` 改成呼叫它；3D 的「整塊移動」與 2D 區域拖動結果一致。
4. **只加不減、連在一起才填**：沒畫到的不動；add 依「離原本邊界的距離」由近到遠處理，必須與這一片已有的結構 4 鄰接才填；這一片沒有這個結構就整片 skipped。

`growMask`／`levelMask`／`translateMask` 改寫成「找出要加／拿／搬的格子 → 呼叫核心」，行為與現在逐體素相同（現有 44 個測試守住）。

### 7.3 `profile` Op

```ts
| {
    kind: 'profile';
    keys: string[];
    scope: Scope;                 // axis = 切面法線軸
    at: number;                   // 參考片
    add: Rle2D;                   // 相對選取外框的 2D RLE；每段帶方向碼 0～3
    remove: Rle2D;
    follow: boolean;
    backfill: Backfill;
    text?: string;                // 「頂角節點往外 2 vx」之類，由手勢產生
  }

interface Rle2D { x0: number; y0: number; w: number; h: number; runs: Int32Array /* [row, start, len, dir]... */ }
```

- 套用：對 scope 裡每一片，把 add／remove 的格子轉成該片的索引，呼叫核心；每個結構各自算（keys 多個時 add／remove 是每個 key 一份：`perKey: Record<string, {add, remove}>`）。
- `opText`：「Si fin 1（XY，z 0～127）{text}」。

### 7.4 報告

```ts
interface SliceReport { at: number; filled: number; pushed: number; blocked: number; skipped: boolean; blockedBy: Record<number, number> }
interface OpReport { slices: SliceReport[]; total: {filled, pushed, blocked, skippedSlices} }
```

Worker 回傳；訊息用 total，「看這些片」用 slices 裡 blocked > 0 的；被擋的格子位置另外回傳一個小 mask（外框內）給切面標紅。

### 7.5 即時回饋三級

1. 正在改的主切面：拖動中每一步只對這一片跑核心（< 1 ms），畫面就是結果。
2. 3D 與兩張小切面：外框 × 範圍 ≤ 40 萬格時走現有 `previewOp` 路徑即時；超過就放開後更新。
3. 放開後送 Worker；M1 後 < 200 ms 成為正式結果，正式網格到了就收掉預覽。

### 7.6 大操作與排隊

- scope ∩ 選取外框的體素 > 門檻（預設 400 萬）→ 先問。
- Worker 忙碌時手勢進 FIFO（最多 3），位置列顯示「排隊 n 步」；排隊中只有主切面即時。超過 3 拒絕並提示。
- 排隊中按 Ctrl+Z：先清掉佇列，再復原已完成的那一步。

### 7.7 對應到長得一樣的結構

- 多選時，在一個結構上做的手勢，對其他結構找對應的節點／邊（座標正規化到各自外框的 [0,1]²，節點門檻 0.12、邊門檻 0.2，允許方向相反）。
- 保險：只對同材質、外框長寬比相差 ≤ 20%、面積相差 ≤ 30% 的結構配對；配不到的結構不動並在訊息裡說「Si fin 3 找不到對應的邊，未改」。
- 浮動工具列的「對應」可關；設定裡可改預設。

### 7.8 相對式套用（M4）

Op 多存 `gesture: {kind:'edge'|'node', ref: 正規化座標, delta}`；每片先描自己的輪廓、用 §7.7 找同一條邊重做，對不到的片退回 add／remove 並在報告標出。只影響 `profile`。

## 8. 效能：每一步只處理改到的地方

### 8.1 先做：版本號取代陣列身分

- `EditState` 加 `version: number`（全域單調遞增，載入時 1）。
- `client.ts` 的 `sidOf(data)` → `sidOf(version)`；`ensure`／`retain` 用 version；`editor.ts` 的 `diffCache`／`countCache` 改以 version 為 key；`views.tsx` 的網格快取 key 用 version。
- 這一步不改任何行為；先合併、全部測試過，再做 8.2。

### 8.2 Op 只在外框裡算

- Worker `apply(from: version, op) → {to: version, patch: {bbox, after}, labelsPatch, comps, report, chunks: ChunkMesh[]}`。
- 外框＝`previewBox`（搬到 `volume/scope.ts` 共用）；只在外框裡跑核心；`relabel` 直接吃外框，跳過全陣列掃描。
- 主執行緒：目前陣列 memcpy 一份（18 MB 幾毫秒）、貼上 patch → 新版本；切面與點選用它。

### 8.3 復原存補丁

- `Split.hist` 存 `{version, bbox, before, after, ops}`；復原＝memcpy＋貼 before（主執行緒與 Worker 各做一次，Worker 用 `undo(version)`／`redo(version)`）。
- `HISTORY_LIMIT` 10 → 50。

### 8.4 3D 網格切 chunk

- chunk 大小：陣列 ≤ 3,000 萬用 32³，否則 64³。
- Worker：`chunkMesh(version, cx, cy, cz)`；每個 split 的目前版本保留全部 chunk 的網格（快取 LRU 3 個 split）。一步之後只重算與 patch.bbox 外擴 1 格相交的 chunk，和 patch 一起回傳。
- 主執行緒：`Map<chunkKey, Mesh>`，每個 Mesh 一個 BVH；空 chunk 不建；raycast 對全部 Mesh（three-mesh-bvh 很快）。
- 隱藏、改色、差異模式：全部 chunk 重算（不在編輯迴圈裡）。
- 選取層、空洞層：維持外框內 mesh（已是區域性）。

### 8.5 diff 與體積帳用差量

- Worker 每個 split 版本保留 diff mask 與 counts；apply 時只在外框裡更新。

### 8.6 目標與量法

| 檔案 | 現在：套用＋relabel | 現在：重畫 3D | 目標：放開到 3D 更新完 |
| --- | --- | --- | --- |
| 160×96×128（197 萬） | 0.3～0.5 s | 0.3 s | < 50 ms |
| 300×300×200（1,800 萬） | 2～3 s | 1.5 s | < 200 ms |
| 480×288×384（5,300 萬） | 5～7 s | 4.5 s | < 500 ms |

量法：`scripts/bench.ts`（把本輪 `dist/bench.ts` 收進 repo）跑 Worker 核心；端到端用 Playwright 腳本（本輪 `smoke.cjs` 收進 `scripts/e2e/`）量「放開 → `.mesh-busy` 消失」。

## 9. 程式結構與每個檔案要改什麼

新增

| 檔案 | 內容 |
| --- | --- |
| `src/volume/scope.ts` | `Scope`、`scopeOf(structure, axis)`、`inScope`、`previewBox`（從 preview.ts 搬來） |
| `src/volume/kernel.ts` | `addCells`／`removeCells`／`moveCells`、`Report` |
| `src/volume/profile.ts` | `Rle2D` 編解碼、`applyProfile(state, orig, op) → {vol, report}` |
| `src/volume/patch.ts` | `Patch`、`applyPatch`、`invert` |
| `src/volume/chunks.ts` | chunk 切法、`greedyMeshChunk`、`chunksTouching(bbox)` |
| `src/slice/trace.ts` | `traceRings(labels, slice, keyIndex) → Ring[]`（含內環）、`simplify`、`isCorner`、`nodesOf` |
| `src/slice/raster.ts` | 編輯後的環 → 這一片的格子（沿用原始輪廓）、`deltaOf(before, after) → {add, remove}`（帶方向碼） |
| `src/slice/gestures.ts` | 狀態機、熱區、`smoothEdgeGroup`、`falloffWeights`、連帶／防穿層、手勢→Op |
| `src/slice/mirror.ts` | `counterparts` 與保險條件 |
| `src/pages/Section3D/SliceEditor.tsx` | 主切面：縮放平移、底圖、SVG 編輯層、浮動工具列、右鍵選單、提示 |
| `src/pages/Section3D/PositionBar.tsx` | 位置列與範圍控制（右欄共用同一個元件） |
| `src/pages/Section3D/FloatingToolbar.tsx` | §5.4 |
| `scripts/bench.ts`、`scripts/e2e/*.cjs` | 效能與操作腳本 |

修改

| 檔案 | 改什麼 |
| --- | --- |
| `volume/ops.ts` | `zRange` → `scope`（含轉換）；`profile`；`opText` |
| `volume/volume.ts` | 三個改體素函式改呼叫核心；`translateMask` follow；`LINER_MAX` 共用 |
| `volume/worker.ts` | `apply`／`undo`／`redo`／`chunkMesh`；版本號；diff／counts 差量；回報告 |
| `volume/client.ts` | 版本號；新請求的型別 |
| `pages/Section3D/editor.ts` | `scope`／`scopeMode`；把手選取（節點／邊）；手勢→Op；排隊；補丁式 hist；大操作確認 |
| `pages/Section3D/views.tsx` | `View3D` 改 chunk Mesh；保留剖面、差異、預覽；`SliceView` 拆成底圖元件給 `SliceEditor` 用 |
| `pages/Section3D/index.tsx` | 版面；頁籤；位置列；3D 標籤；訊息格式 |
| `pages/Section3D/Inspector.tsx` | 範圍改用 PositionBar 元件；節點／邊數值輸入 |
| `pages/Section3D/SettingsDrawer.tsx` | 三個新設定 |
| `pages/Section3D/HelpDrawer.tsx`、`README.md` | 文件 |
| `ui/persist.ts` | 新 key：`editAxis`（上次用的切面方向）、`scopeMode`、`sculpt3d`、`autoZoom`、`hintsSeen` |

## 10. 演算法細節

### 10.1 描輪廓（`slice/trace.ts`）

1. 取這一片的 labels 子陣列，`inside(i) = labels[i] 屬於已選結構`。
2. 邊界鏈：走每個格子的四條邊，`inside` 兩側不同的邊收起來，接成封閉鏈；外環逆時針、內環順時針（用面積正負判斷）。
3. 每條鏈 Douglas-Peucker（0.6 px，端點固定；封閉鏈先在最遠點切兩段）。每個簡化後的段記下原始像素點列。
4. 節點：鏈兩端 ＋ `isCorner`（前後各走 6 px、夾角 ≥ 50°）。
5. 輸出 `Ring { pts: XY[]; raw: XY[][]; nodes: Set<number>; hole: boolean }`。

### 10.2 編輯後的環 → 格子（`slice/raster.ts`）

- 每段：兩端位移相同且整數 → 原始點列整體平移；兩端位移不同 → 沿原始點列長度內插位移；新插的段 → 直線。
- 掃描線以像素中心判定內外（偶奇規則，內環自動挖空），不反鋸齒。
- `deltaOf`：`after && !before` → add；`before && !after` → remove。方向碼：該格最近的那一段的外法線取最接近的軸向（上／下／左／右）。
- 整個剖面整數位移時直接搬格子（不走多邊形），結果和 `translate` 一致。

### 10.3 逐片套用順序（`volume/profile.ts`）

```
for each slice t in scope:
  if 這一片沒有任何 key 的體素: skipped; continue
  remove 先、add 後（先削再補，避免先補的格子馬上被削）
  add 依 BFS 距離（從這一片原本的結構邊界起算）由近到遠處理；處理到的格子要 4 鄰接「已是結構」的格子才填
  呼叫核心；累計報告
```

### 10.4 殼（搬動時跟著走的襯層）

- 對結構每個邊界格，沿它朝外的四個軸向各 `collectLiners`（遇空氣、同材質或厚 > 4 格停）；收到的格子聯集＝殼。
- 搬動：先清（回填）結構與殼，再寫入結構與殼到新位置（殼後寫、結構先寫，結構蓋殼）。

### 10.5 對應（`slice/mirror.ts`）

- 節點：正規化座標距離 < 0.12 的最近者。邊：兩端點正規化距離和 < 0.2，允許反向。
- 配對前先過保險（材質、長寬比 ≤ 20%、面積 ≤ 30%）。

### 10.6 chunk 要重算哪些

- `chunksTouching(bbox 外擴 1)`；跨 chunk 面：每個 chunk 都看鄰居一層（codes 取自整個陣列，不當空氣），所以 chunk 邊界不會多出內部牆。

### 10.7 補丁

- `Patch { bbox, before: Uint8Array, after: Uint8Array }`；`labels` 另有一份同外框的 Int32 補丁（relabel 只改外框內與被重算的結構）。注意 relabel 可能改外框外體素的 label 編號（結構編號壓緊），所以 labels 補丁的外框＝被重算結構的外框聯集 S（`relabel` 已有）。

## 11. 匯出格式

manifest.json 每個 split 的 `ops[]` 項目：

```json
{ "kind": "push", "keys": ["c3"], "scope": {"axis": "z", "lo": 0, "hi": 127}, "dir": [0,-1,0], "n": 3, "follow": true, "backfill": "orig",
  "text": "Si fin 1 往上長 3 vx（1.5 nm）" }
{ "kind": "profile", "keys": ["c3"], "scope": {"axis": "z", "lo": 0, "hi": 127}, "at": 64,
  "add": {"x0": 34, "y0": 28, "w": 12, "h": 4, "runs": [0,0,2,0, 0,10,2,0, 1,0,1,0, 1,11,1,0]},
  "remove": {"x0": 34, "y0": 28, "w": 12, "h": 4, "runs": []},
  "follow": true, "backfill": "orig",
  "text": "Si fin 1（XY，z 0～127）頂角節點往外 2 vx",
  "report": {"filled": 1152, "pushed": 384, "blocked": 0, "skippedSlices": 0} }
```

- `zRange` 不再輸出；舊 manifest 讀進來（未來若做匯入）用 §7.1 的轉換。
- `report` 是結果摘要，重播時忽略。

## 12. 測試清單

M0

- `scope.test.ts`：zRange → scope 轉換後，v10／v11／preview 的所有案例重播逐體素相同。

M1

- `kernel.test.ts`：加／拿／搬三條規則各自的小案例（空氣、薄襯層、厚材質、scope 邊界、連通）；改寫後的 `growMask`／`levelMask`／`translateMask` 和改寫前（保留一份舊實作當對照）逐體素相同。
- `patch.test.ts`：apply 後的 patch 貼回 before ＝ 原狀態；貼 after ＝ 新狀態；labels 補丁同理。
- `chunks.test.ts`：所有 chunk 面積和＝全陣列 greedy mesh 面積和；一步後只重算 `chunksTouching` 回傳的 chunk，結果與全部重算相同。
- `worker.test.ts`：版本號快取命中行為與改造前相同（用 mock 計數 `put`／`mesh` 次數）。

M2

- `trace.test.ts`：方柱、圓頂、有洞（VOID 缺陷）、兩塊（U 形）各自描得出正確環數與節點數；沒動的環重新光柵化逐格相同。
- `raster.test.ts`：節點拖動後只有變動段的格子改變；方向碼正確；整數位移走搬格子且和 translate 相同。
- `profile.test.ts`：範例 fin 1 在 XY 推頂邊 3 → 產生 `push` 且與 3D 長高 3 相同；拖節點 → `profile`，閘極底下襯層被推、blocked = 0；削頂 2 格襯層跟降；搬動帶殼；一片沒有結構 skipped；不連通不填；報告數字。
- `queue.test.ts`：忙碌時手勢排隊不丟；Ctrl+Z 先清佇列。

M3

- `mirror.test.ts`：三根 fin 配對成功；poly 與 fin 不配對；配不到時其他結構不動。
- e2e（Playwright）：§13 的驗收腳本。

## 13. 里程碑、工作拆解、驗收腳本

順序固定 **M0 → M1 → M2 → M3 → M4**，M1 是 M2 的前置。規模用 S／M／L（S ≈ 1～2 天、M ≈ 3～5 天、L ≈ 1～2 週，單人，含測試；只是量級）。

### M0 版面與開關（總量 M）

- [x] S　Scope 型別、zRange 轉換、所有 Op 與 UI 改用 scope（先只接現有工具）
- [x] S　「2D 編輯」進出（按鈕、E／Esc、自動選方向與片、保留選取與範圍）、編輯狀態的版面、X／Y／Z 頁籤
- [x] S　主切面滾輪縮放、平移、換片改鍵、縮放列、自動放大到選取
- [x] S　「在 3D 上雕刻」開關、3D 標籤、關著時 brush 視為 off
- [x] S　位置列（先只有第幾片與範圍三模式）

狀態：已完成（`scripts/e2e/m0.cjs` 驗收腳本全過；`scope.test.ts` 5 個案例＋原有 44 個測試全過）。「大操作確認門檻」設定留到 M2 和確認對話框一起做。

驗收：載入後主畫面是 3D；選 fin 1 按 E 進入 XY 正面、Esc 回 3D 且選取還在；選 Poly-Si 1 按 E 進入 YZ 側面。開關關著時 3D 上怎麼拖都只轉視角；開著時與現在相同。現有 44 個測試 ＋ scope 測試過。

### M1 Worker 區域性運算與 chunk 網格（總量 L）

- [x] S　8.1 版本號（單獨 PR，不改行為）：`EditState.version`、`client.ts` 以版本號當 sid、diff／count／網格快取改用版本號；`worker.test.ts`
- [x] M　7.2 核心 ＋ 三個函式改寫（對照舊實作的測試）：`kernel.ts`、`ref/legacy.ts`、`kernel.test.ts`；translate 多了帶殼（follow）
- [x] M　8.2 `apply` 只在外框裡算、回補丁、relabel 吃外框：`apply.ts`、`patch.ts`、`relabelFast`（只重 flood fill 掉了體素的結構，其他用 union-find）
- [x] S　8.3 補丁式復原、HISTORY_LIMIT 50（Worker `derive`）
- [x] M　8.4 chunk 網格（Worker 快取、主執行緒多 Mesh、BVH、raycast）：`chunks.ts`、Worker `chunks`；另外 3D 改成有變化才重畫
- [x] S　8.5 diff／counts 差量
- [x] S　`scripts/bench.ts`、`scripts/e2e/perf.cjs`（量測結果見 README「大陣列的效能」）

狀態：工作項目都完成，§12 M1 測試（kernel／patch(apply)／chunks／worker）全過。速度目標在雲端容器沒有達到：Worker 核心 ×2（1,570 萬）約 200～250 ms，端到端受 headless 軟體 WebGL 拖累約 1.1～1.6 s（數字見 README）。排隊（§7.6）也在這一輪做了。

驗收：300×300×200 上長高 1 格放開到 3D 更新完 < 200 ms（e2e 量）；復原 10 步記憶體不隨陣列大小成長（Chrome 記憶體面板）；§12 M1 測試全過。

### M2 2D 編輯核心（總量 L）

- [x] M　trace（含內環、多環）、節點、SVG 編輯層
- [x] M　手勢狀態機、三種拖法、連帶／防穿層、Shift／V／E／R
- [x] S　raster 與 delta
- [x] M　`profile` Op、逐片套用、報告、被擋標紅與「看這些片」
- [x] S　手勢→Op 對應表（push／translate／level 優先）
- [x] S　三級即時回饋
- [x] S　大操作確認、排隊
- [x] S　範圍四項提示（位置列文字、3D 藍色、訊息、按鈕文字；按鈕文字在 M3 浮動工具列）

狀態：完成。`scripts/e2e/m2.cjs` 全部步驟通過（方頭在範例上改 1,650 格，不是 768；其他照腳本）；`trace.test.ts`、`profile.test.ts`。排隊沒有另寫單元測試，由 m2.cjs 第 7 步驗。連帶襯層由核心規則處理（follow），防穿層＝follow 關時被厚材質擋住、訊息說被擋幾格。

驗收腳本（Playwright，範例 ×1）：

1. 選 Si fin 1 → 方頭（整根）→ 改動 768 格、blocked 0；與右欄「補平成方頭」結果逐體素相同（匯出 .npy 比對）。
2. 範圍自訂 z 40～52 → 方頭 → 只有這段改，閘極底下不變。
3. 推 fin 1 頂邊往外 3 → 改動清單顯示 push；與 3D 長高 3 相同。
4. 削 fin 1 頂邊往內 2（follow 開）→ 在 XY 切面上 HfO₂、TiN 緊貼新的頂面，沒有空氣或回填夾層。
5. 搬 fin 1 往右 2（follow 開）→ 殼跟著；原位是原始內容。
6. 切到 z = 7（沒有 poly）選 Poly-Si 1 → 位置列顯示「這一片沒有 Poly-Si 1 · 跳到 z = 14」。
7. 連按三次手勢在 Worker 忙時 → 三步都套用、順序正確。

### M3 友善化（總量 M）

- [x] S　浮動工具列、右鍵選單
- [x] S　右欄節點／邊／區域數值輸入（與拖拉等價）
- [x] S　第一次使用提示、頁籤各方向尺寸提示
- [x] M　對應到長得一樣的結構（含保險）
- [x] S　說明、README、訊息文字統一

狀態：完成。`scripts/e2e/m3.cjs` 全過（三步補方頭、拖邊與右欄數值得到同一個 Op、對應三根一起改、右鍵選單）；`mirror.test.ts`。區域（整個結構）的數值輸入沿用右欄原本的長高／方頭／移動。

驗收：第一次用的人照左下角提示三步內完成「三根 fin 一起補方頭」；不用滑鼠用右欄數值做到同一件事並得到相同 Op（改動清單比對）。

### M4 相對式套用（總量 M，可選）

- [x] M　gesture 欄位、每片重描與重做、退回與報告：`ProfileOp.gestures`、`slice/relative.ts`、報告 `fallback`

狀態：完成（`relative.test.ts`：每片多的格數相同、blocked 0、沒有退回；對照絕對座標時偏移段不同；故意對不到時全部退回並回報）。manifest 裡每個 Op 另附 `report`（填／推／被擋／略過／改動格數），重播時忽略。

驗收：人工做一條在 z 方向偏移 1 格的 fin，`profile` 推斜邊往外 3 掃過整根，每片都剛好多 3 格、blocked 0。

## 14. 風險與對策

| 風險 | 對策 |
| --- | --- |
| 8.1 版本號牽一髮動全身 | 單獨 PR、不改行為、全部測試過再動 8.2 |
| chunk 多時 draw call 多（18M／32³ ≈ 550） | 空 chunk 不建；量過再定 32³ 或 64³；必要時同材質合併 draw range |
| 聰明游標在小結構上抓錯 | 自動放大到選取；固定優先順序；V／E／R |
| 預設整根讓人改錯範圍 | 四項提示是驗收條件；復原永遠在訊息上 |
| 兩套規則結果不一致 | 一套核心；手勢盡量對到舊 Op；互相對照的測試 |
| M1 之前先做 M2 會很難用 | 順序固定 |
| relabel 改到外框外的 label 編號 | labels 補丁用 S 外框（10.7） |
| 參考專案的程式碼直接搬會帶進 PNG 專用假設（顏色、px） | 只搬演算法（trace、simplify、isCorner、smoothEdgeGroup、falloff、counterparts、exact raster），資料型別重寫 |

## 15. 已定案的預設與決策記錄

預設

0. 主畫面是 3D；「2D 編輯」要按才進去，Esc 回來；每次載入都從 3D 開始。
1. 進入 2D 編輯時的切面方向＝已選結構最長那一軸的法線切面（fin → XY 正面、poly → YZ 側面），可用頁籤改。
2. 範圍預設「整個結構」。
3. 對應到相同結構預設開。
4. 拿掉的格子回填原始內容。
5. 3D 雕刻開關在設定裡，3D 小窗標題有標籤直達。
6. 選到結構自動放大預設開。

決策記錄

| 日期 | 決定 | 理由 |
| --- | --- | --- |
| v7.0 | 2D 為主、3D 只看 | 結構是剖面拉長的；剖面上可打數字 |
| v7.1 | 拿掉「套用」鈕，每個手勢立刻套用 | 和全 app「一步一 Op、靠復原」一致，不會不知道有沒有生效 |
| v7.1 | Scope 取代 zRange | 兩個範圍控制會打架；三個軸都要能用 |
| v7.1 | 方頭用 `level` 不用 `profile` | 每欄各自補到頂是相對做法，偏移也對 |
| v7.1 | M1 先於 M2 | 立刻套用整根要夠快；現在忙碌時手勢會被丟 |
| v7.1 | 版本號取代陣列身分 | 補丁式更新後陣列身分不再可靠 |
| v7.2 | 整段軸向邊→push、搬動→translate | 能用舊 Op 就用，規則一套、測試一套 |
| v7.3 | 主畫面維持 3D，按「2D 編輯」才切到切面編輯器 | 使用者要求；3D 是看與選的地方，2D 是改的地方，進出要一鍵 |
