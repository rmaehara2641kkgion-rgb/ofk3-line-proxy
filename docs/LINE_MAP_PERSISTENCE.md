# LINE MAP 割当の永続化（GAS + 非公開Drive）と運用手順

**状態: コードとテストのみ。GASのデプロイ、Driveフォルダ作成、Script Properties設定、Render環境変数設定は未実施（承認待ち）。**

## 1. 何を保存し、何を保存しないか
| 保存する（GAS・Drive） | 保存しない |
|---|---|
| 配送日、サイクル、ルートコード、DA安定ID（transportId）、LINE userId、同期時刻 | 配送先住所、緯度経度、荷物・追跡ID、ドライバー名、MAP閲覧トークン、`PROXY_SECRET` / `LINE_CHANNEL_SECRET` 等の秘密値 |

- 許可リスト方式：Node側（保存前・復元時）とGAS側（保存時）の両方で、想定外のキーが1つでもあれば全体を拒否する（住所などが紛れ込んでも保存されない）。
- 配送先データ（Cortex）はGASに置かない。Cortexは再取込で復元する（§5）。

## 2. 保存の仕組み（実装済み）
- 保存形式：`{ v:1, seq, savedAt, checksum(sha256), data }`。
- **保存成功の判定**：GASが送った `seq` と `checksum` を返したときだけ「成功」。確認応答が無い・不一致なら失敗扱い（管理画面には「外部保存」を成功と出さない）。
- **競合・古いデータ**：`expectedSeq` による楽観ロック（GAS側は `LockService` で排他）。競合したら再読込→日付ごとに `syncedAt` が新しい方を採用→1回だけ再試行。古い端末のデータで新しい割当を上書きしない。
- **復元**：checksum・スキーマ・件数・重複・1対1（transportId↔LINE ID）をすべて検証。1つでも不正なら**部分採用せず未復元**。未復元の間は配送情報を返さない（LINE返信は「復元中」）。
- 障害分類（固定コードのみ、URL・トークンは含めない）：`gas-timeout` / `gas-network` / `gas-rate-limited`(429) / `gas-server-error`(5xx) / `gas-unauthorized` / `gas-bad-json` / `gas-too-large` / `gas-partial-response` / `gas-conflict` / `gas-folder-not-private` / `remote-corrupt`。再試行は復元30秒間隔、保存は次の同期時（嵐にならない）。
- 保存先フォルダが**非公開（PRIVATE）でなければ書き込まない**（GAS側で検査）。

## 3. GASの公開範囲とリスク（導入前に判断が必要）
GAS Webアプリは「アクセスできるユーザー：全員（匿名可）」でないとRenderから呼べません。URLを知る第三者がリクエストできる状態になります。

| リスク | 緩和 |
|---|---|
| URLが漏れると誰でも要求できる | トークン無しは何も返さない（`unauthorized`）。トークンはPOSTボディのみ（URLに載せない）。トークンは長い乱数にし、漏えい時はScript Propertiesを更新するだけで失効 |
| トークン漏えい | 保存内容は住所・座標を含まない最小限（ルート・DA ID・LINE ID）。ただしLINE userIdとDA IDの対応は個人情報なので、漏えい時は影響あり → 定期ローテーション推奨 |
| GAS側のクォータ・障害 | 失敗しても業務は継続（メモリ保持）。復元できない間は安全側（MAPなし）に停止 |
| 実行ユーザー | 「自分として実行」。保存先フォルダのみ参照。共有設定を変えると書き込みを拒否 |

## 4. 本番導入に必要な手動操作（すべて承認後）
1. Google Driveに**非公開**フォルダを作成（共有しない）。フォルダIDを控える。
2. Apps Scriptに `gas/line-map-store.gs` を貼り付け。
3. Script Properties：`LINE_MAP_GAS_TOKEN`（長い乱数）、`LINE_MAP_FOLDER_ID`。
4. Webアプリとしてデプロイ（実行：自分 / アクセス：全員）。URLを控える。
5. 事前確認：GASエディタで `doPost` の疎通テスト（未設定時 `not-configured`、トークン誤り時 `unauthorized` になること）。
6. Render環境変数：`LINE_MAP_GAS_URL`、`LINE_MAP_GAS_TOKEN`、`LINE_CHANNEL_SECRET`、`LINE_MAP_PUBLIC_ORIGIN`。**`LINE_MAP_SHOW_ADDRESS` は設定しない**（または `0`）。`LINE_MAP_REPLY_ENABLED` は最後（管理者のみで検証後）。
7. デプロイ後、管理者で `/line-map/status`（要ログイン）を確認：`assignmentsRestored:true`、`remote.configured:true`、`lastError:null`。
8. 管理画面でアサインを取り込み、コンソールの「外部保存:ok」を確認。GASのDriveファイルに住所・座標が含まれないことを目視確認。

## 5. Render再起動後のCortex（配送MAP元データ）の復旧手順
`cortexPriorityStore` はメモリのみで、再起動・再デプロイで消えます。**自動では復旧しません**（拡張機能の自動再送なし）。

1. 割当は自動復元される（GAS）。`/line-map/status` で `assignmentsRestored:true` を確認。
2. 当日のCortexデータを再取込する：Amazon Logistics（Cortex）にログインしたChromeで、拡張機能「OFK3 Cortex Capture」のアイコンを押して取得・送信を再実行。
3. `/line-map/status` で `cortexRouteStops` が0より大きいことを確認。
4. 復旧するまでの間、ドライバーが「マップ」と送ると「配送データがまだ取得・復元できていません」と返り、MAPは出ない（誤配送なし）。
5. 再起動は業務時間外に行う。やむを得ず業務中に再起動した場合は、上記2を直ちに実施する。

（参考：将来、Cortexの永続化が必要になった場合は、住所・座標を含むため別途の設計・承認が必要。今回は対象外。）

## 6. 残存リスク
- **レート制限・ログイン失敗カウンタ・重複排除はメモリ上**で、再起動でリセットされる。MAPトークンは192bitのため総当たりは非現実的だが、再起動直後に閲覧要求の洪水を許す。対策案：①Render/CDN側のレート制限、②総量上限（全体の無効トークン回数）、③カウンタのGAS永続化（過剰）。
- 座標・PINから配送先位置が推測可能（住所を出さなくても）。MAP全体を機微情報として扱い、トークンは30分失効・再発行で旧トークン失効。
- LINE内ブラウザでのCSP・Leaflet・位置情報の挙動は実機未検証。

## 7. LINE内ブラウザ・実機の確認項目
1. LINEトークからのリンクで開く（URLの `#` 以降が保持され、読み込み後に履歴から消えること）。
2. 地図タイル・PIN番号・ドラッグ・ピンチズーム、縦横回転。
3. 日本語表示、ダークモード、小さい画面での文字切れ。
4. 30分後の期限切れ案内（再度「マップ」と送る導線）。
5. 外部ブラウザで開き直した場合の挙動。
6. 通信が遅い／切れた場合のエラー表示。
