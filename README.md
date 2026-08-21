# ofk3-line-proxy

OFK3 配送管理アプリ + LINE Webhook プロキシ（Render デプロイ）。

## どこを直すか（重要）

| 用途 | パス |
|------|------|
| **Production Entry（本番）** | [`index.html`](index.html) |
| **Demo** | [`delivery-app/demo-app/`](delivery-app/demo-app/) |
| **Legacy / Development Copy（本番修正禁止）** | [`delivery-app/index.html`](delivery-app/index.html) |

詳細: [docs/PRODUCTION-ENTRY.md](docs/PRODUCTION-ENTRY.md)

## 起動

```bash
npm install
npm start   # inject-tenko-audit.js → render-webhook-server.js
```

## テスト

```bash
npm run test:all
```
