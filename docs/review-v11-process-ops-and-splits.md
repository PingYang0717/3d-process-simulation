# 盤點 v11：操作要有製程意義、系統要為「撒 split」而設計

> 位置：`docs/review-v11-process-ops-and-splits.md`，分支 `claude/upbeat-einstein-wod16i`。
> 對應現況：plan v10 完成後（commit 8efe3d7）。這份是盤點與建議，不是實作計畫；每一條都寫「現況 → 問題 → 建議 → 動到哪裡」。

---

## 0. 一句話

現在的系統是一個很完整的「體素雕刻器」，但使用者要的是「製程變異產生器」：他腦中想的是「L<sub>g</sub> 16／18／20 nm」「via 偏移 0／2／4 nm」「HfO₂ 1.5 → 2.0 nm」，系統存的卻是「push +1／+2／+3 vx」。兩個層面的改善都從這個落差出發：

1. **操作層**：把工具收斂成「製程上真的會發生的變化」，缺的補、會畫出非物理形狀的收起來，並加一層物理檢查。
2. **split 層**：把 split 從「操作歷史」升級成「實驗變數的水平組合」，讓產生、命名、比較、匯出都圍繞變數而不是步驟。

---

## 1. 操作層：現有工具對應到什麼製程意義

| 現有工具 | 對應的製程變異 | 物理上成立？ | 備註 |
| --- | --- | --- | --- |
| 長／縮（push，一次一面） | CMP 餘量、沉積厚度、蝕刻深度、單側 CD 偏差 | 成立 | 對稱 CD 偏差要做兩次（左 +1、右 +1），sweep 時尤其麻煩 |
| 整塊移動（translate，可帶殼） | 對位偏移（overlay）：via、閘極、接觸孔 | 成立 | 帶殼＝barrier／襯層一起偏，正確 |
| 方頭（level） | CMP 平坦化、recess 到固定高度 | 成立 | 只能給絕對座標，不能說「比 fin 頂低 3 nm」 |
| 圓頭（round：角、r、ru／rv、n、凹角） | fin 頂角圓化、poly corner rounding、footing（內圓角）、斜切（n=1） | 成立 | 這是目前最接近「參數化製程形狀」的工具，n 與 ru／rv 的設計很好 |
| 換材質（material） | 製造 VOID、材質替換 | 部分 | 允許任何材質換任何材質（fin 換成 TiN 也行），沒有合理性檢查 |
| 襯層跟推（follow） | 保形層跟著下層走 | 成立 | 3D 推面是 overwrite，會穿過厚材質（見 §1.3） |
| 2D 推邊（profile：整段軸向邊） | 等同 push | 成立 | |
| 2D 拖斜邊 | 側壁角度 | 成立 | 但沒有角度數字，只能用滑鼠拉，每片重做靠相對式套用 |
| 2D 拖節點：矩形角 | 等同兩面 push | 成立 | |
| 2D 拖節點：單點、自由衰減 | 無 | **不成立** | 可以拉出尖角、星形、任意多邊形 |
| 筆刷局部長／縮（圓／方） | 局部 loading、局部 recess | 勉強 | 在平面上戳一個圓形凸起不是任何一道製程的結果 |
| 筆刷局部方頭 | 局部 CMP／recess | 勉強 | 同上 |

### 1.1 缺的（依製程前段到後段）

優先級：P0＝撒 split 一定會用到、P1＝常見實驗、P2＝進階。

| # | 缺的操作 | 製程意義 | 現在怎麼湊 | 建議 | 優 |
| --- | --- | --- | --- | --- | --- |
| A1 | **對稱 CD 偏差**（寬度 ±n，兩側各 n/2） | 曝光／蝕刻 CD bias，L<sub>g</sub>、fin 寬、via CD、金屬線寬，前後段都是第一變數 | push 左 1 次＋push 右 1 次 | 新 Op `cd`：`{keys, axis, delta, anchor:'center'|'left'|'right'}`，內部展開成兩個 push；FacePicker 加「兩側」選項；sweep 可掃 | P0 |
| A2 | **保形層厚度**（沿所有法線膨脹／收縮） | ALD 厚度：HfO₂、TiN 功函數層、spacer、barrier、seed；電性最敏感的變數之一 | 選 HfO₂ 推一面只推一面，包著 fin 的殼推不出來 | 新 Op `dilate`：`{keys, n, follow}`，每一格沿 6 鄰（或 26 鄰）外擴 n 格，外面的襯層推開、厚的擋住；縮＝erode。kernel 的「加」規則可以直接用，只是方向是每格自己的法線 | P0 |
| A3 | **側壁角度**（taper、footing、notching） | 蝕刻非等向性；閘極、via、fin 的側壁 | 2D 拖斜邊、每片相對式重做 | 新 Op `taper`：`{keys, face, angle 或 topDelta/bottomDelta, anchor:'top'|'bottom'}`，每一列依高度線性加／減；footing＝只在底部 k 格外擴（round 的內圓角已經很接近，可以共用） | P1 |
| A4 | **相對 recess**（以另一個結構為基準） | STI recess＝fin 露出高度、gate recess、contact recess、via under-etch 留多厚 | level 給絕對座標，使用者自己算 | level 卡片加「相對於：{結構} 的 {頂／底} ± n」，存成 Op 時展開成絕對值但記下參照（重播時仍是絕對值，逐體素不變） | P1 |
| A5 | **缺陷注入**（在結構裡放一個 void／顆粒） | bamboo void、銅填充 void、顆粒缺陷、pinhole；撒缺陷 split 的核心 | 筆刷戳一個洞再換材質 VOID，或搬現成的 VOID | 新 Op `defect`：`{inKey, shape:'slab'|'sphere'|'box', center(相對結構外框的 0～1 座標), size, mat:VOID 或任一}`；用相對座標所以同一個定義能套到別的 split／別的結構 | P0 |
| A6 | **沒蝕穿／殘留**（via 底、contact 底留一層） | under-etch，直接開路 | push 底面 −n、backfill 指定介電 | 不用新 Op，但 backfill 要能在卡片上直接選材質（現在在設定裡），並在 A4 的相對 recess 裡當一個預設 | P1 |
| A7 | **線邊緣粗糙度 LER／LWR** | 統計型變異，可靠度與 Vt 分布 | 無 | 新 Op `roughen`：`{keys, face, amplitude, correlationLength, seed}`，沿軸向產生帶相關長度的隨機偏移；seed 存進 Op 所以可重播 | P2 |
| A8 | **CMP dishing／erosion** | 寬金屬線中央下凹、密集區整體變薄 | 筆刷局部方頭近似 | level 加 `profile:'flat'|'dish'`，dish 用拋物線深度；P2 | P2 |
| A9 | **Epi S/D 的 facet 形狀** | {111} 面的菱形磊晶 | round n=1 斜切勉強 | round 已覆蓋大半；加一個「菱形」預設（四角都斜切、ru≠rv）就夠 | P2 |

不在範圍（材質標籤模型做不到，不建議做）：摻雜濃度、應力、熱預算、晶界。

### 1.2 多餘或應該收起來的

| # | 現況 | 為什麼 | 建議 |
| --- | --- | --- | --- |
| B1 | 2D 節點「自由衰減」「單點」拖法 | 能拉出非物理形狀；plan v7 的決策記錄也寫它是「舊版的預設」 | 預設只留「矩形角」與「斜邊」；自由衰減移到設定的「進階：自由形變」開關底下，開了才出現，並在 Op 的白話描述標「自由形變」 |
| B2 | 筆刷局部長／縮當成一個與 3D 把手平級的頁籤 | 製程上沒有「在面上戳一個圓凸起」 | 降級成缺陷注入（A5）的實作細節，或留在進階開關底下 |
| B3 | 3D 推面 policy=overwrite | 會無聲地吃掉 fin、STI；2D 卻是 block，同一個動作兩種結果 | 統一預設 block；卡片上加「允許穿過其他材質」勾選（預設關），勾了才 overwrite，描述裡要寫出來 |
| B4 | 換材質可以換成任何材質 | fin 換 TiN、STI 換 Poly 沒有製程意義 | 清單只列「合理目標」：VOID、同類材質（介電↔介電、金屬↔金屬）、原始材質；其他放在「全部…」底下並警告 |
| B5 | 同一個操作有五個入口（右欄卡片、上方工具列、浮動列、右鍵、3D 把手、2D 把手） | 功能沒錯，但學習成本高；使用者分不清哪個是「正式」的 | 以「製程操作卡片」為唯一主入口，其餘都是開同一張卡片的捷徑（現在已經是同一張 OpCard，差在說明與導引） |
| B6 | SplitsTab 的 H／W 表 | 和 CompareView 的卡片腳重複，而且只有外框尺寸 | 併入 §2 的實驗矩陣表 |

### 1.3 物理檢查（lint）

每一步之後、每個 split 匯出前都跑，結果顯示在訊息列、ChangesTab 的警告區、以及 §2 的矩陣表上。全部都是 O(改動外框) 的檢查，可以在 Worker 的 `apply` 回補丁時一起算。

| 檢查 | 怎麼算 | 嚴重度 |
| --- | --- | --- |
| **禁止相鄰**：Poly／金屬閘直接碰到 fin、Cu 直接碰到 low-k、金屬直接碰到矽（無 silicide） | 一張材質相鄰規則表（manifest 可覆寫）；在補丁外框裡掃 6 鄰 | 錯誤 |
| **保形層破洞**：HfO₂／TiN／barrier 在某處厚度 0 | 對被標為 liner 的材質，沿結構法線量厚度，出現 0 就報 | 錯誤 |
| **保形層厚度不均**：同一層最薄與最厚差 > 1 格 | 同上，報最薄／最厚位置 | 警告 |
| **懸空**：結構沒有和任何非空氣結構相連 | 連通標記已經有，加一個「碰到的鄰居材質集合」 | 錯誤 |
| **切斷／合併／消失**：ChangesTab 已有 | 現有 | 警告 |
| **最小尺寸**：某結構某軸 < 使用者設定的下限（例如 fin 寬 < 4 nm） | bbox 已有 | 警告 |
| **穿層**：這一步 overwrite 了厚材質 | Report 已經有 blocked／pushed，加 overwritten 計數 | 警告 |

---

## 2. split 層：從「操作歷史」改成「實驗變數」

### 2.1 現況

- Split = 名字 + Op 清單；SweepModal 只能掃 push／translate 的一串數值；名字是「Poly-Si 2 往上長 +2nm」這種相對量。
- 比較：CompareView 每個 split 一張同位置切面、紅框＝和**原始**不同；SplitsTab 列選到結構的 H／W。沒有 split 對 split、沒有全部 split 疊在一起看。
- manifest：每個 split 有 ops 與白話文字，沒有「這個 split 的變數值是多少」的欄位，下游要自己 parse 文字。

### 2.2 問題（使用者的話）

1. 「我想要 L<sub>g</sub> 16／18／20，不是 +1／+2／+3。」相對量看不出絕對值，兩個人做出來的 split 名字一樣、實際尺寸不同。
2. 「圓角半徑 2／4／6 nm 要一個一個做。」round、level、liner 厚度都不能掃。
3. 「L<sub>g</sub> × 偏移 的 3×3 要手動做 9 個。」沒有多變數矩陣。
4. 「split 3 和 split 4 差在哪？」只能各自對原始比，差異在 1～2 格時卡片上根本看不到。
5. 「全部 split 都要加同一個 void。」沒有「套用到所有 split」。
6. 「匯出後我要一張表：split 名、L<sub>g</sub>、偏移、改動體素、有沒有警告。」沒有。

### 2.3 建議的資料模型

```ts
/** 一個實驗變數：對哪些結構做哪個操作、參數名、單位、標稱值。 */
interface Factor {
  id: string;
  name: string;              // 「L_g」「via 偏移 x」「HfO₂ 厚度」
  keys: string[];            // 結構
  op: 'cd' | 'push' | 'translate' | 'level' | 'round' | 'dilate' | 'taper' | 'defect' | 'material';
  param: string;             // 這個 Op 裡哪個欄位是變數（n、d[0]、r、to…）
  template: Partial<Op>;     // 其他固定欄位（方向、scope、follow、backfill…）
  unit: 'nm' | 'vx' | 'deg';
  nominal: number;           // 標稱（從原始量出來或使用者填）
}

/** split 多帶一份「它是哪些水平的組合」；ops 照舊，仍是重播的唯一真相。 */
interface Split {
  /* 既有欄位不變 */
  levels?: Record<string /* factorId */, number>;  // {Lg: 18, offset: 2}
  tags?: string[];           // 「baseline」「defect」「DOE-1」
  lint?: LintResult;         // 最近一次物理檢查
}
```

Op 不變、重播不變、manifest 相容；只是多了一層「為什麼有這個 split」的標註。從 Factor + levels 產生 Op 的函式是純函式（放 `volume/ops.ts` 旁的 `volume/factors.ts`），sweep 就是「一個 factor、一串水平」的特例，矩陣就是「多個 factor 的笛卡兒積」。

### 2.4 建議的介面

**產生（取代 SweepModal）：「實驗設計」面板**

1. 變數清單：每個變數一列，「結構 · 操作 · 參數 · 單位 · 標稱 · 水平（逗號分開）」。新增變數時先選結構，操作清單只列對那種材質合理的（§1.2 B4 的同一張表）。
2. 水平輸入支援 `16, 18, 20`、`±2 step 1`、`nominal ±10%`；顯示絕對值與相對值兩欄（「18 nm（−2 nm）」）。
3. 組合方式：單變數掃描（每個變數各自掃，其他維持標稱）／全因子矩陣／手動勾選組合。即時顯示會產生幾個 split、每個的名字與預估改動體素。
4. 命名樣板：`{factor}={value}{unit}`，多變數用 `_` 連，例如 `Lg=18nm_off=2nm`；可改。
5. 「從哪裡開始」保留：原始／接在目前 split 之後／**套用到所有現有 split**（第 5 題）。
6. 產生前對每個組合跑 lint，會出錯的先標出來（例如偏移 6 nm 會讓 via 掉出 M1）。

**比較：三種看法，同一個差異引擎**

| 看法 | 用途 | 怎麼做 |
| --- | --- | --- |
| **疊圖**（新） | 一眼看 5 個 split 的輪廓差在哪 | 同一張切面上，每個 split 用一種顏色描選到結構的輪廓（trace.ts 已經有描輪廓）；原始黑色粗線。自動縮放到「所有 split 差異的聯集外框」 |
| **A vs B**（新） | split 3 和 split 4 差在哪 | CompareView 的基準從「原始」改成可選（原始／任一 split）；差異 mask 用 Worker 既有 diff 算兩個版本 |
| 並排（現有） | 整體檢視 | 保留，但卡片預設放大到差異外框，不是整片；腳註從 H／W 改成「這個 split 的變數值」 |

**矩陣表（取代 SplitsTab）**

列＝split，欄＝每個變數的水平（絕對值＋相對值）、使用者定義的量測、改動體素、lint 結果、tags。點一列切過去、點一欄排序、可匯出 CSV（和 manifest 同一份資料）。

**量測（新，讓「差異」有數字）**

使用者定義 2～3 個量尺，每個 split 自動算，進矩陣表與 manifest：

- 兩個面的距離（例如 poly 底到 fin 頂＝有效 recess）
- 某保形層在某結構周圍的最小／平均厚度
- 兩個結構的接觸面積（via 底 ∩ M1 頂，單位 nm²）
- 某結構的截面積（在某一片）

這些都是 mask 上的局部運算，Worker 的 `layer`／`count` 路徑可以直接算。

### 2.5 manifest 要加的

```json
{
  "factors": [{ "id": "Lg", "name": "L_g", "keys": ["c12"], "op": "cd", "unit": "nm", "nominal": 20 }],
  "baseline": "original",
  "splits": [{
    "name": "Lg=18nm_off=2nm",
    "file": "...",
    "levels": { "Lg": 18, "off": 2 },
    "tags": ["DOE-1"],
    "measures": { "poly_to_fin_nm": 1.5, "via_contact_nm2": 310 },
    "lint": { "errors": 0, "warnings": 1, "items": ["HfO₂ 最薄 1 格"] },
    "changedVoxels": 10368,
    "ops": [ "...照舊..." ]
  }]
}
```

下游 Python 一行 `pd.DataFrame([{**s['levels'], **s['measures'], 'file': s['file']} for s in m['splits']])` 就是實驗表。

---

## 3. 建議的順序

| 階段 | 做什麼 | 動到 | 為什麼先 |
| --- | --- | --- | --- |
| M1 | Factor／levels 資料模型；實驗設計面板支援 push／translate／level／round 四種既有 Op 的單變數掃描與全因子矩陣；名字樣板；manifest 加 factors／levels | `volume/factors.ts`（新）、`editor.ts` 的 `addSweep` → `addDesign`、`SweepModal.tsx` 重寫、`index.tsx` manifest | 不加任何新 Op 就能解決 §2.2 的 1、2、3、6 |
| M2 | 疊圖比較、A vs B 基準、並排卡片自動放大到差異外框、矩陣表 | `CompareView.tsx`、`SplitsTab.tsx`、Worker 加「兩版本 diff」 | 解決第 4 題 |
| M3 | 新 Op：`cd`（A1）、`dilate`（A2）、`defect`（A5）；都進實驗設計面板可掃 | `ops.ts`、`kernel.ts`（dilate 的每格法線）、`OpCard.tsx`、`opWords.ts` | 撒 split 最常用的三個變數 |
| M4 | 物理 lint（§1.3）＋ 收斂（B1～B4：自由衰減進階化、3D 推面預設 block、材質清單限制） | `volume/lint.ts`（新）、`ChangesTab.tsx`、`SettingsDrawer.tsx`、`OpCard.tsx` | 讓產出的 split 可信 |
| M5 | `taper`（A3）、相對 recess（A4）、量測器（§2.4）、套用到所有 split | 同上 | |
| M6 | `roughen`（A7）、dishing（A8） | | 進階 |

每一階段都維持既有原則：Op 是唯一真相、重播逐體素相同、原始唯讀、沒碰到的體素不變。
