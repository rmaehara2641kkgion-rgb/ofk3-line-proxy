# 静的ファイル公開ポリシー（SEC-04）

## 目的
`render-webhook-server.js` の `app.use(express.static(path.join(__dirname)))`（リポジトリルート全体の公開）を廃止し、
**ブラウザが実際に必要とするファイルだけをファイル単位で許可するデフォルト拒否方式**に置き換える。
サーバー側JS・仕様書・テスト・GAS・設定・内部JSON等が URL 直打ちで取得できる状態を解消する。

## 仕組み（`static-public-policy.js`）
- 許可リスト `PUBLIC_FILES`（63件）に**完全一致**したパスだけを配信する。拡張子単位・ディレクトリ単位の許可はない。
- リクエストのパスは許可リストの**照合キーとしてのみ**使う。実ファイルのパスは許可リスト側の定数から組み立てる。
- 次の形は照合前に拒否する: 不正/二重パーセントエンコード、NUL・制御文字、バックスラッシュ(`%5c`含む)、`.` `..` 空セグメント、
  末尾が `.`/空白のセグメント、`:`（ドライブ指定・NTFS代替データストリーム）、512文字超。大文字小文字は区別（完全一致）。
- `GET` / `HEAD` のみ。それ以外は `next()`（既存ハンドラ/404）。
- 未許可・不正・存在しない・ディレクトリは**応答せず `next()`** へ渡す。既存のAPIルート、後続の404処理はそのまま動く。
- 許可ファイルの実体（`realpath`）が許可リストのそのファイルと一致しない場合（シンボリックリンク等）は配信しない。
- 配信は `res.sendFile(rel, {root, dotfiles:'deny'})`。ETag/Last-Modified/Range（動画再生）は従来どおり。
  クエリ文字列（`?v=...` のキャッシュバスター）はパス照合に影響しない。
- 認証・API Guard・管理者ログインのCSP/ヘッダーは変更していない（ミドルウェアの位置は従来の `express.static` と同じ）。

`index.html`（`/` と `/index.html`）はサーバーの注入ルート（`app.get(['/', '/index.html'])`）が配信するため許可リストに含めない。
管理者ログイン（`/admin/login`, `/admin/login.js`）は `admin-session.js` の専用ルートが配信する。

## 公開許可ファイル一覧（63件）
| ファイル |
|---|
| `area-experience-core.js` |
| `assign-support-core.js` |
| `assign-support.js` |
| `billing-reconcile-core.js` |
| `contact-compliance-core.js` |
| `cortex-13-priority-core.js` |
| `cortex-13-priority.js` |
| `cortex-route-sequence.js` |
| `dnr-core.js` |
| `driver-ability-import-core.js` |
| `driver-cumulative-core.js` |
| `driver-cumulative-ui.js` |
| `driver-cumulative-xlsx.js` |
| `duty-hours-format.js` |
| `duty-risk-dashboard.js` |
| `duty-risk-snapshot.js` |
| `harvest-daily-manifest.js` |
| `harvest-rolling60h-run.js` |
| `lat-departure-core.js` |
| `lat-timeline-core.js` |
| `line-unlinked-core.js` |
| `manual-assign-board-core.js` |
| `manual-assign-board.js` |
| `nearby-course-core.js` |
| `ofk3-bag-sheet.js` |
| `ofk3-cortex-priority-ui.js` |
| `ofk3-delivery-map.js` |
| `ofk3-map-cortex-overlay.js` |
| `ofk3-nearby-course-ui.js` |
| `qr-print-order-core.js` |
| `rolling60h-board-ui.js` |
| `rolling60h-core.js` |
| `rolling60h-dispatch-ui.js` |
| `rolling60h-dispatch.js` |
| `rolling60h-local-board.js` |
| `rolling60h-local-store.js` |
| `rolling60h-prefix-view.js` |
| `rolling60h-summary-bridge.js` |
| `rolling60h-ui.js` |
| `tenko-transport-audit-success.js` |
| `tenko-transport-audit.js` |
| `ofk3-time-window-board.js` |
| `gds-fleet-audit-core.js` |
| `ofk3-gds-fleet-audit-ui.js` |
| `harvest-core.js` |
| `harvest-collectors-cortex.js` |
| `harvest-collector-rolling60h.js` |
| `ofk3-harvest-ui.js` |
| `inoichi-core.js` |
| `inoichi-detection-core.js` |
| `inoichi-detection-rules.js` |
| `inoichi-time-window-adapter.js` |
| `inoichi-quality-dryrun.js` |
| `inoichi-rolling-dryrun.js` |
| `ofk3-inoichi-ui.js` |
| `vendor/sheetjs/xlsx-0.20.3.full.min.js` |
| `ofk3-ops-console.css` |
| `assets/gion-ofk3-logo.png` |
| `logo-cityact.png` |
| `logo-flex.png` |
| `logo-gds.png` |
| `ofk3-splash.mp4` |
| `route-map.html` |

内訳: `index.html` が読み込むスクリプト 40 / サーバー・起動スクリプトが注入するスクリプト 15 / SheetJS 0.20.3 自社配信 1 / CSS・画像・動画 6 / HTML 1（`route-map.html`）。

## 非公開になる主なファイル
- サーバー側JS: `render-webhook-server.js` `admin-session.js` `api-guard.js` `inject-tenko-audit.js` `harvest-local-server.js` `duty-risk-*.js`（フロント以外）ほか
- `docs/` `tests/`（テストデータ・fixtures含む） `scripts/` `legacy/` `local/` `gas/` `*.gs` `node_modules/` `.git/`
- `package.json` `package-lock.json` `render.yaml` `.env*` `.gitignore` 等の設定・デプロイ定義
- `cortex-capture-extension/`（ブラウザ拡張のソース）、`demo-app/`（別サービス）、`vendor/sheetjs/LICENSE`
- `README.md` `PROJECT_OVERVIEW.md`、リポジトリ直下の未参照の画像・GIF・動画（`ofk3-splash.png/gif` 等）
- `manual.html` `presentation-short.html`（下記）

## 業務影響の確認事項
- `manual.html` / `presentation-short.html`: コード内に参照が無く、`index.html` からもリンクされていないため**非公開（404）**とした。
  外部で共有しているURL（ブックマーク・メール・LINE等）がある場合は 404 になる。必要なら `PUBLIC_FILES` に1行追加すれば復活する。
- `demo-app/` は別サービス（`demo-app/render.yaml`・独自 `server.js`）のため本ポリシーの対象外。デモ画面から本番の `route-map.html` へ張るURLは維持している。
- `harvest-local-server.js` はローカル専用の別サーバーで、独自の明示ファイルマップを持つため影響なし。

## ファイルを追加するとき
新しいブラウザ向けJS/CSS/画像を `index.html` やサーバー注入に追加したら、`static-public-policy.js` の `PUBLIC_FILES` にも**1ファイルずつ**追記する。
忘れても `tests/static-public-policy.test.mjs` の完全性テスト（index.html・注入タグの依存が全て許可リストにあること）が失敗する。

## テスト
```
npm run test:static-policy
```
独立したテスト用Expressアプリ（合成ファイル）と、実リポジトリ・実 `admin-session.js`/`api-guard.js`・**実際に起動した `render-webhook-server.js`** に対するHTTPテスト。
許可ファイルの取得（JS/CSS/画像/動画/SheetJS/route-map）、GET/HEAD/Range、クエリ付きURL、未許可・非公開ファイルの拒否（リポジトリ内の許可リスト外の全ファイル）、
パストラバーサル・二重エンコード・NUL・Windowsパス・代替データストリーム・大文字小文字・シンボリックリンクの迂回拒否、既存API/管理者ログイン/index注入ルートへの非影響を確認する。
実業務データ・外部API・LINE送信は使わない（ローカル 127.0.0.1 のみ）。

## 残存リスク・今回の対象外
- 許可ファイル内の情報（フロントのJSは公開前提）。管理者LINE ID等が `index.html`・`render-webhook-server.js` に直書きされている件は別課題（`index.html` は従来どおり配信される）。
- CORS・CSP・HTTPセキュリティヘッダー、ZIP展開容量、`test:assign-support` の既存失敗、依存パッケージの脆弱性等は本変更の対象外。
- 本変更はデプロイ前に、Renderのステージング等で画面（HARVEST/INOICHI/CORTEX/Rolling60h/点呼/配送MAP/請求照合）の実画面確認を行うこと。
