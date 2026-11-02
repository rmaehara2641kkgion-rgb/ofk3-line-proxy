# API保護 本番切替計画（最終監査版）

前提: `docs/API_PROTECTION.md`（調査・方式）の続き。**本書の操作はすべて承認が必要**で、この時点では何も実施していない。
本番の環境変数・Renderの状態は、調査環境から確認できていない（**未確認**）。推測で書いていない。

## 0. 検証済みの事実（このPRのテストで実証）
- `API_GUARD_MODE=report` は**応答を変えない**: 同一環境で `off` / `report` の2台に40件超の同一リクエストを送り、ステータス・ヘッダーの種類・本文が一致（`tests/api-guard-report-mode.test.mjs`）。
- report のログ・集計に秘密値、IP、LINE ID、住所、本文は出ない。
- HARVEST の実際の中継経路（`harvest-local-server.js` の `createServer`、無変更）は report でも従来どおり読める。
- **`API_GUARD_ENFORCE=cortex-read` にすると、現行のHARVEST中継は読めなくなる**（中継は認証ヘッダーを一切付けない設計）。→ HARVESTが読取トークンを送れるようになるまで `cortex-read` は強制しない。
- 管理画面は、`getProxyHeaders()` を使う呼び出し（`/proxy` 送信、`/route-data`、`/map-image`、`/pdf-upload`、`/volume-master` の保存）はsecret保存済みなら通る。**ヘッダーを付けない呼び出し**（`/cortex-priority` の取得、`/volume-master?action=list`、`/tenko-master`（読み書きとも）、`/area-experience-master`（保存含む）、`/addr-master` の読み取り系 lookup/list/pending/stats（保存系はヘッダー付与済み））は、管理者ログイン（Cookie）が必要。

## 1. 影響範囲と安全な切替順（APIごと）

| 順 | グループ / API | 主な利用元 | 強制すると壊れる可能性 | 事前条件 | 優先度の理由 |
|---|---|---|---|---|---|
| 1 | `line-send`: `/proxy`, `/mentor-alert`, `/line-notifications/toggle` | 管理画面(secret付き)、Activepieces | secret/ログインなしの管理画面、`X-Proxy-Secret` を付けていないActivepieces | 管理者全員がログイン済み or secret保存済み。Activepiecesにヘッダー追加 | なりすましLINE送信を止める。**`PROXY_SECRET` 未設定なら今も無認証** |
| 2 | `share-write`: `POST /route-data`, `/map-image`, `/pdf-upload` | 管理画面(secret付き) | 上と同じ | 同上 | 無制限書き込み(メモリ枯渇)を止める。閲覧リンク(GET by ID)は対象外なので**ドライバーのリンクは壊れない** |
| 3 | `exports` | 管理画面 | ログイン/secretなしのエクスポート | 同上 | 濫用防止。データ漏えいリスクは低い |
| 4 | `masters` | 管理画面（ヘッダーなしの呼び出しが多い） | **ログイン必須**（secretだけでは足りない呼び出しがある） | 全管理者のログイン運用が定着 | 読み書きとも無認証のマスタ(住所・点呼・ドライバー) |
| 5 | `cortex-ingest`: `POST /cortex-priority/import` | Chrome拡張 | **拡張に取込トークン未設定のPC**は取込不可（当日MAPが作れない） | 拡張を使う全PCで `chrome.storage.local.ofk3IngestToken` を設定 | 当日データの改ざんを止める。業務影響が大きいので慎重に |
| 6 | `cortex-read`: `GET /cortex-priority` | 管理画面、**HARVEST中継** | HARVEST中継が読めなくなる | HARVEST側で `Authorization: Bearer <CORTEX_READ_TOKEN>` を送れる対応（別承認・別PR） | 最も機微（全ルートの住所・座標・ドライバー名）だが、利用元調整が最後 |
| 7 | `line-unlinked` | 管理画面 | secret/ログインなし | 1と同様 | 既存secret方式を補強（未設定時の素通りを塞ぐ） |

> 注: `cortex-read` は危険度が最大なのに順番が最後になっている。理由は上記のHARVEST依存のみ。HARVEST対応が早く取れるなら、5・6を前倒しする。暫定策として、`/cortex-priority` 全体を保護できるまでの間は、Renderの公開範囲(IP制限等)での緩和も検討できる（Render側の設定は未確認）。

## 2. 段階計画とロールバック条件

### 段階1: 本番 `PROXY_SECRET` の確認【最優先・承認不要の確認作業】
- 方法（人が実施）: Render Dashboard → 対象サービス → Environment で `PROXY_SECRET` の**存在だけ**を確認（値は見ない・共有しない）。
- 未設定だった場合: 先に設定する（承認事項）。値は十分に長い乱数。設定後、管理画面の設定画面の `proxySecret` にも同じ値を入力する必要がある（入力しないと管理画面からのLINE送信が403になる）。
- ロールバック: 管理画面からの送信が失敗する場合は、設定を戻さず、画面側の `proxySecret` 入力を修正する（戻すと再び無認証になるため）。

### 段階2: 新コードの安全なデプロイ
- 既定は挙動不変（環境変数が空）。**デプロイだけでは何も遮断されない**ことをテストで確認済み。
- 手順: PRレビュー → mainマージ → Renderデプロイ。LINE MAP(#77)とは `package.json` のテスト登録行のみ競合する見込み。後から入れる方でリベースして解消。
- 確認: デプロイ後に `/ping`、管理画面の表示、拡張機能の取込、点呼同期が従来どおりであること（手動）。
- ロールバック条件: 管理画面・取込・点呼のいずれかに異常 → Renderの直前デプロイへ戻す（新規環境変数は未設定のため単純に戻せる）。

### 段階3: reportモードで観測（`API_GUARD_MODE=report`）
- 前提: `ADMIN_PASSWORD_HASH` / `ADMIN_SESSION_SECRET` を設定し、各管理者PCで `/admin/login` にログイン。
- 期間: 業務の一周（最低1週間、月初・月末を含めるのが望ましい）。
- 見るもの: `GET /admin/api-guard-report`（要ログイン）のグループ別 `anonymous` と `wouldDeny`。
- 合格条件: 強制したいグループの `wouldDeny` が、**把握済みの利用元だけ**で説明できる。
- ロールバック: `API_GUARD_MODE` を空に戻す（即時・無影響）。ログイン運用で問題が出た場合は `ADMIN_*` を外せばログインのみ無効になる。

### 段階4: 利用元の認証対応
| 利用元 | 対応 | 担当/承認 |
|---|---|---|
| 管理画面 | 管理者ログイン（コード変更不要） | 運用 |
| Chrome拡張 | `INGEST_TOKEN` を発行し各PCの `chrome.storage.local.ofk3IngestToken` に設定 | 運用（DevToolsでの設定。UI化は別途） |
| HARVEST | `CORTEX_READ_TOKEN` を `Authorization: Bearer` で送る対応 | **別承認・別PR（本件では未着手）** |
| Activepieces | `/mentor-alert` に `X-Proxy-Secret` を付与 | 運用 |
- 完了条件: reportの `anonymous` が0（または想定内の少数）になる。
- ロールバック: トークンを無効化したいときは該当環境変数を外す。

### 段階5: 段階的強制（`API_GUARD_ENFORCE`）
- 1グループずつ追加し、**追加後すぐに**管理画面の主要操作・拡張取込・点呼を実機確認。各グループ間は最低1営業日。
- ロールバック条件（いずれかで直ちに該当グループを環境変数から外す）:
  - 拡張機能の取込が失敗（401/403）
  - 管理画面の操作が401になる
  - HARVESTが「上流エラー」になる
  - Activepiecesのアラートが届かない
  - `anonymous` に未把握の利用元が現れた
- 環境変数を外すだけで即時に元に戻る（再デプロイ不要）。

### 段階6: 秘密情報の整理
- 前提: 全呼び出しが `session` / 各トークンで通ることをreportで確認済み。
- 内容: `localStorage.lineSettings` の `channelToken`/`channelSecret`/`notifyToken`/`proxySecret` を、**利用者が明示的に実行する削除操作**で消去（`docs/API_PROTECTION.md` §5）。ソース直書きのLINEユーザーIDを環境変数化。`PROXY_SECRET` をローテーション。
- ロールバック: 削除前に項目名を確認し、削除は元に戻せないため、実行前に「サーバー側で設定済み」を確認する。

## 3. 残る重大リスク（現時点）
1. 本番 `PROXY_SECRET` の設定有無が**未確認**（未設定なら `/proxy` 等が無認証）。
2. `GET /cortex-priority` と `POST /cortex-priority/import` が無認証のまま（強制はHARVEST・拡張の対応待ち）。
3. マスタ系（読み書き）が無認証のまま。
4. `/static-map` `/geocode` は LINEが取得するため公開のまま（Google Maps APIクォータ濫用）。
5. 共有リンク(`/route-data/:id` 等)は、ID（144bit乱数）を知る人なら6時間は誰でも閲覧可。
6. レート制限・セッションはメモリ上（再起動でリセット、複数インスタンスでは共有されない）。
7. 管理画面本体（`/`）は誰でも配信される（データは含まないがコードは公開）。
