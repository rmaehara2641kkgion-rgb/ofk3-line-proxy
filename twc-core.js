/**
 * OFK3 TWC（時間指定違反分析）— 判定・集計処理コア（DOM非依存の純粋関数のみ）
 *
 * index.html の既存TWC実装（findTwcHeaderRow/mapTwcColumns/parseTwcWindowEndMinutes/
 * parseTwcWindowStartMinutes/twcWindowDisplayLabel/parseTwcDateTimeCell/twcFormatDate/
 * twcFormatTime/twcFormatOverage/processTwcData/groupTwcByDriver/classifyTwcJudgment/
 * twcMultiDayCount/buildTwcDaComment/twcAttemptRangeLabel/twcDatesLabel/exportTwcResult、
 * index.html内 17969-18364行付近、現行main時点の行番号）から、DOM/ブラウザAPI
 * （FileReader・document・localStorage・alert・XLSX.writeFile等）に依存しない部分だけを
 * 抽出したもの。判定ロジック（時間指定超過の算出・優先順位判定の3閾値）は一切変更していない。
 *
 * 現時点では render-webhook-server.js（/twc-export）からのみ require('./twc-core.js') で
 * 利用する。index.html 側は今回変更しない。将来的に index.html のインライン実装をこの
 * core呼び出しへ置き換える際も、ここに定義した関数のシグネチャ（純粋関数・DOM非依存）は
 * そのまま流用できるように設計している（dnr-core.jsと同じ方針）。
 *
 * ドライバー名解決（TID→氏名）は twcProcessRows() では行わない。原本の processTwcData は
 * resolveDriverNameFromTid()（ブラウザのグローバル変数transportIDsに依存）を呼んでいるが、
 * 本コアはDOM非依存のため、driverNameは空文字のプレースホルダのまま返す。呼び出し側が
 * ドライバーマスタ取得後にTID完全一致で解決する（FTDS/CC/DNRの各APIと同じ設計）。
 * 判定ルール自体（TID完全一致のみ、rowNameへのフォールバックなし）は変更していない
 * （resolveDriverNameFromTid(tid, '') は rowName=='' のため実質TID完全一致のみと等価）。
 */
(function (global) {
  'use strict';

  // index.html: TWC_REQUIRED_COLS (17978) を値そのまま移植
  var TWC_REQUIRED_COLS = ['transporter_id', 'time_window', 'planned_enter_time', 'actual_attempt_time'];

  // 3シート出力のスタイル定義（styleTwcSheetの引数をそのまま移植）。
  // 列幅(!cols)はxlsxライブラリで書き出し可能だが、太字フォント等のセルスタイルは
  // 現在利用しているxlsx(SheetJS Community Edition)では書き出し時に保持されないことを
  // 実機検証済み（Pro版が必要）。render-webhook-server.js側では列幅のみ再現する。
  var TWC_SHEET_STYLE = {
    summary: { headerRow: 3, colCount: 6, widths: [10, 22, 8, 20, 16, 10], sheetName: '時間指定_サマリー' },
    driverDetail: { headerRow: 0, colCount: 6, widths: [22, 8, 20, 16, 16, 30], sheetName: 'DA別_詳細' },
    topDriver: { headerRow: 1, colCount: 4, widths: [10, 16, 16, 12] }
  };

  // index.html: findTwcHeaderRow (17985-17993) を移植。
  // 先頭10行以内でTWC_REQUIRED_COLSの4列すべてが揃う行をヘッダー行とみなす（AND条件）。
  function twcFindHeaderRow(rows) {
    for (var r = 0; r < Math.min(rows.length, 10); r++) {
      var row = rows[r] || [];
      var norm = row.map(function (c) { return String(c || '').trim().toLowerCase(); });
      var hasAll = TWC_REQUIRED_COLS.every(function (col) { return norm.indexOf(col) >= 0; });
      if (hasAll) return r;
    }
    return -1;
  }

  // index.html: mapTwcColumns (17995-18002) を移植。同名ヘッダーが複数ある場合は後勝ち（原本と同じ）。
  function twcMapColumns(header) {
    var map = {};
    for (var c = 0; c < header.length; c++) {
      var key = String(header[c] || '').trim().toLowerCase();
      if (key) map[key] = c;
    }
    return map;
  }

  // index.html: parseTwcWindowEndMinutes (18005-18010) を移植
  function twcParseWindowEndMinutes(text) {
    var s = String(text || '');
    var m = s.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*[-–〜～]\s*(\d{1,2}):(\d{2})(?::\d{2})?/);
    if (!m) return null;
    return parseInt(m[3], 10) * 60 + parseInt(m[4], 10);
  }

  // index.html: parseTwcWindowStartMinutes (18011-18016) を移植
  function twcParseWindowStartMinutes(text) {
    var s = String(text || '');
    var m = s.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*[-–〜～]\s*(\d{1,2}):(\d{2})(?::\d{2})?/);
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }

  // index.html: twcPad (18023) を移植
  function twcPad(n) { return (n < 10 ? '0' : '') + n; }

  // index.html: twcWindowDisplayLabel (18017-18022) を移植
  function twcWindowDisplayLabel(text) {
    var s = twcParseWindowStartMinutes(text);
    var e = twcParseWindowEndMinutes(text);
    if (s == null || e == null) return String(text || '');
    return twcPad(Math.floor(s / 60)) + ':' + twcPad(s % 60) + '〜' + twcPad(Math.floor(e / 60)) + ':' + twcPad(e % 60);
  }

  // index.html: parseTwcDateTimeCell (18027-18034) を移植。
  // xlsxはcellDates:trueでDateオブジェクトになるが、CSVや一部フォーマットでは文字列
  // ("2026-08-28 10:59:12"等)のためフォールバックで解析する（原本と同じ2系統対応）。
  function twcParseDateTimeCell(v) {
    if (v instanceof Date && !isNaN(v.getTime())) return v;
    if (!v) return null;
    var s = String(v).trim();
    var m = s.match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (!m) return null;
    return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10), parseInt(m[4], 10), parseInt(m[5], 10), m[6] ? parseInt(m[6], 10) : 0);
  }

  // index.html: twcFormatDate (18036-18038) を移植
  function twcFormatDate(d) {
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  // index.html: twcFormatTime (18039-18041) を移植
  function twcFormatTime(d) {
    return twcPad(d.getHours()) + ':' + twcPad(d.getMinutes());
  }

  // index.html: twcFormatOverage (18042-18047) を移植
  function twcFormatOverage(min) {
    min = Math.round(min);
    if (min < 60) return min + '分';
    var h = Math.floor(min / 60), m = min % 60;
    return h + '時間' + (m > 0 ? (m + '分') : '');
  }

  // index.html: processTwcData (18093-18153) の判定本体を移植。DOM操作・グローバル状態更新
  // （twcViolations等への代入・renderTwcDashboard呼出・ボタン活性化）は含まない。
  // 違反判定ロジック（同日のwindow終了日時を構築し、overageMin<=0を除外する部分）は無変更。
  // 戻り値: 成功時 { violations, totalRows, windowLabel }。
  //   headerIdx<0（TWC必須4列が見つからない＝非TWCファイル）→ { error: 'header_not_found' }
  //   headerIdx>=0だが有効行が1件もない（totalRows===0）→ { error: 'no_valid_rows' }
  function twcProcessRows(rows) {
    var headerIdx = twcFindHeaderRow(rows);
    if (headerIdx < 0) return { error: 'header_not_found' };
    var cols = twcMapColumns(rows[headerIdx]);

    var violations = [];
    var totalRows = 0;
    var windowCounts = {};

    for (var r = headerIdx + 1; r < rows.length; r++) {
      var row = rows[r];
      if (!row || !row.length) continue;
      var tid = String(row[cols.transporter_id] || '').trim();
      var timeWindow = String(row[cols.time_window] || '').trim();
      var actualAttempt = twcParseDateTimeCell(row[cols.actual_attempt_time]);
      if (!tid || !timeWindow || !actualAttempt) continue;

      var windowEndMin = twcParseWindowEndMinutes(timeWindow);
      if (windowEndMin == null) continue;

      totalRows++;
      windowCounts[timeWindow] = (windowCounts[timeWindow] || 0) + 1;

      // 同日判定（既存仕様のまま変更しない）: actual_attempt_timeの日付にwindow終了時刻(分)を
      // 合成してwindowEndDtを作る。日またぎは考慮しない。
      var windowEndDt = new Date(actualAttempt.getFullYear(), actualAttempt.getMonth(), actualAttempt.getDate(), Math.floor(windowEndMin / 60), windowEndMin % 60, 0);
      // 超過時間(分)は「経過した完了分」を採用する（Math.floor）。四捨五入(Math.round)だと
      // 例えば実超過が70分30秒のとき71分に繰り上がってしまい、既存正常出力（W35_時間指定違反_分析）
      // の表示（完了分のみ・端数切り捨て）と1分ずれる（実データ比較で確認: 対象DAの最大超過時間が
      // 1時間10分→1時間11分にずれていた）。切り捨てにしても超過0分以下の除外判定（次行）や
      // DA別違反件数には影響しない（超過が正の場合のfloorは常に0以上であり、超過なし/マイナス超過は
      // 従来通り除外される）。全件一律に-1分するような補正ではなく、端数(30秒以上)を持つケースのみ
      // 挙動が変わる。
      var overageMin = Math.floor((actualAttempt.getTime() - windowEndDt.getTime()) / 60000);
      if (overageMin <= 0) continue; // 時間指定内に完了＝違反ではない

      var plannedEnter = cols.planned_enter_time !== undefined ? twcParseDateTimeCell(row[cols.planned_enter_time]) : null;

      violations.push({
        date: actualAttempt,
        driverName: '', // TID→氏名の解決は呼び出し側（マスタ取得後）で行う
        transportId: tid,
        scannableId: cols.scannable_id !== undefined ? String(row[cols.scannable_id] || '').trim() : '',
        timeWindow: timeWindow,
        plannedEnter: plannedEnter,
        actualAttempt: actualAttempt,
        overageMin: overageMin,
        failureBridge: cols.failure_bridge !== undefined ? String(row[cols.failure_bridge] || '').trim() : ''
      });
    }

    if (!totalRows) return { error: 'no_valid_rows' };

    var topWindow = '';
    var topCount = -1;
    for (var w in windowCounts) { if (windowCounts[w] > topCount) { topCount = windowCounts[w]; topWindow = w; } }
    var windowLabel = twcWindowDisplayLabel(topWindow);

    return { violations: violations, totalRows: totalRows, windowLabel: windowLabel };
  }

  // 新規: ドライバー表示名の自己重複除去（表示バグ対策）。
  // index.htmlのTWC UI（resolveDriverNameFromTid）はTID完全一致でtransportIDsのキー
  // （ドライバーマスタのenglishNameフィールドの値そのもの）をそのまま表示名として使う
  // だけで、名前の組み立て・結合処理は一切行っていない。render-webhook-server.js側
  // （/twc-export）も同様にmaster[].englishNameをそのまま採用しているが、実データ比較で
  // マスタ側のenglishNameの値自体が区切りなく2回連結された状態（例:
  // "晴樹 藤永晴樹 藤永"、"健士朗 脇山 脇山"）になっているケースが見つかっている。
  // TransportIDの完全一致ルールやfuzzy match排除の方針は変更せず、氏名の新規合成も行わず、
  // 明確な自己重複（文字列全体が同一部分文字列の単純な2回繰り返し、または空白区切りの
  // 末尾語が直前の語と同一）だけを取り除く防御的な表示整形のみを行う。
  function twcDedupeDisplayName(name) {
    var s = String(name || '').trim();
    if (!s) return s;
    // a) 全体が同一文字列の2回連続（区切りなし）: "晴樹 藤永晴樹 藤永" → "晴樹 藤永"
    var len = s.length;
    if (len > 0 && len % 2 === 0) {
      var half = s.slice(0, len / 2);
      if (half && half === s.slice(len / 2)) return half;
    }
    // b) 空白区切りの単語が直前と同一のまま連続: "健士朗 脇山 脇山" → "健士朗 脇山"
    var words = s.split(/\s+/);
    var out = [];
    for (var i = 0; i < words.length; i++) {
      if (i === 0 || words[i] !== words[i - 1]) out.push(words[i]);
    }
    return out.join(' ');
  }

  // index.html: groupTwcByDriver (18156-18178) を移植（無変更、元から純粋関数）
  function twcGroupByDriver(violations) {
    var byName = {};
    for (var i = 0; i < violations.length; i++) {
      var v = violations[i];
      var key = v.driverName || ('不明 (' + v.transportId + ')');
      if (!byName[key]) {
        byName[key] = { driverName: key, transportId: v.transportId, count: 0, dates: {}, maxOverageMin: 0, attemptTimes: [], records: [] };
      }
      var s = byName[key];
      s.count++;
      s.dates[twcFormatDate(v.date)] = v.date.getTime();
      if (v.overageMin > s.maxOverageMin) s.maxOverageMin = v.overageMin;
      s.attemptTimes.push(v.actualAttempt);
      s.records.push(v);
    }
    var list = Object.keys(byName).map(function (k) { return byName[k]; });
    list.sort(function (a, b) {
      if (b.count !== a.count) return b.count - a.count;
      return b.maxOverageMin - a.maxOverageMin;
    });
    for (var i2 = 0; i2 < list.length; i2++) list[i2].rank = i2 + 1;
    return list;
  }

  // index.html: classifyTwcJudgment (18184-18188) を移植。
  // 判定規則（W35_時間指定違反_分析の実データから逆算し19/19件で一致確認済み・閾値変更禁止）:
  //   件数>=6 かつ 最大超過>=60分 → 最重点
  //   最大超過>=60分 または 件数>=3 → 要確認
  //   それ以外 → 経過確認
  function twcClassifyJudgment(count, maxOverageMin) {
    if (count >= 6 && maxOverageMin >= 60) return '最重点';
    if (maxOverageMin >= 60 || count >= 3) return '要確認';
    return '経過確認';
  }

  // index.html: twcMultiDayCount (18190) を移植
  function twcMultiDayCount(dates) { return Object.keys(dates).length; }

  // index.html: buildTwcDaComment (18193-18206) を移植（無変更、元から純粋関数）
  function twcBuildDaComment(rank, count, maxOverageMin, dateCount, totalViolations) {
    var multiDay = dateCount > 1;
    if (rank <= 5) {
      var pct = totalViolations > 0 ? (count / totalViolations * 100).toFixed(1) + '%' : '-';
      var s = '全体' + pct;
      if (multiDay) s += '。複数日に発生';
      if (maxOverageMin >= 60) s += '。1時間以上の超過あり';
      return s;
    }
    if (maxOverageMin >= 60) return '1時間以上の超過あり';
    if (multiDay) return '複数日に発生';
    if (maxOverageMin < 30) return '軽度超過中心';
    return '単発または超過幅小';
  }

  // index.html: twcAttemptRangeLabel (18208-18212) を移植
  function twcAttemptRangeLabel(times) {
    var sorted = times.slice().sort(function (a, b) { return a.getTime() - b.getTime(); });
    if (sorted.length === 1) return twcFormatTime(sorted[0]);
    return twcFormatTime(sorted[0]) + '〜' + twcFormatTime(sorted[sorted.length - 1]);
  }

  // index.html: twcDatesLabel (18214-18217) を移植
  function twcDatesLabel(dates) {
    var keys = Object.keys(dates).sort(function (a, b) { return dates[a] - dates[b]; });
    return keys.join('・');
  }

  // index.html: exportTwcResult内のシート3名生成ロジック（18359）を移植
  function twcResolveSheet3Name(topDriverName) {
    var name = String(topDriverName || '');
    return (name.split(/\s+/)[0] || name).replace(/[\[\]\\\/\?\*]/g, '_').substring(0, 20) + '_重点確認';
  }

  // index.html: exportTwcResult内のシート1（時間指定_サマリー）行生成（18311-18320）を移植。
  // XLSXシートへの変換（aoa_to_sheet等）や罫線・太字等のスタイル適用は呼び出し側の責務。
  function twcBuildSummarySheetRows(driverStats, opts) {
    opts = opts || {};
    var period = opts.period || '';
    var windowLabel = opts.windowLabel || '';
    var totalViolations = opts.totalViolations || 0;
    var rows = [];
    rows.push([period + ' 時間指定違反 分析サマリー', '', '', '', '', '']);
    rows.push(['対象', windowLabel + ' 時間指定', '違反件数', totalViolations, '分析方針', '時間指定終了超過・件数・複数日発生を重点評価']);
    rows.push([]);
    rows.push(['優先順位', 'DA', '件数', '発生日', '最大時間指定超過', '判定']);
    for (var i = 0; i < driverStats.length; i++) {
      var s = driverStats[i];
      rows.push([s.rank, s.driverName, s.count, twcDatesLabel(s.dates), twcFormatOverage(s.maxOverageMin), twcClassifyJudgment(s.count, s.maxOverageMin)]);
    }
    return rows;
  }

  // index.html: exportTwcResult内のシート2（DA別_詳細）行生成（18326-18331）を移植
  function twcBuildDriverDetailSheetRows(driverStats, totalViolations) {
    var rows = [['DA', '件数', '発生日', '実際の配達試行', '最大時間指定超過', '評価・確認ポイント']];
    for (var j = 0; j < driverStats.length; j++) {
      var s = driverStats[j];
      rows.push([s.driverName, s.count, twcDatesLabel(s.dates), twcAttemptRangeLabel(s.attemptTimes), twcFormatOverage(s.maxOverageMin), twcBuildDaComment(s.rank, s.count, s.maxOverageMin, twcMultiDayCount(s.dates), totalViolations)]);
    }
    return rows;
  }

  // index.html: exportTwcResult内のシート3（最優先ドライバーの重点確認）行生成（18337-18361）を移植。
  // driverStatsが空の場合はnullを返す（原本と同じく1位ドライバーが存在する場合のみシート生成）。
  function twcBuildTopDriverSheetRows(driverStats, totalViolations) {
    if (!driverStats || driverStats.length === 0) return null;
    var top = driverStats[0];
    var rows = [];
    rows.push([top.driverName + ' 重点確認', '', '', '']);
    rows.push(['発生日', '計画上の到着', '実際の配達試行', '計画比']);
    var recs = top.records.slice().sort(function (a, b) { return a.actualAttempt.getTime() - b.actualAttempt.getTime(); });
    for (var k = 0; k < recs.length; k++) {
      var rec = recs[k];
      var planLabel = rec.plannedEnter ? twcFormatTime(rec.plannedEnter) : '-';
      var diffLabel = '-';
      if (rec.plannedEnter) {
        var diffMin = Math.round((rec.actualAttempt.getTime() - rec.plannedEnter.getTime()) / 60000);
        diffLabel = (diffMin >= 0 ? '+' : '') + diffMin + '分';
      }
      rows.push([twcFormatDate(rec.date), planLabel, twcFormatTime(rec.actualAttempt), diffLabel]);
    }
    rows.push([]);
    var pct = totalViolations > 0 ? (top.count / totalViolations * 100).toFixed(1) + '%' : '-';
    rows.push(['判定', top.count + '件発生。最大時間指定超過は' + twcFormatOverage(top.maxOverageMin) + '。全体' + pct + 'のため、優先して原因確認。', '', '']);
    rows.push(['確認候補', 'ルート設計／荷物量／積込遅延／救済・ルート移管／時間指定を後回しにした可能性', '', '']);
    return { sheetName: twcResolveSheet3Name(top.driverName), rows: rows };
  }

  var TwcCore = {
    TWC_REQUIRED_COLS: TWC_REQUIRED_COLS,
    TWC_SHEET_STYLE: TWC_SHEET_STYLE,
    twcFindHeaderRow: twcFindHeaderRow,
    twcMapColumns: twcMapColumns,
    twcParseWindowEndMinutes: twcParseWindowEndMinutes,
    twcParseWindowStartMinutes: twcParseWindowStartMinutes,
    twcPad: twcPad,
    twcWindowDisplayLabel: twcWindowDisplayLabel,
    twcParseDateTimeCell: twcParseDateTimeCell,
    twcFormatDate: twcFormatDate,
    twcFormatTime: twcFormatTime,
    twcFormatOverage: twcFormatOverage,
    twcProcessRows: twcProcessRows,
    twcDedupeDisplayName: twcDedupeDisplayName,
    twcGroupByDriver: twcGroupByDriver,
    twcClassifyJudgment: twcClassifyJudgment,
    twcMultiDayCount: twcMultiDayCount,
    twcBuildDaComment: twcBuildDaComment,
    twcAttemptRangeLabel: twcAttemptRangeLabel,
    twcDatesLabel: twcDatesLabel,
    twcResolveSheet3Name: twcResolveSheet3Name,
    twcBuildSummarySheetRows: twcBuildSummarySheetRows,
    twcBuildDriverDetailSheetRows: twcBuildDriverDetailSheetRows,
    twcBuildTopDriverSheetRows: twcBuildTopDriverSheetRows
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = TwcCore;
  }
  if (typeof global !== 'undefined') {
    global.TwcCore = TwcCore;
  }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
