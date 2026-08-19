# Iron Front — Europe 1936

モバイルブラウザ (Chrome / タッチ操作) で動作する、Hearts of Iron IV 風の
グランドストラテジーゲーム。実際のヨーロッパの地理データ (Natural Earth) を
使用し、国家運営・生産・部隊指揮・外交・リアルタイム時間進行を扱う。

```bash
npm install
npm run build      # 地図データ生成 → アセット生成 → バンドル
npm run preview    # http://127.0.0.1:4173
```

開発時は `npm run dev`。`?country=FRA` で操作国を、`?seed=123` でシードを、
`?static=1` でアニメーション停止 (スクリーンショット用) を指定できる。

## 遊び方

| 操作 | 動作 |
|---|---|
| 1本指ドラッグ | 地図をパン (離すと慣性) |
| 2本指ピンチ | ズーム (指の間の点を固定) |
| タップ | プロヴィンス選択 → 下部シートに詳細 |
| 選択中の自軍スタックからドラッグ | 移動命令 |
| 下部ナビ | 生産 / 建設 / 陸軍 / 外交 |
| 右上 | マップモード (政治 / 地形 / 資源 / 補給 / 勝利点) |
| 右上の ⏸ ▶ とピップ | 一時停止と速度 1-5 |

**目的**: 1936 年 1 月 1 日開始。敵陣営の大国をすべて降伏させれば勝利、
自国が降伏すれば敗北。1948 年 1 月 1 日に到達した場合は勝利点で判定する
(シナリオは必ず有限時間で決着する)。

## 構成

```
src/sim/      シミュレーション (DOM 非依存・決定論的・Node で完結)
src/render/   PixiJS v8 / WebGL のマップ描画
src/input/    PointerEvent ジェスチャ認識
src/ui/       DOM の HUD とパネル
tools/        地図データ生成 (Natural Earth) / 画像アセット生成
tests/        unit (Vitest) / scenario (ヘッドレス完走) / e2e (Playwright)
```

設計は [ARCHITECTURE.md](./ARCHITECTURE.md)。
検証ループが実際に見つけた不具合の記録は [docs/FINDINGS.md](./docs/FINDINGS.md)。

## テスト

```bash
npm test            # 134 ユニットテスト (約 2.5 秒)
npm run typecheck
npm run test:scenario   # 1936→決着までのヘッドレス完走 × 11
npm run test:e2e        # スクリーンショット差分 / フレームタイム / タッチ / アセット
```

意図的に見た目を変えた場合は `UPDATE_SNAPSHOTS=1 npm run test:e2e` で
スクリーンショットのベースラインを更新する。

## データとアセットの出所

- 地理: [Natural Earth](https://www.naturalearthdata.com/) 50m
  (`nvkelso/natural-earth-vector`, public domain) をビルド時に取得し、
  ヨーロッパ範囲へクリップ → Lambert 正角円錐図法で投影 → 簡略化。
  現代の行政区画を 1936 年の政治地図へ再編成している
  (チェコスロバキア・ユーゴスラビア・ソ連の再構成、東プロイセンの復元など)。
- 画像: すべてビルド時に SVG として生成。外部画像は一切取得しない。
  地形・海洋・紙目テクスチャは実行時に seeded ノイズから合成する。
