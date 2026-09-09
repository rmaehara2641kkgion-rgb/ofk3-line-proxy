# ドライバー識別キーに関する技術メモ

作成理由: 「玲緒 山田 山」のリネーム不具合調査に伴い、`driverName`（氏名文字列）を
識別キーとして使っている箇所を洗い出したもの。将来 `driverId` / UUID を正式な
不変キーへ移行する際の着手点リスト。**今回のタスクではこの移行自体は行っていない**
（影響範囲が大きいため）。

## 現状の設計

`driverId` という連番（`getNextDriverId()`、`index.html`）は存在するが、実際の
保存・検索・同期キーとしてはほぼ使われておらず、事実上「表示用の付随情報」に
とどまっている。氏名文字列（英語表記/Amazon取込名がそのままキーになっているケースが多い）
が唯一の実質的な主キーとして機能している。

## name をキーにしている箇所一覧（判明分）

### クライアント側（`index.html`、ブラウザ localStorage）
- `driverDB`（永続化先: `localStorage['driverDBOverlay']`） — キー=氏名
- `lineMapping` / `phoneMapping` / `transportIDs` / `driverDepartments` /
  `driverJapaneseNames` / `masterNotes` — いずれもキー=氏名
- `driverNameAliases` — 別名(氏名)→正キー(氏名)の対応表。氏名キー問題への
  「その場しのぎ」の緩和策として機能しているが、根本解決ではない
- `deletedDrivers` — 退職者フラグ。キー=氏名
- `resolveDriverKey()` — 表記ゆれ（空白・姓名反転・サフィックス等）を氏名文字列の
  パターンマッチで吸収する中央関数。`driverId` は一切使っていない
- `getQRData()` — TID → `driverId` → **氏名文字列** の優先順でQRを生成。
  TID・driverId が未設定のドライバーは、QRコード自体が氏名依存になる
- `findDriverByQr()` の `OFK3_DRIVER:` / `OFK3_LICENSE:` 形式 — 氏名文字列をそのまま
  照合キーとして使用（`OFK3_D<driverId>` 形式のみ driverId ベース）
- `tenkoLog` / `tenkoSchedule` — 点呼データも氏名文字列で記録
- `twc-core.js`（220行）— `driverName` を集計キーとして優先使用
  （`transportId` が無い場合のフォールバックではなく、`driverName` が第一キー）
- `rolling60h-core.js`（764行）— `rec.transportId` があればそちらを優先、無ければ
  `'NAME:' + rec.name` にフォールバック（こちらは比較的安全な設計）

### サーバー側（`render-webhook-server.js`、外部GAS）
- `/tenko-master` の `updateMasterField` API — `{action, name, field, value}`。
  更新対象の特定が**氏名文字列**。リネーム/削除用のAPIは存在しない
  （このリポジトリには含まれない、外部Google Apps Script側の実装次第）
- `/tenko-sync` の `driverDeltas` — 各deltaは `name` を主キーとして保持。
  `driverId` はマージ時の重複排除キー（`mergeKey`）としてのみ補助的に使われ、
  実際のデータ書き込み先は常に `delta.name`（今回のタスクでここを部分的に緩和し、
  `driverNameAliases` を経由した解決を追加した。詳細は本メモ末尾の「今回実施した対策」参照）

## 影響範囲（driverId主キー化する場合に触る必要がある箇所）

1. `driverDB` 等7つのオブジェクトのキー構造をすべて `driverId` ベースに変更
2. `resolveDriverKey()` を「氏名表記ゆれの吸収」から「氏名→driverId解決」へ役割変更
3. `getQRData()` / `findDriverByQr()` の氏名フォールバック経路の廃止（QRは常に driverId ベースにする）
4. `/tenko-sync` の `driverDeltas` ペイロード・マージロジックを driverId 必須に変更
5. 外部GAS側（`TENKO_MASTER_GAS_URL`）のAPI契約変更（`name` ではなく `driverId` で更新）
   — **このリポジトリの外にあるため、GAS側のコード変更が別途必要**
6. `twc-core.js` / `rolling60h-core.js` 等、集計系コアの集計キーを driverId ベースに変更
7. `tenkoLog` 等、過去データに `driverId` が存在しない場合の移行（後方互換のための
   氏名→driverId解決レイヤーが移行期間中は必要）

上記の通り、外部システム（GASスプレッドシート）まで含めた契約変更が必要になるため、
1回のPRで安全に終わらせるのは難しい規模の変更である。段階的に進めるのが現実的。

## 今回実施した対策（このリポジトリ内、最小変更）

「氏名をキーにする」設計自体は変更していないが、以下の局所的な安全対策を追加した。

1. `renameDriver()`:
   - 全角スペース等の入力正規化を追加
   - リネーム後、旧名称を `driverNameAliases` に登録（今まで欠けていた）
   - 名前衝突時は単純拒否ではなく `mergeDriverKeys()` による統合を確認ダイアログ付きで提案
   - リネーム後、`/tenko-sync` へ「墓標(tombstone) delta」を配信（下記2）
   - リネーム後、既知フィールドを `/tenko-master` へも新名称でベストエフォート反映
2. `/tenko-sync` の driverDelta に `renamedTo` / `deleted` フィールドを追加し、
   受信側（`index.html` のマージ処理）は `renamedTo` 付きdeltaを見ると
   「無ければ作る」経路を通さず、別名登録＋既存データの統合のみを行うよう変更。
   また、通常deltaの適用時も `driverNameAliases` を先に解決してから書き込むようにした。
   これにより、送信済みバッファ（直近200件）に残っている旧名称向けの古い作成deltaが
   後から（別端末・再同期・サーバー再起動後の復元等で）再適用されても、
   旧名称のドライバーが復活しないようにしている。

これらは「氏名がキーである」という根本構造そのものは変えていない、あくまで延命的な
対策である点に留意。
