# INO-1 実データ監視ダッシュボード

正式名称は **INO-1** です。画面・ブラウザタブ・ウィンドウタイトル・manifest はすべて「INO-1」です。
内部識別子（`inoichi-*` のファイル名、`X-INOICHI-Server` ヘッダー値 `inoichi-prototype1-step8`、過去のGit履歴）は互換のため改名していません。

## 構成

```
ブラウザ(INO-1) → GET /api/monitor (127.0.0.1:8765, INO-1 server)
                     ├→ GET {OFK3_BASE_URL}/harvest/rolling60h/alerts   (OFK3、読み取りのみ)
                     └→ GET {OFK3_BASE_URL}/mentor-startup/notice        (OFK3、読み取りのみ)
```

- `inoichi-server.js`: `/api/monitor` を追加。OFK3 には GET のみ。タイムアウト8秒、応答2MB上限、結果を5秒キャッシュ（更新ボタン連打・自動更新でOFK3を叩きすぎない）。
- `OFK3_BASE_URL`（既定 `http://127.0.0.1:3000`）: origin のみ。http は loopback 限定、認証情報・パス不可。OFK3 側フィードは loopback 限定のため、INO-1 は OFK3 と同じ PC で動かします。
- `inoichi-live-monitor.js`: OFK3 が計算済みの結果を分類するだけです。Rolling60h の時間は **再計算しません**（OFK3 と数値が食い違わない）。
- 画面は 60 秒ごとに自動更新（非表示タブでは停止）と「更新」ボタン。

## 状態の区別

| 状態 | 意味 |
| --- | --- |
| 正常 | 実データを取得し、OFK3 の判定で超過・接近・判定不能なし |
| 警告 | 60時間超過見込み / 接近を検出 |
| 未判定 | 判定不能者がいる、または OFK3 側データ不足（安全扱いにしない） |
| 取得失敗 | OFK3 に接続できない・応答が不正（値は表示しない） |
| データ遅延 | OFK3 判定が15分超古い、または実績保管が前日分まで届いていない |
| 未対応 | データ源が未接続 |

取得失敗時は、前回成功データを現在値として表示しません（前回成功の時刻のみ表示）。

## 現在の対応範囲

| カード | 状態 |
| --- | --- |
| Rolling60h | OFK3 `/harvest/rolling60h/alerts` に接続。超過見込み・接近・判定不能、対象者・期間・見込み時間、判定時刻（OFK3の計算時刻）と元データ最終日を表示 |
| Mentor監視 | OFK3 の `GET /mentor-startup/notice` に接続（下記「Mentor連携」）。OFK3 に通知が無い・取得失敗・15分超過のときは正常/0件にせず、未判定・取得失敗・データ遅延で表示 |
| 当日稼働状況 | **未対応**（未対応の監視がある間、重要アラートは正常にならず「未判定」） |
| 検知エンジン | **未対応**（実データ入力が未接続のためルール評価は未実行） |
| 重要アラート | Rolling60h の警告を集約。未判定の監視がある間は「0件」「正常」とは表示しない |
| 残り稼働可能時間 / 連続勤務 / 12時間超過 | OFK3 のフィードに含まれないため未対応（INO-1 で独自計算しない） |

## 起動とアイコン

- `inoichi-launch.ps1` は Edge / Chrome があれば `--app=http://127.0.0.1:8765/` で開きます。タスクバーの実行中アイコンはページの favicon / `inoichi.webmanifest`（`assets/inoichi-taskbar-192/512.png`）、タイトルは「INO-1」です。
- `assets/inoichi.ico` と `assets/inoichi-taskbar.ico` は同一の、16/24/32/48/64/128/256px を含む ICO です。素材は添付の INO-1 ロゴ（黒い正方形背景・円形に切り抜かない）を加工せず縮小したものです。原画は `assets/inoichi-taskbar-source.png`。
- ヘッダーの大きなロゴ画像（`inoichi-logo-light.webp`）は画面デザイン用で、アイコンとは別素材のため変更していません。

### タスクバーのピン留めが古いアイコンのままの場合

ピン留めは「ピン留めした時点のショートカット／アプリ ID」を保持します。旧ショートカット（PowerShell 起動）をピン留めしたものは、実行中の Edge/Chrome ウィンドウとは別アイコン・別項目になります。
INO-1 を起動 → 実行中のウィンドウを右クリック →「タスクバーにピン留めする」で新しいピンを作り、旧ピンを手動で外してください。既存のピン留め・ショートカットはこの変更では削除していません。

## Mentor連携

Mentor 未起動疑いの判定本体は OFK3 側（`cortex-capture-extension/id-diag-core.js` の `suspectView`、通知化は `mentor-startup-notice.js`、API は `mentor-startup-route.js`）にあります。INO-1 は判定を **再実装せず**、OFK3 が保存した通知を読み取って表示するだけです。

流れ: Chrome 拡張（Scheduling / Mentor タブの取得）→ OFK3 `POST /mentor-startup/notice`（loopback）→ `local/mentor-startup-notice.json` → INO-1 が `GET /mentor-startup/notice` を読む。OFK3 から INO-1 への送信はありません（OFK3 の Mentor コードは INO-1 を参照しない）。

| 項目 | 扱い |
| --- | --- |
| 分類 | Active確認候補 / 当日終了履歴（参考） / Mentor未起動疑い（要確認） / 判定不能 を別々の件数で表示 |
| 未起動疑い | 「未起動の確定ではありません」と明記。`confirmedUnstarted` は使わない |
| 正常 | 全サイクルが `clear`・15分以内・判定不能0・未起動疑い0 のときだけ。判定不能が1名でもいれば未判定 |
| 鮮度 | OFK3 と同じ基準: スケジュール取得・Mentor取得・判定の3つの時刻がすべて15分以内。1つでも超過・欠落なら「データ遅延」（件数・氏名は表示しない） |
| 複数サイクル | サイクルごとに判定。判定不可・遅延のサイクルがあれば全体を正常にしない（件数には含めない） |
| 個人情報 | 氏名・状態・原因のみを許可リストで通し、Scheduling ID 等は転送しない。氏名は鮮度内の通知だけ。応答は 127.0.0.1 のみで、Host / Origin / Sec-Fetch-Site が不正な要求は 403、CORS ヘッダーなし |

「INO-1・HARVESTへ自動送信しない」（`feat/mentor-startup-friday` ブランチの `docs/mentor-prototype-1.md`）との関係: この規定は OFK3 が4分類を INO-1/HARVEST へ送らないこと、および Active候補・未起動疑いを点呼完了・本人確認済み・未起動確定として渡さないことと解釈しています。INO-1 からの読み取り（pull）はこれに反せず、表示文言も上記の制限を守っています。運用上、読み取り連携自体を認めない場合は `inoichi-server.js` の Mentor 取得（`OFK3_MENTOR_PATH`）を外すと Mentor カードは「未対応」に戻ります。

注意: 通知は拡張機能が Chrome・Scheduling・Mentor のタブを開いている間だけ更新されます。閉じている間は「データ遅延」になります。
