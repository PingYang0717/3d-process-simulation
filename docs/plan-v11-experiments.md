# 計畫 v11：為撒 split 而設計——實驗變數、比較、製程操作、收斂

> 位置：`docs/plan-v11-experiments.md`，分支 `claude/upbeat-einstein-wod16i`，接在 plan v10 之後。
> 出發點：`docs/review-v11-process-ops-and-splits.md` 的盤點，加上 2026-10-31 與使用者確認的決定（§9）。
> 範圍：M0 檔案格式（PointData 多材質比例＋FieldData，2026-10-31 追加）、M1 實驗變數模型與「實驗」頁籤、M2 比較（疊圖、A vs B、矩陣表）、M3 新操作（對稱 CD、保形層 dilate、缺陷注入、側壁 taper、相對 recess）、M4 收斂（3D 推面預設 block、自由形變進階化、材質清單、筆刷降級）。**物理 lint 這一輪不做。**

---

## 目錄

0. 一句話
1. 問題總表
2. 目標與驗收方式
3. 原則、不做的事
4. 設計
   - 4.0 檔案格式：PointData 多材質比例＋FieldData 材質表
   - 4.1 實驗變數（Factor）與水平（level）：資料模型
   - 4.2 「實驗」頁籤：定義變數 → 組合 → 產生
   - 4.3 命名、變數 id、範本
   - 4.4 比較：疊圖、A vs B、矩陣表
   - 4.5 新操作 `cd`：對稱 CD 偏差
   - 4.6 新操作 `dilate`：保形層加厚／減薄
   - 4.7 新操作 `defect`：缺陷注入
   - 4.8 新操作 `taper`：側壁斜度
   - 4.9 `level` 加相對參照：相對 recess
   - 4.10 收斂：block 預設、自由形變、材質清單、筆刷
   - 4.11 manifest
5. 每個檔案要改什麼
6. 測試清單
7. 里程碑、工作拆解、驗收
8. 風險與對策
9. 決策記錄

---

## 0. 一句話

使用者定義「變數」（哪個結構、哪個操作、哪個參數、標稱多少），填幾個「水平」，系統算出笛卡兒積或逐一掃描、照樣板命名、每個組合產生一個 split；矩陣表一列一個 split、一欄一個變數，疊圖把所有 split 的輪廓畫在同一張切面上；同時補上對稱 CD、保形層厚度、缺陷、側壁斜度、相對 recess 五個製程上真正會掃的操作，並把會畫出非物理形狀的工具收到進階開關後面。Op 仍是唯一真相，重播逐體素不變。

## 1. 問題總表

| # | 問題 | 現況 | 本計畫 |
| --- | --- | --- | --- |
| P0 | 真實檔案是 PointData 裡每個材質一個比例陣列（`material_1`、`material_2`…）＋FieldData 材質表；現在只挑一個陣列當編號、FieldData 不讀、匯出寫單一 UInt8 CellData | 真實檔案載入錯、匯出下游讀不回 | §4.0 argmax 載入、FieldData 命名、同格式匯出 |
| P1 | 使用者想的是「L<sub>g</sub> 16／18／20」，系統只有「+1／+2／+3」 | SweepModal 只收相對值，名字是相對量 | §4.1 Factor 有 nominal，水平可填絕對或相對，兩欄都顯示 |
| P2 | 圓角半徑、recess 深度、襯層厚度不能掃 | `sweepOps` 只有 push／translate | §4.2 所有可參數化的 Op 都能當變數 |
| P3 | 兩變數矩陣要手動做 9 個 | 無 | §4.2 單變數掃描／全因子／手動勾選 |
| P4 | split 3 和 split 4 差在哪看不出來 | CompareView 只對原始、整片顯示 | §4.4 疊圖、A vs B、自動放大到差異外框 |
| P5 | 全部 split 都要加同一個 void | 只有「接在目前 split 之後」 | §4.2「套用到所有現有 split」 |
| P6 | 匯出後沒有實驗表 | manifest 只有 ops 文字 | §4.4 矩陣表＋CSV、§4.11 manifest 加 factors／levels |
| P7 | 對稱 CD 要推兩次 | 一次一面 | §4.5 `cd` |
| P8 | HfO₂／TiN／spacer／barrier 厚度改不了 | 選襯層推一面只推一面 | §4.6 `dilate` |
| P9 | 放一個 void 要筆刷戳洞再換材質 | 無 | §4.7 `defect` |
| P10 | 側壁角度只能 2D 拉斜邊 | 無數字 | §4.8 `taper` |
| P11 | recess 要自己算絕對座標 | level 只收絕對 | §4.9 相對參照 |
| P12 | 3D 推面無聲穿過 fin／STI，2D 卻被擋 | growMask overwrite、profile block | §4.10 預設 block |
| P13 | 自由衰減／單點可以拉出星形 | 預設可用 | §4.10 進階開關 |
| P14 | fin 可以換成 TiN | 材質清單全列 | §4.10 合理目標在前、其他收起 |
| P15 | 筆刷和 3D 把手平級 | 編輯工具列四個頁籤 | §4.10 進階開關 |

## 2. 目標與驗收方式

- 範例檔：定義「L<sub>g</sub>」（Poly-Si 2 沿 z 的 `cd`，標稱 24 格＝12 nm）與「偏移」（Poly-Si 2 沿 z 的 `translate`），水平各 3 個，全因子 → 9 個 split，名字 `Lg=11nm_off=+1nm` 這種，矩陣表 9 列 2 欄，CSV 與 manifest 的 levels 一致；每個 split 的 ops 重播逐體素相同（`v12.test.ts`）。
- 疊圖：9 個 split 在同一張 XY 切面上 9 條不同色輪廓，自動放大到差異外框；點圖例可關掉某條。A vs B：基準選 split 3 時 split 4 的紅框只在差 1 格的地方。
- `cd` +2：左右各 +1，體積與「左 +1 再右 +1」逐體素相同。`dilate` +1 對 HfO₂ 1：殼外多一層、TiN 被推開、fin 不動、角落是圓的（距離 ≤ 1 的格子）；`dilate` −1 再 +1 不等於原樣（會丟角），測試只驗厚度與被擋。`defect`：Poly-Si 3 中心放 20×1×30 的 VOID，只改 poly 內的格子。`taper` 頂 −1 底 +2：每一片的位移等於線性插值取整。相對 recess：「STI 1 頂面相對 Si fin 1 頂 +6」算出的 `to` 等於 fin 頂 + 6。
- 3D 推面預設 block：範例 Poly-Si 2 往下長 5，被擋 > 0、STI 體積不變；勾「允許穿過」後和 v10 相同。舊 manifest 的 push（沒有 policy）重播和 v10 逐位元組相同。
- 自由形變關閉時：2D 節點只剩矩形角、Alt／Shift 不生效；打開後和 v10 相同。
- 效能：產生 9 個 split（×1）< 5 s；疊圖描 9 條輪廓 < 50 ms／片；矩陣表 50 個 split 不卡。

## 3. 原則、不做的事

不變的原則：Op 是唯一真相、重播逐體素相同、原始唯讀、沒碰到的體素不變、所有改體素的路徑走 kernel。

Factor／levels 是**標註**，不是第二份真相：刪掉 factors 欄位，split 的 ops 仍然完整可重播。

不做：物理 lint（下一輪）、量測器（下一輪）、LER、dishing、多人、伺服器端。

## 4. 設計

### 4.0 檔案格式：PointData 多材質比例＋FieldData 材質表

使用者的真實 `.vti`（2026-10-31 口述，沒有範例檔；格式細節照 VTK 慣例假設，§8 有對策）：

- `PointData` 裡每個材質一個單分量陣列，名稱像 `material_1`、`material_2`…，值是這一點屬於那個材質的**比例**（0～1）。
- `FieldData` 裡有材質表：材質代碼、材質名稱、顏色。

**載入（取代「挑一個陣列當編號」）**

1. 收集 `PointData` 裡名稱符合 `/^material[_ ]?(\d+)$/i` 的所有單分量陣列；編號＝名稱裡的數字（或 FieldData 代碼表對得上的那個代碼）。一個都沒有 → 退回現在的邏輯（單一編號陣列）。
2. 每一點取**比例最大**的材質（argmax）；平手取編號小的；全部為 0 → Air（0）。只有一個比例陣列時以 ≥ 0.5 判定。比例是 0／1 時結果就是「哪個陣列是 1」。
3. 點數＝Extent 每軸加一，每個點當一格（現有的 PointData 分支已經這樣）。Spacing／Origin 照舊。
4. `FieldData`：讀代碼（整數陣列）、名稱（`String` 陣列，或 `UInt8` 以 0 結尾的字串）、顏色（三分量 0～255 或 0～1，或十六進位字串）。對得上代碼的材質用它的名字與顏色；對不上的仍叫「材質 n」。manifest 的 `materials` 多記 `source: 'FieldData' | 'auto'`。
5. 原始檔案的 bytes 留著（`File`／`ArrayBuffer` 本來就在記憶體），**不**把每個比例陣列解碼後常駐：4,000 萬點 × 8 個 Float32 陣列是 1.3 GB，放不下。

**上傳面板**：偵測結果列出來讓使用者確認再載入：「PointData 比例陣列 8 個（material_1…material_8）→ 取最大者；FieldData 材質表 8 筆（Si、SiO₂、…）；點數 401×301×201」。對不上的（名稱不符規則、FieldData 缺欄）在這裡標橘色，可手動指定哪個陣列是哪個材質。這是沒有範例檔的保險。

**匯出（和輸入一模一樣，§9 D15）**

- XML 結構、Extent／Spacing／Origin、`PointData` 的陣列名稱與型別、`FieldData` 整段、編碼與壓縮方式都和輸入相同（輸入壓縮就輸出壓縮，用 `CompressionStream('deflate')`，格式是 zlib；不支援時退回 appended raw 並提示）。
- 沒改到的點：原值 bit-identical。做法是匯出時從保留的原始 bytes 把每個比例陣列**重新解碼一次**、套上這個 split 的 diff、編碼、丟掉，一次只在記憶體裡放一個陣列。
- 改到的點：新材質的比例寫 1.0、其他寫 0（§9 D16）。
- 新出現的材質（例如 VOID 254 原本沒有陣列）：補一個 `material_254` 陣列（同型別，未改點全 0），FieldData 補一筆（代碼、名稱、顏色）。
- 現有的「單一 UInt8 編號」匯出保留為第二個選項（`.npy` 也保留），供只要標籤的下游。
- 若輸入本來就是單一編號陣列（CellData 或 PointData），匯出照現在。

**manifest** 多記 `input: { source: 'PointData', fractionArrays: ['material_1', …], fieldData: true, dtype: 'Float32', compressed: true }`，讓下游知道這份是哪種格式。

### 4.1 實驗變數（Factor）與水平（level）：資料模型

```ts
// volume/factors.ts（新，純函式，主執行緒與測試共用）
export type FactorOp = 'cd' | 'push' | 'translate' | 'level' | 'round' | 'dilate' | 'taper' | 'defect';

export interface Factor {
  /** ASCII id：檔名、manifest、命名樣板用；預設自動產生（§4.3），可改，同一個 Design 內唯一。 */
  id: string;
  /** 顯示名，可中文；預設同 id。 */
  name: string;
  keys: string[];
  op: FactorOp;
  /** 變數欄位：cd→delta、push→n、translate→d[axis]、level→offset（相對）或 to、round→r、dilate→n、taper→top|bottom|both、defect→size[axis]。 */
  param: string;
  /** 其他固定欄位（方向、axis、anchor、face、shape、center、follow、backfill、scope…），缺的用產生時的全域設定補。 */
  template: Record<string, unknown>;
  unit: 'nm' | 'vx';
  /** 標稱：絕對量的基準（vx）。cd＝現在的寬、push／level＝那一面的座標、dilate＝量到的厚度；translate／taper／defect＝0。 */
  nominal: number;
  /** 水平輸入預設：有標稱可量的絕對、本質是位移的相對（§9 D4）。 */
  mode: 'absolute' | 'relative';
}

export interface Design {
  factors: Factor[];
  /** 每個 factor 的水平（以 unit 為單位；mode 決定是絕對還是相對）。 */
  levels: Record<string, number[]>;
  /** 單變數掃描（其他維持標稱）／全因子／手動勾選的組合。 */
  combine: 'ofat' | 'full' | 'manual';
  picks?: Record<string, number>[];
  from: 'base' | 'active' | 'all';
  nameTemplate: string; // 預設 '{id}={value}{unit}'，多變數用 '_' 連
}

/** 一個組合 → 一串 Op（每個 factor 一個；水平等於標稱的 factor 不產生 Op）。純函式。 */
export function opsOfCombo(design: Design, combo: Record<string, number>, ctx: FactorCtx): Op[];
/** 組合展開：ofat → 每個 factor 各自掃、其他取標稱；full → 笛卡兒積；manual → picks。 */
export function combosOf(design: Design): Record<string, number>[];
/** 名字。 */
export function nameOfCombo(design: Design, combo: Record<string, number>): string;
/** 從現在的狀態量標稱：cd／push／level／dilate 用；量不到回 0。 */
export function measureNominal(L: Labeled, vol: Volume, f: Pick<Factor, 'keys' | 'op' | 'template'>): number;
```

`FactorCtx` 帶 `L`、`vol`、`nmPerVoxel`、全域 follow／backfill／policy；相對 → 絕對的換算在這裡做一次，產生出來的 Op 全是絕對格數（和現在一樣）。

`Split` 多三個可選欄位：

```ts
interface Split {
  /* 既有 */
  levels?: Record<string, number>;   // 這個 split 是哪些水平（以 factor.unit 記）
  designId?: string;                 // 哪一次產生
  tags?: string[];                   // 'baseline' | 'DOE-1' | 使用者自訂
}
```

`Design` 存在 editor state（`designs: Design[]`，目前編輯中的一份 `draft`），跟 split 一起進 manifest；重新整理後靠 `usePersisted('designDraft')` 留住草稿。

### 4.2 「實驗」頁籤：定義變數 → 組合 → 產生

右欄新頁籤「實驗」（和「選取與調整」「改了哪些」「Split」並列；「Split」改名「矩陣」，見 §4.4）。上半是變數、下半是產生。

**變數清單**：每個變數一列：`色點 · 名稱（id） · 結構 · 操作 · 標稱 · 水平輸入框 · ⋯`。

- 「＋新增變數」：先選結構（用現在的選取；沒選就提示），再選操作。操作清單依材質類別過濾（§4.10 的 `kind`）：介電薄層優先列 `dilate`、閘極／金屬線優先列 `cd`／`taper`、任何結構都有 `push`／`translate`／`level`／`round`／`defect`。選完後開對應的 OpCard（同一張，多一列「這個欄位當變數」的單選），卡片上的其他欄位就是 `template`。
- 標稱：`measureNominal` 自動量，旁邊「重新量」；量不到（translate／taper／defect）顯示 0 並鎖住。
- 水平輸入：一個輸入框，接受 `16, 18, 20`、`±2 step 1`、`−2..2 step 1`、`nominal ±10%`；下面即時顯示兩欄「絕對 → 相對」或「相對 → 絕對」（例：`18 nm（−2 nm）`），以及換成格數後的值；小於半格的警告（沿用 SweepModal 的檢查）。mode 可在這裡切。
- 水平裡等於標稱的那個自動標「標稱」，產生時不出 Op（它就是對照組；全因子時仍佔一格）。

**組合**：Segmented「逐一掃描（其他維持標稱）／全因子／手動勾選」。全因子時顯示 `3 × 3 = 9 個 split`；手動勾選列出所有組合的核取方塊。

**從哪裡開始**：原始／接在目前 split 之後／**套用到所有現有 split**。第三種不是產生新 split，而是對每個現有 split 各 commit 一次同一組 Op（每個 split 自己的復原堆疊各多一步，levels 合併進去）；只允許單一水平（例如「全部加同一個 void」），多水平時這個選項反灰並說明。

**產生前預覽**：列出會產生的名字；每個組合用 `previewOp` 在裁切外框裡試算一次（有 cap，超過就跳過），顯示「改動 ≈ n 格、被擋 m 格」，被擋的標橘色。按「產生 N 個 split」才真的跑（沿用 `addSweep` 的 `run` 迴圈，改名 `addDesign`）。

**範本**：頁籤右上角「範本 ▾」：存成範本（命名，例如「FEOL 閘極」）、載入範本、匯出 JSON、匯入 JSON（§4.3）。

### 4.3 命名、變數 id、範本

**預設 id**：`slug(結構名) + '_' + 參數後綴`。slug：去空白、`×`→`x`、下標數字轉半形、非 ASCII 字元整段改用 `m{材質編號}`；多個結構時用材質名 + `x{n}`。參數後綴：cd→`W`／`H`／`D`（依軸）、push→`{面}`（`top`／`bot`／`L`／`R`／`F`／`B`）、translate→`{axis}`、level→`to`、round→`r`、dilate→`t`、taper→`taper`、defect→`void`。例：`PolySi2_W`、`HfO2x3_t`、`m6_2_z`。重複時加 `_2`。使用者改成 `Lg`、`off` 之後存進 Factor。

**命名樣板**：`{id}={value}{unit}`，多變數用 `_` 連；`value` 依 mode 是絕對值（`Lg=18nm`）或帶號相對值（`off=+2nm`）；nm 保留一位小數但去掉 `.0`；使用者可改樣板字串（可用 `{name}`、`{value}`、`{unit}`、`{id}`、`{n}` 序號）。split 的顯示名與檔名都用它（§9 D2）。產生後仍可逐一重新命名。

**範本**（JSON，`version: 1`）：

```json
{
  "version": 1,
  "name": "FEOL 閘極",
  "factors": [{
    "id": "Lg", "name": "L_g", "op": "cd", "param": "delta", "unit": "nm", "mode": "absolute",
    "template": { "axis": 2, "anchor": "center" },
    "match": { "material": "Poly-Si", "ordinal": 2 },
    "levels": [10, 12, 14]
  }],
  "combine": "full", "nameTemplate": "{id}={value}{unit}"
}
```

`match` 取代 `keys`：材質名稱（載入後使用者改過的名字，或 manifest 帶的）＋同材質裡第幾個（`label` 裡的序號）。載入範本時對回結構：找得到就填 keys、重新量標稱；找不到的變數列成橘色「請重選結構」，不擋其他變數。範本存在 localStorage（`usePersisted('factorTemplates')`），也可匯出成檔案。

### 4.4 比較：疊圖、A vs B、矩陣表

**疊圖**（CompareView 標題列 Segmented「並排｜疊圖」）：

- 一張大切面（同 SliceEditor 的縮放／平移），底圖是基準（原始或選定 split）那一片。
- 每個 split 一條輪廓：對「選到的結構」（沒選就用這個 split 改到的結構聯集）在這一片的 mask 跑 `trace.ts` 的描輪廓（含內環），畫成不同顏色的 1.5 px 線；基準黑色 2 px。顏色用 8 色類別色盤循環，超過 8 個自動變半透明並在圖例提示。
- 自動放大：所有 split 在這一片的差異 mask 聯集外框（＋4 格邊距），沒有差異就退到選取外框。
- 圖例：每個 split 一列（色塊、名字、這一片差幾格），點名字切到那個 split，點色塊暫時隱藏那條線，滑過時那條線加粗。
- 快取：`(split version, axis, at, keys)` → 輪廓；換片才重描，一片 9 個 split 在 ×1 約 10 ms。

**A vs B**：CompareView 標題列多一個「基準：原始 ▾」（原始／任一 split）。並排與疊圖的差異 mask 改成「對基準」。Worker 已有 `diff`（兩個版本的 mask 與 count），接成 `call('diff', {a, b})`，快取 key 是版本對；基準是原始時沿用 `useSplitDiffs`。3D 差異模式、ChangesTab、切面紅框**不變**（§9 D6）。

**矩陣表**（SplitsTab 改名「矩陣」）：

| 欄 | 內容 |
| --- | --- |
| ✓ | 匯出時要不要包含（預設全勾） |
| Split | 名字；點切過去；雙擊改名 |
| 每個 factor 一欄 | 水平：`18 nm`，下一行小字 `−2 nm`；等於標稱顯示「標稱」 |
| 選到結構的 W／H／D | 沿用現有（沒選就隱藏） |
| 改動 vx | 現有 |
| 被擋 | 產生時的 Report 加總（沒有就 —） |
| tags | 可點加減 |

欄可排序、可隱藏；上方「匯出 CSV」（和 manifest 同一份資料）；「並排看」按鈕移到這裡與 Split 列各一個。

### 4.5 新操作 `cd`：對稱 CD 偏差

```ts
{ kind: 'cd'; keys; scope; axis: 0 | 1 | 2; delta: number /* 總格數，正＝變寬 */; anchor: 'center' | 'lo' | 'hi'; follow: boolean; backfill: Backfill; policy?: 'block' | 'overwrite' }
```

- 展開成兩個 push：`center` → lo 側 `floor(|delta|/2)`、hi 側 `ceil(|delta|/2)`（奇數多的給 hi 側，§9 D8）；`lo` 錨定＝只推 hi 側 `delta`；`hi` 錨定＝只推 lo 側。兩個 push 依序套用（先 lo 後 hi），和使用者手動做兩次逐體素相同（測試）。
- `previewBox`＝兩個 push 外框聯集；`opWords`：「Poly-Si 2 寬 W（z）24 → 26（兩側各 +1 格 = 0.5 nm）· 中心不動 · 襯層跟著 · 整根」。
- 卡片：PushCard 加 Segmented「一面｜兩側（CD）」；兩側時 FacePicker 以「軸」為單位亮兩面，錨點三選一。3D 把手不變。
- factor：param＝`delta`，nominal＝結構 bbox 在該軸的寬，mode 絕對。

### 4.6 新操作 `dilate`：保形層加厚／減薄

```ts
{ kind: 'dilate'; keys; scope; n: number /* 正加厚、負減薄，格 */; metric: 'euclid'; follow: boolean; backfill: Backfill }
```

**加厚（n > 0）**：在裁切外框（mask bbox ± (|n| + LINER_MARGIN)）裡，對 mask 外每一格算到最近 mask 格中心的歐氏距離（§9 D3）：半徑 ≤ 8 用預先排好的位移表（r=4 時 257 個、r=8 時 2,109 個）掃一遍，記最小距離與來源格；距離 ≤ n 的格子是候選。候選依距離由近到遠分層處理，每格呼叫 kernel `addCell`，方向 d＝從來源格指向這一格的位移取軸向主分量（`sign(max |component|)`），材質＝來源格材質，policy block、follow 照設定：空氣填、薄襯層沿 d 推開、厚材質擋住（report.blocked）。由近到遠保證外層看到的是已經長好的內層。

**減薄（n < 0）**：對 mask 內每一格算到最近「非 mask」格的距離，≤ |n| 的由外到內 `removeCell`，back 方向＝指向最近外部格的軸向主分量，follow 時外面的薄層跟著退回、回填 backfill。

- scope 內才改。多個 keys 時各自算（材質可能不同）。
- `previewBox`＝mask bbox ± (|n| + LINER_MARGIN)；`previewOp` 直接跑同一個純函式。
- `opWords`：「HfO₂ 1 整層加厚 1 格（0.5 nm）：沿每一面往外長，外面的 TiN 跟著推開 · 整根」。
- 卡片：新的 DilateCard（在「長／縮」卡片裡以 Segmented「一面｜兩側｜整層（保形）」切換；整層時沒有方向）；顯示「目前厚度約 n 格」（`measureNominal`：沿六軸向各量 run length 的中位數）。
- factor：param＝`n`，nominal＝量到的厚度，mode 絕對（「HfO₂ 1.5／2.0／2.5 nm」）。

### 4.7 新操作 `defect`：缺陷注入

```ts
{
  kind: 'defect'; keys: [host]; scope;
  shape: 'slab' | 'sphere' | 'box';
  /** 相對 host 外框的 0～1（§9 D5）；slab 的 normal 軸由 size 裡為 1 的那一軸決定。 */
  center: [number, number, number];
  /** 格數。 */
  size: [number, number, number];
  mat: number; // 預設 VOID
  /** 產生時算好的絕對外框，apply 只看它（重播不變）。 */
  abs: BBox;
}
```

- apply：`abs ∩ host mask ∩ scope` 裡的格子設成 `mat`（sphere 用橢球判定）。不經 kernel（不是長縮，是結構內部換材質），不會改到 host 以外。
- 水平＝0 時不產生 Op（＝沒有缺陷，對照組）。
- `opWords`：「Poly-Si 3 裡放 VOID 片：中心 (0.50, 0.30, 0.50)、20×1×30 格（10×0.5×15 nm）」。
- 卡片：新的 DefectCard（編輯工具列與右欄「材質」卡片旁多一顆「缺陷」）：形狀、中心三個滑桿（0～1，旁邊顯示絕對格與 nm）、大小（nm）、材質（VOID 在前，其餘依 §4.10 的合理清單）。預覽走既有管線（`previewBox`＝abs）。3D 上拖缺陷位置這一輪不做。
- factor：param＝`size[axis]`（厚度／直徑）或 `center[axis]`（位置掃描），mode 相對（size 從 0 起算）。

### 4.8 新操作 `taper`：側壁斜度

```ts
{ kind: 'taper'; keys; scope; face: Vec3 /* 哪個側壁 */; along: 0 | 1 | 2 /* 高度軸 */; top: number; bottom: number /* 兩端的位移，格，正＝往外 */; both?: boolean /* 對面也做（鏡像） */; follow; backfill; policy? }
```

- 展開：沿 `along` 軸從結構 lo 到 hi 的每一片 t，`delta(t) = round(lerp(top, bottom, (t − lo)/(hi − lo)))`；相鄰且 delta 相同的片合成一段，每段一個 `push`（scope 夾在這一段）；`both` 時對面鏡像再做一次。同樣是純函式展開，重播逐體素相同。
- `top`／`bottom` 的名字依 `along`：y → 頂／底，x → 左端／右端，z → 前端／後端。
- `previewBox`＝push 外框，n 取 `max(|top|, |bottom|)`。
- `opWords`：「Poly-Si 2 右面側壁：頂 −1、底 +2 格（線性，footing）· 兩側對稱 · 整根」。
- 卡片：PushCard 的第四種模式「側壁斜度」：FacePicker 選面、兩個數字、「兩側對稱」勾選。
- factor：param＝`bottom`（頂固定）或 `top` 或 `both`（兩端同值異號＝整體傾斜），mode 相對（§9 D4）。

### 4.9 `level` 加相對參照：相對 recess

`level` Op 多一個可選欄位，`to` 仍是絕對值：

```ts
ref?: { key: string; side: 'lo' | 'hi'; offset: number /* 格，沿 dir 軸 */ }
```

- 產生時 `to = ref 結構 bbox 在該軸的 lo|hi + offset`；apply 只看 `to`（重播不變）；`ref` 給描述、factor、與範本用。
- 卡片：LevelPart 加「相對於 ▾」：清單先列在同一平面上和選取外框相交的結構（例如 fin、STI），再列其他；選了之後 `to` 欄位改成唯讀顯示、offset 可填 nm。
- `opWords`：「STI SiO₂ 1 方頭：頂面補到 y = 36（= Si fin 1 頂 +6 格 = 3.0 nm）· 只填空氣 · 整根」。
- factor：param＝`offset`，nominal＝現在的 `面座標 − 參照座標`，mode 絕對（「fin 露出 15／18／21 nm」）。

### 4.10 收斂：block 預設、自由形變、材質清單、筆刷

**3D 推面預設 block**（P12）：`push` Op 加 `policy?: 'block' | 'overwrite'`；**省略＝overwrite**（舊 Op 重播不變），新產生的 Op 一律帶 `policy`，預設 `'block'`。`growMask` 把 policy 傳進 `addCell`。PushCard、3D 把手、方向鍵、筆刷的 push 都用設定裡的預設（`usePersisted('pushPolicy', 'block')`），卡片上有「允許穿過其他材質」勾選（勾了這一張卡片用 overwrite，描述加「· 允許穿層」）。被擋時訊息沿用 profile 的格式（「被擋 n 格 · 看這些片」）。`cd`、`taper` 同樣帶 policy。

**自由形變進階化**（P13）：設定抽屜加「進階：自由形變（2D 節點可任意拖）」，預設關。關閉時：節點熱區只在矩形角出現（`resolveNodeDrag` 回 `'corner'` 的那些），其他節點不可抓、只能推邊或拖斜邊；HandleRow 的拖法只剩「矩形角」；Alt／Shift 修飾鍵不改拖法；右鍵選單不列單點。打開時和 v10 相同，且這樣產生的 profile Op 的 `text` 前面加「自由形變：」，矩陣表與 manifest 看得出來。

**材質清單只列合理目標**（P14）：`Material` 加 `kind?: 'semi' | 'diel' | 'metal' | 'void' | 'other'`，載入時依名稱猜（Si／Poly→semi；SiO₂／SiN／HfO₂／low-k／Oxide／Nitride→diel；TiN／TaN／W／Cu／Co／Al／Ti→metal；VOID→void；其他 other），StructureList 的改名對話框可改，寫進 manifest。MaterialCard 分兩組：「合理」＝VOID、原始材質（這些格子在原始檔裡的材質，若不同）、同 kind 的材質；「全部…」摺疊，展開有一行警告「換成不同類的材質通常沒有製程意義」。defect 卡片的材質清單同一套。

**筆刷降級**（P15）：編輯工具列預設只有「瀏覽｜3D 把手｜2D 剖面」；設定抽屜「進階：筆刷」打開才出現第四個頁籤。說明與 README 把局部缺陷導向 `defect`。

### 4.11 manifest

```json
{
  "...": "既有欄位不變",
  "materials": [{ "id": 6, "name": "Poly-Si", "color": "#e8604c", "kind": "semi" }],
  "designs": [{ "id": "d1", "factors": [ "...同 §4.3 範本的 factor，含 keys 與 match..." ], "levels": {"Lg": [10,12,14]}, "combine": "full", "nameTemplate": "{id}={value}{unit}" }],
  "baseline": "original",
  "splits": [{
    "name": "Lg=12nm_off=+1nm", "file": "...", "changedVoxels": 10368, "blocked": 0,
    "designId": "d1", "levels": { "Lg": 12, "off": 1 }, "tags": ["DOE-1"],
    "ops": [ "...照舊，每個 Op 多 text..." ]
  }]
}
```

舊 manifest 沒有這些欄位照常匯出；下游 `pd.DataFrame([{**s['levels'], 'file': s['file']} for s in m['splits']])` 就是實驗表。CSV 與這份同源（矩陣表匯出）。

## 5. 每個檔案要改什麼

| 檔案 | 改什麼 |
| --- | --- |
| `src/volume/vti.ts` | 讀：收集 `material_k` 比例陣列、argmax、FieldData 材質表；保留原始 bytes 與每個陣列的位置／型別／壓縮資訊（`VtiInfo` 加 `fractions`、`fieldData`）。寫：`encodeVtiLike(info, orig bytes, diff, mats)` 同結構重寫（串流逐陣列）；`CompressionStream` 壓縮；補新材質陣列與 FieldData 列 |
| `src/pages/Section3D/UploadPanel.tsx` | 偵測結果確認畫面、手動指定陣列 ↔ 材質 |
| `src/volume/factors.ts`（新） | `Factor`／`Design`、`combosOf`、`opsOfCombo`、`nameOfCombo`、`measureNominal`、`defaultId`／`slug`、範本的 `toTemplate`／`fromTemplate`（match ↔ keys） |
| `src/volume/ops.ts` | `Op` 加 `cd`／`dilate`／`defect`／`taper`；`push` 加 `policy`；`level` 加 `ref`；`applyOp` 的分支（cd／taper 展開成 push 後呼叫 `growMask`，dilate 呼叫 `dilateMask`，defect 呼叫 `setRegionMaterial`）；`opText`；`sweepOps` 保留但標 deprecated（由 factors 取代） |
| `src/volume/kernel.ts` | 不改三條規則；加 `dilateMask`／`erodeMask` 需要的距離表 `offsetsWithin(r)` 與「軸向主分量」`majorAxis(d)` 兩個小工具 |
| `src/volume/volume.ts` | `growMask` 接 `policy`；新增 `dilateMask`（§4.6）、`setRegionMaterial`（defect）、`thicknessOf`（量襯層厚度）；`Material.kind` 與 `guessKind` |
| `src/volume/preview.ts` | `previewBox`／`previewOp` 加四種 kind；cd／taper 走 push 的外框聯集 |
| `src/volume/apply.ts`、`patch.ts` | 不改邏輯；確認新 kind 走 generic 路徑（`applyOpInPlace` 非 profile／translate 的分支），`carryStepStats` 不看 kind |
| `src/volume/workerCore.ts`、`client.ts` | `diff` 開放給主執行緒（版本對 → mask＋count）；`apply` 回傳的 report 帶 blocked 給矩陣表 |
| `src/pages/Section3D/editor.ts` | `Split` 加 `levels`／`designId`／`tags`；`designs`／`draft`／`templates` 狀態；`addDesign`（取代 `addSweep`，含 from:'all' 的逐 split commit）；`commitTo(splitId, op)`；`pushPolicy`／`freeform`／`brushOn` 設定；`compareBase` 狀態 |
| `src/pages/Section3D/ExperimentTab.tsx`（新） | §4.2 整頁：變數清單、水平輸入與解析（`parseLevels`）、組合、從哪裡開始、產生前預覽、範本選單 |
| `src/pages/Section3D/MatrixTab.tsx`（SplitsTab 改名） | §4.4 矩陣表、CSV、匯出勾選、tags |
| `src/pages/Section3D/OverlayView.tsx`（新） | 疊圖：描輪廓快取、圖例、自動放大 |
| `src/pages/Section3D/CompareView.tsx` | 「並排｜疊圖」、基準選擇、卡片自動放大到差異外框、腳註改成 levels |
| `src/pages/Section3D/OpCard.tsx` | PushCard 四模式（一面／兩側 CD／整層 dilate／側壁 taper）、LevelPart 的「相對於」、DefectCard、policy 勾選、材質分組、「這個欄位當變數」列（給 ExperimentTab 用） |
| `src/pages/Section3D/FacePicker.tsx` | 兩面同時亮（軸模式） |
| `src/pages/Section3D/opWords.ts` | 四種新 kind 與 ref／policy 的句子 |
| `src/pages/Section3D/EditToolbar.tsx`、`SettingsDrawer.tsx` | 筆刷頁籤受設定控制；三個進階開關；pushPolicy 預設 |
| `src/pages/Section3D/Inspector.tsx`、`handleOps.ts`、`SliceEditor.tsx`、`src/slice/gestures.ts` | 自由形變關閉時的熱區與拖法限制 |
| `src/pages/Section3D/StructureList.tsx` | 改名對話框加材質類別 |
| `src/pages/Section3D/index.tsx` | 右欄頁籤（實驗、矩陣）、manifest 新欄位、CSV 下載、SweepModal 移除 |
| `src/pages/Section3D/SweepModal.tsx` | 刪除（功能併入 ExperimentTab） |
| `src/pages/Section3D/HelpDrawer.tsx`、`README.md` | 實驗流程、新操作、進階開關 |
| `scripts/e2e/m11.cjs`（新） | 驗收腳本（§7） |

## 6. 測試清單

逐體素測試（vitest）：

- `vti.test.ts` 加：合成一個 PointData 三個比例陣列＋FieldData 的 `.vti`（ascii 與 appended、壓縮與不壓縮各一），讀回的編號等於 argmax、平手取小、全 0 為 Air；名稱與顏色來自 FieldData；改一格後 `encodeVtiLike` 寫出再讀回：未改點每個陣列 bit-identical、改點 1.0／0、FieldData 整段相同、新材質補陣列與列；輸入是單一編號陣列時行為和 v10 相同。
- `factors.test.ts`：`combosOf` 三種模式的數量與順序；`opsOfCombo` 等於標稱不出 Op；絕對↔相對換算；`nameOfCombo` 樣板與去 `.0`；`defaultId` 的 slug（中文結構名、`×3`、重複加 `_2`）；範本 `toTemplate`／`fromTemplate` 對回 keys、對不到的列出；`measureNominal` 對範例 Poly-Si 2 的 W、HfO₂ 1 的厚度（2 格）、STI 頂相對 fin 頂。
- `cd.test.ts`：`cd` +2 center ≡ push lo +1 再 push hi +1；+3 center 多的在 hi；anchor lo／hi；被擋計數＝兩個 push 相加。
- `dilate.test.ts`：HfO₂ 1 +1：每個新格到原殼距離 ≤ 1、TiN 被推開且總體積不變、fin／poly 體積不變；角落格（對角）有被填（歐氏，不是 6 鄰）；+1 時 scope 只有 z 60～64 則其他片不變；−1：厚度 2 → 1，TiN 跟著退回、回填原始；poly（厚）+1 碰到 fin：被擋 > 0、fin 不變；report 數字。
- `defect.test.ts`：abs ∩ host；sphere 的橢球判定；host 外一格都不變；size 0 不出 Op（在 factors 層）。
- `taper.test.ts`：頂 −1 底 +2 每片 delta 等於 lerp 取整；both 鏡像；和手動逐片 push 逐體素相同；scope 只取一段時插值仍按整根算。
- `level` ref：`to` 等於參照 + offset；重播只看 `to`（把 ref 刪掉重播相同）。
- `policy.test.ts`：沒有 policy 的 push 重播和 v10 的 `ref/legacy.ts` 逐體素相同；block 時 Poly-Si 2 往下 5 被擋、STI 不變；overwrite 和舊結果相同。
- `preview.test.ts` 加四種 kind：裁切範圍內逐體素和正式結果相同。
- `v12.test.ts`（黃金）：範例上的 3×3 設計產生 9 個 split，重播每一個與 manifest 的 ops 相同；manifest 的 levels／designs 欄位 round-trip。
- `overlay.test.ts`：描輪廓快取 key；差異聯集外框。

Playwright（`scripts/e2e/m11.cjs`）：見 §7。

## 7. 里程碑、工作拆解、驗收

### M11.0 檔案格式（M）

`vti.ts` 讀（比例 argmax、FieldData）＋測試 → UploadPanel 確認畫面 → `encodeVtiLike` 同格式匯出＋測試 → manifest `input`。先做：沒有它真實檔案進不來，後面全部白做。

驗收（m11 §0）：合成檔載入後左欄顯示 FieldData 的名字與顏色；匯出的 `.vti` 用 vtk 讀回，未改陣列逐位元組相同、改過的點比例 1／0。

### M11.1 Factor 模型與「實驗」頁籤（L）

`factors.ts`＋測試 → `editor.ts` 的 `addDesign`／`commitTo` → `ExperimentTab.tsx`（先支援既有 push／translate／level／round）→ 命名、範本、manifest → 刪 SweepModal。

驗收（m11 §1）：範例上定義 Poly-Si 2 往上 push（相對 1／2／3 nm）與 translate z（−1／+1），全因子 6 個；名字對；矩陣表 6 列 2 欄；匯出 zip 的 manifest 有 designs／levels；載入自存的範本後變數對回 Poly-Si 2。

### M11.2 比較（M）

Worker `diff` 開放 → CompareView 基準選擇與自動放大 → `OverlayView.tsx` → `MatrixTab.tsx`（含 CSV）。

驗收（m11 §2）：6 個 split 疊圖 6 條線、自動放大到差異外框、點圖例隱藏一條；基準切到 split 2 時 split 3 的差異格數等於兩者 diff；CSV 行數＝split 數＋1。

### M11.3 新操作（L）

順序：`policy`（最小、其他都依賴）→ `cd` → `taper`（展開成 push，共用）→ `level.ref` → `dilate`（唯一要新演算法的）→ `defect`。每個都先純函式＋測試，再 preview，再 opWords，再卡片，最後接進 ExperimentTab 的操作清單。

驗收（m11 §3）：Poly-Si 2 `cd` +2 後 W 24 → 26；HfO₂ ×3 `dilate` +1 後 TiN 被推、fin 不變；Poly-Si 3 放 VOID 片後只有 poly 內的格子變；`taper` 頂 −1 底 +2 的側面切面是斜的；STI 相對 fin 頂 +6 的 `to` 正確；Poly-Si 2 往下 5 預設被擋、勾「允許穿過」後和 v10 一樣。

### M11.4 收斂（M）

自由形變開關（gestures／handleOps／SliceEditor）→ 材質 `kind` 與 MaterialCard 分組 → 筆刷開關 → 說明與 README。

驗收（m11 §4）：預設下 Si fin 1 的斜切角節點抓不到、矩形角抓得到、Alt 無效；打開後和 v10 的 m5.cjs 相同；MaterialCard 對 fin 只列 VOID／Si (p)／原始，TiN 在「全部…」裡；預設沒有筆刷頁籤。

### 文件

README 的「掃描」段改成「實驗」；HelpDrawer 加一條任務「撒 split」；`docs/plan-v11-experiments.md` §10 實作紀錄。

## 8. 風險與對策

| 風險 | 對策 |
| --- | --- |
| 沒有範例檔，PointData／FieldData 的名稱與型別是猜的 | 上傳面板把偵測結果列出來、可手動對應；讀取器對不上就退回「材質 n」而不是失敗；拿到第一個真實檔案時先跑一次 `vti.test.ts` 的 round-trip |
| 匯出時重新解碼每個比例陣列，大檔案慢 | 一次一個陣列、Worker 裡做、進度條；4,000 萬點 × 8 陣列估 10～20 s，可接受 |
| `dilate` 的方向只取軸向主分量，斜向推襯層時可能推錯邊 | 由近到遠分層、每層先處理軸向距離的格；測試覆蓋角落；report 記 pushed，疊圖可檢查 |
| `dilate` 大結構（基板）外框太大 | 和 push 一樣用 previewBox cap，超過 600 萬不預覽、超過 400 萬先確認 |
| 全因子組合數爆炸 | 超過 50 個先確認、超過 200 個拒絕並提示改逐一掃描或手動勾選 |
| 「套用到所有 split」對某些 split 被擋 | 逐 split 回報，矩陣表「被擋」欄顯示，不中斷 |
| 範本對結構對不回（材質名改過、結構數變） | `match` 用材質名＋序號，對不到只標橘色，使用者重選 |
| policy 預設改變讓舊使用者覺得「推不動」 | 訊息列明寫「被擋 n 格 · 允許穿過」可直接點；設定裡可改回 overwrite 預設 |
| 自由形變關閉後既有 e2e（m5／m9）失效 | 腳本開頭打開進階開關 |
| 疊圖顏色超過 8 個分不清 | 半透明＋滑過加粗＋圖例點選；建議使用者用矩陣表篩選 |

## 9. 決策記錄

| # | 決定 | 理由 |
| --- | --- | --- |
| D1 | 實驗設計放右欄新頁籤「實驗」，不是 Modal 或全頁 | 變數常駐、可邊看 3D 邊改，預覽走既有卡片管線（使用者選擇） |
| D2 | 命名樣板 `{id}={value}{unit}`，多變數 `_` 連，ASCII | 檔名與 pandas 安全；id 由系統預設、使用者可改、可存範本（使用者選擇） |
| D3 | `dilate` 用歐氏距離（圓角） | 最像 ALD 保形沉積；只在補丁外框裡算（使用者選擇） |
| D4 | taper 參數＝頂與底各差幾格；水平輸入預設依操作：有標稱的絕對、位移類相對 | 全整數、重播安全、與 cd 一致（使用者選擇） |
| D5 | defect 位置用相對結構外框的 0～1，Op 同時存絕對 abs | 同一個定義能套到別的 split；apply 只看 abs 保重播（使用者選擇） |
| D6 | A vs B 基準只影響並排與疊圖 | 3D 差異模式與「改了哪些」語意維持對原始（使用者選擇） |
| D7 | 物理 lint 這一輪不做 | 使用者選擇；矩陣表先用 Report 的被擋數 |
| D8 | `cd` 奇數格、center 錨定時多的一格給 hi 側 | 要有固定規則才能重播；文件與卡片描述寫明 |
| D9 | 「套用到所有現有 split」是對每個 split 各 commit 一步，不是產生新 split | 符合「全部加同一個 void」的意圖；每個 split 可各自復原 |
| D10 | `push.policy` 省略＝overwrite | 舊 manifest 重播逐位元組不變；新 Op 一律明寫 |
| D11 | Factor／Design 是標註，Op 仍是唯一真相 | 刪掉 factors 不影響重播；下游只讀 levels 就夠 |
| D12 | `taper`／`cd` 展開成 push，不加 kernel 規則 | 規則一套；只有 `dilate` 需要新的距離計算 |
| D13 | `defect` 不經 kernel | 它是結構內部換材質，沒有長縮語意 |
| D14 | SweepModal 刪除 | 功能完全被 ExperimentTab 覆蓋；單變數掃描就是 combine:'ofat' 一個 factor |
| D15 | 匯出和輸入一模一樣（PointData 多比例陣列＋FieldData），單一編號陣列留為第二選項 | 下游不用改（使用者選擇） |
| D16 | 改到的點比例寫新材質 1.0、其他 0 | 最簡單、可重播；邊界比原始硬一點先接受（使用者選擇） |
| D17 | 載入用所有 `material_k` 的 argmax，而不是只看 `material_1` | 只看一個陣列拿不到編號；比例為 0／1 時結果和「哪個是 1」相同，介面有部分比例時也成立 |
| D18 | 比例陣列不常駐記憶體，匯出時從原始 bytes 重新解碼一次 | 4,000 萬點 × 多個 Float32 放不下 |

## 10. 實作紀錄（2026-10-31）

### 完成的範圍

| 里程碑 | 內容 | 測試 |
| --- | --- | --- |
| M11.0 | `vti.ts`：`parseHead`／`readValues`／`inspectVti`；比例陣列 argmax（平手取小、全 0＝Air、單一陣列 ≥ 0.5、`material_254`＝VOID）；FieldData 代碼／名稱（String 或 0 結尾 UInt8，ascii 是字元碼或空白分隔字）／顏色（三分量 0～255、0～1 或十六進位字串）；`encodeVtiLike` 照原格式寫回（ascii 只換改到的 token；appended 照原 offset 順序重排，沒改的區塊原封不動複製；壓縮沿用原 blockSize）；上傳確認畫面（手動勾選陣列與編號）；匯出選單多「單一編號 .vti」；manifest `input` | `vtiFrac.test.ts`（6 種編碼 × 讀＋寫：沒改＝逐位元組相同、未改點 bit-identical、改點 1／0、新材質補陣列與 FieldData）；舊 `vti.test.ts` 不變 |
| M11.1 | `factors.ts`、`editor.addDesign`／`commitTo`、`ExperimentTab.tsx`、`MatrixTab.tsx`、`matrix.ts`（CSV、manifest）、刪 `SweepModal.tsx` | `factors.test.ts`、`v12.test.ts`（3×3＝9 個 split，Worker 重播 ≡ manifest ops 重播，levels／designs round-trip） |
| M11.2 | `OverlayView.tsx`、`overlay.ts`、CompareView 並排／疊圖、基準選擇、卡片自動放大、腳註改 levels；`SliceView` 多 `box` | `overlay.test.ts` |
| M11.3 | `cd`、`taper`（展開成 `pushSeq`）、`dilate`（`dilateMask`）、`defect`（`setRegionMaterial`）、`level.ref`、push `policy`；卡片：長／縮四模式、允許穿層、方頭相對於、缺陷卡、FacePicker 軸模式 | `cd`／`taper`／`dilate`／`defect`／`policy`／`levelRef.test.ts`（每個都驗預覽裁切 ≡ applyOp ≡ applyOpLocal） |
| M11.4 | 設定：推面 policy 預設、進階「自由形變」「筆刷」；`hitTest` 的 `nodeOk`、Shift／Alt 關閉、自由形變 Op 加「自由形變：」；`Material.kind`／`guessKind`、左欄改類別、MaterialCard 分組；README、HelpDrawer | `scripts/e2e/m11.cjs`（§0～§4 全過）；m0／m2／m3／m5／m9／m10 開頭打開進階開關後全過 |

### 和計畫不同的地方

- **實驗頁籤的變數表單**：沒有重用 OpCard 加「這個欄位當變數」那一列，改成頁籤裡的精簡表單（操作、軸／面、錨點、相對於、高度軸、缺陷形狀與位置…）。OpCard 的預覽／套用流程和「一個欄位變成多個水平」對不太起來，硬塞會讓卡片變複雜；產生的 Op 仍走同一組產生函式（`opOfFactor` 和卡片產生的欄位相同）。
- **A vs B 的 diff 在主執行緒算**：兩個 split 的帳簿都在主執行緒（plan v9 §4.1），直接逐格比、以版本對快取（最近 24 對），不經 Worker `diff`（那個 handler 只回「對原始」的 diff，要另開版本對的請求還得把另一本送過去）。
- **匯出在主執行緒、沒有進度條**：`encodeVtiLike` 一次解一個比例陣列，記憶體符合 §9 D18；但沒有搬進 Worker。4,000 萬點的實測還沒做（沒有真實檔案）。不支援 `CompressionStream` 的瀏覽器會報錯並請使用者改用「單一編號 .vti」，不是自動退回 appended raw。
- **同一個組合裡多個變數的 Op 都從起點狀態量**：`level` 的 `to`、`defect` 的 `abs`、`round` 的參考片在產生時用起點（原始或目前 split）的外框算，不會看同一組合裡前一個變數改過的形狀。CD＋偏移這類只靠 keys 的組合不受影響。
- **taper 的 scope**：每一段推面的 scope 沿高度軸；使用者的範圍另外當 `clip` 夾（`growMask` 新增的參數），插值仍按整根算。
- **dilate 減薄只從露出的面退**：計畫寫「到最近非 mask 格的距離」；實作時 HfO₂ 的內面貼著 fin，照字面會兩面一起退、厚度 2 的殼整個不見。改成只從外面是空氣或薄襯層的面算距離（和加厚時被厚材質擋住對稱）。
- **block 時被擋的格子不算長出來**：`growMask` 原本把 front 全部標進 mask；block 時被擋的格子若也標進去，下一步會從擋住的格子再往前長、穿過薄的鄰居。現在只標真的寫到的格子（overwrite 照舊，舊 Op 重播不變）。
- **dilate 的 TiN 體積**：測試只驗變化 < 5%；角落的格子沿主分量推襯層，體積不是逐格守恆（§8 已列這個風險）。
- **範本的多結構**：`match` 多一個 `ordinals`（多個結構時）；level 的 `ref` 也換成 `match`。defect 的位置變數（`center[k]`）沒有單位（0～1）。
- 逐體素測試在整個範例上跑，vitest 的單一測試上限調到 120 s（`vite.config.ts`）。

### 數字

| 項目 | 結果 |
| --- | --- |
| 單元測試 | 34 個檔案、231 個測試全過 |
| 3×3 設計 Worker 重播（×1，node） | 約 3.5 s（`v12.test.ts`，目標 < 5 s） |
| e2e m11 | §0～§4 共 19 項全過 |

### 還沒做

- 物理 lint、量測器（本來就在下一輪）。
- 3D 上拖缺陷位置（§4.7 本來就說這一輪不做）。
- 匯出搬進 Worker＋進度條；拿到第一個真實檔案時跑一次 round-trip（§8）。
