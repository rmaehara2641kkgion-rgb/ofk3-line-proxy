# ofk3-line-proxy

OFK3 配送管理アプリ + LINE Webhook プロキシ（Render デプロイ）。

## どこを直すか（重要）

| 用途 | パス |
|------|------|
| **Production Entry（本番）** | [`index.html`](index.html) |
| **Demo** | [`demo-app/`](demo-app/) |
| **Legacy（本番修正禁止）** | [`legacy/delivery-app/`](legacy/delivery-app/) |

**本番修正時に `legacy/` を編集しないでください。**

詳細: [docs/PRODUCTION-ENTRY.md](docs/PRODUCTION-ENTRY.md)

## 起動

```bash
# 本番同等（Render）
npm install
npm start   # inject-tenko-audit.js → render-webhook-server.js

# デモ
cd demo-app && npm install && npm start
```

## テスト

```bash
npm run test:all
```
