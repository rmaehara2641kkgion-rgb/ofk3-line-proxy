# OFK3 配送管理アプリ — プロジェクト概要

## 概要
Amazon配送拠点「OFK3」の日次オペレーションを一元管理するWebアプリ。
スマホ・PC両対応。単一HTML構成（index.html 約16,000行）。

## 本番URL・リポジトリ
- 本番: https://ofk3-line-proxy-1.onrender.com/index.html
- GitHub: https://github.com/rmaehara2641kkgion-rgb/ofk3-line-proxy
- ホスティング: Render (Node.js / Express)

## 技術スタック
- フロントエンド: 単一 `index.html`（HTML/CSS/JS、フレームワークなし）
- CSS: Tailwind CSS (CDN)
- ライブラリ (CDN): xlsx@0.18.5, html5-qrcode@2.3.8, tesseract.js@5, qrcodejs@1.0.0
- バックエンド: Render上の `render-webhook-server.js` (Express)
- 外部連携: LINE Messaging API, Google Apps Script, Google Maps API
- **制約: テンプレートリテラル（バッククォート）禁止** — EdgeのIEモード互換のため文字列連結のみ使用

## 主要機能

### 1. ダッシュボード
- Amazon配送データ(.xlsx)アップロード → コース別・ドライバー別の配送状況表示
- ジオコーディング（住所→座標変換）: GASスプレッドシートの住所マスタ(11.3万件)優先、未取得分はGoogle Maps APIで日次100件自動取得
- 地図表示（Google Maps）

### 2. 点呼管理
- DAシフト表アップロード → 着車時間・免許認証・メンター認証を管理
- QRコード読取 / OCR / 手動入力に対応
- 点呼ログはlocalStorageに保存（将来GAS連携予定）

### 3. ドライバー能力データベース
- 85名分の累計実績データ（個/時間、配送成功率、誤配率等）をindex.html内に埋め込み
- 配送終了時間の予測計算にも使用

### 4. メンター早期停止検知（方式B）
- Activepiecesクラウド版で30分ごとに自動実行
- eDriving/VRM MentorのAPIからOFK3のActiveドライバーを取得
- 前回Activeリストとの差分で「消えた人」を検知
- 4時間未満で消えた場合 → Render → LINE通知（管理者7名）
- 永続化: GASスプレッドシート（activeDriversシート + notifiedLogシート）

## システム構成図
```
[Activepieces Cloud]
  Schedule (30min) → eDriving API → 6.Code (検知ロジック)
       │                                    │
       │  GET ?action=getActive/saveActive   │  POST /mentor-alert
       ▼                                    ▼
  [GAS スプレッドシート]              [Render server.js]
   - activeDrivers                     │
   - notifiedLog                       │ LINE Push API
                                       ▼
                                  [LINE 管理者通知]
```

## ファイル構成（2026-08 Phase 1 以降）

```
/                                 # リポジトリ直下 = Render 静的配信 root
├── index.html                    # Production 正本（約19,000行）
├── lat-departure-core.js         # LAT 判定コア（本番）
├── assign-support-core.js        # アサイン支援コア（本番）
├── assign-support.js             # アサイン支援 UI 連携（本番）
├── tenko-transport-audit.js      # 点呼 TransportID 監査（本番）
├── render-webhook-server.js      # Render 用 Express サーバー
├── inject-tenko-audit.js         # 起動前フック → render-webhook-server.js
├── package.json
├── render.yaml
├── tests/                        # 本番向けテスト（npm run test:all）
├── demo-app/                     # 営業デモ（独立 server.js、本番とは別）
│   ├── index.html
│   ├── demo-data.js
│   └── server.js
├── gas/                          # GAS ソース正本
│   ├── addr-master.gs
│   └── mentor-notified.gs
├── legacy/                       # git 追跡 Legacy 削除済み（untracked 残存あり）
└── gas-proxy-code.gs 等          # LINE プロキシ GAS（repo root）
```

| 用途 | パス |
|------|------|
| **Production** | `index.html`（repo root） |
| **Demo** | `demo-app/` |
| **GAS** | `gas/` |
| **Legacy app** | ~~`legacy/delivery-app/`~~ git 追跡分削除済み |

詳細: [docs/PRODUCTION-ENTRY.md](docs/PRODUCTION-ENTRY.md)

## 既知の技術的負債
- **カメラ統合**: getUserMedia 4箇所 / stop 7箇所が分散。CameraManagerへの集約が必要
- **index.html 16,000行**: 将来的にモジュール分割を検討
- **localStorage依存**: 点呼ログ等はPC間で同期されない

## 注意事項
- GASデプロイ時は「デプロイを管理→既存を編集→新バージョン」を使う（「新しいデプロイ」はURL変更される）
- Activepiecesのコード変更後は必ず「公開」ボタンを押す
- Renderスリープ防止: cron-job.orgで /ping 定期アクセス設定済み
