# INO-1 ローリング60h 指標の定義（rolling60h-predict-3）

dry-run 専用。LINE 送信はしない（`sent=false` / `channel=dry-run`）。
`confirmedActual=false` は「Amazon の推定稼働時間（estimated_working_hour）であり、確定実績ではない」の意味。

## 5分類（人数単位・排他・合計 = driverCount）
| 指標 | 意味 |
|---|---|
| clearCount | すべての7日窓が確定し、60h 以下で、60h ちょうどの窓もない |
| exceedCount | 欠損のない人で、確定した窓に 60h 超がある |
| approachCount | 欠損のない人で、60h ちょうどの窓がある（超過なし） |
| partialCount | 欠損（未確定・データ無し・未定義記号）のある窓と、判定できた窓（正常/接近/超過）または `knownOver` の窓の両方を持つ人 |
| undeterminedCount | 判定できた窓も `knownOver` の窓も無く、欠損のみの人 |

## 部分欠損の内訳（人数単位。第6分類ではなく partialCount の内数）
| 指標 | 意味 |
|---|---|
| partialExceedCount | 部分欠損の人のうち、**欠損のない確定窓**で超過がある人 |
| partialApproachCount | 部分欠損の人のうち、確定窓で 60h ちょうどがあり、超過窓がない人 |
| partialKnownOverCount | 部分欠損の人のうち、**未確定の空白を含む窓**で、確定済みの時間だけで 60h 超の窓がある人 |

`partialExceedCount` と `partialKnownOverCount` は見ている窓が違うため、一致しない。
同じ人が両方に数えられることもあり、確定超過窓を持たず knownOver だけの人は後者のみに数える。
どちらも partialCount を超えない。

## 窓単位の指標
| 指標 | 意味 |
|---|---|
| knownOverWindows | `knownOver` の7日窓の数（人数ではない） |
| blankFilledWindows / blankFilledPersons | 前回「空白(未確定)」だった日が今回勤務記号に変わった窓の数 / 人数 |
| blankFilledToAlertWindows | 上記のうち、今回が超過・接近の窓 |
| normalToExceedWindows | 前回 `within`（正常）だった窓が今回 `exceed` になった窓の数 |
| normalToExceedBySchedule / ByDaily | 上記の原因。予定変更（空白補完を含む）/ デイリー更新 |

## 日付単位・人日単位
| 指標 | 意味 |
|---|---|
| blankUnconfirmedPersonDays | 勤務記号が混在する日付列の空白セルの数（人日）。0h にしない |
| outsidePeriodDateCount | 全員が空白の日付列の数（有効期間外候補）。7日窓は短縮しない |
| outsidePeriodKeptByDailyDays | 上記の日のうち、有効なデイリー時間があり残した人日 |

## 比較ルール
- 履歴の比較は同じ `logicVersion` の直近の実行とだけ行う。旧版（predict-2）の履歴は削除せず保持し、比較には使わない。
- 初回の predict-3 は比較対象がないため、変更系の指標（blankFilled* / normalToExceed* / resolved* / stillAlert）は 0。
- 空白セル・数式の空文字は未確定。「休」は確定 0h。不明な記号は 0h にせず判定不能。

# OFK3 ローリングシフト アラート者一覧（rolling-alert-v1）
OFK3「Rolling 60h」画面の「アラート者」一覧。`rolling-alert-core.js` が判定し、`rolling60h-ui.js` が表示する。
上の INO-1 / HARVEST の「任意7日窓の全スライド判定」（`computeRolling60h`）とは別の、**対象日（基準日）を当日とする1点判定**。

| 区分 | 条件 |
|---|---|
| 超過確定 | 過去6日の**実績**だけで 60h 超 |
| 超過予測 | 予定（過去の予定日・当日予定）を含めて 60h 超。60h ちょうどは超過ではない |
| 接近警告 | 過去6日が 49〜60h、かつ当日>0h、かつ合計 60h 以内 |
| 勤務予定未確認 | 過去6日が 49〜60h だが当日の予定が不明（空白・データなし） |
| （対象外）当日休 | 過去6日が 49〜60h で当日0h。超過でなければ除外 |
| （対象外）判定不能 | 過去6日に未取得日（空白・データなし・未定義記号）があり、既知分でも超過でない |

- 超過予測が成立する人は接近警告に重複計上しない。空白セルは 0h にしない。
- 結果は `GET /rolling-alerts/latest` / `POST /rolling-alerts/save`（**要認証**）で最新1件を保存（一時ディスクJSON＋ブラウザ localStorage）。同一データ（指紋一致）の再投入は置換も追記もしない。認証・保存・移行は `docs/ROLLING_ALERT_API.md`、HARVEST との差分は `docs/ROLLING_ALERT_HARVEST_COMPARISON.md`（HARVEST側は未確認）。
- テスト: `npm run test:rolling-alert`（判定・保存）、`npm run test:rolling-alert-browser`（Chromium実機）。
