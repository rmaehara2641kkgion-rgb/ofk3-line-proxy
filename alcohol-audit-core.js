/**
 * OFK3 アルコールチェック × DAシフト 照合 — 純粋ロジック（UI非依存・XLSX非依存）
 *
 * 運行実績集計（run-summary-core.js）とは独立したモジュール。
 * 集計結果（RunSummaryCore.summarizeShift* の persons[].shiftDays）を「読むだけ」で、
 * シフト回数・運行種類には一切影響させない。
 *
 * 対象原体: アルコール検知器履歴CSV（列: ID / 氏名 / 数値 / 判定 / 日時 / 測定場所 / …）
 *   - 出発前/帰着後の区分列は無い → 1日の測定から推定する（区分列がある形式にも対応）
 *       ・有効な測定（判定「中断」を除く）の最初＝出発前、最後＝帰着後
 *       ・有効な測定が1回のみ: シフト開始想定時刻の3時間前〜1時間後なら出発前、それ以外は帰着後
 *         （開始想定: bike・b1 9:00 / ○・C1 11:00 / ❽ 14:40 / b2 15:00 / C3 18:00）
 *   - 共用ID（flex / biker / テスト）は個人に紐付かないため照合対象外
 *   - CSV表記とシフト表表記が異なる人は「名前対応」（aliases）で紐付ける
 *
 * 判定（1人×1日）:
 *   OK      シフト日に出発前・帰着後の両方を測定、全てA判定
 *   軽微    出発前のみ測定（帰着後未測定）
 *   重大    A以外（B〜E）の判定を含む、または帰着後のみで出発前未測定
 *   未測定  シフトありで有効な測定記録なし
 *   シフト外 シフトなし（休・空欄）の日に測定記録あり（参考）
 *
 * 制約: index.html と同じくテンプレートリテラル禁止（文字列連結のみ）。
 */
(function (global) {
  'use strict';

  function summaryCore() {
    if (global.RunSummaryCore) return global.RunSummaryCore;
    if (typeof require === 'function') {
      try {
        return require('./run-summary-core.js');
      } catch (e) {}
    }
    return null;
  }

  function nameKey(n) {
    return summaryCore().nameKey(n);
  }
  function displayName(n) {
    return summaryCore().normalizeDisplayName(n);
  }

  /** シフト開始想定時刻（分）。キーは RunSummaryCore の集計コード */
  var SHIFT_START_MINUTES = { BIKE: 540, B1: 540, MARU: 660, C1: 660, HACHI: 880, B2: 900, C3: 1080 };
  var BEFORE_WINDOW_FROM = -180;
  var BEFORE_WINDOW_TO = 60;

  /** 共用ID（個人に紐付かない測定）の氏名 */
  var DEFAULT_SHARED_NAMES = ['flex', 'biker', 'テスト'];

  var INTERRUPTED = '中断';

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function compactLabel(v) {
    return String(v === null || v === undefined ? '' : v).replace(/[\s　]/g, '').toLowerCase();
  }

  /**
   * CSVのバイト列を文字列にする（UTF-8 として不正なら Shift_JIS とみなす）。
   * 検知器の履歴CSVは Shift_JIS で出力される。
   */
  function decodeCsvBytes(bytes) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
    } catch (e) {
      return new TextDecoder('shift_jis').decode(bytes);
    }
  }

  function findHeaderCol(row, patterns, exclude) {
    for (var c = 0; c < row.length; c++) {
      var lab = compactLabel(row[c]);
      if (!lab) continue;
      if (exclude && exclude.some(function (x) { return lab.indexOf(x) >= 0; })) continue;
      for (var i = 0; i < patterns.length; i++) {
        if (lab.indexOf(patterns[i]) >= 0) return c;
      }
    }
    return -1;
  }

  function serialParts(num) {
    var d = new Date(Math.round((num - 25569) * 86400000));
    return { ymd: d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()), minutes: d.getUTCHours() * 60 + d.getUTCMinutes(), seconds: d.getUTCSeconds() };
  }

  /** 日時セル → {date:'YYYY-MM-DD', minutes, time:'HH:MM:SS'}（時刻なしは minutes:null） */
  function parseDateTime(v, timeCell) {
    var date = null;
    var minutes = null;
    var sec = 0;
    if (v instanceof Date && !isNaN(v.getTime())) {
      date = v.getFullYear() + '-' + pad2(v.getMonth() + 1) + '-' + pad2(v.getDate());
      minutes = v.getHours() * 60 + v.getMinutes();
      sec = v.getSeconds();
    } else if (typeof v === 'number' && v > 40000 && v < 60000) {
      var p = serialParts(v);
      date = p.ymd;
      minutes = p.minutes;
      sec = p.seconds;
    } else {
      var s = String(v === null || v === undefined ? '' : v).trim();
      var m = s.match(/(\d{4})\s*[-\/年.]\s*(\d{1,2})\s*[-\/月.]\s*(\d{1,2})/);
      if (m) date = m[1] + '-' + pad2(parseInt(m[2], 10)) + '-' + pad2(parseInt(m[3], 10));
      var t = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/);
      if (t) {
        minutes = parseInt(t[1], 10) * 60 + parseInt(t[2], 10);
        sec = t[3] ? parseInt(t[3], 10) : 0;
      }
    }
    if (minutes === null && timeCell !== undefined && timeCell !== null && timeCell !== '') {
      if (typeof timeCell === 'number' && timeCell < 1) {
        var total = Math.round(timeCell * 86400);
        minutes = Math.floor(total / 60);
        sec = total % 60;
      } else {
        var tt = String(timeCell).match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
        if (tt) {
          minutes = parseInt(tt[1], 10) * 60 + parseInt(tt[2], 10);
          sec = tt[3] ? parseInt(tt[3], 10) : 0;
        }
      }
    }
    if (!date) return null;
    return { date: date, minutes: minutes, time: minutes === null ? '' : pad2(Math.floor(minutes / 60)) + ':' + pad2(minutes % 60) + ':' + pad2(sec) };
  }

  /** 区分列の値 → 'before' / 'after' / ''（区分列がある形式用） */
  function classifyAlcoholTiming(v) {
    var s = String(v === null || v === undefined ? '' : v).replace(/[\s　]/g, '');
    if (!s) return '';
    if (/帰着|帰庫|乗務後|業務後|運転後|終業|退勤/.test(s)) return 'after';
    if (/出発|出庫|乗務前|業務前|運転前|始業|出勤/.test(s)) return 'before';
    return '';
  }

  /**
   * アルコール原体の rows（sheet_to_json header:1、CSVは文字列のまま読むこと）を解析する。
   * 列はヘッダー名で検出する。
   */
  function parseAlcoholRows(rows) {
    rows = rows || [];
    var headerIdx = -1;
    var col = {};
    for (var r = 0; r < Math.min(rows.length, 15) && headerIdx < 0; r++) {
      var row = rows[r] || [];
      var nc = findHeaderCol(row, ['氏名', '名前', '運転者', 'ドライバー', '測定者', '社員名', '従業員名', 'ユーザー名'], ['ﾌﾘｶﾞﾅ', 'フリガナ', 'かな', 'カナ', 'ローマ']);
      var dc = findHeaderCol(row, ['測定日時', '日時', '測定日', '日付', '年月日', '実施日']);
      if (nc >= 0 && dc >= 0) {
        headerIdx = r;
        col.name = nc;
        col.date = dc;
        col.time = findHeaderCol(row, ['測定時刻', '時刻'], ['日時']);
        col.id = -1;
        for (var ci = 0; ci < row.length; ci++) if (compactLabel(row[ci]) === 'id') col.id = ci;
        col.value = findHeaderCol(row, ['数値', '測定値', '濃度']);
        col.judgment = findHeaderCol(row, ['判定', '結果']);
        col.timing = findHeaderCol(row, ['測定区分', '点呼区分', '乗務区分', '区分', 'タイミング', '乗務前後']);
        col.company = findHeaderCol(row, ['所属', '会社', '社名']);
      }
    }
    if (headerIdx < 0) return { ok: false, records: [], warnings: [{ type: 'ALCOHOL_HEADER_NOT_FOUND' }], meta: {} };
    var warnings = [];
    var records = [];
    function cell(dr, c) {
      return c >= 0 && dr[c] !== undefined && dr[c] !== null ? String(dr[c]).trim() : '';
    }
    for (var i = headerIdx + 1; i < rows.length; i++) {
      var dr = rows[i];
      if (!dr) continue;
      var name = displayName(dr[col.name]);
      if (!name) continue;
      var dt = parseDateTime(dr[col.date], col.time >= 0 ? dr[col.time] : undefined);
      if (!dt) {
        warnings.push({ type: 'ALCOHOL_DATE_UNPARSED', row: i + 1, value: String(dr[col.date]) });
        continue;
      }
      records.push({
        row: i + 1,
        id: cell(dr, col.id),
        name: name,
        nameKey: nameKey(name),
        company: displayName(cell(dr, col.company)),
        date: dt.date,
        minutes: dt.minutes,
        time: dt.time,
        value: cell(dr, col.value),
        judgment: cell(dr, col.judgment),
        timing: col.timing >= 0 ? classifyAlcoholTiming(dr[col.timing]) : '',
      });
    }
    return { ok: true, records: records, warnings: warnings, meta: { headerRowIdx: headerIdx, columns: col, hasTimingColumn: col.timing >= 0 } };
  }

  /**
   * 「名前対応」表（列: CSV表記 / シフト表表記）の rows → { CSV氏名キー: シフト表氏名 }
   */
  function parseAliasRows(rows) {
    rows = rows || [];
    var aliases = {};
    var hdr = -1;
    var cCsv = -1;
    var cShift = -1;
    for (var r = 0; r < Math.min(rows.length, 10) && hdr < 0; r++) {
      var row = rows[r] || [];
      cCsv = findHeaderCol(row, ['csv表記', 'csv', '測定器表記', 'アルコール']);
      cShift = findHeaderCol(row, ['シフト表表記', 'シフト表', 'シフト']);
      if (cCsv >= 0 && cShift >= 0 && cCsv !== cShift) hdr = r;
    }
    if (hdr < 0) return aliases;
    for (var i = hdr + 1; i < rows.length; i++) {
      var a = displayName((rows[i] || [])[cCsv]);
      var b = displayName((rows[i] || [])[cShift]);
      if (a && b) aliases[nameKey(a)] = b;
    }
    return aliases;
  }

  function judgmentOk(j) {
    return String(j).toUpperCase() === 'A';
  }

  /**
   * シフト（RunSummaryCore の集計結果）とアルコール測定を 1人×1日 で照合する。
   * @param {Object} summary summarizeShiftWorkbook / summarizeShiftRecords の戻り値
   * @param {Array} records parseAlcoholRows().records
   * @param {{aliases?:Object, sharedNames?:Array}} options
   */
  function auditAlcohol(summary, records, options) {
    options = options || {};
    var aliases = options.aliases || {};
    var shared = (options.sharedNames || DEFAULT_SHARED_NAMES).map(function (n) { return nameKey(n).toLowerCase(); });
    var month = summary.month;
    var persons = summary.persons || [];
    var byKey = {};
    persons.forEach(function (p, idx) {
      (byKey[p.nameKey] = byKey[p.nameKey] || []).push(idx);
    });

    var sharedRecords = [];
    var unmatched = {};
    var ambiguous = {};
    var aliasUsed = {};
    var meas = {}; // personIdx|date -> [records]
    (records || []).forEach(function (a) {
      if (month && a.date.slice(0, 7) !== month) return;
      if (shared.indexOf(a.nameKey.toLowerCase()) >= 0) {
        sharedRecords.push(a);
        return;
      }
      var key = a.nameKey;
      if (aliases[key]) {
        aliasUsed[a.name] = aliases[key];
        key = nameKey(aliases[key]);
      }
      var cands = byKey[key] || [];
      if (!cands.length) {
        (unmatched[a.name] = unmatched[a.name] || []).push(a);
        return;
      }
      if (cands.length > 1) {
        (ambiguous[a.name] = ambiguous[a.name] || []).push(a);
        return;
      }
      var mk = cands[0] + '|' + a.date;
      (meas[mk] = meas[mk] || []).push(a);
    });

    var counts = { OK: 0, 軽微: 0, 重大: 0, 未測定: 0, シフト外: 0, shiftWithBefore: 0, shiftWithoutBefore: 0, shiftWithAfter: 0, shiftWithoutAfter: 0, measuredWithoutShift: 0 };
    var days = [];
    var nonA = [];
    persons.forEach(function (p, idx) {
      if ((byKey[p.nameKey] || []).length > 1) return;
      var dates = {};
      Object.keys(p.shiftDays || {}).forEach(function (d) { dates[d] = true; });
      Object.keys(meas).forEach(function (mk) {
        var sp = mk.split('|');
        if (Number(sp[0]) === idx) dates[sp[1]] = true;
      });
      Object.keys(dates).sort().forEach(function (date) {
        var all = (meas[idx + '|' + date] || []).slice().sort(function (x, y) { return (x.minutes || 0) - (y.minutes || 0); });
        var valid = all.filter(function (x) { return x.judgment !== INTERRUPTED; });
        var interrupted = all.length - valid.length;
        var codes = (p.shiftDays || {})[date] || [];
        var before = null;
        var after = null;
        if (valid.some(function (x) { return x.timing; })) {
          valid.forEach(function (x) {
            if (x.timing === 'before' && !before) before = x;
            if (x.timing === 'after') after = x;
          });
        } else if (valid.length >= 2) {
          before = valid[0];
          after = valid[valid.length - 1];
        } else if (valid.length === 1) {
          var start = null;
          codes.forEach(function (c) {
            var s = SHIFT_START_MINUTES[c];
            if (s !== undefined && (start === null || s < start)) start = s;
          });
          var m = valid[0].minutes;
          if (start === null || m === null || (m >= start + BEFORE_WINDOW_FROM && m <= start + BEFORE_WINDOW_TO)) before = valid[0];
          else after = valid[0];
        }
        var bad = valid.filter(function (x) { return !judgmentOk(x.judgment); });
        var notes = [];
        bad.forEach(function (x) { notes.push('A以外: ' + x.time + ' ' + x.value + '(' + x.judgment + ')'); });
        var result;
        if (!codes.length) {
          result = 'シフト外';
        } else if (!valid.length) {
          result = '未測定';
        } else if (bad.length || (!before && after)) {
          result = '重大';
          if (!before) notes.push('出発前未測定');
        } else if (before && after) {
          result = 'OK';
        } else {
          result = '軽微';
          notes.push('帰着後未測定');
        }
        if (valid.length > 2) notes.push('測定' + valid.length + '回（最初と最後を採用）');
        if (interrupted) notes.push('中断' + interrupted + '回');
        counts[result]++;
        if (codes.length) {
          if (before) counts.shiftWithBefore++;
          else counts.shiftWithoutBefore++;
          if (after) counts.shiftWithAfter++;
          else counts.shiftWithoutAfter++;
        } else {
          counts.measuredWithoutShift++;
        }
        bad.forEach(function (x) { nonA.push({ company: p.company, name: p.name, date: date, time: x.time, value: x.value, judgment: x.judgment, id: x.id }); });
        days.push({
          date: date,
          company: p.company,
          name: p.name,
          codes: codes,
          before: before,
          after: after,
          count: valid.length,
          interrupted: interrupted,
          result: result,
          note: notes.join(' / '),
        });
      });
    });

    return {
      counts: counts,
      days: days,
      nonA: nonA,
      sharedRecords: sharedRecords,
      unmatchedNames: unmatched,
      ambiguousNames: ambiguous,
      aliasUsed: aliasUsed,
    };
  }

  function codeLabel(k) {
    var codes = summaryCore().TARGET_CODES;
    for (var i = 0; i < codes.length; i++) if (codes[i].key === k) return codes[i].label;
    return k;
  }

  /** Excel出力「アルコール照合」シートの AOA */
  function buildAlcoholAoa(audit) {
    var c = audit.counts;
    var aoa = [
      ['判定', '件数'],
      ['OK', c.OK],
      ['軽微', c['軽微']],
      ['重大', c['重大']],
      ['未測定', c['未測定']],
      ['シフト外', c['シフト外']],
      [],
      ['日付', '社名', '氏名', 'シフト', '出発前 時刻', '出発前 数値', '出発前 判定', '帰着後 時刻', '帰着後 数値', '帰着後 判定', '測定回数', '照合結果', '備考'],
    ];
    audit.days.forEach(function (d) {
      var b = d.before || {};
      var a = d.after || {};
      aoa.push([d.date, d.company, d.name, d.codes.length ? d.codes.map(codeLabel).join('+') : '（休）', b.time || '', b.value || '', b.judgment || '', a.time || '', a.value || '', a.judgment || '', d.count, d.result, d.note]);
    });
    aoa.push([]);
    aoa.push(['要確認', '日時', 'ID', '氏名', '数値', '判定', '内容']);
    Object.keys(audit.unmatchedNames).forEach(function (n) {
      aoa.push(['シフト表に氏名なし', '', '', n, '', '', audit.unmatchedNames[n].length + '件']);
    });
    Object.keys(audit.ambiguousNames).forEach(function (n) {
      aoa.push(['同名が複数（自動照合せず）', '', '', n, '', '', audit.ambiguousNames[n].length + '件']);
    });
    audit.sharedRecords.forEach(function (x) {
      if (!judgmentOk(x.judgment)) aoa.push(['A以外判定（共用ID）', x.date + ' ' + x.time, x.id, x.name, x.value, x.judgment, '共用ID（照合対象外）']);
    });
    return aoa;
  }

  var AlcoholAuditCore = {
    SHIFT_START_MINUTES: SHIFT_START_MINUTES,
    DEFAULT_SHARED_NAMES: DEFAULT_SHARED_NAMES,
    decodeCsvBytes: decodeCsvBytes,
    parseAlcoholRows: parseAlcoholRows,
    parseAliasRows: parseAliasRows,
    classifyAlcoholTiming: classifyAlcoholTiming,
    auditAlcohol: auditAlcohol,
    buildAlcoholAoa: buildAlcoholAoa,
  };

  global.AlcoholAuditCore = AlcoholAuditCore;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = AlcoholAuditCore;
  }
})(typeof window !== 'undefined' ? window : global);
