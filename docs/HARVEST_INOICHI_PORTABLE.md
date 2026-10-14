# HARVEST + INOICHI 移植・復元ガイド

> 目的: Verdent workspace が利用不能になっても、別の Windows PC から Git  clone またはファイルコピーで HARVEST + INOICHI Prototype 0 を復元・動作させられる状態にする。

## 1. 必要環境

|項目|要件|備考|
|---|---|---|
|OS|Windows 10/11|開発・実行ともに Windows 想定|
|Node.js|>= 18.0.0|package.json `engines` 準拠。動作確認は v24.19.0|
|npm|Node 同梱|
|Git|任意|clone用。なければ zip ダウンロードでも可|
|ブラウザ|Google Chrome または Microsoft Edge|Cortex capture extension は Chromium 系必須|
|インターネット接続|必須|CDN, LINE API, Google Maps API, Render 外部 URL 等への接続に必要|
|メモリ/ディスク|通常の開発用 PC レベル|

## 2. Git から取得する方法

```bash
git clone <repo-url>
cd <repo-directory>
git checkout feat/inoichi-prototype0
```

現在の HARVEST + INOICHI 対象 branch: `feat/inoichi-prototype0`

注意: この branch には HARVEST Prototype 0 と INOICHI Prototype 0 が含まれている。`main` にはまだ merge していない。

## 3. npm install 等の初期セットアップ

```bash
npm ci
```

`package-lock.json` が存在するため、`npm ci` を推奨。依存は以下:

- `express`
- `axios`
- `archiver`, `archiver-zip-encrypted`
- `multer`
- `unzipper`
- `xlsx`

## 4. 必要な環境変数一覧

以下の環境変数を `.env` ファイルまたは Render/ホスト OS の環境変数で設定する。**値そのものは Git に含めない。**

|名称|用途|なしの場合|
|---|---|---|
|`PORT`|OFK3 サーバー待受ポート|3000 が使われる|
|`CHANNEL_ACCESS_TOKEN`|LINE Messaging API チャネルアクセストークン|LINE 系機能が動作しない|
|`ADMIN_LINE_ID`|管理者 LINE ユーザー ID|管理者通知が飛ばない|
|`GOOGLE_MAPS_API_KEY`|Google Maps Geocoding / Static Map API|地図・ジオコーディングが動作しない|
|`GAS_URL`|Google Apps Script 連携 URL|GAS 連携機能が動作しない|
|`TENKO_SYNC_TOKEN`|/tenko-sync エンドポイント認証|sync エンドポイントが 503 になる|
|`NODE_ENV`|production 設定時は localhost 許可が変わる|development 動作|

## 5. Chrome/Edge 拡張の導入方法

### OFK3 本体はブラウザ拡張ではない
OFK3 は Web アプリ（`index.html` + `render-webhook-server.js`）。拡張は **Cortex データ取得** 専用。

### Cortex Capture Extension 導入
1. Chrome/Edge を開く
2. `chrome://extensions` （Edge は `edge://extensions`）
3. 右上の「デベロッパー モード」を ON
4. 「パッケージ化されていない拡張機能を読み込む」
5. リポジトリ内 `cortex-capture-extension/` フォルダを選択
6. `OFK3 Cortex Capture` が読み込まれたことを確認

## 6. Cortex Capture Extension の導入方法

上記 5 と同じ。拡張 ID はストア経由ではないため、読み込み先 PC ごとに変わる。

### 拡張の接続先切り替え
拡張はデフォルトで `https://ofk3-line-proxy-1.onrender.com` を参照。ローカル動作時は、拡張の `background.js` が参照する `chrome.storage.local` の `ofk3TargetBaseUrl` を `http://localhost:3000` に変更するか、ソース内の `OFK3_PRODUCTION_BASE_URL` を一時変更して再読み込みする。

## 7. OFK3 起動方法

```bash
npm start
```

または

```bash
node inject-tenko-audit.js
```

`inject-tenko-audit.js` は `index.html` に必要な `<script>` を注入し、同じプロセスで `render-webhook-server.js` を起動する。

### 起動後の確認
- ブラウザで `http://localhost:3000` を開く
- コンソールに `GOOGLE_MAPS_API_KEY configured: ...` 等が表示される

## 8. HARVEST 動作確認方法

1. Cortex Capture Extension を読み込んだブラウザで Amazon Logistics （`https://logistics.amazon.co.jp/*`）を開く
2. 拡張アイコンをクリックし「取得開始」→「Bag 取得」→「OFK3 へ送信」を実行
3. `http://localhost:3000` を開き、ダッシュボード上部の「HARVEST Collector 確認」ボタンをクリック
4. オーバーレイ内で `timeWindow` / `bag` collector の status が `ok` / `partial` / `stale` 等になっていることを確認
5. 「handoff 準備」ボタンを押すと `harvest:handoff` イベントが発火する

## 9. INOICHI dry-run 確認方法

1. HARVEST 動作確認後、ダッシュボード上の「INOICHI 変換(dry-run)」ボタンをクリック
2. オーバーレイ内に以下が表示される:
   - 入力件数
   - 正常 / partial / rejected 件数
   - dataType 別件数
   - diagnostics
   - 最終 Payload（JSON）
3. dry-run は OFK3 への実書き込みを行わない（`written: false`）
4. コンソールからも実行可能: `window.OFK3Inoichi.runDryRun()`

## 10. 正常稼働判定

|確認項目|OK基準|
|---|---|
|`npm run test:inoichi`|全テスト PASS（20 tests / 76 assertions）|
|`npm run test:harvest`|全テスト PASS|
|`npm start`|ポート 3000 で起動、コンソールにエラーなし|
|Cortex 拡張|Amazon Logistics ページでパネルが開き、送信成功|
|HARVEST UI|Collector status が正常系 or partial/stale でエラーでない|
|INOICHI dry-run|envelope 生成され、`written: false`、`ready: true`|

## 11. 別 PC 移行時に手動コピーが必要なもの

以下は Git 管理外のため、別 PC 移行時に手動で移行または再作成が必要:

- `node_modules/` （`npm ci` で再生成可）
- ブラウザ localStorage に保存された設定:
  - LINE bot 設定（channel access token, channel secret, GAS URL 等）
  - `transportIDs`, `driverJapaneseNames`, `phoneMapping`, `lineMapping`
  - `teamQualitySnapshot`, `driverDepartments`
  - `tenkoDate`
- Chrome/Edge 拡張のローカル設定（`chrome.storage.local` の `ofk3TargetBaseUrl`）
- Render 等ホスティング環境の環境変数
- サーバー上の一時ファイル/メモリデータ（`cortexPriorityStore`, `pdfStore`, `mapImageStore`, `tenkoSyncStore` 等）
- `.env` ファイル（もし作成していれば）

## 12. 秘密情報を Git へ含めないための注意

**以下を決して Git commit しないこと:**

- `.env` ファイル
- 環境変数の値を含むメモ・ログ
- `CHANNEL_ACCESS_TOKEN`, `ADMIN_LINE_ID`, `GOOGLE_MAPS_API_KEY`, `GAS_URL`, `TENKO_SYNC_TOKEN` の値
- Chrome 拡張のローカルストレージダンプ
- `localStorage` のエクスポート JSON（機密を含む場合）

リポジトリには `.gitignore` があれば `.env` を追加する。現状 `.env` ファイルは存在しない。

## 13. トラブル時の復旧方法

### サーバーが起動しない
- `npm ci` 実施済みか確認
- ポート 3000 が他プロセスで使われていないか確認
- `PORT` 環境変数で別ポートを指定

### テストが落ちる
- `npm run test:inoichi` で落ちる場合は `node_modules` を削除して `npm ci` し直す
- `test:harvest` も同様

### HARVEST がデータを取得しない
- Chrome/Edge 拡張が読み込まれているか確認
- 拡張の「取得開始」から「OFK3 へ送信」までの手順を確認
- サーバー側 `cortexPriorityStore` はメモリのため、サーバー再起動で消える。再度拡張から送信する

### INOICHI dry-run ボタンが出ない
- `inject-tenko-audit.js` / `render-webhook-server.js` の script 注入が正しく行われているか確認
- ブラウザコンソールで `window.OFK3Inoichi` が存在するか確認
- 存在しない場合は `inoichi-core.js` と `ofk3-inoichi-ui.js` が `<script>` タグで読み込まれているか確認

### 別 PC 移行後に設定が空
- localStorage の内容を手動で再入力するか、事前にエクスポートしておいた JSON を import する
- LINE bot 設定画面（index.html 内）で再入力

---

## 現在のコミット情報

|対象|Branch|Commit hash|説明|
|---|---|---|---|
|HARVEST Prototype 0|`feat/harvest-prototype0`|`744bd17`|HARVEST collector hub prototype 0|
|HARVEST 修正|`feat/harvest-prototype0`|`76bd693`|awaiting-data 文言修正|
|INOICHI Prototype 0|`feat/inoichi-prototype0`|`7ec342c`|INOICHI Prototype 0 relay layer|

注意: `feat/inoichi-prototype0` branch には別案件（LINE 未紐付け / QR 印刷）のコミットも含まれている。INOICHI 自体の変更は `7ec342c` に集約されている。
