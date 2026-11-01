# INO-1 開発引き継ぎ

調査日: 2026-10-15  
対象リポジトリ: `C:\Users\PC-2320\ofk3-repo-link`  
Branch: `feat/inoichi-prototype1-detection`  
調査時の HEAD: `c5cfe55b94c68799a7f9e2651b075542ff906274`  
この文書は、その時点の実装と作業ツリーを読んで作成した。推測で埋めていない。未追跡の作業メモは、コードと一致する範囲だけを Step 番号の対応づけに使っている。

Dashboard、ローカルサーバー、デスクトップランチャー、対応するテスト、およびこの文書は、コミット `feat: add INO-1 prototype 1 dashboard and desktop launcher` で追跡する。親は上記 HEAD である。

既存の `docs/HARVEST_INOICHI_PORTABLE.md` は Prototype 0 の移植手順である。branch 表は `feat/inoichi-prototype0` / `7ec342c` のままで、この branch の Prototype 1 は載っていない。この引き継ぎではそのファイルは変更していない。

## 1. INO-1 の目的

INO-1（コード上の表記は INOICHI / INO-1）は、OFK3 の業務情報から問題やリスクを感知するためのエージェントである。

現在のコードが実際に行っていることは、次の二つに分かれる。

- Prototype 0: HARVEST が観測済みの時間指定（`timeWindow`）と Bag を受領し、検証・正規化して Envelope を作る。dry-run のみで、OFK3 へは書き込まない。
- Prototype 1: 車両台数の必要数と計画数を比較し、不足があればアラートを作り、状態を保持し、通知文面の dry-run を出す。Dashboard はサンプルデータだけを表示する。

運行計画と実績の差異、期限タスク、一般的な異常値、管理者への実通知、FRIDAY 連携は、構想としてはあるが、この branch の実装にはない。

INO-1 は業務操作を自分で実行しない。外部通知の送信口もない。

## 2. システム構成

実装は二つの系統で、互いに接続されていない。

```text
Prototype 0（コミット済み、OFK3 画面に載る）
  HARVEST collector (timeWindow, bag)
        |  harvest:handoff （実データは持たず payloadReference のみ）
        v
  window.OFK3Cortex13 の getter
        v
  inoichi-core.js  readInput / dryRun
        v
  ofk3-inoichi-ui.js  手動ボタンの dry-run 表示
  written: false

Prototype 1（検知ライブラリは c5cfe55 までにコミット済み。画面と起動はこの保存コミット）
  サンプルの fleet master / dateMap
        v
  inoichi-fleet-adapter.js  -> fleet-capacity-canonical
        v
  inoichi-detection-core.js + inoichi-detection-rules.js
        v
  inoichi-alert-store.js
        v
  inoichi-notification-adapter.js  （dry-run。送信しない）
        v
  inoichi-dashboard.*  （sampleMode: true）
        v
  inoichi-server.js    （127.0.0.1:8765）
        v
  inoichi-launch.ps1   （デスクトップショートカット）
```

OFK3 本体の車両比較は `index.html` にある。必要台数は `localStorage` の `fleetMasterV2`（無いときはコード内の初期値）、計画台数はアップロードされた配車データからその場で作る `dateMap` である。Fleet Adapter はこの形を入力にできるが、`index.html` から Adapter を呼ぶコードはない。

起動方式はローカル HTTP のままである。専用ウィンドウやデスクトップアプリ化は未決定であり、この引き継ぎでも変えていない。

## 3. 主要ファイルと役割

| ファイル | Git | 役割 |
|---|---|---|
| `harvest-core.js` | 追跡済み | collector hub。handoff は参照だけを渡す |
| `harvest-collectors-cortex.js` | 追跡済み | `timeWindow` と `bag` の collector |
| `ofk3-harvest-ui.js` | 追跡済み | HARVEST の確認 UI |
| `inoichi-core.js` | 追跡済み | Prototype 0。`timeWindow` / `bag` の正規化と dry-run |
| `ofk3-inoichi-ui.js` | 追跡済み | OFK3 上の「INOICHI 変換(dry-run)」 |
| `inoichi-detection-core.js` | 追跡済み | ルール評価、アラート生成、同一キーの更新と resolved |
| `inoichi-detection-rules.js` | 追跡済み | 既定ルールは空。サンプルの欠車ルール 1 件、`enabled: false` |
| `inoichi-fleet-adapter.js` | 追跡済み + 未コミット 3 行 | `fleetMaster` と `dateMap` を canonical input にする |
| `inoichi-alert-store.js` | 追跡済み | OPEN / ONGOING / RESOLVED / REOPENED と履歴 |
| `inoichi-notification-adapter.js` | 追跡済み | 通知候補と dry-run。実送信なし |
| `inoichi-dashboard.js` / `.html` / `.css` | この保存コミット | 調査用 Dashboard。サンプル固定 |
| `inoichi-server.js` | この保存コミット | `127.0.0.1:8765` の静的配信 |
| `inoichi-launch.ps1` | この保存コミット | 起動、二重起動防止、ブラウザを開く |
| `inoichi-stop.ps1` | この保存コミット | PID とコマンドラインを確認してから停止 |
| `inoichi-install-shortcut.ps1` | この保存コミット | デスクトップに起動・終了ショートカットを作る |
| `tests/inoichi-*.mjs` | P0 と Step 3–5 は c5cfe55 まで。Dashboard / Server / Launcher はこの保存コミット | 各層のテスト |
| `tests/inoichi-fixtures.mjs` | 追跡済み | Prototype 0 のテスト入力 |
| `docs/HARVEST_INOICHI_PORTABLE.md` | 追跡済み | Prototype 0 の移植手順。内容は古い |
| `tmp-*-dryrun.mjs` / `tmp-dryrun-example.mjs` | 未追跡 | 手元確認用スクリプト。製品ではない |

`package.json` の `test:inoichi` は Prototype 0 の 2 ファイルだけを実行する。Prototype 1 のテストは npm script に入っていない。

## 4. 現在の実装状況

### 実装済み

Prototype 0

- HARVEST handoff（`harvest:handoff`）を受け、`OFK3Cortex13` の getter から timeWindow と Bag を読む。
- 行の検証、正規化、diagnostics、Envelope 生成を行う。
- dry-run の結果は `written: false`。UI は手動ボタンだけで、handoff 受信だけでは変換しない。
- Bag の 14 状態は一つの status に潰さない。

Prototype 1 検知

- 比較演算子 6 種でルールを評価する。
- サンプルルール `fleet-capacity-shortage-v1` は、`actual < expected` のとき欠車アラートを作る。severity は不足 3 台以上で `critical`、1 台以上で `warning`。これはサンプルであり、公式の業務閾値ではない。ルール定義の `enabled` は `false`。Dashboard は表示時にだけ `true` にして使う。
- 検知エンジンの重複キーは `ruleId|localDate|block`。状態は `detected` / `acknowledged` / `resolved`。
- Alert Store のキーは `ruleId|localDate|hours`。状態は `OPEN` / `ONGOING` / `RESOLVED` / `REOPENED`。同じ hours は block が違っても 1 件になる。
- メモリ保存と、任意の `localStorage` アダプタがある。Dashboard のサンプルはアダプタなしのメモリだけを使う。
- 通知アダプタは候補とプレビューを作る。ONGOING、RESOLVED、dry-run でない実行、サンプルルール、宛先なし、根拠不足は抑止する。それらを通過しても、最後は `policy-not-confirmed` で抑止する。`eligible` を返す経路はない。
- Dashboard はサマリー、欠車一覧、履歴、通知 dry-run、診断を描画する。HTML は `sampleMode: true` と「サンプルデータ（本番未接続）」を固定している。
- ローカルサーバーは Node 標準モジュールだけを使う。GET と HEAD のみ。配信ファイルは allow-list。`127.0.0.1` が既定。
- デスクトップランチャーは Node の有無、応答による INO-1 識別、使用中ポートが他アプリなら起動中止、PID ファイル、コマンドラインと開始時刻が一致するプロセスだけ停止、ブラウザ起動を行う。

### 構想段階（コードにない）

- 配送計画と運行実績の差異検知
- 期限タスク検知
- 欠車以外の異常値ルール
- 公式業務ルールと、その承認済み閾値
- HARVEST から Prototype 1 検知へのデータ受け渡し
- Dashboard の実データ表示
- FRIDAY、LINE、webhook への実通知
- 検知結果に基づく配車変更その他の業務操作
- PostgreSQL
- Docker（リポジトリ直下に Dockerfile も compose もない）
- 専用ウィンドウ、デスクトップアプリ、ハイブリッド UI

PostgreSQL という語は `PROJECT_OVERVIEW.md` の点呼データ永続化候補にだけある。INO-1 の設計ではない。

## 5. 起動・終了手順

作業ディレクトリはリポジトリ直下。Node.js 18 以上。この環境の確認値は v24.19.0。

ショートカット作成:

```powershell
powershell -ExecutionPolicy Bypass -File .\inoichi-install-shortcut.ps1
```

確認を省く場合は `-Force`、または環境変数 `INO_ASSUME_YES=1`。既存の `INO-1 起動.lnk` は上書きせず、`INO-1 起動(1).lnk` のように別名で作る。承認済みロゴファイルはリポジトリに無い。アイコンは PowerShell の既定アイコンになる。

起動:

```text
デスクトップの「INO-1 起動」
  -> powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File inoichi-launch.ps1
  -> node inoichi-server.js
  -> ブラウザで http://127.0.0.1:8765/
```

既に INO-1 が応答していれば、新しいプロセスは作らずブラウザだけ開く。別アプリが 8765 を使っている場合は起動しない。

終了:

```text
デスクトップの「INO-1 終了」 -> inoichi-stop.ps1
```

`%LOCALAPPDATA%\INO-1\server.pid` の PID について、コマンドラインに `inoichi-server.js` があり、開始時刻が一致するときだけ停止する。

直接起動する場合:

```powershell
node inoichi-server.js
```

ポートは環境変数 `PORT`。ランチャー側の待受ポートは引数または `INO_PORT`（既定 8765）。ログは `%LOCALAPPDATA%\INO-1\launcher.log`。

Prototype 0 の dry-run は別経路である。OFK3 を `npm start` で起動し、HARVEST の handoff のあと、画面の「INOICHI 変換(dry-run)」を押す。コンソールでは `window.OFK3Inoichi.runDryRun()`。これはポート 8765 の Dashboard ではない。

## 6. テスト実行方法

Prototype 1 は npm script が無いので、ファイルを直接実行する。

```powershell
node tests/inoichi-launcher.test.mjs
node tests/inoichi-server.test.mjs
node tests/inoichi-dashboard.test.mjs
node tests/inoichi-fleet-adapter.test.mjs
node tests/inoichi-detection.test.mjs
node tests/inoichi-alert-store.test.mjs
node tests/inoichi-notification-adapter.test.mjs
npm run test:inoichi
```

`npm run test:inoichi` は `tests/inoichi-core.test.mjs` と `tests/inoichi-wiring.test.mjs` だけである。

ランチャーテストは一時ディレクトリとランダムポートを使い、デスクトップの実ショートカットは作らない。テスト用に `INO_TEST_NO_GUI`、`INO_NO_BROWSER`、`INO_PID_DIR`、`INO_DESKTOP_DIR` を使う。

### 2026-10-15 の再実行

Node v24.19.0。作業ツリーの未コミット変更を含んだ状態。

| テスト | 過去報告 | 今回 |
|---|---|---|
| Launcher `tests/inoichi-launcher.test.mjs` | 53/53 PASS | 53/53 PASS |
| Server | 39/39 PASS | 39/39 PASS |
| Dashboard | 23/23 PASS | 23/23 PASS |
| Fleet Adapter | 26/26 PASS | 26/26 PASS |
| Detection | 26/26 PASS | 26/26 PASS |
| P0 `npm run test:inoichi` | 20 tests / 76 assertions PASS | core 20 tests PASS、wiring 76 assertions PASS |
| Alert Store | 過去報告の表には無い | 27/27 PASS |
| Notification Adapter | 過去報告の表には無い | 24/24 PASS |

ランチャーテストの項目 (14) は、Server、Dashboard、Detection、Fleet Adapter、`npm run test:inoichi` を内部で再実行する。それも PASS した。

今回、デスクトップの実ショートカットを人がクリックする確認はしていない。その確認は、引き継ぎ前の利用者による実機確認として報告されている。

## 7. 安全設計

確認できた制限は次のとおり。

- Prototype 0 は dry-run で、`written: false`。OFK3 への書き込み、再 POST、外部通信をしない。
- 通知アダプタに `fetch`、XHR、POST はない。プレビューに宛先の token を出さない。完全な候補でも `policy-not-confirmed` で抑止し、送信可能状態を作らない。
- Dashboard に更新用フォームは無い。表示処理は acknowledge / resolve を呼ばない。サンプルデータ生成だけがメモリ上の Alert Store に `ingest` する。
- サーバーは既定で `127.0.0.1`。変更メソッドは 405。allow-list 外と `..` は 404。`package.json` や `.env` は配信しない。
- ランチャーは、応答ヘッダ `X-INOICHI-Server: inoichi-prototype1-step8`、または本文の Prototype 1 表示で INO-1 を識別する。他プロセスは停止しない。
- サンプルルールは既定で無効。Dashboard はサンプルであることをバナーに出す。
- 秘密情報は Step 8 のスクリプト、サーバー、Dashboard には無い。ログ先はローカルの `%LOCALAPPDATA%\INO-1`。識別用トークンは公開の固定文字列で、認証秘密ではない。

残っている境界:

- サーバーの bind アドレスは `HOST` 環境変数で上書きできる。既定だけが `127.0.0.1`。
- Alert Store の `localStorage` アダプタはブラウザ上では実在の `localStorage` に書く。Dashboard のサンプル初期化はアダプタを渡していない。
- 検知エンジンと Alert Store で、同一アラートのキーと状態名が違う。画面が見ているのは Alert Store 側である。

## 8. 未実装機能

第 4 節の「構想段階」が未実装の一覧である。加えて、ライブラリとしてはあるが製品の動作経路に入っていないものがある。

- Fleet Adapter は OFK3 の `fleetMasterV2` / `dateMap` を受けられるが、OFK3 画面からは呼ばれない。
- Dashboard の `initDashboard` は `detect()` を呼ぶが、その戻り値は描画に使っていない。見えているアラートは `generateSampleStore()` が直接作ったサンプルである。
- 既定ルール配列は空である。
- 通知の `eligible` は定数としてあるが、ポリシーは返さない。
- FRIDAY というモジュールは無い。テストは、各ファイルに `friday` という文字列が無いことを確認している。

## 9. 既知の制約

- `c5cfe55` には Dashboard、サーバー、ランチャーは無い。この保存コミット以降の branch 先頭には含まれる。
- 保存前、この branch は `origin/feat/inoichi-prototype1-detection` より 2 commit 進んでいた。進んでいたのは Fleet Adapter と Alert Store（`db84081`）、Notification Adapter（`c5cfe55`）。この保存コミットを加えると 3 commit 先行になる。push はしていない。
- `inoichi-fleet-adapter.js` に未コミットの 3 行がある。`dateMap` の時間帯の値が `null` または `undefined` のとき、不正件数にせず読み飛ばす。既存テストはこの行が無くても PASS する。テストの「actual 未取得」はキー自体が無いケースである。
- Dashboard サンプルの `dateMap` は `{ 2: undefined }` を含む。上記 3 行があると、この値は不正件数に入らない。
- `docs/HARVEST_INOICHI_PORTABLE.md` の branch と commit 表は、現在の branch と一致しない。
- 作業ツリーには `cortex-*` を含む、INO-1 以外の変更と未追跡ファイルが大量にある。
- ポート 8765 を他のアプリが使っていると、ランチャーは INO-1 を起動しない。
- UI はブラウザのローカル HTTP である。

## 10. HARVEST・FRIDAY との連携構想

役割の分担は構想である。コード上の境界は次のとおり。

HARVEST

- 実装されているデータ型は `timeWindow` と `bag` だけである。
- handoff レコードは件数、状態、エラー、`payloadReference` を持つ。本体は持たない。
- `payloadReference.via` は `window.OFK3Cortex13`。timeWindow は `getEntry`、`getPackages`、`getPackageSequenceIndex`、`getRouteStops`、`getStops`。bag は `getEntry`、`getPackages`、`getPackageAssistIndex`、`getPackageAssistDiagnostics`。
- Prototype 0 の INOICHI はこの参照を読んで Envelope にする。検知ルールの入力 `fleet-capacity-canonical` には変換しない。

INO-1 Prototype 1

- 入力は `{ block, hours, count }` の配列と、`YYYY-MM-DD -> { hours -> count }` の dateMap である。
- この形は OFK3 の `index.html` にある車両比較と同じである。HARVEST collector の出力ではない。

FRIDAY

- 音声、通知、統合操作を担う想定で、実装ファイルは無い。
- 通知アダプタの dry-run プレビューが、将来渡す文面の現在の形である。送信先の型としてテストと Dashboard が置いている値は `{ type, id }` または `{ type, token }` だが、token はプレビューに出さず、送信もしない。

したがって、HARVEST の既存出力を Prototype 1 の欠車検知へそのまま接続することはできない。接続するなら、新しい collector か、timeWindow / bag から別の検知入力への変換仕様が先に必要である。欠車検知に近い既存データは HARVEST ではなく、OFK3 の `fleetMasterV2` と `dateMap` である。

## 11. 次期開発の優先順位

これは調査に基づく提案である。承認前に実装しない。

1. Step 6–8 の保存は、このコミットで Dashboard、サーバー、ランチャー、対応テスト、この文書に限って行う。`c5cfe55` だけでは起動経路は復元できない。
2. Fleet Adapter の未コミット 3 行は、この保存に含めない。サンプルの `undefined` 台数と、不正件数の意味が変わるため、別件でレビューする。
3. 実データ化の最初の候補は、OFK3 の `fleetMasterV2` と `dateMap` を読み取り専用で既存 Adapter に渡すことである。HARVEST の新仕様を待たなくてよい。ただし OFK3 本番画面への組み込み、書き込み、通知は別承認にする。
4. その読み取り結果を載せるとき、Alert Store をメモリのままにするか、ブラウザの `localStorage` にするかを決める。PostgreSQL は、まだ件数も保持期間も無い。
5. HARVEST 連携は、渡すデータ型を決めてから着手する。現状の handoff は timeWindow と bag の参照だけである。
6. 公式の検知ルールは、閾値の承認後にサンプルルールと分けて追加する。サンプルの 1 台 / 3 台を公式値として扱わない。
7. FRIDAY へ渡すなら、まず dry-run の候補オブジェクトの契約だけを決める。`policy-not-confirmed` を外すことと、実送信は別承認にする。
8. Docker と PostgreSQL は、ローカル 1 台の静的 Dashboard を離れる要件が決まってからでよい。現在のサーバーは依存パッケージを追加していない。

## 12. 新しい開発担当が最初に読むファイル

1. この文書
2. `inoichi-dashboard.html` と `inoichi-dashboard.js`（今の画面が何を表示し、何を表示していないか）
3. `inoichi-server.js`、`inoichi-launch.ps1`、`inoichi-stop.ps1`
4. `inoichi-fleet-adapter.js`、`inoichi-detection-rules.js`、`inoichi-detection-core.js`
5. `inoichi-alert-store.js`、`inoichi-notification-adapter.js`
6. `inoichi-core.js` の先頭コメントと `harvest-collectors-cortex.js` の `payloadReference`（HARVEST との境界）
7. `docs/HARVEST_INOICHI_PORTABLE.md`（Prototype 0 の起動手順。branch 表は古い）

未追跡ディレクトリ `916b6e4a-1a8a-4738-bd64-a28b9c700856\task-skills\` に Step 3 から Step 8 の作業メモがある。仕様の正本はコードとテストである。このディレクトリはコミット対象にしない。

## Git の保全

調査時の HEAD は `c5cfe55b94c68799a7f9e2651b075542ff906274`、branch は `feat/inoichi-prototype1-detection` だった。push、reset、clean、checkout は行っていない。

### この保存コミットに含めるファイル

ランチャー単体ではサーバーと Dashboard が無いと起動できない。次の 11 ファイルを一組で追跡する。秘密情報は無い。

- `inoichi-launch.ps1`
- `inoichi-stop.ps1`
- `inoichi-install-shortcut.ps1`
- `tests/inoichi-launcher.test.mjs`
- `inoichi-server.js`
- `tests/inoichi-server.test.mjs`
- `inoichi-dashboard.html`
- `inoichi-dashboard.css`
- `inoichi-dashboard.js`
- `tests/inoichi-dashboard.test.mjs`
- `docs/inoichi-handover.md`

`tmp-detection-dryrun.mjs`、`tmp-dryrun-example.mjs`、`tmp-fleet-adapter-dryrun.mjs` はサンプルを印刷する作業スクリプトであり、この組に入れない。

### 保護したまま触っていない変更

追跡済みの未ステージ変更:

- `cortex-13-priority-core.js`
- `cortex-capture-extension/cortex-13-priority-core.js`
- `cortex-capture-extension/phase1-core.js`
- `cortex-capture-extension/phase1-runner.js`
- `tests/cortex-bag-enrichment.test.mjs`
- `inoichi-fleet-adapter.js`（INO-1 だが Step 8 ではない。null / undefined の読み飛ばし 3 行）

その他の未追跡ファイル（`.verdent/`、`delivery-app-demo/`、`state/`、各種 `temp_*`、UUID ディレクトリなど）はステージしていない。内容の棚卸しはしていない。
