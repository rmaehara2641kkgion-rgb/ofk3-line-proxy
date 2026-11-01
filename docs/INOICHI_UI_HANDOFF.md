# INO-1 内装引き継ぎ

この文書は、Verdent が残した INO-1 内装を専用ブランチへ保存した時点の記録です。内装の完成や原因調査はここには含みません。

保存元は Windows 上の OFK3 作業ツリーです。保存時の元ブランチは `feat/inoichi-prototype1-detection`、元 HEAD は `ca9a928b68d07e8a2c80ce8f06d09c6eaf7535e8` です。元の作業ツリーには他案件の未コミット差分が残っています。このブランチには内装一式だけを入れています。

## 実装済みの内装

- 画面の基調は暗い漆色です。テーマカラーは `#0d0b14` です。
- ページ背景に `assets/inoichi-castle-bg.webp` を指定しています。
- ヘッダーに明るいロゴ `assets/inoichi-logo-light.webp` を出します。読み込めないときは `assets/inoichi-logo.png` に切り替え、それも失敗したらロゴ画像だけを隠します。
- タグラインは「人間道：勤務監視・異常検知・リスク予測（ローカル専用）」です。
- 花びらの装飾をヘッダー周りに置いています。動きを減らす設定では花びらを出しません。
- タブアイコンは `assets/inoichi.ico` と `assets/inoichi-logo.png` です。
- デスクトップショートカットは、引数を省略すると `assets/inoichi.ico` を使います。既にあるショートカットは、対象が PowerShell で、引数がこのリポジトリの起動または終了スクリプトを指すときだけ更新します。
- ローカルサーバーは PNG、ICO、2つの WebP を配れるようにし、WebP の Content-Type を `image/webp` にしています。

既存の調査画面はそのままです。サンプルデータ、サマリー、欠車リスク一覧、ドライラン、実通知なし、という Prototype 1 の枠は変えていません。

## 変更ファイルと画像素材

ソースとテスト:

- `inoichi-dashboard.css`
- `inoichi-dashboard.html`
- `inoichi-dashboard.js`
- `inoichi-server.js`
- `inoichi-install-shortcut.ps1`
- `tests/inoichi-dashboard.test.mjs`
- `tests/inoichi-launcher.test.mjs`
- `tests/inoichi-server.test.mjs`

画像とアイコン。いずれも再生成していません。保存時点のサイズは次のとおりです。

- `assets/inoichi-castle-bg.webp` — 378752 bytes
- `assets/inoichi-logo-light.webp` — 90184 bytes
- `assets/inoichi-logo.png` — 2513444 bytes
- `assets/inoichi.ico` — 205926 bytes

この保存に入れていないもの:

- `assets/gion-ofk3-logo.png`
- `inoichi-fleet-adapter.js` の未コミット差分
- rolling60h 関連
- HARVEST 関連
- `index.html`
- 元作業ツリーに残るその他の差分

## 現在のテスト結果

保存直前に、混在した元作業ツリーで次を実行しました。サーバーは再起動していません。

- `node tests/inoichi-dashboard.test.mjs` — 25件成功
- `node tests/inoichi-server.test.mjs` — 46件成功
- `node tests/inoichi-launcher.test.mjs` — 63件成功、1件失敗

失敗は `(14) npm run test:inoichi` です。中身は `tests/inoichi-wiring.test.mjs` の `index.html untouched by INOICHI` です。元作業ツリーの `index.html` に、この内装とは別の未コミット差分があり、そのファイルに `inoichi` という文字列があります。コミット済みの `index.html` にはその文字列はありません。このブランチは `index.html` を含みません。

次の担当は、このブランチのクリーンな取得先で同じ3本を再実行してください。元作業ツリーの失敗を、内装の失敗として扱わないでください。

## 起動・確認方法

ローカル専用です。待受は `127.0.0.1`、既定ポートは `8765` です。

```text
node inoichi-server.js
```

ブラウザでは `http://127.0.0.1:8765/` を開きます。初期表示は `sampleMode: true` で、データ取得元はサンプルです。実通知は送りません。

ショートカットを作る場合:

```text
powershell -ExecutionPolicy Bypass -File inoichi-install-shortcut.ps1
```

確認するときは、ロゴ、タグライン、セクション「A. サマリー」「B. 欠車リスク一覧」が残っていることを見てください。

## 8765番サーバーの状態

保存作業の時点で、`127.0.0.1:8765` は Listen でした。プロセスは node、PID は 29152 で、コマンドは `inoichi-server.js` を指していました。この保存ではサーバーを止めていません。再起動もしていません。

次の担当がポートを使う前に、まだ同じ INO-1 サーバーが居るか確認してください。別のプロセスが 8765 を使っているときは、そのプロセスを止めないでください。

## 背景画像がスクリーンショットで見えない問題

スクリーンショットでは城の背景が見えない、という観察があります。原因は未確定です。次のどれか一つとは決めないでください。

- 画像ファイルの有無
- サーバーが画像を返せているか
- CSS の背景指定
- 画面の重ね合わせ
- スクリーンショットの撮り方

スタイルシートは、ページ背景に暗い色、グラデーション、`./assets/inoichi-castle-bg.webp` を一緒に書いています。これは事実の記録であり、見えない理由の結論ではありません。

## 次の担当が確認する順番

1. ブランチ `feat/inoichi-ui-handoff` を取得し、この文書と12個の対象ファイルがあることを確認する。
2. 4つの画像のファイルサイズが、上の記録と一致することを確認する。
3. クリーンな取得先で dashboard、server、launcher の3テストを実行する。
4. `127.0.0.1:8765` のプロセスが INO-1 サーバーであることを確認してから `http://127.0.0.1:8765/` を開く。違うプロセスなら起動し直さず、別ポートを検討する。
5. ロゴ、タグライン、既存セクションが見えることを確認する。
6. 背景は、画像への GET、Content-Type、ページ上の見え方を分けて記録する。見えなくても原因を断定しない。
7. main へのマージ、デプロイ、LINE 送信は行わない。

## 既存機能の保護事項

- 検知、ルール、アラート保存、通知アダプタのロジックはこの保存の対象外です。
- `inoichi-fleet-adapter.js` の未コミット差分は、内装ではないので含めていません。
- サーバーは許可した GET だけを返し、POST 系は拒否します。パストラバーサルでリポジトリ外を返さないことを維持してください。
- 画面はサンプルのままです。本番データ、実通知、LINE、FRIDAY、HARVEST への書き込みを足さないでください。
- 画像を作り直さないでください。
- 元の作業ツリーにある他案件の差分を、このブランチへ混ぜないでください。
