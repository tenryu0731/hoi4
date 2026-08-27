# ARCHITECTURE — *Iron Front: Europe 1936*

モバイルブラウザ (Chrome / タッチ操作) で動作する Hearts of Iron IV 風グランドストラテジー。
本ドキュメントは実装に先立つ設計定義であり、実装はここで定義したインターフェースに従う。

---

## 0. 技術選定

| 項目 | 選定 | 理由 |
|---|---|---|
| 描画 | **PixiJS v8 (WebGL2 / WebGPU fallback → WebGL)** | 数百のポリゴン + 数百のスプライトをモバイルGPUで 60fps 描画。`Graphics` が earcut 三角形分割を内蔵、`RenderTexture` によるベイク、`ParticleContainer` 相当のバッチングを持つ |
| 言語 | **TypeScript 5.9** (strict) | シミュレーション層の型安全性。ゲームステートの構造が大きいため必須 |
| ビルド | **Vite 8** | 高速 HMR、静的サイト出力 (`dist/`) |
| ロジックテスト | **Vitest** (ブラウザ非起動) | 資源計算 / 戦闘計算 / 時間進行の単体テスト |
| E2Eテスト | **Playwright (headless Chromium)** | スクリーンショット差分、フレームタイム計測、タッチ操作スクリプト |
| 地理データ | **Natural Earth 50m (nvkelso/natural-earth-vector)** | 実際のヨーロッパ地理。ビルド時にダウンロード → 投影 → 簡略化 → `public/data/*.json` |
| 画像アセット | **ビルド時 SVG 生成 (Node, 依存ゼロ)** | 国旗・NATO兵科記号・資源アイコン・UIフレームを決定論的に生成。ライセンス問題なし、合計 < 100KB |

### 依存を意図的に持たないもの
- ゲームエンジン (Phaser 等) — 時間進行を自前で完全制御したいため
- 状態管理ライブラリ (Redux 等) — シミュレーションは純粋な可変オブジェクトグラフ + 明示的な tick で回す方が高速
- UI フレームワーク (React 等) — HUD は DOM を直接操作。差分更新は「dirty フラグ + 値比較」で十分軽い

---

## 1. レイヤ構造

```
┌──────────────────────────────────────────────────────────────┐
│  presentation                                                 │
│  ┌────────────┐  ┌────────────┐  ┌───────────────────────┐    │
│  │ map-render │  │     ui     │  │      touch-input      │    │
│  │  (Pixi)    │  │   (DOM)    │  │  (PointerEvent FSM)   │    │
│  └─────┬──────┘  └─────┬──────┘  └───────────┬───────────┘    │
└────────┼───────────────┼─────────────────────┼────────────────┘
         │ read-only     │ read-only           │ Commands
         │ view of state │ view of state       │ (意図)
┌────────▼───────────────▼─────────────────────▼────────────────┐
│  simulation  (純粋 TypeScript / DOM 非依存 / 決定論的)          │
│  ┌────────────┐                                                │
│  │time-engine │──tick(hour)──┐                                 │
│  └────────────┘              │                                 │
│      ┌───────────────────────┼───────────────────────┐         │
│      ▼           ▼           ▼           ▼           ▼         │
│  production  military-units  diplomacy  ai-opponent  supply    │
│      └───────────┴───────────┴───────────┴───────────┘         │
│                          GameState                             │
│                             ▲                                  │
│                      province-data (静的)                      │
└────────────────────────────────────────────────────────────────┘
         ▲
         │ build time
┌────────┴────────────────────────────────────────────────────────┐
│  tools/   map-build (Natural Earth) │ asset-generation (SVG)     │
└─────────────────────────────────────────────────────────────────┘
```

**不変条件**
1. `sim/` は `window` / `document` / `performance` を参照しない。Node 上で完結し、Vitest で直接テストできる。
2. presentation → simulation への書き込みは **Command** オブジェクト経由のみ。直接ミューテーション禁止。
3. simulation は同じ seed + 同じ Command 列 → 同じ GameState を返す (決定論)。`Math.random` 禁止、`Object.keys` 順序依存禁止 (常に配列 + 数値 ID で反復)。

---

## 2. サブシステム定義

### 2.1 `time-engine` — 時間進行 (最初に固める骨格)

**責任**: シミュレーション時刻の前進、速度制御、tick 分配、レンダループとの分離。

- 内部時間単位は **1 hour**。HOI4 と同じく「1日 = 24 tick」。
- `SPEED_TABLE = [0, 24, 8, 3, 1, 0.4]` — index が速度段 (0 = pause)。値は「実時間 1 秒あたりの hour 数」…ではなく **1 hour を進めるのに必要な実時間 ms** の逆数として持つ:
  `MS_PER_HOUR = [Infinity, 1000, 333, 125, 42, 16]`
- アキュムレータ方式。1 フレームで進める tick 数に上限 (`MAX_CATCHUP_TICKS = 240`) を設け、重いフレームでスパイラルしない。
- 描画は tick と非同期。`alpha` (tick 間補間係数) を map-render に渡す。

```ts
interface TimeEngine {
  readonly clock: GameClock;            // { hour, day, month, year, totalHours }
  speed: 0 | 1 | 2 | 3 | 4 | 5;         // 0 = paused
  /** 実時間 dtMs を消費して 0..MAX_CATCHUP_TICKS 回 onTick を呼ぶ。実行した tick 数を返す */
  advance(dtMs: number): number;
  /** テスト用: 実時間に依存せず n 時間進める */
  step(hours: number): void;
  onTick: (clock: GameClock) => void;   // 毎時
  readonly alpha: number;               // 0..1 補間係数
}
```

**Tick カスケード** — 各サブシステムは自分の周期でしか動かない (モバイルCPU予算のため):

| 周期 | 実行内容 |
|---|---|
| hourly (24/day) | 部隊移動、戦闘ラウンド、補給消費 |
| daily | 生産ライン進捗、建設進捗、資源収支、人的資源、AI 経済判断 (国を日毎に分散) |
| weekly | 外交 opinion、AI 戦略再評価、正当化進捗 |
| monthly | 統計スナップショット、勝利条件判定 |

日付は 1936-01-01 から。うるう年を含む実カレンダー (`DAYS_IN_MONTH`)。

**テスト**: 1年進めて `year==1937 && month==1 && day==1`、うるう年 1936/2/29 の存在、速度変更でシミュレーション結果が変わらないこと (同 tick 数なら同一 state)。

---

### 2.2 `province-data` — 地図データ

**ビルド時パイプライン** (`tools/map-build/`):

```
Natural Earth (GeoJSON, パブリックドメイン)
  ├ ne_10m_admin_1_states_provinces  実在の行政単位 ← ステートの素材
  ├ ne_10m_land                      陸地マスク
  ├ ne_10m_populated_places          都市 (プロヴィンス種点 & 命名)
  ├ ne_50m_lakes                     湖
  └ ne_50m_rivers_lake_centerlines   河川 (描画のみ)
        │
        │ 1. bbox クリップ  lon [-26, 52], lat [27.5, 72]
        │ 2. 1936年の持ち主へ  historical.ts の帰属表と切り出し規則
        │    ケーニヒスベルク→独、クレシ→波、ベッサラビア→羅、
        │    カレリア地峡→芬、イストリア→伊 …
        │ 3. 投影  Lambert Conformal Conic (λ0=15°E, φ1=40°N, φ2=62°N)
        │ 4. トポロジー  共有アークに切って一度だけ簡略化
        │    (Visvalingam-Whyatt, 16 km²)  ← 隣国どうしが離れない
        │ 5. 併合  8,500 km² (植民地は 55,000) 未満の単位を隣へ溶かす
        ▼
  states[]  (~490)  境界はすべて実在の行政境界の上にある
        │
        │ 6. Voronoi 細分化  ステートの内側だけで
        │    種点 = 人口上位都市 + 最遠点サンプリングの補充点
        │    Voronoi セル ∩ ステートのポリゴン = province
        ▼
  provinces[]  (~1720)  必ずどれか一つのステートの中に収まる
```

出力 `public/data/map.json` (1.6MB, gzip 後 ~475KB):

```ts
interface MapData {
  projection: { name: 'lcc'; lon0: number; lat1: number; lat2: number;
                scale: number; offsetX: number; offsetY: number };
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  provinces: ProvinceGeo[];
  states: StateGeo[];
  seaZones: SeaZoneGeo[];      // 海戦・護送船団用の粗い海域
  coastline: Ring[];           // 描画専用
  rivers: Polyline[];          // 描画専用
  lakes: Ring[];               // 描画専用
  labels: LabelAnchor[];       // 国名・都市名の配置点
}

interface ProvinceGeo {
  id: ProvinceId;              // 0..N-1 の連番 (配列 index と一致)
  stateId: StateId;
  rings: Float32Array[];       // 投影済み world 座標 [x0,y0,x1,y1,...] 外環 + 穴
  center: [number, number];    // pole-of-inaccessibility (ラベル/カウンタ配置)
  area: number;
  neighbors: ProvinceId[];     // 陸接続
  seaNeighbors: ProvinceId[];  // 海峡越え接続 (上陸・海峡渡河)
  terrain: TerrainType;        // plains|forest|hills|mountain|urban|marsh|desert
  isCoastal: boolean;
  adjacentSeaZones: SeaZoneId[];
  victoryPoints: number;       // 0 = 非VP
  name: string;
}

interface StateGeo {
  id: StateId; name: string;
  provinces: ProvinceId[];
  category: StateCategory;     // 建物スロット上限を決める (rural..megalopolis)
  manpowerPool: number;        // 総人口 (万人)
  resources: Partial<Record<ResourceType, number>>;
  infrastructureBase: number;  // 1..5
}
```

**ランタイム API** (`sim/map/ProvinceIndex.ts`):

```ts
class ProvinceIndex {
  static load(data: MapData): ProvinceIndex;
  get(id: ProvinceId): ProvinceGeo;
  /** world 座標 → ProvinceId。均一グリッド (64x64 バケット) + point-in-polygon。O(1) 期待 */
  pick(x: number, y: number): ProvinceId | null;
  /** A* 最短経路 (陸)。cost = 距離 / (infrastructure 補正 × 地形速度) */
  path(from: ProvinceId, to: ProvinceId, opts: PathOpts): ProvinceId[] | null;
  distance(a: ProvinceId, b: ProvinceId): number;
  /** 前線検出: 自国支配 province のうち、敵支配 province に隣接するもの */
  frontline(controller: CountryId, enemyOf: CountryId): ProvinceId[];
}
```

**テスト**: 全 province の rings が閉じている / 自己交差なし、隣接関係が対称、連結成分数、`pick()` が center を正しく返す、A* が隣接ノード列を返す。

---

### 2.3 `production` — 生産・経済

HOI4 の中核ループを簡略化しつつ本質を保つ。

```ts
type ResourceType = 'oil' | 'steel' | 'aluminium' | 'tungsten' | 'rubber' | 'chromium';

interface Economy {
  civilianFactories: number;     // 建設 + 消費財 + 貿易
  militaryFactories: number;     // 装備生産
  dockyards: number;             // 艦船生産
  consumerGoodsRatio: number;    // 0..1 (法律 + 戦時経済で変動)
  stockpile: Record<EquipmentType, number>;
  resources: Record<ResourceType, { produced: number; imported: number; consumed: number }>;
  manpower: number;              // 徴兵可能人的資源
  convoys: number;
  politicalPower: number;
}

interface ProductionLine {
  id: number;
  equipment: EquipmentType;      // infantry_equipment | support_equipment | artillery |
                                 // light_tank | medium_tank | fighter | cbs | destroyer ...
  assignedFactories: number;
  efficiency: number;            // 0.10 → cap。日々 growth
  efficiencyCap: number;         // 0.5 + 技術/法律
  progress: number;              // 現在ユニットの進捗 (0..cost)
  priority: 0 | 1 | 2 | 3;       // low..exclusive (資源不足時の配分)
}

interface ConstructionItem {
  id: number; kind: BuildingType; stateId: StateId;
  progress: number; cost: number; assignedFactories: number;
}
```

**日次計算 (`tickDaily`)**:
1. 資源産出 = Σ(支配 state の resources) × (1 − 貿易輸出比率)
2. 資源需要 = Σ(生産ライン工場数 × 装備の資源原単位)
3. 不足時は priority 降順に配分 → 不足ラインは `efficiency` にペナルティ (最大 −50%)
4. 消費財工場数 = `ceil(civ × consumerGoodsRatio)` → 残りを建設 + 貿易へ
5. 各生産ライン: `progress += factories × 5 × efficiency × outputBonus`
   `while (progress >= cost) { progress -= cost; stockpile[eq]++ }`
6. `efficiency += (cap − efficiency) × 0.008 × factories/assigned` (漸近成長)
7. 建設: `progress += factories × 5 × infraBonus`。完了で building 増加、civ/mil factory は翌日から稼働
8. 人的資源: `manpower += Σ(state.manpowerPool) × conscriptionLaw.rate / 365`

**テスト**: 資源不足で効率が落ちること、工場0で進捗0、100日回して stockpile が解析解の ±1 に収まること、消費財が正しく差し引かれること、決定論 (同じ入力 → 同じ出力)。

---

### 2.4 `military-units` — 部隊編成・移動・戦闘

```ts
interface DivisionTemplate {
  id: number; name: string;
  battalions: BattalionType[];    // infantry|artillery|light_armor|medium_armor|motorized|...
  supports: SupportType[];
  // 派生値 (テンプレ変更時に再計算)
  maxOrg: number; maxHp: number; softAttack: number; hardAttack: number;
  defense: number; breakthrough: number; armor: number; piercing: number;
  hardness: number; speedKmh: number; supplyUse: number;
  equipmentNeed: Record<EquipmentType, number>;
  manpowerNeed: number;
}

interface Division {
  id: DivisionId; owner: CountryId; templateId: number;
  provinceId: ProvinceId;
  org: number; hp: number;        // 0..max
  experience: number;
  equipment: Record<EquipmentType, number>;   // 実保有 (不足すると攻撃力が線形低下)
  supplyLevel: number;            // 0..1
  order: UnitOrder | null;
  moveProgress: number;           // 0..1 (現 province → path[0])
  path: ProvinceId[];
  combatId: CombatId | null;
  armyId: ArmyId | null;
}

type UnitOrder =
  | { kind: 'move'; target: ProvinceId }
  | { kind: 'attack'; target: ProvinceId }
  | { kind: 'defend' }
  | { kind: 'frontline'; assignedProvinces: ProvinceId[] }   // 軍集団の前線ホールド
  | { kind: 'offensive'; target: ProvinceId };               // 攻勢計画
```

**移動 (hourly)**: `moveProgress += speed × terrainMod × infraMod × supplyMod / distance`。
到達時、目標が敵支配なら戦闘開始、無防備なら占領。組織率 (org) が 0 の部隊は移動不可 (退却のみ)。

**戦闘 (hourly ラウンド)** — HOI4 の damage model を簡略化:

```
参加側ごとに combat width (地形依存: plains 90, mountain 50 ...) まで前線に投入。
1ラウンド:
  attackerShots = softAttack × (1 − defenderHardness) + hardAttack × defenderHardness
  effAttack     = attackerShots × equipmentRatio × (0.5 + 0.5×supplyLevel) × (1 + expBonus)
  defRolls      = defense (防御側が防御姿勢) or breakthrough (攻撃側)
  hits          = effAttack × (armorPen ? 1.0 : 0.5)
  blocked       = min(hits, defRolls)              // 防御に吸収された分 → org のみ削る
  through       = hits − blocked                   // hp (strength) を削る
  defender.org -= blocked  × ORG_DAMAGE_K
  defender.hp  -= through × STR_DAMAGE_K
戦術・地形・渡河・包囲・航空優勢を係数として乗算。
org が 0 になった側が敗北 → 退却 (隣接の自軍支配 province へ)。
```

すべて決定論 seeded RNG。命中判定は乱数ではなく **期待値 + 小さな seeded ジッタ (±10%)** とし、テストで解析検証可能にする。

**補給**: 首都 (or 上陸拠点) から鉄道/インフラを辿った BFS で supply hub を伝播。距離とインフラで supply throughput を計算。`supplyLevel < 1` の部隊は attrition で装備損耗 + org 回復低下。包囲 (敵支配で完全に囲まれた) 判定は連結成分で行う。

**テスト**: 同一戦力同士で戦闘が引き分けに収束、装備不足で攻撃力が線形低下、包囲判定、A* 移動が n hour 後に到着、退却先が正しい、org 回復が上限を超えない。

---

### 2.5 `diplomacy` — 外交

```ts
interface Faction { id: FactionId; name: string; leader: CountryId; members: CountryId[]; }
interface War { id: WarId; attackers: CountryId[]; defenders: CountryId[]; startDay: number; }

interface DiplomaticState {
  opinion: Map<CountryId, number>;        // -100..100
  guarantees: CountryId[];
  justifications: { target: CountryId; progress: number; days: number }[];
  worldTension: number;                   // 0..100 (グローバル)
}
```

アクション: `justifyWarGoal` / `declareWar` / `guarantee` / `inviteToFaction` / `joinFaction` /
`leaveFaction` / `improveRelations` / `sendVolunteers` / `lendLease` / `demandTerritory`。
政治力 (political power) を消費。world tension が閾値を超えると民主国家も参戦可能になる。

**降伏 (capitulation)**: `capitulationProgress = Σ(敵に支配された自国 VP) / Σ(自国 VP)`。
`> country.surrenderLimit (既定 0.8)` で降伏 → 全 province が敵陣営に移譲、部隊消滅、陣営から離脱。

**テスト**: 宣戦で war が生成され両陣営の同盟国が引き込まれる、VP 占領で降伏閾値を超えると capitulate、
world tension の増減、降伏後に部隊が残らないこと。

---

### 2.6 `ai-opponent` — AI

各国 1 AI。CPU 予算のため **国を曜日で分散** (`countryId % 7 === dayOfWeek` の国だけが重い再評価を行う)。

```
経済 AI (daily):
  - 建設優先度: 軍需工場 < 民需工場 (序盤) → 戦時は軍需 + インフラ + 対空
  - 生産ライン: 陸軍装備 60% / 支援 15% / 砲兵 15% / 空軍 10% (国の doctrine で変動)
軍事 AI (weekly + 戦時は daily):
  - 前線割当: 自国 & 同盟国の敵接触 province を frontline として抽出、師団を距離で貪欲割当
  - 攻勢判定: 局所戦力比 > 1.4 かつ補給 > 0.6 → offensive order
  - 撤退判定: org < 25% → 後方 province へ
外交 AI (weekly):
  - 陣営リーダーは弱い隣国に war goal を正当化
  - 中立国は world tension と自国戦力で陣営参加を判断
```

AI は Command を発行するだけで、実行はプレイヤーと同じコードパスを通る (バグの二重化を防ぐ)。

**テスト**: AI のみで 1936→1945 をヘッドレス実行してクラッシュしないこと、必ず勝敗が決すること、
1 日あたりの AI 計算時間が予算内 (< 2ms) であること。

---

### 2.7 `map-render` — 描画

Pixi のシーングラフ (下から順):

| # | レイヤ | 実装 | 更新頻度 |
|---|---|---|---|
| 0 | 海洋 | 全画面 Mesh + カスタムシェーダ (深度グラデ + 低周波ノイズの波) | 毎フレーム (time uniform) |
| 1 | 陸地ベース | `RenderTexture` にベイクした陰影起伏風テクスチャ | 静的 |
| 2 | province 塗り | `Mesh` (earcut 済み) × 1、頂点カラーで所有国色。所有変更時のみ VBO 部分更新 | 稀 |
| 3 | 湖・河川 | `Graphics` (静的、1回ベイク) | 静的 |
| 4 | province 境界 | 細線。ズーム < 閾値では非表示 | 静的 |
| 5 | 国境 | 太線 + 外側グロー。所有変更時に再生成 | 稀 |
| 6 | 前線・戦闘 | 前線ライン (赤)、戦闘アイコン (点滅) | 毎フレーム |
| 7 | 選択ハイライト | 選択 province の輪郭アニメーション | 毎フレーム |
| 8 | 部隊カウンタ | NATO 記号スプライト。同一 province は集約して 1 カウンタ + 数字 | tick 毎 |
| 9 | 移動矢印 | ベジエ矢印 (`Graphics`、命令変更時のみ) | 稀 |
| 10 | ラベル | `BitmapText`。ズーム段階で LOD (国名 → 州名 → VP名) | ズーム変更時 |

**LOD**: ズーム倍率 z に応じて
`z < 1.2`: 国境 + 国名のみ / `1.2 ≤ z < 3`: + state 境界 + 州名 / `z ≥ 3`: + province 境界 + 全ラベル。

**マップモード**: `political` / `terrain` / `resource` / `supply` / `frontline` / `victoryPoints`。
モード切替は province 塗りメッシュの頂点カラー配列を書き換えるだけ (再三角分割なし)。

**パフォーマンス予算 (mobile, DPR 2, 390×844)**: フレーム 16.6ms のうち
描画 ≤ 8ms / シミュレーション ≤ 4ms / UI 更新 ≤ 2ms。
`resolution = min(devicePixelRatio, 2)`、`antialias: false` + 自前 FXAA 相当は使わない (境界線は太めに描く)。

---

### 2.8 `touch-input` — タッチ操作

PointerEvent ベースの状態機械。マウスでも同一コードで動作 (テスト容易性)。

```
IDLE ──pointerdown(1)──▶ MAYBE_TAP ──移動 > 10px──▶ PAN ──pointerup──▶ INERTIA ──▶ IDLE
                            │  └─500ms 静止──▶ LONG_PRESS (コンテキストメニュー)
                            └──pointerup < 250ms──▶ TAP (province 選択)
MAYBE_TAP/PAN ──pointerdown(2)──▶ PINCH (2点間距離でズーム、中点でパン) ──1点解放──▶ PAN
部隊選択中 ──MAYBE_TAP が部隊カウンタ上──▶ DRAG_ORDER (指の先に矢印プレビュー) ──up──▶ move 命令
```

- ズーム範囲 `[0.6, 12]`、ピンチは中点をアンカーに保つ (`world` 座標固定)。
- 慣性: `v *= 0.92` / frame、`|v| < 0.05` で停止。
- パン境界: マップ bbox の 20% までオーバースクロール可、離すとバネで戻る。
- タップ判定は **移動距離 ≤ 10 CSS px かつ 250ms 以内**。
- `touch-action: none` + `preventDefault` でブラウザのスクロール/ダブルタップズームを抑止。
- タップターゲットは最小 44×44 CSS px (HUD ボタン)。

```ts
interface TouchController {
  attach(el: HTMLElement, camera: Camera): void;
  onTap: (world: Vec2, screen: Vec2) => void;
  onLongPress: (world: Vec2, screen: Vec2) => void;
  onDragOrder: (from: Vec2, to: Vec2, phase: 'start'|'move'|'end') => void;
  update(dtMs: number): void;    // 慣性・バネ
}
```

**テスト (Playwright, `page.touchscreen` + CDP `Input.dispatchTouchEvent`)**:
パン → カメラが移動 / ピンチ → ズーム倍率変化 + アンカー保持 / タップ → province 選択 /
部隊ドラッグ → 移動命令発行 / ダブルタップでブラウザズームが起きないこと。

---

### 2.9 `ui` — HUD

DOM (絶対配置 + CSS Grid)。Pixi キャンバスの上に重ねる。モバイル優先。

```
┌─────────────────────────────────────────────────┐
│ TOP BAR: 国旗 | PP | 人的資源 | 資源×6 | 日付 | ⏸ ▶ ▶▶ │  56px, safe-area-top
├─────────────────────────────────────────────────┤
│                                                 │
│                  MAP (Pixi canvas)              │
│                                                 │
│                      ┌──────────────┐           │
│                      │ province     │  ← タップで下からせり上がるシート
│                      │ tooltip/panel│           │
├─────────────────────────────────────────────────┤
│ BOTTOM NAV: 生産 建設 陸軍 外交 技術 マップモード      │  64px, safe-area-bottom
└─────────────────────────────────────────────────┘
```

- パネルはボトムシート (スワイプで開閉、3 段階のスナップ)。
- 更新は `requestAnimationFrame` 内で dirty な要素のみ `textContent` を書き換え (レイアウトスラッシング回避)。
- アラート (戦闘発生、生産完了、宣戦布告) はトーストキュー。

---

### 2.10 `asset-generation` — 画像アセット

`tools/asset-gen/` の Node スクリプトが `public/assets/` を決定論的に生成する。
外部画像を実行時に取得しない (オフライン動作 + ライセンス安全)。

| アセット | 実績数 | 形式 | 生成方法 |
|---|---|---|---|
| 国旗 | 30 | SVG (60×40) | 1936 年時点の旗を矩形 / 北欧十字 / 三色旗 / 三日月等のプリミティブで記述したテーブルから生成。ナチ党旗は描画しない (黒白赤の三色旗を使用) |
| NATO 兵科記号 | 12 | SVG (48×32) | 歩兵 (×)、機甲 (楕円)、自動車化、砲兵 (●)、山岳 (∧)、海兵、空挺、騎兵 等 |
| 資源アイコン | 6 | SVG (32×32) | 石油・鋼鉄・アルミ・タングステン・ゴム・クロム |
| UI アイコン | 16 | SVG (32×32) | 工場、造船所、人的資源、政治力、研究、外交、生産、建設、補給、警告 等 |
| 地形/海洋/紙目/グロー テクスチャ | 4 | 手続き生成 (実行時) | seeded value noise + fBm。**帯域ゼロ**、スクリーンショット差分も安定 |
| ビットマップフォント | 3 | Pixi `BitmapFont.install` | 国名 (serif)、州名、都市名。グリフアトラス 1 枚で全ラベルを 1 バッチ描画 |

**実績: 64 ファイル / 22.1 KB (gzip 13.5 KB)**、`public/assets/manifest.json` に全件記録。
テストで合計容量・最大ファイル・在庫リスト・初回ロード時間を検証する
(**閾値: 全アセット ≤ 300KB、map.json ≤ 900KB、起動 ≤ 12s、初回転送 ≤ 3MB**;
実測: 22.1KB / 449KB / 約 2.0s / 約 1.1MB)。

---

## 3. ゲームステート

```ts
interface GameState {
  meta: { version: number; scenario: string; seed: number; playerCountry: CountryId };
  clock: GameClock;                       // { totalHours, year, month, day, hour }
  rng: { s: number };                     // mulberry32 の内部状態
  countries: Country[];                   // index === CountryId
  provinces: ProvinceState[];             // index === ProvinceId (静的 geo とは別)
  states: StateRuntime[];
  divisions: Division[];                  // 削除は tombstone (id 安定のため)
  combats: Combat[];
  factions: Faction[];
  wars: War[];
  nextIds: { division: number; combat: number; line: number; construction: number };
  outcome: { status: 'playing'|'victory'|'defeat'; reason?: string; day?: number };
}

interface ProvinceState {
  owner: CountryId; controller: CountryId;
  victoryPointsHeld: number;
  supply: number;                          // 0..1
  fortLevel: number;
  divisions: DivisionId[];                 // 駐留 (キャッシュ、毎 tick 再構築しない)
}

interface Country {
  id: CountryId; tag: string;              // 'GER','FRA','SOV',...
  name: string; color: [number, number, number];
  capital: ProvinceId;
  economy: Economy;
  productionLines: ProductionLine[];
  constructionQueue: ConstructionItem[];
  templates: DivisionTemplate[];
  diplomacy: DiplomaticState;
  factionId: FactionId | null;
  atWarWith: CountryId[];
  capitulated: boolean;
  isAI: boolean;
  ideology: 'fascist'|'democratic'|'communist'|'neutral';
  research: { slots: number; active: ResearchItem[]; completed: TechId[] };
}
```

**シリアライズ**: `JSON.stringify(state)` がそのままセーブデータ。`Float32Array` は state に含めない
(静的 geo 側のみ)。localStorage に保存、自動セーブは月次。

**決定論 RNG**:
```ts
function mulberry32(s: number) { return () => { s = (s + 0x6D2B79F5)|0; let t = Math.imul(s ^ (s>>>15), 1|s);
  t = (t + Math.imul(t ^ (t>>>7), 61|t)) ^ t; return ((t ^ (t>>>14))>>>0) / 4294967296; }; }
```

---

## 4. シナリオ: *Europe 1936*

- **開始**: 1936-01-01。プレイ可能: ドイツ / フランス / イギリス / ソ連 / イタリア (既定はドイツ)。
- **陣営**: 枢軸 (独伊) / 連合 (英仏) / コミンテルン (ソ) + 中立国 ~35。
- **勝利条件**: 敵陣営の全メンバーが降伏 → `victory`。
- **敗北条件**: プレイヤー国が降伏 → `defeat`。
- **時間切れ**: 1948-01-01 到達で、支配 VP の多い陣営の勝ち (`victory` / `defeat` に解決)。
  ※ 必ず有限時間で決着することを保証する (無限ループ防止 + テスト可能性)。

---

## 5. 検証戦略

### 軽量 (サブシステム完成ごと・毎回)
```
npm test          # Vitest。時間進行 / 資源 / 戦闘 / 経路 / 外交 / AI の単体テスト
npm run typecheck # tsc --noEmit
```

### 重量 (2-3 サブシステムの節目のみ)
```
npm run test:e2e     # Playwright / headless Chromium (Pixel 7 相当 412×869, DPR 2)
  ├ screenshot   8 シーン + 決定論チェックを撮影し 32px タイル単位で差分比較。
  │              「変更のあった領域」をタイル座標で報告する。
  │              閾値: 変化率 2% 超のタイルが 4 枚以下。
  │              UPDATE_SNAPSHOTS=1 で意図的な変更を再ベースライン。
  ├ perf         フレーム時間を **ゲーム自身の処理 (scene)** と
  │              **ラスタライズ (draw)** に分けて計測する。
  │              このコンテナには GPU がなく Chromium は SwiftShader
  │              (ソフトウェアラスタライザ) で動くため、wall clock は
  │              実機 GPU を代表しない。判定は scene 側に対して行う。
  │              閾値: p50 ≤ 16.6ms, p95 ≤ 24ms, p99 ≤ 33.3ms (= 30fps 下限)
  │              加えてシーングラフのノード数と マップモード切替コストを検証。
  ├ touch        パン / 慣性 / ピンチ (ズーム・アンカー保持・クランプ) /
  │              タップ選択 / ドラッグによる移動命令 / マップモード / 速度制御 /
  │              ページ自体がスクロール・ズームしないこと
  └ assets       manifest 容量・在庫、map.json 容量、起動時間、転送量、
                 全国旗/アイコンの 404 チェック
```

> **Chromium タッチエミュレーションの制約**: 1 ページにつきマルチタッチ
> シーケンスは 1 回しか受け付けられない (2 回目の 2 点 touchStart は
> pointerdown が 1 つしか発火しない)。そのためピンチ系のテストは
> 1 ページ 1 ジェスチャに分割している。

### 完走テスト
```
npm run test:scenario   # ヘッドレス (ブラウザ非起動)、AI vs AI で 1936→決着まで
                        # 検証: クラッシュなし / outcome !== 'playing' / 状態不変条件が毎月成立
```

**状態不変条件 (毎月アサート)**
1. 全 division の `provinceId` が有効、`org/hp` が `[0, max]`
2. 全 province の `controller` が存在する国、降伏国が province を支配していない
3. 資源・人的資源・在庫が非負
4. 戦闘に参加している division の `combatId` が実在する combat を指す
5. 両陣営の division 総数が上限内 (メモリリーク検出)

---

## 6. 実装順序

| Step | 内容 | 検証 |
|---|---|---|
| 1 | 骨格: GameState / RNG / time-engine / Command バス | unit |
| 2 | province-data パイプライン (国単位) + ProvinceIndex | unit |
| 3 | map-render (国境のみ) + touch-input | unit + **e2e** |
| 4 | production + 資源 | unit |
| 5 | military-units (移動・戦闘・補給) | unit |
| 6 | diplomacy + ai-opponent | unit + **scenario** |
| 7 | ui (HUD / パネル) + asset-generation | **e2e** |
| 8 | province 細分化 (第2イテレーション) | unit + **e2e** |
| 9 | 最終検証ループ (perf / screenshot / touch / scenario) | 全部 |

実装中に検証で発見し修正した主な不具合は `docs/FINDINGS.md` に記録している。

---

## 7. ディレクトリ

```
/
├ ARCHITECTURE.md
├ package.json  tsconfig.json  vite.config.ts  vitest.config.ts  playwright.config.ts
├ index.html
├ public/
│  ├ data/map.json
│  └ assets/{flags,units,icons}/*.svg  manifest.json
├ src/
│  ├ main.ts
│  ├ sim/                 ← DOM 非依存・決定論
│  │  ├ core/       { GameState.ts, rng.ts, ids.ts, commands.ts, invariants.ts }
│  │  ├ time/       { TimeEngine.ts, calendar.ts }
│  │  ├ map/        { ProvinceIndex.ts, pathfind.ts, terrain.ts }
│  │  ├ economy/    { production.ts, construction.ts, resources.ts, equipment.ts }
│  │  ├ military/   { division.ts, movement.ts, combat.ts, supply.ts, encirclement.ts }
│  │  ├ diplomacy/  { diplomacy.ts, war.ts, capitulation.ts }
│  │  ├ ai/         { economyAI.ts, militaryAI.ts, diplomacyAI.ts }
│  │  └ scenario/   { europe1936.ts, victory.ts }
│  ├ render/        { MapRenderer.ts, layers/*.ts, Camera.ts, shaders/*.ts, palette.ts }
│  ├ input/         { TouchController.ts, gestures.ts }
│  ├ ui/            { Hud.ts, panels/*.ts, toast.ts }
│  └ app/           { Game.ts (合成ルート), loop.ts }
├ tools/
│  ├ map-build/     { fetch.ts, project.ts, simplify.ts, provinces.ts, build.ts }
│  └ asset-gen/     { flags.ts, natoIcons.ts, resourceIcons.ts, build.ts }
└ tests/
   ├ unit/*.test.ts
   ├ scenario/full-run.test.ts
   └ e2e/{screenshot,perf,touch,assets}.spec.ts
```
