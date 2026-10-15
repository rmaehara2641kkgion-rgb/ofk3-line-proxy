# HARVEST ローカルアプリ (独立HTTP起動)

HARVEST を OFK3 本体とは別の、専用ウィンドウで起動するためのローカル専用アプリです。
OFK3 本体 (`render-webhook-server.js`) は起動しません。Render 本番では動作しません (起動拒否)。

- 画面: `http://127.0.0.1:3100/harvest`
- サーバー: `harvest-local-server.js` (Node.js 18 以上、追加パッケージ不要)
- 既存の HARVEST (`harvest-core.js` / `harvest-collectors-cortex.js` / `ofk3-harvest-ui.js`) と `ofk3-cortex-priority-ui.js` を無変更で再利用

## 1. 起動

エクスプローラーで `start-harvest.cmd` をダブルクリックします。

1. 3100 番ポートを確認します。別のアプリが使っている場合は、誤接続せずに停止します。
2. 未起動なら `harvest-local-server.js` を非表示で起動します (PID とログは `%LOCALAPPDATA%\OFK3-HARVEST\` に保存)。
3. 起動を待ってから、Edge (なければ Chrome) の専用ウィンドウ (`--app`) で画面を開きます。

停止は `stop-harvest.cmd` です (PID ファイルで特定し、コマンドラインが `harvest-local-server.js` のプロセスだけを停止します)。

手動起動: `npm run harvest:local` (または `node harvest-local-server.js`)。

## 2. 設定 (任意)

`start-harvest.cmd` と同じフォルダに `harvest-local.config.cmd` を作ると読み込まれます (Git 管理外)。

```bat
set HARVEST_PORT=3100
set HARVEST_UPSTREAM_BASE_URL=https://<取得元のOFK3>
```

| 変数 | 既定値 | 意味 |
|---|---|---|
| `HARVEST_PORT` | 3100 | 待ち受けポート (1024-65535)。待ち受けは常に 127.0.0.1 のみ |
| `HARVEST_UPSTREAM_BASE_URL` | 未設定 | 取得元の OFK3 (origin のみ。https 必須、ループバックのみ http 可) |

これ以外の環境変数 (LINE / GAS / Google / 点呼のトークン等) は読みません。

## 3. データ取得 (自動取得なし)

- 画面を開いた・再表示した・画面に戻っただけでは、Cortex 素材の読込を開始しません。
- 「データ読込を開始」を押したときに限り `ofk3-cortex-priority-ui.js` を読み込み、取得元から送信済みの素材を読み込みます (Cortex の取得そのものは開始しません)。
- 読込後、「HARVEST 確認」→「再確認」は従来どおり手動です。
- 取得元が未設定なら外部通信は一切せず、「データなし」を明示します。
- 取得元設定時は、ローカルサーバーが `GET /cortex-priority` だけを中継します。
  - クエリは `localDate` (YYYY-MM-DD) と `latest=1` のみ許可。5 秒タイムアウト。
  - Cookie・認証情報・クライアントのヘッダーは転送しません。リダイレクトは拒否します。
  - 取得データはファイルに保存しません。上流のエラー・タイムアウト・不正応答は画面に明示します。
- 取得元の `GET /cortex-priority` は、現時点のコードでは認証を要求していません。認証が必要な取得元は未対応です (認証情報を転送しないため)。
- **実際の本番データ取得は、別途承認後に試してください。**

## 4. 安全仕様

- 127.0.0.1 のみ。Host ヘッダー検証 (DNS リバインディング対策)、クロスオリジン拒否。
- GET / HEAD のみ。POST / PUT / DELETE などは 405。ファイル書き込み・定期処理なし。
- 配信ファイルは許可リスト限定 (ディレクトリ配信なし)。
- ページの CSP は `connect-src 'self'`。ブラウザ側からも外部へ通信できません。
- `NODE_ENV=production` または `RENDER*` 環境変数がある環境では起動を拒否します。
- WH60 の定期処理・LINE 通知・GAS 連携・点呼などの OFK3 の機能は、このサーバーには存在しません。

## 5. ショートカットとタスクバー固定 (Windows 実機での確認が必要)

### 方法 A: PWA としてインストール (専用アイコンになりやすい・推奨)
1. `start-harvest.cmd` でサーバーを起動します。
2. 通常の Edge で `http://127.0.0.1:3100/harvest` を開きます。
3. アドレスバーのアプリ アイコン、または `…` → 「アプリ」→「このサイトをアプリとしてインストール」を選びます。
4. インストールされた HARVEST をタスクバーに右クリックから「タスクバーにピン留めする」。
5. 以後は `start-harvest.cmd` でサーバーを起動してから、ピン留めした HARVEST を開きます。

### 方法 B: ショートカット
1. `start-harvest.cmd` を右クリック → 「ショートカットの作成」。
2. ショートカットのプロパティ → 「アイコンの変更」→ `assets\harvest.ico` を指定、「実行時の大きさ」を「最小化」。
3. ショートカットを右クリックして「タスクバーにピン留めする」。ピン留めできない場合は、スタートメニューへのピン留めを使ってください。

> ブラウザの `--app` ウィンドウがタスクバーで独立したアイコン・グループになるかは環境に依存します。PWA を優先し、実機で確認してください。

## 6. 将来の HARVEST → INO-1 連携で残る課題

- `harvest:handoff` は同一ウィンドウ内のイベントです。別ウィンドウの INO-1 には届きません。
- 連携案: 同じローカルサーバー (同一オリジン) で `/inoichi` を提供し、`BroadcastChannel` で handoff を渡す。INO-1 側の「保存なし」の方針との整合を決める必要があります。
- 現段階では INO-1 の既存実装を変更せず、自動取得・自動検知は追加していません。

## 7. トラブルシュート

| 症状 | 対処 |
|---|---|
| 「Port 3100 is used by another application」 | 別アプリを止めるか、`harvest-local.config.cmd` で `HARVEST_PORT` を変更 |
| 起動に失敗 | `%LOCALAPPDATA%\OFK3-HARVEST\server.err.log` / `server.log` を確認 |
| 「refuses to start」 | `NODE_ENV=production` や `RENDER*` が設定されていないか確認 (ローカル専用です) |
| 「取得元(上流)が未設定」 | `HARVEST_UPSTREAM_BASE_URL` を設定して再起動 |
| 「取得元が5秒以内に応答しませんでした」 | 取得元がスリープ復帰中の可能性。時間をおいて再度「データ読込を開始」 (ページ再読込後) |
