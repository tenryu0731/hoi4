# Iron Front — Europe 1936

モバイルブラウザ (Chrome / タッチ操作) で動作する、Hearts of Iron IV 風の
グランドストラテジーゲーム。実際のヨーロッパの地理データ (Natural Earth) を
使用し、国家運営・生産・部隊指揮・外交・リアルタイム時間進行を扱う。

```bash
npm install
npm run build      # 地図データ生成 → アセット生成 → バンドル
npm run preview    # http://0.0.0.0:4173 (同じ LAN のスマホからも開ける)
```

開発時は `npm run dev`。`?country=FRA` で操作国を、`?seed=123` でシードを、
`?static=1` でアニメーション停止 (スクリーンショット用) を指定できる。

### 実機で遊ぶ (サーバーなし)

```bash
npm run build:single   # → play.html (約 1.1 MB)
```

地図データ・アセット・スクリプトをすべて埋め込んだ 1 ファイル。スマホに
転送してブラウザで開けばそのまま起動する (`file://` でも動作、通信ゼロ)。
リポジトリのルートに出力してコミットしてあるので、静的配信するだけの
ホスティング (ブランチをそのまま公開する GitHub Pages など) でも
`<公開 URL>/play.html` が単体で動く。ゲーム側を変更したら再生成すること。

### GitHub Pages

`.github/workflows/pages.yml` が `npm run build:app` の成果物 (`dist/`) を
公開する。リポジトリの Settings → Pages → Source を **GitHub Actions** に
すること。ブランチをそのまま公開する設定では `index.html` は Vite の
開発用エントリなので動かない (その場合でも `/play.html` は動く)。

`index.html` は起動できなかったことを必ず画面に出す。ロゴの下に赤字が出た
場合、その本文が原因 (スクリプトを取得できない / 地図 JSON が 404 / WebGL
初期化失敗) を指す。リポジトリをそのまま静的配信すると `src/main.ts` は
実行できないため、必ずビルド成果物 (`dist/`) を配信すること。

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
