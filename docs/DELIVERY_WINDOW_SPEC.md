# 配送時間帯 スキャン連動読み上げ — 照合仕様 (Phase 2)

状態: 仕様案 v0.1 / 実装: `delivery-window-core.js`, `delivery-window-voice.js` / テスト: `tests/delivery-window-core.test.mjs`
本番未反映。`index.html` は未変更。実データはリポジトリに含めない。

## 1. 原則

1. 時間帯は「確認できた」ときだけ読み上げる。それ以外は `確認できません！`。
2. SearchResults の時間欄が空欄でも「時間指定なし」とは判定しない(確定根拠が未定)。
3. エリミと SearchResults が矛盾したら、どちらも正とせず矛盾として記録し、読み上げない。
4. 日付が不整合なデータは、検証が終わるまで読み上げない。
5. 部分一致で別荷物を拾わない。判断に迷う入力は読み上げない。

## 2. 入力

### SearchResults CSV (`parseSearchResults`)
- UTF-8 (BOM可) / CRLF・引用符・セル内改行に対応。
- 必須列: `Tracking ID`, `Scheduled Delivery Start Time`, `Scheduled Delivery End Time`, `Promised Delivery Date`。1つでも欠けたら取込拒否(欠落列名を返す)。
- 任意列: `Last Updated Time`(最終更新の表示に使用)。その他の列は無視。
- Tracking ID は半角化・trim・大文字化。空IDの行は件数のみ数えて捨てる。

### エリミ Excel (`parseElimiCycleSheet`) — 対象は「エリミネーション報告」のみ
- `Cycle<N>` 見出しセルの列ごとにセクションを認識し、直下を区分見出し、その下の `トラッキングID`/`TRID` 行をID列とする。
- 日付セル(`日付`の右)を基準日(reportDate)として読む。文字列・Excelシリアル・Date対応。
- ID形式外のセルは `invalidCells` に数える。
- 他シート(未配報告・DFK2返送ほか)は読み上げ対象外。将来は `sheet → parser` の対応表を足す形で追加する(`buildTable` は `{id, cycle, heading, expected, mixed}` のレコード列だけを受け取る)。

### 区分見出しの扱い
| 見出し | 扱い |
|---|---|
| 単一区分で時間範囲あり(例 `16-18時指定`) | 期待時間帯 16:00-18:00 を持つ。**ただし見出しが個別荷物の予定時間と同じ意味かは未確定(§9.2)** |
| 複数区分が混在(例 `AM指定・14-16指定・BC`) | 混在 (mixed)。期待値なし。**見出しだけで矛盾とは断定しない** |
| 範囲なし (例 `AM指定`) | 期待値なし |

## 3. 照合キー
- キーは Tracking ID(正規化後)の完全一致。DA番号 = Tracking ID とは仮定せず、スキャン値側で次の順に解決する。

| 順 | 条件 | matchKind |
|---|---|---|
| 1 | 正規化後が `[A-Z]{2}\d{10}` と完全一致 | exact |
| 2 | 設定した接頭辞/接尾辞(`allowedAffixes`)を除くと完全一致 | affix |
| 3 | 英数字以外で区切られたID形式トークンがちょうど1種類 | embedded |
| — | 異なるIDトークンが複数 | ambiguous → 読み上げない |
| — | それ以外 | not_found |

- 英数字が隣接する場合(`XDA…`, `DA…3`)、桁欠け、別接頭辞(`DB…`)は一致させない。
- 実機バーコードの形式は未確認。サンプル確認後に `allowedAffixes` を設定する。
- 既存 `lookupDA` の「含まれていれば一致」ロジックは使わない。

## 4. 状態判定

結果 status は `window` / `no_window` / `unknown` の3種。判定は上から順に最初に当たったもの。

| 順 | 条件 | status | reason |
|---|---|---|---|
| 1 | エリミにもSRにも無い | unknown | not_found |
| 2 | SRにあるがエリミに無い (`requireElimi` 既定true) | unknown | not_in_elimi |
| 3 | エリミにあるがSRに無い | unknown | not_in_sr |
| 4 | エリミで複数サイクルに重複 | unknown | dup_cycle_elimi |
| 5 | SR重複で時間帯・約束日が不一致 | unknown | dup_conflict_sr |
| 6 | 開始・終了とも空欄 | unknown (※) | time_blank |
| 7 | 片方のみ空欄 | unknown | time_partial |
| 8 | 形式不正・タイムゾーン付き・終了≦開始 | unknown | time_invalid |
| 9 | 開始日≠終了日 | unknown | date_span |
| 10 | Promised Delivery Date が空欄/不正 | unknown | date_promised_missing |
| 11 | 開始日≠Promised Delivery Date | unknown | date_mismatch |
| 12 | 基準日からの日数が許容範囲外 | unknown | date_out_of_range |
| 13 | 単一範囲見出しの期待値と異なる | unknown | conflict_elimi |
| 14 | 上記すべて問題なし | window | ok |

※ 順6のみ、`noWindowEvidence(info)` が厳密に `true` を返した場合 `no_window`(`時間指定なし！`)。既定は未設定=常にunknown。確定根拠が決まったら関数を渡すだけで使える。順5より前に来ることはなく、データ矛盾の隠蔽には使えない。

SR重複: 同一ID・同一(開始,終了,約束日)なら1件に統合し重複件数に計上。1つでも異なれば dup_conflict_sr。
エリミ重複: 同一サイクル内の重複は無害(件数のみ計上)。複数サイクルにまたがる場合は dup_cycle_elimi。

## 5. 時間・日付仕様案(日付不整合 14 件への対応)

- 時刻は `YYYY-MM-DD HH:MM[:SS]` のゾーン無し壁時計。JST(現地時刻)として扱い、`Date` 変換はしない(ずれ防止)。`Z`・`+09:00` などが付いた値は推測せず time_invalid。
- 秒は切り捨て(23:59:59 → 23:59)。
- 読み上げ文は分が0なら `H時`、そうでなければ `H時M分`。`8:00-22:00` → `8時から22時！`、`18:00-23:59` → `18時から23時59分！`。固定パターンは持たない。
- 日付の整合条件 (すべて満たすときのみ読み上げ):
  1. 開始日 = 終了日
  2. 開始日 = Promised Delivery Date
  3. 基準日(エリミの`日付`、または設定値)からの日数が `0〜+1`(当日・翌日)。範囲は `dateRange` で変更可、`null` で無効化。
- いずれかを満たさなければ除外(順9〜12)。画面には理由コードを出す。
- 実データ(SR全体で時間帯あり36行): 日付整合 20行 / 約束日≠開始日 16行(約束日が開始日より前 14行・後 2行)。エリミ対象内では 14行が date_mismatch。原因の解釈(再予約・SCC側の更新遅れ等)は未確定。

## 6. 音声

- 新しい読み上げ専用。既存の `speakRouteNumber`(女性声優先)は変更しない。
- 男性声は SpeechSynthesisVoice に性別項目が無いため、名前一覧(Ichiro / Otoya / Takumi / Keita / Naoki ほか)で判定。`Google 日本語`・`Nanami`・`Haruka` 等は女性扱い。
- 男性声が無い端末では ja 音声にフォールバックし `male:false` を返す(画面に「男性声未検出」を出す。男性と偽らない)。
- 方式は最新スキャン優先(割り込み)を推奨。詳細は Phase 4。

## 7. 実データ読み取り検証 (Phase 2 時点、集計のみ)

入力: エリミ232件(ユニーク227)、SR 214行。読み上げ可能(window) = **0件**。

| 区分 | 件数 | 理由 |
|---|---|---|
| エリミ対象 227 | | |
| ├ SRに無い | 59 | not_in_sr (Cycle1 は 18件すべてSR無し) |
| ├ 時間欄が空欄 | 136 | time_blank |
| ├ 見出し(16-18)と矛盾 | 16 | conflict_elimi |
| ├ 約束日と時間帯の日付が不一致 | 14 | date_mismatch |
| └ 基準日から範囲外 | 2 | date_out_of_range |

- 照合一致 168 / エリミのみ 59 / SRのみ 46。
- エリミ重複5件はすべて Cycle1 と Cycle2 の両方に載っているID。

## 8. 画面統合方針 (Phase 5 で実装)

- 既存 `panel-scan` / `#scan-input` を再利用。`lookupDA` は変更しない。
- 新規 `delivery-window-ui.js` が `window.lookupDA` をラップする。ラッパーは(1)入力値を控え(2)時間帯モードON時のみ既存の音声フラグ `scanVoiceEnabled` を一時的にfalseにして元の `lookupDA` を実行(既存の女性音声が重ならない)(3)結果を新カードに表示し読み上げる。OFF時は完全に素通し。
- 時間帯モードの既定はOFF(本番挙動を変えない)。
- 追加UI: スキャン結果カード / 照合状態 / 音声ON-OFF / 最終データ更新日時 / エリミ・SR読込ボタン / 男性声の選択・未検出表示。
- スキャン値は画面に保持しない(履歴にはID末尾のみ)。結果カードは次のスキャンで置換。
- 既存の `scan-ready` はマニフェスト読込後にのみ表示される。時間帯モードのみで使う場合の表示条件は未決(§9)。

## 9. Phase 3: 除外理由の明確化と比較 (実データは読み取り専用で集計)

### 9.1 除外理由 — 1件につき主たる理由1つ (エリミ対象 227件、合計 227)
主たる理由は §4 の判定順で最初に当たったもの。すべての該当理由は `items.csv` の `all_reasons`(`|`区切り)に残る。

| 主たる理由 | 件数 | 備考(その理由を持つ件数。重複あり) |
|---|---|---|
| 読み上げ可能 | 0 | |
| SearchResultsに無い (not_in_sr) | 59 | 59 |
| 時間欄が空欄 (time_blank) | 136 | 136 |
| 約束日と時間帯の日付が不一致 (date_mismatch) | 14 | 14 |
| 基準日から当日・翌日の範囲外 (date_out_of_range) | 2 | 5 |
| エリミ見出しと時間帯が不一致 (conflict_elimi) | 16 | 32 |
| 合計 | 227 | |

複数理由の組合せ(時間帯ありの 32件): `date_mismatch + conflict_elimi` 11 / `date_mismatch + date_out_of_range + conflict_elimi` 3 / `date_out_of_range + conflict_elimi` 2 / `conflict_elimi` のみ 16。

### 9.2 エリミ見出し(Cycle2 「16-18時指定」)の扱い — 運用確認待ち
- 見出しは、荷物個別の配達希望時間ではなく、エリミ処理上の区分である可能性が高い(運用情報)。根拠が確認できるまで、見出しとSearchResultsの時間帯を直接比較する判定は**保留**する。
- ただし本番の読み上げ条件は緩和しない。`headingCheck` の既定は `true`(現行どおり矛盾扱いで読み上げない)。`headingCheck:false` は**比較・分析専用**で、画面/本番からは使わない。
- 見出しと時間帯が異なる事実は `heading_differs` 列と `headingDiffers` に常に記録する。
- 運用確認事項:
  1. Cycle2 は「16-18時指定」の荷物だけか、16-18時の配送サイクル(締め時間帯)を指す区分か。
  2. エリミ対象の時間帯は、SearchResultsの `Scheduled Delivery Start/End Time` で判断してよいか。
  3. Cycle1 の `AM指定・14-16指定・BC` に含まれる区分ごとの意味。

### 9.3 日付条件の比較 (分析のみ。本番は当日・翌日の暫定ルールを維持)
`delivery-window-report.js` の `compareScenarios` が、他の安全条件(空欄・日付不一致・重複・SR未掲載)は一切変えずに、見出し比較と日付制限だけを切り替えて件数を比べる。

| シナリオ | 読み上げ可能 | 変化 |
|---|---|---|
| 現行(本番条件) | 0 | |
| 見出し比較なし | 16 | `conflict_elimi → ok` 16 |
| 日付制限(当日・翌日)なし | 0 | `date_out_of_range → conflict_elimi` 2(見出し比較は有効のため) |
| 見出し比較なし + 日付制限なし | 18 | 16 + 2 |

- 日付制限なしで加わる2件は、前日(-1日)の時間帯。過去の時間帯を現在の荷物として読み上げる妥当性は要確認。
- 14件の `date_mismatch` はどのシナリオでも除外されたまま(約束日が時間帯の日付と一致しないため)。
- 見出し比較を外した場合に読み上げ可能になる 16件の内訳: 8時から22時 11 / 0時から23時59分 2 / 18時から23時59分 2 / 5時から13時 1。**8-12・14-16・16-18 は含まれない**。8:00-22:00 は Amazon の既定枠(実質指定なし)の可能性があり、そのまま「8時から22時！」と読むことが現場で意味を持つかは未確認。

### 9.4 仕様変更案 (未適用。承認後に適用)
- 案A: 見出し比較を「矛盾」ではなく「参考表示(画面にのみ表示、読み上げは止めない)」に降格する。運用確認 9.2-1/2 が取れてから。
- 案B: 8:00-22:00 などの広い枠は「読み上げる」「画面表示のみ」「確認できません」のどれにするか決める(`broadWindow` 判定の追加)。
- 案C: 日付制限は当日・翌日を維持。再配達日の運用(何日先まで有効か)が分かった時点で `dateRange` を調整。前日以前は引き続き除外。
いずれも現行の既定値は変更していない。

### 9.5 SearchResults 48列の調査 (値は集計のみ、個人情報は表示していない)
- `Scheduled Delivery Start/End Time` と同じ記入パターンの列は他にない。時間指定の有無を単独で確定できる列はない(時間帯あり 36 / なし 178)。
- 参考になる列:
  - `Ship Option`: `scheduled-delivery-jp` は 12件すべて時間帯あり、`rush` は 6件すべて時間帯あり。→ これらで時間欄が空なら「時間指定ありのはずが欠落」の可能性として要確認度を上げる材料になる。**「時間指定なし」の確定根拠にはならない**。
  - `Ship Method`: `AMZN_JP_MAIL` は 20件すべて時間帯なし、`AMZN_JP_WAVE_*` は時間帯ありと混在、`AMZN_JP_RUSH_LATE` は 5件すべて 18:00-23:59。
  - `Reason`(`Out Of Delivery Time` 9件はすべて時間帯なし)、`Operation`(`CANCELLED`)も関連しうるが、意味は未確認。
- 全件空欄の列: `Last Scan location`, `Expected Next Location`, `Last Scan Status`, `District`, `Shipment Type`, `Service Type`, `SAL Color`。
- 「時間帯なしの荷物にだけ見られる値」は観測上の傾向であって、Amazon の仕様ではない。「時間指定なし」の確定条件にするには、Amazon側の定義(または運用ルール)の確認が必要。

### 9.6 出力と取り扱い
- `scripts/delivery-window-report.mjs --sr <csv> --elimi <xlsx> --out <dir>` が `summary_by_primary_reason.csv`, `items.csv`, `scenario_comparison.csv`, `errors.json` を書く。入力は読み取り専用。外部送信・音声再生なし。
- 出力に配送情報が入るため、`--out` はリポジトリ外か `./local/`(gitignore済)のみ許可。リポジトリ内の他の場所は拒否する。
- `errors.json` は件数・コードのみ(Tracking IDや時刻を含まない)。
