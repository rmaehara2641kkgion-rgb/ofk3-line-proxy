# demo-app（営業デモ版）

OFK3 配送管理アプリのデモ。**本番（Render）とは別エントリです。**

## 起動

```bash
cd demo-app
npm install
npm start   # http://localhost:3000
```

## 依存

- `server.js` の `rootDir`（`..`）= リポジトリ直下 — 共有画像・スプラッシュ動画を配信
- `index.html` の `../` 参照 = repo root の静的アセット
- **legacy/delivery-app には依存しません**（Phase 4 で物理削除済み）
- root 本番 JS（`/assign-support.js` 等）は参照しません（自己完結 + `demo-data.js`）

## 正本との関係

| 用途 | パス |
|------|------|
| Production | [`../index.html`](../index.html) |
| Demo | このディレクトリ |
| Legacy | ~~`legacy/delivery-app/`~~ 解体済み — Git 復元は `legacy/README.md` 参照 |
