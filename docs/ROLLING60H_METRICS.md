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
