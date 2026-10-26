# OFK3 ローカル60時間ボードと FRIDAY 連携仕様

WH60管理タブの「データ取込」「残り時間・リスク一覧」は、Excelをブラウザ内で集計します。
GAS・Render・HARVESTは使いません（既存の公開経路は残してあり、このボードとは独立です）。

## データの流れ
1. シフトExcel（DSP別シート）と Amazon Daily Working Hour（`Report5_Daily_Data`）を取り込む。
2. 既存の判定エンジン（`harvest-rolling60h-run.js` の `capture`、中身は `rolling60h-core.js`）に、読み込み済みのブックを渡して集計する。判定ロジックは変更していない。
3. `rolling60h-local-board.js` が一覧用のボードと FRIDAY 用の要約を作る。
4. `rolling60h-local-store.js` が IndexedDB に保存する。**保存先はそのブラウザ（オリジン）だけ**。

## 数値の意味
| 項目 | 定義 | 確定値になる条件 |
|---|---|---|
| 勤務可能上限 | 60 − 過去6日の合計 | 過去6日がすべてAmazon実績（推定）のとき。予定を含むと「暫定」。欠損があると算出不可（null） |
| 予定終了後の余裕 | 60 − 今日を終端とする7日の予測合計 | 7日すべてが実績のとき。予定を含むと「暫定」 |

判定（正常・接近・超過・部分欠損・判定不能）は既存エンジンの出力そのまま。エンジンの境界は「合計 > 60 が超過、合計 = 60 ちょうどが接近」。
Amazon の `estimated_working_hour` は推定で、法的な労働時間の確定値ではない。

## 保存のルール
- 検証に通った集計だけを保存する（`validateBoard`）。保存は1トランザクションで、失敗しても前回の保存分は変わらない。
- 取込の失敗（形式不正・読込不能）は、前回取り込んだファイルも保存済みの集計も変更しない。
- シフトかDailyのどちらかが欠けた集計は画面に暫定表示するだけで、保存しない（保存済みの正常な集計を置き換えない）。
- 集計対象者が0人のときは保存しない。
- ファイル自体は保存しない。

## FRIDAY 用の要約 JSON（`ofk3.rolling60h.friday-summary` v1）
氏名・Transport ID・個人ごとの時間は含まない。

```json
{
  "kind": "ofk3.rolling60h.friday-summary",
  "schemaVersion": 1,
  "generatedAt": "2026-10-26T01:15:11.600Z",
  "readAt": "2026-10-26T01:15:12.878Z",
  "referenceDate": "2026-10-26",
  "counts": {
    "exceed": 8, "approach": 0, "undetermined": 38,
    "partial": 27, "partialExceed": 5, "partialApproach": 1,
    "clear": 19, "driverCount": 92
  },
  "freshness": { "status": "fresh", "reasons": [], "ageMinutes": 0, "staleAfterHours": 12 },
  "data": {
    "completeness": "partial",
    "inputs": { "shift": true, "daily": true },
    "safeToAnnounceAsComplete": false
  },
  "hoursKind": "estimated_working_hour",
  "notice": "推定値・予定を含む参考値。法的な労働時間の確定値ではありません。",
  "source": "ofk3-local"
}
```

| フィールド | 意味 |
|---|---|
| `counts.*` | 人数。`exceed + approach + partial + undetermined + clear = driverCount`（互いに排他）。`partialExceed` / `partialApproach` は `partial` の内数。データなしのときは `null`（0人とは区別する） |
| `generatedAt` | 集計した時刻（ISO, UTC）。`readAt` は要約を読んだ時刻 |
| `referenceDate` | 7日窓の終端（JSTの日付） |
| `freshness.status` | `fresh` / `stale` / `unknown`。`stale` の理由は `age-over-limit`（12時間超）または `reference-date-not-today`（基準日がJSTの今日ではない）。鮮度は **読んだ時点** で再計算される |
| `data.completeness` | `complete`（全員判定済み）/ `partial`（部分欠損か判定不能がいる）/ `incomplete-input`（シフトかDailyが未取込）/ `no-data` |
| `data.safeToAnnounceAsComplete` | `complete` かつ `fresh` のときだけ true。音声で「異常なし」と言ってよい条件 |

音声通知の推奨の扱い（接続側で決める）:
- `freshness.status !== "fresh"` または `data.completeness !== "complete"` のときは、人数の読み上げに「未確定」「古いデータ」を添える。
- `counts.exceed` が `null` のときは「データなし」であり、「0人」ではない。

## Cursor が要約を取得する方法
どれも読み取り専用で、HARVESTやFRIDAYへの送信は実装していない。

1. **関数（推奨）**: OFK3のページ内で `await Rolling60hBoardUI.getFridaySummary()`。IndexedDB の最新ボードから、鮮度を現在時刻で再計算した要約を返す。保存済みボードがなければ `completeness: "no-data"`。
2. **イベント**: 集計と保存に成功するたびに `window` へ `CustomEvent('ofk3:rolling60h-summary', { detail: <要約> })` を発火する。
3. **同期読み出し用ミラー**: `localStorage['ofk3.rolling60h.fridaySummary']` に最後の要約（個人情報なし）を複製する。鮮度は保存時点の値なので、`generatedAt` から再計算すること。
4. **IndexedDB 直読**: DB `ofk3-rolling60h` / ストア `boards` / キー `friday-summary`（要約）、`latest`（個人情報を含む一覧用ボード。FRIDAYには渡さない）。

HARVESTへ載せる場合は、要約をそのまま `harvest:handoff` の payload に入れる実装を Cursor 側で追加する。HARVESTが停止してもOFK3の一覧は動く（独立している）。

## 既知の制約
- 保存はブラウザ単位。別のPC・ブラウザ・シークレットウィンドウでは見えない。
- ブラウザには HARVEST の履歴アーカイブ（過去日の実績の再利用）がないため、Dailyファイルの対象期間より前の日は欠損扱いになる。HARVEST経由の集計と人数が1人程度ずれることがある。
- シフト表は1ファイルのみ（既存のサーバー側集計と同じ）。月をまたぐ窓は判定不能になりうる。複数月を合成する既存の格子表示は「シフト格子（既存）」サブタブに残している。
