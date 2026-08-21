# OFK3 配送アプリ — 本番正本とディレクトリ構成

Phase 0（2026-08）時点の調査メモ。**本番修正は必ず `root/index.html`（リポジトリ直下）へ行う。**

## エントリポイント一覧

| 用途 | パス | Render 本番で使用 |
|------|------|-------------------|
| **Production Entry** | `index.html`（repo root） | **はい** — `/` および `/index.html` |
| **Demo** | `delivery-app/demo-app/index.html` | いいえ — 別サーバ `demo-app/server.js` 想定 |
| **Legacy / Development Copy** | `delivery-app/index.html` | **いいえ** — URL `/delivery-app/index.html` では到達可能だがデフォルトではない |

## Render 本番配信経路

```
render.yaml
  startCommand: node render-webhook-server.js
package.json
  start: node inject-tenko-audit.js  → require('./render-webhook-server.js')

render-webhook-server.js L48:
  app.use(express.static(path.join(__dirname)));  // repo root を静的配信

結果:
  GET /              → index.html（root）
  GET /index.html    → index.html（root）
  GET /lat-departure-core.js  → root の JS
  GET /assign-support.js      → root の JS
  GET /delivery-app/index.html → 到達可能だが本番デフォルトではない
```

- **起動ファイル:** `inject-tenko-audit.js` → `render-webhook-server.js`
- **express.static 対象:** リポジトリ直下（`__dirname`）
- **本番 HTML 正本:** `index.html`（root）

## 外部 JS の参照関係

両 `index.html` は末尾で **絶対パス `/...`** を参照するため、Render 本番では **常に root 配下の JS** が読み込まれる。

| ファイル | root/index.html | delivery-app/index.html | root 実体 | delivery-app コピー | 本番で使われる実体 |
|----------|-----------------|-------------------------|-----------|---------------------|-------------------|
| lat-departure-core.js | `/lat-departure-core.js` | 同左 | あり | あり（同一 MD5） | **root** |
| assign-support-core.js | `/assign-support-core.js?v=20260818-6` | `/assign-support-core.js?v=20260816-1` | あり（新） | あり（**古い**） | **root** |
| assign-support.js | `/assign-support.js?v=20260818-6` | `/assign-support.js?v=20260816-1` | あり（新） | あり（**古い**） | **root** |
| tenko-transport-audit.js | root v20260812-3 | da v20260812-2 | あり（新） | あり（古） | **root** |
| tenko-transport-audit-success.js | 同上 | 同上 | あり | あり | **root** |

`delivery-app/*.js` はローカル開発用の**重複コピー**であり、Render 本番では通常参照されない（HTML が `/` 始まりのため）。

## root vs delivery-app/index.html 比較（2026-08 調査）

| 指標 | root | delivery-app |
|------|------|--------------|
| 行数 | ~17,595 | ~16,958 |
| 関数数（inline） | 多い | root の部分集合（**da-only 関数 0 件**） |
| root-only 関数 | 41（LAT Phase3 パーサ、FTDS/CC 累積 import、協力会社スコア等） | — |

### 機能タブ（両方に存在 — 同一 UI 構成）

本日ダッシュボード、アサイン・最適化、時間指定、マスタ、ドライバー、点呼、点呼照合、WH60、仕分けスキャン、住所検索、MAP、物量、台数照合、FTDS/CC、品質、協力会社、経営、請求、LAT

### 分類サマリ

| 分類 | 内容 |
|------|------|
| **A. root のみ** | `parseLatDspRouteData` 系（LAT Phase 3）、Assign Phase 1.5–1.8（`as-generate-suggestions-btn`、`parseScheduleCellWorkHint`、`__ofk3MasterLoadStatus` 等）、FTDS/CC 累積 import・協力会社レポート系 inline 関数 41 件 |
| **B. delivery-app のみ** | **重要な未移植機能なし**（inline 関数として root にないものは 0 件） |
| **C. 両方同一** | タブ構成・大部分の UI / ロジック（歴史的コピー） |
| **D. 両方あるが実装差** | **LAT `handleDspFile`**（root=本番パーサ、da=旧 strict `employee_id` 必須 + 診断 log）、**アサイン支援**（root=Phase 1.8 まで、da=Phase 1 相当の HTML）、外部 JS キャッシュバージョン文字列 |

## demo-app の役割

- パス: `delivery-app/demo-app/`
- タイトル: 「配送管理 - OFK3（デモ版）」
- `demo-app/server.js` が `demo-app/index.html` を `/` で配信。Sentry なし、`demo-data.js` 注入。
- Render 本番とは独立。プレゼン・オフライン demo 用。

## LAT 修正履歴 — どちらに入ったか

| Commit | 内容 | root | delivery-app | 本番影響 |
|--------|------|------|--------------|----------|
| `93fc918` | LatDepartureCore + timeline 判定/X軸 | — | **✓ 最初はここだけ** | **未反映**（本番は root） |
| `27e99b8` | 上記を root へ port | **✓** | — | 反映 |
| `d89f79f` | dspRouteMap 本番 CSV パーサ | **✓** | — | 反映 |
| `bb3517e` | LAT 診断 log（2789048-15） | — | **✓** | 本番対象外 |
| `c0e74ec` | 同上を root へ | **✓** | — | 反映 |

### 事故パターン（明文化）

> **「修正済みと思ったが本番対象外だった」**

1. `93fc918` で `delivery-app/index.html` のみ修正 → Render は root を配信するため本番に出ない
2. `delivery-app/index.html` を開いてローカル確認 → 動くように見えるが、本番 URL とは別ファイル
3. `d89f79f` は root のみ → 正しい手順。da 側は旧 `handleDspFile` のまま残存

## 将来整理案（今回は未実施）

| 案 | 内容 | 推奨度 |
|----|------|--------|
| A. delivery-app 削除 | 差分確認後に root のみ化 | 中 — da-only 重要機能は無いが、デモパスが `delivery-app/demo-app` に依存 |
| B. `legacy/delivery-app` へ移動 | 誤修正防止 + 履歴保持 | **高（中期）** |
| C. 差分移植後削除 | root が superset のため、移植作業はほぼ不要。削除前に da コピー JS への直リンクがないか再確認 | 高 |
| D. 開発用途として残す | 現状。コメント + 本ドキュメントで防止 | **Phase 0 採用（短期）** |

**推奨:** 短期は **D（残す + 正本明示）** → 中期 **B または C**（`demo-app` は `demo/` へ独立移動を検討）。

## 誤修正防止（Phase 0 で追加）

- `delivery-app/index.html` 先頭 HTML コメント
- `index.html`（root）先頭 HTML コメント
- 本ファイル `docs/PRODUCTION-ENTRY.md`
