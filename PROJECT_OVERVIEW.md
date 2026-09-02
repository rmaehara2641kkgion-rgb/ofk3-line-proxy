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
- ライブラリ (CDN): xlsx@0.18.5, html5-qrcode@2.3.8（QR読取）, tesseract.js@5（OCR）, qrious@4.0.2（QR生成）
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
- 点呼データはlocalStorageに加え、`/tenko-sync` によるPC⇔タブレット間サーバー同期に対応（詳細: [5. 点呼データ同期](#5-点呼データ同期tenko-sync)）
- ステータス選択肢: 正常 / 遅刻 / 欠勤 / 他拠点

### 3. ドライバー能力データベース
- 85名分の累計実績データ（個/時間、配送成功率、誤配率等）をindex.html内に埋め込み
- 配送終了時間の予測計算にも使用

### 4. メンター早期停止検知（方式B）
- Activepiecesクラウド版で30分ごとに自動実行
- eDriving/VRM MentorのAPIからOFK3のActiveドライバーを取得
- 前回Activeリストとの差分で「消えた人」を検知
- 4時間未満で消えた場合 → Render → LINE通知（管理者7名）
- 永続化: GASスプレッドシート（activeDriversシート + notifiedLogシート）

### 5. 点呼データ同期（`/tenko-sync`）
2026-08時点で `render-webhook-server.js` にサーバー同期エンドポイントが実装済み（従来の「localStorageのみ」という記載は古い）。

**同期対象:**
- `tenkoSchedule`（点呼スケジュール本体。免許認証・メンター認証などの認証状態を含む）
- 点呼アラート解除/再有効化状態（`notifyDisabled`）
- 新規ドライバーdelta（`driverId` / TransportID / 日本語名 / 所属など。マスタ新規登録・一括インポートを他端末へ伝播）
- 点呼ログ（`/tenko-master` 経由でGASスプレッドシートへも記録）
- ドライバーマスタ全体（`/tenko-master` 経由、GAS読み書き）

**同期経路:**
```
タブレット（点呼QR/OCR認証） ── POST /tenko-sync ──▶ サーバーストア（tenkoSyncStore） ──▶ PC（GET /tenko-sync）
PC（マスタ新規登録・一括インポート） ── POST /tenko-sync（driverDeltas） ──▶ サーバーストア ──▶ タブレット
```

**同期タイミング:**
- 手動同期ボタン「📤 タブレットに同期」（PC→サーバー、`tenkoSchedule`全体を送信）
- 30秒ごとの自動GETポーリング（両端末、`pollTenkoSync()`）
- QR認証完了時（自動push、2秒デバウンス、`autoSyncTenkoSchedule()`）
- メンター認証完了時（同上）
- 新規ドライバー登録・一括インポート時、QR表示/印刷時（`driverDeltas`を自動push）
- POST送信時は `X-Tenko-Sync-Token` 認証ヘッダが必須（サーバー環境変数 `TENKO_SYNC_TOKEN` 未設定時は503、不一致時は401でfail-closed）

**将来の改善候補（未実装・今回はDB化を行っていません）:**
- サーバーストア実体は `os.tmpdir()/tenko-sync-store.json`（Renderの一時領域）。簡易ディスクバックアップはあるが、再デプロイ等で永続性が失われる可能性がある
- `tenkoSchedule` はPOST単位で丸ごと上書き（マージなし）のため、複数端末がほぼ同時に送信すると後勝ちで一部更新が失われる可能性がある
- 恒久対応の候補: Render Persistent Disk / PostgreSQL / Supabase等の外部DBへの移行（今回は範囲外、候補の記載のみ）

### 6. QRコード生成仕様
ドライバー向けQRコードの生成ロジックは `getQRData(name)` を正式な共通ロジックとして扱う。`showDriverQR()`（個別表示）・`printAllQR()`（一括印刷）など、QRを生成する箇所は必ずこの関数を呼び出し、独自にQR値を組み立てるロジックを再実装しない。

**QR生成値の優先順位:**
1. TransportID（`transportIDs[name]`が存在すればそれをそのまま使用。日本語を含まず読み取りが安定するため最優先）
2. `driverId`（`"OFK3_D" + driverId`。ドライバーの氏名変更・追加削除があっても不変の固定値）
3. 氏名ベース（`"OFK3_DRIVER:" + name`。上記2つが無い場合の最終手段）

**新規ドライバー登録時の同期:** 一括インポート（能力DB取込・配送実績取込等）や手動追加でドライバーが新規登録された場合、`driverId`/TransportID等のdeltaをタブレット側へ自動push（[5. 点呼データ同期](#5-点呼データ同期tenko-sync)参照）する。また `showDriverQR()`・`printAllQR()` の呼び出し時にも同じdeltaを再push（自己修復的に同期漏れを解消）する。

### 7. 品質管理 — 時間指定（TWC）違反分析
品質管理タブに、Amazon週次TWC（Time Window Commitment）データを分析する機能を追加（既存の「時間指定」タブとは別機能——そちらは当日の時間指定荷物を別部隊へ引き渡すための抽出機能）。

- **取込**: Amazon週次TWC生データ（xlsx/csv）をドラッグ&ドロップ
- **ドライバー照合**: `transporter_id` 列を既存のFTDS/CCと同じTID照合ロジック（`resolveDriverNameFromTid`）で氏名に変換
- **違反判定**: `time_window`（例: `DW 05:00:00-13:00:00`）の終了時刻と `actual_attempt_time` を比較し、終了時刻を超過した配達を違反として抽出
- **集計**: ドライバー別（件数・発生日・最大超過時間）、日別/DA別の明細
- **優先順位判定**（W35実データの目視分析19件全件と一致するよう検証済みのルール）:
  - 件数 ≥ 6 かつ 最大超過 ≥ 60分 → **最重点**
  - 最大超過 ≥ 60分 または 件数 ≥ 3 → **要確認**
  - それ以外 → **経過確認**
- **Excel出力**: 3シート構成（時間指定_サマリー／DA別_詳細／最優先ドライバーの重点確認）。既存の`aoa_to_sheet`パターン（協力会社レポート等）を再利用
- **検証情報**: 提供されたW35実データ（`W35_OFK3_GDS_TWC.xlsx`）を実際に処理した結果、違反57件・対象ドライバー19名、および優先順位・件数・最大超過時間のすべてが既存の分析結果（`W35_時間指定違反_分析.xlsx`）と一致することを確認済み

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
├── legacy/                       # README のみ（delivery-app 解体済み）
└── gas-proxy-code.gs 等          # LINE プロキシ GAS（repo root）
```

| 用途 | パス |
|------|------|
| **Production** | `index.html`（repo root） |
| **Demo** | `demo-app/` |
| **GAS** | `gas/` |
| **Legacy app** | ~~`legacy/delivery-app/`~~ | **Phase 4 で物理削除済み** |

詳細: [docs/PRODUCTION-ENTRY.md](docs/PRODUCTION-ENTRY.md)

## 既知の技術的負債
- **カメラ統合**: getUserMedia 4箇所 / stop 7箇所が分散。CameraManagerへの集約が必要
- **index.html 16,000行**: 将来的にモジュール分割を検討
- **点呼データ同期ストアの永続性**: `/tenko-sync` のサーバーストアはRenderの一時領域(`os.tmpdir()`)依存のため、再デプロイ等で消える可能性がある。また`tenkoSchedule`はPOST単位で丸ごと上書きされるため、複数端末がほぼ同時に更新すると競合しうる（詳細: [5. 点呼データ同期](#5-点呼データ同期tenko-sync)）。恒久対応にはRender Persistent Disk / PostgreSQL / Supabase等への移行が候補

## 注意事項
- GASデプロイ時は「デプロイを管理→既存を編集→新バージョン」を使う（「新しいデプロイ」はURL変更される）
- Activepiecesのコード変更後は必ず「公開」ボタンを押す
- Renderスリープ防止: cron-job.orgで /ping 定期アクセス設定済み
