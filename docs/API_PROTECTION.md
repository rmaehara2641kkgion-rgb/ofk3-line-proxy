# 既存API保護計画（認証なしAPIの段階的保護）

本書はコード・設定のみの調査結果です（本番URLへのリクエストは送っていません）。
**この変更の既定動作は「何も変えない」**です。環境変数を設定するまで、既存APIは今までどおり動きます。

## 1. APIごとの調査結果

| API | 認証(現状) | 取得/操作できるもの | 呼び出し元 | 危険度 | 保護グループ |
|---|---|---|---|---|---|
| `GET /cortex-priority` | なし | 当日の全ルートの住所・座標・ドライバー名・追跡ID・バッグ情報 | 管理画面(`ofk3-cortex-priority-ui.js`)、HARVEST ローカル中継(認証ヘッダーなし) | **高** | `cortex-read` |
| `POST /cortex-priority/import` | なし | 誰でも当日データを上書き(MAPや13:00必達の誤表示) | Chrome拡張(認証なし) | **高**(改ざん) | `cortex-ingest` |
| `POST /route-data` | なし | メモリへ最大10MBを無制限に保存(DoS)・任意データ公開 | 管理画面(`getProxyHeaders`) | 中 | `share-write` |
| `GET /route-data/:id` | ID(推測可だった) | 配送先の名前・住所・座標 | ドライバー(LINEのMAPリンク、`route-map.html`) | 中〜高 | 対象外(下記) |
| `POST /map-image`, `POST /pdf-upload` | なし | 任意PNG/PDFを自ドメインで公開・メモリ消費 | 管理画面 | 中 | `share-write` |
| `GET /map-image/:id`, `GET /pdf/:id` | ID(推測可だった) | MAP画像・請求PDF(個人情報を含みうる) | LINEサーバー/ドライバー | 中〜高 | 対象外(下記) |
| `/volume-master` `/addr-master` `/tenko-master` `/area-experience-*` | なし | GAS中継。読み取りで住所・ドライバーマスタ・点呼、**書き込みも無認証** | 管理画面 | **高** | `masters` |
| `GET /mentor-notified` | なし | 通知済みドライバー名 | Activepieces等 | 低〜中 | `masters` |
| `POST /proxy`, `GET /proxy` | `PROXY_SECRET` **未設定なら無認証** | 任意のLINE IDへ任意メッセージをpush / LINEプロフィール取得 | 管理画面 | **高**(なりすまし送信) | `line-send` |
| `POST /mentor-alert` | なし | 管理者へ任意のLINEアラート送信 | Activepieces | 中〜高 | `line-send` |
| `POST /line-notifications/toggle` | `PROXY_SECRET` **未設定なら無認証** | LINE送信の非常停止スイッチを誰でも切替 | 管理画面 | 高 | `line-send` |
| `/line-unlinked*` | `PROXY_SECRET`（**未設定なら素通り**） | LINE ID・表示名・紐付け | 管理画面 | 高(未設定時) | `line-unlinked` |
| `/wh60/*`, `/encrypt-zip`, `/decrypt-zip`, `/*-export` | なし | アップロード処理(CPU消費)・計算結果 | 管理画面 | 中(濫用) | `exports` |
| `/geocode`, `/static-map` | なし | Google Maps APIキーのクォータ消費 | 管理画面、**LINEサーバー(画像URL)** | 中(濫用) | 対象外(LINEが取得するため) |
| `POST /webhook` | なし → LINE署名検証はPR #77 | 未紐付け候補の捏造・ログ肥大 | LINE | 中 | PR #77で署名検証 |
| `/tenko-sync` | `TENKO_SYNC_TOKEN` | — | 点呼 | 済 | — |
| `GET /`, `/index.html` ほか静的 | なし | 管理画面のコード(データは含まない) | 利用者 | 低 | — |
| `/api/status`, `/deploy-info`, `/ping` | なし | 稼働/コミット情報 | 監視 | 低 | — |

### 認証の対象外にしているもの（理由）
- `GET /route-data/:id` `/map-image/:id` `/pdf/:id` は、**LINEのリンクをドライバーや LINE サーバーが開く**ためログイン不可。代わりに**IDを暗号論的乱数(144bit)に変更**した（新規発行分のみ。既存IDの形式は変えない）。有効期間は従来どおり6時間。
- `/static-map` `/geocode` は LINE が画像を取得するため公開のまま。濫用対策(署名付きURL・レート制限)は別途検討。

## 2. 推奨する認証方式

| 利用元 | 方式 | 理由 |
|---|---|---|
| 管理画面(ブラウザ) | **管理者ログイン → HttpOnly + SameSite=Strict のセッションCookie** | 共通secretをJSに渡さない。XSSでもCookieは読めない。更新系は同一Origin検査(CSRF対策) |
| Chrome拡張 | **取込専用トークン** `X-Ofk3-Ingest-Token`（`chrome.storage.local.ofk3IngestToken`） | 取込以外には使えない(スコープ限定)。拡張は既に `storage` 権限と同種の設定を持つ |
| HARVEST等の非ブラウザ | **読み取り専用トークン** `Authorization: Bearer <CORTEX_READ_TOKEN>` | `GET /cortex-priority` のみ。HARVEST側の対応は別承認（本PRでは触っていない） |
| Activepieces等のサーバー間 | `X-Proxy-Secret`（既存方式、定数時間比較） | 既存互換 |
| LINE Webhook | LINE署名 | PR #77 |

サーバー間通信は資格必須。強制するグループで資格が1つも設定されていなければ **503で安全側に停止**します。

## 3. 実装したもの（すべて既定は無効）

- `admin-session.js` … `/admin/login`(ページ), `POST /admin/login`, `/admin/logout`, `/admin/session`。scrypt、署名付き期限付きCookie(12h)、5回失敗/10分でロック、`ADMIN_PASSWORD_HASH` / `ADMIN_SESSION_SECRET`(32文字以上) 未設定ならログイン不可。
- `api-guard.js` … `API_GUARD_MODE=report`（遮断せず、グループ×資格種別の件数のみ集計。IP・ヘッダー・本文は記録しない）、`API_GUARD_ENFORCE=グループ,…`（指定グループのみ遮断）。`GET /admin/api-guard-report`（要認証）。
- `scripts/make-admin-password-hash.js` … パスワードをstdinで受け取りハッシュのみ出力。
- 拡張機能: 取込トークンが設定されている場合のみ `X-Ofk3-Ingest-Token` を付与（未設定なら従来どおり）。
- 共有ID(`route-data`/`map-image`/`pdf`)を暗号論的乱数へ。
- ログの個人情報削減: `/proxy` の宛先LINE ID・本文、ウェルカム送信先、`/mentor-alert` の宛先IDをログに出さない。

## 4. 本番切替の手順（承認が必要。上から順に）

1. （承認後）Renderに `ADMIN_PASSWORD_HASH` / `ADMIN_SESSION_SECRET` を設定。ハッシュは `node scripts/make-admin-password-hash.js` で生成。
2. 管理者が各PCで `/admin/login` にログイン（Cookieは12時間）。
3. `API_GUARD_MODE=report` をON。数日運用し `GET /admin/api-guard-report` で、グループごとの `anonymous`（資格なしの呼び出し）を確認。
4. `anonymous` が想定外の呼び出し元（HARVEST中継、Activepieces 等）に由来する場合は、その利用元に資格を配る:
   - 拡張機能: `INGEST_TOKEN` を発行し、拡張の `chrome.storage.local.ofk3IngestToken` に設定
   - HARVEST: `CORTEX_READ_TOKEN` を発行（HARVEST側の対応が別途必要）
   - Activepieces: `X-Proxy-Secret` ヘッダーを付与
5. 影響の小さいグループから `API_GUARD_ENFORCE` に追加（推奨順: `exports` → `share-write` → `line-send` → `masters` → `cortex-ingest` → `cortex-read` → `line-unlinked`）。問題があれば環境変数から外すだけで即時に元へ戻せる。
6. `PROXY_SECRET` が本番で**設定済みか**を確認（未設定だと `/proxy` と toggle が無認証）。

## 5. localStorage `lineSettings` の調査（P2）

保存される項目（値は記載しない）: `notifyToken`(LINE Notify), `channelToken`, `channelSecret`, `messageTemplate`, `adminLineId`, `lineBotId`, `lineBotLogoUrl`, `gasProxyUrl`, `addrMasterGasUrl`, `proxySecret`。
同じブラウザには `tenkoSyncToken`(点呼同期トークン)、`lineMapping`(LINE ID)、`transportIDs`、`phoneMapping`、`driverDBOverlay` なども平文で保存されている。

| 項目 | 読み取り箇所 | 実際の用途 | 移行方針 |
|---|---|---|---|
| `channelToken` / `channelSecret` | 設定フォームと「設定済み」バッジのみ(`index.html` 約8813–8950行) | **機能上は未使用**（実送信はサーバーの環境変数 `CHANNEL_ACCESS_TOKEN`） | ブラウザから**削除可能**。まず入力欄を非表示にし、既存値は削除前に「サーバー側で設定済みか」確認 |
| `notifyToken` | `sendViaNotify`（`notify-api.line.me` へ直接送信） | LINE Notify は 2025-03 にサービス終了済みで動作しない可能性が高い | 機能の廃止を確認後に削除 |
| `proxySecret` | `getProxyHeaders()` など | 管理画面→サーバーのヘッダー | **管理者セッション導入後は不要**（同一オリジンfetchはCookieで認証）。段階移行: ①セッション運用開始 ②`proxySecret` 欄を非推奨表示 ③値をクリア |
| `gasProxyUrl` / `addrMasterGasUrl` | 送信先URL設定 | 秘密情報ではないが設定値 | そのまま（サーバー設定化は別途） |
| `adminLineId` / `messageTemplate` / `lineBot*` | 設定フォーム | 非秘密 | そのまま |
| `tenkoSyncToken` | 点呼同期 | 点呼用トークン | セッション導入後に `/tenko-sync` もセッション許可を追加できる（別承認） |

**XSSリスク**: 管理画面は多くの外部入力(Excel/CSV/名前)をDOMに描画するため、XSSが1件でもあれば `localStorage` の全秘密情報が読み出される。HttpOnly Cookieへの移行で、トークン窃取のリスクは「ログイン中の操作を代行される」範囲に下がる。

**既存利用者の設定を失わない移行**（実装は承認待ち。本PRでは値の削除・移行を一切していない）:
1. セッション認証が動いて、`report` で `session` の件数が確認できるまで、`localStorage` は**触らない**。
2. 次のリリースで、`channelToken` / `channelSecret` / `notifyToken` の**入力欄を読み取り専用化**（保存済みの値は残す）。
3. 管理者が「サーバー側設定済み」を確認した後、設定画面に「ブラウザ保存分を削除」ボタンを追加し、**利用者が明示的に押したときだけ**該当キーを削除（削除前に項目名だけ表示。値は表示しない）。
4. `proxySecret` は、全呼び出しが `session` で通ることをレポートで確認してから同様に削除。

## 6. 緊急確認が必要な事項
1. 本番で `PROXY_SECRET` が設定されているか（未設定なら `POST /proxy` で任意LINEへ送信可能、`/line-unlinked` も素通り）。
2. `GET /cortex-priority` が認証なしで当日全ルートの住所・座標・ドライバー名を返している。
3. `POST /cortex-priority/import` が認証なしで当日データを上書きできる。
4. 管理者のLINE ユーザーIDが `index.html`（テスト送信）と `render-webhook-server.js`（`MENTOR_ADMIN_IDS`、WH60の既定値）にソース直書きされている。
