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

## 3分で見ること

1. ダッシュボードで当日状況を見る
2. ドライバーを見る
3. 勤務スケジュールを見る
4. Auto Assign で担当候補を作る
5. 時間指定MAPでPINを確認する
6. 担当者別 LINE 共有プレビューを見る

「サンプルデータで試す」だけで最後まで体験できます。Excel は不要です。

## 安全設計

- 公開時の LINE は **プレビューのみ**
- トークン / secret はフロントに置かない
- 実送信は `LINE_SEND_ENABLED=true` かつサーバー環境変数がある Private 環境のみ検討可能
- このフォルダは repo root の Production ファイルを参照しません

## テスト

```bash
npm test
```

## 将来の分離

このディレクトリだけを別リポジトリへ移せます。
