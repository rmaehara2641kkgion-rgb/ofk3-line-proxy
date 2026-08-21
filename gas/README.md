# GAS ソース（Google Apps Script）

Render 本番からプロキシ経由で呼び出される GAS の**ソース正本**。

| ファイル | 用途 | 本番との関係 |
|----------|------|--------------|
| `addr-master.gs` | 住所マスタ（lookup / geocode / batchSave） | `render-webhook-server.js` の `/addr-master` が GAS Web App URL へ中継。UI は `index.html` の `addr-master-gas-url` 設定 |
| `mentor-notified.gs` | メンター通知済みログ・activeDrivers 永続化 | Activepieces → Render `/mentor-alert` から GAS URL 経由で参照 |

## 秘密情報

- API キーは **GAS Script Properties**（`GOOGLE_MAPS_API_KEY`）で管理。ソースに直書きなし
- ファイル内の `SPREADSHEET_ID` は Google スプレッドシート ID（公開 URL 構成要素）

## デプロイ

Google Apps Script エディタにコピーし、Web アプリとしてデプロイ。Render / index.html 側の URL 設定をデプロイ URL に合わせる。
