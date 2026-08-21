# ofk3-line-proxy

OFK3 配送管理アプリ + LINE Webhook プロキシ（Render デプロイ）。

## どこを直すか（重要）

| 用途 | パス |
|------|------|
| **Production Entry（本番）** | [`index.html`](index.html) |
| **Demo** | [`demo-app/`](demo-app/) |
| **GAS source** | [`gas/`](gas/) |

`legacy/delivery-app` の git 追跡コードは Phase 3 で削除済み。untracked 残存物は [`legacy/`](legacy/) 参照。

**本番修正時に `legacy/` の untracked コピーを編集しないでください。**

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
