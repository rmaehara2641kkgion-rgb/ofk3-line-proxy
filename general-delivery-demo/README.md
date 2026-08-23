# 配送管理デモ / Delivery Operations Demo

宅配・軽貨物・ラストワンマイル向けの**公開ショールーム**です。  
特定キャリアや特定拠点の専用画面ではありません。本番アプリとも独立しています。

## 起動

```bash
cd general-delivery-demo
npm install
npm start
```

http://localhost:3100

## Render（新規Service専用）

既存の本番Serviceは使わないでください。新しい Web Service を作ります。

| 項目 | 値 |
|------|-----|
| Service Name | `general-delivery-demo` |
| Root Directory | `general-delivery-demo` |
| Build Command | `npm install` |
| Start Command | `node server.js` |
| Branch | `feature/general-delivery-demo` |
| Environment Variables | なし |
| Node | 18 以上 |

## 3分で見ること

1. ダッシュボードで当日状況を見る
2. ドライバーを見る
3. 勤務スケジュールを見る
4. Auto Assign で担当候補を作る
5. 時間指定MAPでPINを確認する
6. 担当者別 LINE 共有プレビューを見る

「サンプルデータで試す」だけで最後まで体験できます。

## 安全設計

- LINE はプレビューのみ。実送信APIは常に拒否します
- フロントに認証情報を置きません
- このフォルダは repo root の本番ファイルを参照しません

## テスト

```bash
npm test
```

## 公開用repoについて

このbranchのGit履歴には本番コードの歴史があります。  
本格公開では `general-delivery-demo/` だけを**新規の空リポジトリ**へ移してください。既存履歴の丸ごとコピーはしないでください。
