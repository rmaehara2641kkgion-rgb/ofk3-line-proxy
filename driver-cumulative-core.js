/**
 * ドライバー別配送データ「累計データ作成モード」コア。DOM・SheetJS・外部ライブラリ非依存。
 *
 * 入力は「シート名 → 2次元配列」(XLSX.utils.sheet_to_json(ws, {header:1, defval:null}) 相当)。
 * 流れ: parseWorkbook(各ファイル) → planMerge(基準 + 追加複数) → buildOutputModel(結果)。
 *
 * 集計定義（既存の週次ファイル・累計ファイルの定義を踏襲。数値の丸写しはしない）:
 *   加算      : 稼働日数 / 総稼働時間 / 配送個数 / 期間中配送個数(全日) / 距離 / 回収・誤配回収・正配依頼合計
 *   再計算    : 個/時間 = 配送個数 ÷ 総稼働時間、誤配率 = 正配依頼合計 ÷ 配送個数(集計対象日)
 *   配管率    : 各ファイルの稼働日数による加重平均（簡易版も同様）。片側が空欄なら他方の値を保持する。
 * 0と空欄は区別する（空欄は null）。加算は両方空欄なら空欄、片方だけ数値ならその値。
 */
(function (global) {
  'use strict';

  var SHEET_MAIN = 'ドライバー別集計';
  var SHEET_SIMPLE = '簡易版(ログイン-ログアウトのみ)';
  var SHEET_NOTE = '検証・算出方法';

  // 出力列定義。header は基準ファイルのヘッダーがあればそちらを優先（改行位置などを踏襲）。
  var MAIN_COLUMNS = [
    { key: 'name', header: '配達アソシエート', width: 24, re: /^配達アソシエート/ },
    { key: 'days', header: '集計対象稼働日数', width: 15, re: /^(集計対象稼働日数|稼働日数)$/ },
    { key: 'hours', header: '総稼働時間(h)', width: 15, fmt: '0.00_ ', re: /^総稼働時間/ },
    { key: 'pkg', header: '配送個数合計\n(集計対象日)', width: 15, re: /^配送個数合計/ },
    { key: 'pph', header: '1時間あたり配送個数', width: 15, fmt: '0.00_ ', re: /^1時間あたり配送個数/ },
    { key: 'allPkg', header: '参考:期間中配送個数\n(全日合計)', width: 15, re: /参考.*期間中配送個数/ },
    { key: 'km', header: '総走行距離(km)', width: 15, re: /^総走行距離/ },
    { key: 'kaishu', header: '回収/正配依頼\n(件数)', width: 15, re: /^回収\/正配依頼/ },
    { key: 'gohai', header: '誤配回収/正配依頼\n(件数)', width: 15, re: /^誤配回収\/正配依頼/ },
    { key: 'seihai', header: '正配依頼\n合計', width: 15, re: /^正配依頼合計/ },
    { key: 'mis', header: '誤配率', width: 15, fmt: '0.00_ ', re: /^誤配率/ },
    { key: 'rate', header: '配管率%\n(平均)', width: 15, fmt: '0.00_ ', re: /^配管率/ }
  ];
  var SIMPLE_COLUMNS = [
    { key: 'name', header: '配達アソシエート', width: 24, re: /^配達アソシエート/ },
    { key: 'days', header: '稼働日数', width: 15, re: /^(集計対象稼働日数|稼働日数)$/ },
    { key: 'hours', header: '総稼働時間(h)\n(ログイン～ログアウト)', width: 15, re: /^総稼働時間/ },
    { key: 'pkg', header: '配送個数合計', width: 15, re: /^配送個数合計/ },
    { key: 'pph', header: '1時間あたり配送個数', width: 15, re: /^1時間あたり配送個数/ },
    { key: 'km', header: '総走行距離(km)', width: 15, re: /^総走行距離/ },
    { key: 'kaishu', header: '回収/正配依頼\n(件数)', width: 15, re: /^回収\/正配依頼/ },
    { key: 'gohai', header: '誤配回収/正配依頼\n(件数)', width: 15, re: /^誤配回収\/正配依頼/ },
    { key: 'seihai', header: '正配依頼\n合計', width: 15, re: /^正配依頼合計/ },
    { key: 'rate', header: '配管率%\n(平均)', width: 15, re: /^配管率/ }
  ];
  var SHEETS = {
    main: { title: SHEET_MAIN, columns: MAIN_COLUMNS, hasMis: true },
    simple: { title: SHEET_SIMPLE, columns: SIMPLE_COLUMNS, hasMis: false }
  };
  var ADDITIVE = {
    main: ['days', 'hours', 'pkg', 'allPkg', 'km', 'kaishu', 'gohai', 'seihai'],
    simple: ['days', 'hours', 'pkg', 'km', 'kaishu', 'gohai', 'seihai']
  };
  var REQUIRED = {
    main: ['name', 'days', 'hours', 'pkg', 'allPkg', 'km', 'kaishu', 'gohai', 'seihai'],
    simple: ['name', 'days', 'hours', 'pkg', 'km', 'kaishu', 'gohai', 'seihai']
  };
  var FIELD_LABEL = {
    name: '配達アソシエート', days: '稼働日数', hours: '総稼働時間', pkg: '配送個数合計', pph: '1時間あたり配送個数',
    allPkg: '参考:期間中配送個数', km: '総走行距離', kaishu: '回収/正配依頼', gohai: '誤配回収/正配依頼',
    seihai: '正配依頼合計', mis: '誤配率', rate: '配管率'
  };

  // ---------- 文字列ユーティリティ ----------
  function nfkc(s) {
    s = String(s == null ? '' : s);
    return typeof s.normalize === 'function' ? s.normalize('NFKC') : s;
  }
  function squash(s) { return nfkc(s).replace(/\s+/g, ''); }

  /** ドライバー名の照合キー。全角半角・空白の揺れ・英字の大小・「• 会社名」サフィックスを吸収する。 */
  function normalizeName(name) {
    var s = nfkc(name);
    var idx = s.indexOf('•');
    if (idx < 0) idx = s.indexOf(' - ');
    if (idx > 0) s = s.substring(0, idx);
    return s.replace(/\s+/g, ' ').trim().toLowerCase();
  }
  function nameNoSpace(name) { return normalizeName(name).replace(/ /g, ''); }
  function nameTokensSorted(name) {
    return normalizeName(name).split(' ').filter(Boolean).sort().join(' ');
  }

  function parseNumber(v) {
    if (v == null) return { ok: true, value: null };
    if (typeof v === 'number') return isFinite(v) ? { ok: true, value: v } : { ok: false };
    var s = nfkc(v).replace(/,/g, '').replace(/%$/, '').trim();
    if (s === '') return { ok: true, value: null };
    var n = Number(s);
    return isFinite(n) ? { ok: true, value: n } : { ok: false };
  }

  // ---------- 週・期間 ----------
  function expandWeeks(text) {
    var s = nfkc(text);
    var re = /W\s*(\d{1,2})(?:\s*[〜~～\-–−]\s*W?\s*(\d{1,2}))?/gi;
    var out = [], m, bad = false;
    while ((m = re.exec(s))) {
      var a = parseInt(m[1], 10), b = m[2] != null ? parseInt(m[2], 10) : a;
      if (b < a) { bad = true; continue; }
      for (var w = a; w <= b; w++) if (out.indexOf(w) < 0) out.push(w);
    }
    out.sort(function (x, y) { return x - y; });
    return { weeks: out, bad: bad };
  }
  function weeksLabel(weeks, sep) {
    var ws = weeks.slice().sort(function (a, b) { return a - b; });
    var parts = [], i = 0;
    while (i < ws.length) {
      var j = i;
      while (j + 1 < ws.length && ws[j + 1] === ws[j] + 1) j++;
      parts.push(j > i ? 'W' + ws[i] + sep + 'W' + ws[j] : 'W' + ws[i]);
      i = j + 1;
    }
    return parts.join(',');
  }
  function parseDateRanges(text) {
    var s = nfkc(text);
    var re = /(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})\s*[〜~～]\s*(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/g;
    var out = [], m;
    function iso(y, mo, d) { return y + '-' + ('0' + mo).slice(-2) + '-' + ('0' + d).slice(-2); }
    while ((m = re.exec(s))) out.push({ start: iso(m[1], m[2], m[3]), end: iso(m[4], m[5], m[6]) });
    return out;
  }
  function rangesOverlap(a, b) { return a.start <= b.end && b.start <= a.end; }

  // ---------- Excel読込（シート・列検出） ----------
  function findSheetName(names, role) {
    for (var i = 0; i < names.length; i++) {
      var n = squash(names[i]);
      if (role === 'main' && n.indexOf('ドライバー別集計') >= 0) return names[i];
      if (role === 'simple' && n.indexOf('簡易版') >= 0) return names[i];
      if (role === 'note' && (n.indexOf('算出方法') >= 0 || n.indexOf('検証') >= 0 || n.indexOf('注記') >= 0)) return names[i];
    }
    return null;
  }

  function detectColumns(aoa, role) {
    var cols = SHEETS[role].columns;
    for (var r = 0; r < Math.min(aoa.length, 5); r++) {
      var row = aoa[r] || [];
      var map = {};
      for (var c = 0; c < row.length; c++) {
        var h = squash(row[c]);
        if (!h) continue;
        for (var k = 0; k < cols.length; k++) {
          if (map[cols[k].key] == null && cols[k].re.test(h)) { map[cols[k].key] = c; break; }
        }
      }
      if (map.name != null) return { headerRow: r, map: map, headers: row };
    }
    return null;
  }

  function issue(level, code, file, driver, field, cause, extra) {
    var o = { level: level, code: code, file: file || '', driver: driver || '', field: field || '', cause: cause };
    if (extra) for (var k in extra) o[k] = extra[k];
    return o;
  }

  function parseSheet(aoa, role, fileName, issues) {
    var det = detectColumns(aoa, role);
    var title = SHEETS[role].title;
    if (!det) {
      issues.push(issue('error', 'HEADER_NOT_FOUND', fileName, '', title, '「配達アソシエート」列を含むヘッダー行が見つかりません'));
      return null;
    }
    var missing = REQUIRED[role].filter(function (k) { return det.map[k] == null; });
    if (missing.length) {
      issues.push(issue('error', 'COLUMN_MISSING', fileName, '', title,
        '必須列が見つかりません: ' + missing.map(function (k) { return FIELD_LABEL[k]; }).join('、')));
      return null;
    }
    var headers = {};
    SHEETS[role].columns.forEach(function (c) {
      if (det.map[c.key] != null) headers[c.key] = String(det.headers[det.map[c.key]]);
    });
    var rows = [], seen = {}, ok = true;
    for (var r = det.headerRow + 1; r < aoa.length; r++) {
      var line = aoa[r] || [];
      var rawName = line[det.map.name];
      var display = rawName == null ? '' : String(rawName).trim();
      var key = normalizeName(rawName);
      var hasAny = line.some(function (v) { return v != null && String(v).trim() !== ''; });
      if (!key) {
        if (hasAny) issues.push(issue('warn', 'NAME_EMPTY', fileName, '', title, (r + 1) + '行目: ドライバー名が空欄のため除外しました'));
        continue;
      }
      var rec = { name: display, key: key, rowNo: r + 1, v: {} };
      SHEETS[role].columns.forEach(function (c) {
        if (c.key === 'name') return;
        var idx = det.map[c.key];
        if (idx == null) { rec.v[c.key] = null; return; }
        var p = parseNumber(line[idx]);
        if (!p.ok) {
          ok = false;
          issues.push(issue('error', 'VALUE_INVALID', fileName, display, FIELD_LABEL[c.key],
            title + ' ' + (r + 1) + '行目: 数値として読み取れない値です（' + String(line[idx]) + '）'));
          rec.v[c.key] = null;
        } else {
          rec.v[c.key] = p.value;
          if (p.value != null && p.value < 0 && c.key !== 'rate') {
            issues.push(issue('warn', 'VALUE_NEGATIVE', fileName, display, FIELD_LABEL[c.key], title + ' ' + (r + 1) + '行目: 負の値です'));
          }
        }
      });
      if (seen[key]) {
        ok = false;
        issues.push(issue('error', 'DUPLICATE_ROW', fileName, display, title,
          (r + 1) + '行目: 同一ファイル内で同じドライバー（' + seen[key].name + ' / ' + seen[key].rowNo + '行目）が重複しています。どちらが正しいか判断できないため統合を停止します。元ファイルの重複行を整理してください'));
        continue;
      }
      seen[key] = rec;
      // 元ファイルの再計算値が定義と一致するか（統合には再計算値を使うので参考警告）
      var v = rec.v;
      if (v.hours != null && v.pkg != null && v.pph != null && v.hours > 0 && Math.abs(v.pph - v.pkg / v.hours) > 1e-6 * Math.max(1, Math.abs(v.pph))) {
        issues.push(issue('warn', 'SRC_PPH_MISMATCH', fileName, display, FIELD_LABEL.pph, title + ': 元ファイルの値が「配送個数÷総稼働時間」と一致しません。累計は定義どおり再計算します'));
      }
      if (SHEETS[role].hasMis && v.mis != null && v.pkg > 0 && v.seihai != null && Math.abs(v.mis - v.seihai / v.pkg) > 1e-9) {
        issues.push(issue('warn', 'SRC_MIS_MISMATCH', fileName, display, FIELD_LABEL.mis, title + ': 元ファイルの値が「正配依頼合計÷配送個数」と一致しません。累計は定義どおり再計算します'));
      }
      rows.push(rec);
    }
    return { headers: headers, rows: rows, ok: ok };
  }

  function parseNoteSheet(aoa, fileName, issues) {
    var map = {}, histories = [];
    for (var r = 0; r < (aoa || []).length; r++) {
      var row = aoa[r] || [];
      if (row[0] == null) continue;
      var k = squash(row[0]);
      var val = row[1] == null ? '' : String(row[1]);
      if (k.indexOf('統合履歴(JSON)') === 0) {
        try { histories.push(JSON.parse(val)); }
        catch (e) { issues.push(issue('warn', 'HISTORY_UNREADABLE', fileName, '', '統合履歴', '統合履歴(JSON)を読み取れません。履歴が不十分なものとして扱います')); }
        continue;
      }
      if (map[k] == null) map[k] = val;
    }
    var meta = { weeks: [], dates: [], hashes: [], histories: histories, kind: 'unknown', historyLevel: 'none', periodText: '' };
    if (map['統合済み週'] != null) {
      meta.weeks = expandWeeks(map['統合済み週']).weeks;
    } else if (map['対象期間'] != null) {
      var e = expandWeeks(map['対象期間']);
      meta.weeks = e.weeks;
      if (e.bad) issues.push(issue('warn', 'PERIOD_BAD', fileName, '', '対象期間', '週範囲の指定が逆順です'));
    } else if (map['集計期間'] != null) {
      var cw = /Concessions週[:：]\s*([^、,\n]+)/.exec(nfkc(map['集計期間']));
      if (cw) meta.weeks = expandWeeks(cw[1]).weeks;
    }
    if (map['集計期間'] != null) meta.dates = parseDateRanges(map['集計期間']);
    histories.forEach(function (h) {
      (h.added || []).forEach(function (a) {
        if (a.hash) meta.hashes.push(a.hash);
        (a.dates || []).forEach(function (d) { meta.dates.push(d); });
      });
      if (h.baseHash) meta.hashes.push(h.baseHash);
    });
    meta.periodText = map['対象期間'] || map['集計期間'] || '';
    if (map['対象期間'] != null || map['統合済み週'] != null) meta.kind = 'cumulative';
    else if (map['集計期間'] != null) meta.kind = 'weekly';
    if (map['統合済み週'] != null && histories.length) meta.historyLevel = 'full';
    else if (meta.weeks.length) meta.historyLevel = meta.kind === 'weekly' ? 'weekly' : 'periodOnly';
    return meta;
  }

  /**
   * @param {{fileName:string, fileHash?:string, sheetNames:string[], aoa:Object<string,Array[]>}} input
   */
  function parseWorkbook(input) {
    var fileName = input.fileName || '';
    var issues = [];
    var names = input.sheetNames || Object.keys(input.aoa || {});
    var out = { fileName: fileName, fileHash: input.fileHash || '', main: null, simple: null, note: null, issues: issues, ok: true };
    ['main', 'simple'].forEach(function (role) {
      var sn = findSheetName(names, role);
      if (!sn) {
        issues.push(issue('error', 'SHEET_MISSING', fileName, '', SHEETS[role].title, '必要なシートが見つかりません'));
        return;
      }
      out[role] = parseSheet(input.aoa[sn] || [], role, fileName, issues);
    });
    var nn = findSheetName(names, 'note');
    out.note = nn ? parseNoteSheet(input.aoa[nn] || [], fileName, issues)
      : { weeks: [], dates: [], hashes: [], histories: [], kind: 'unknown', historyLevel: 'none', periodText: '' };
    if (!nn) issues.push(issue('warn', 'NOTE_MISSING', fileName, '', SHEET_NOTE, '算出方法・注記シートがないため対象期間を読み取れません'));
    out.ok = !!(out.main && out.simple && out.main.ok && out.simple.ok);
    return out;
  }

  // ---------- 統合 ----------
  function cloneVals(v) { var o = {}; for (var k in v) o[k] = v[k]; return o; }

  function sumNullable(a, b) {
    if (a == null && b == null) return null;
    return (a == null ? 0 : a) + (b == null ? 0 : b);
  }

  /** 累計値から再計算する項目。0除算を避け、入力が空欄なら空欄のまま。 */
  function recompute(role, v) {
    v.pph = (v.hours == null || v.pkg == null) ? null : (v.hours > 0 ? v.pkg / v.hours : 0);
    if (SHEETS[role].hasMis) v.mis = (v.seihai == null || v.pkg == null) ? null : (v.pkg > 0 ? v.seihai / v.pkg : 0);
    return v;
  }

  function toAccRow(role, rec, fromBase) {
    var v = cloneVals(rec.v);
    return {
      name: rec.name, key: rec.key, fromBase: fromBase, touched: false,
      before: fromBase ? cloneVals(rec.v) : null, added: null,
      v: v, rateW: v.rate != null ? (v.days || 0) : 0
    };
  }

  function mergeInto(role, acc, rec, file, issues, title) {
    var v = acc.v, a = rec.v;
    ADDITIVE[role].forEach(function (k) { v[k] = sumNullable(v[k], a[k]); });
    if (a.rate != null) {
      if (v.rate == null) { v.rate = a.rate; acc.rateW = a.days || 0; }
      else {
        var w = acc.rateW + (a.days || 0);
        if (w > 0) { v.rate = (v.rate * acc.rateW + a.rate * (a.days || 0)) / w; acc.rateW = w; }
        else {
          v.rate = null;
          issues.push(issue('warn', 'RATE_WEIGHT_ZERO', file, acc.name, FIELD_LABEL.rate, title + ': 稼働日数が0のため加重平均できず、配管率を空欄にしました（推測値は出力しません）'));
        }
      }
    }
    acc.touched = true;
    acc.added = acc.added || {};
    ADDITIVE[role].forEach(function (k) { acc.added[k] = sumNullable(acc.added[k], a[k]); });
  }

  function mergeRole(role, baseParsed, addedFiles, opts, issues) {
    var title = SHEETS[role].title;
    var rows = [], index = {}, baseFile = baseParsed.fileName;
    baseParsed[role].rows.forEach(function (rec) {
      if (index[rec.key]) {
        issues.push(issue('error', 'DUPLICATE_ROW', baseFile, rec.name, title, '基準ファイル内で正規化後に同一となるドライバーが重複しています: ' + index[rec.key].name));
        return;
      }
      var acc = toAccRow(role, rec, true);
      index[rec.key] = acc;
      rows.push(acc);
    });
    var manual = opts.manualMappings || {};
    addedFiles.forEach(function (f) {
      f[role].rows.forEach(function (rec) {
        var target = index[rec.key];
        if (!target) {
          var nsKey = nameNoSpace(rec.name);
          for (var i = 0; i < rows.length && !target; i++) {
            if (nameNoSpace(rows[i].name) === nsKey) {
              target = rows[i];
              issues.push(issue('info', 'NAME_SPACE_VARIANT', f.fileName, rec.name, title, '空白の違いのみのため「' + rows[i].name + '」と同一ドライバーとして統合しました'));
            }
          }
        }
        if (!target && manual[rec.key] && index[normalizeName(manual[rec.key])]) {
          target = index[normalizeName(manual[rec.key])];
          issues.push(issue('info', 'NAME_MANUAL_MERGE', f.fileName, rec.name, title, '手動確認により「' + target.name + '」と統合しました'));
        }
        if (target) { mergeInto(role, target, rec, f.fileName, issues, title); return; }
        // 統合せず新規追加。順序違い等の曖昧候補は警告して手動確認対象にする
        var tk = nameTokensSorted(rec.name);
        var cands = rows.filter(function (r) { return r.key !== rec.key && nameTokensSorted(r.name) === tk && tk.indexOf(' ') > 0; });
        if (cands.length) {
          issues.push(issue('warn', 'NAME_AMBIGUOUS', f.fileName, rec.name, '配達アソシエート',
            title + ': 姓名の順序違いの可能性がある既存ドライバーがいます（' + cands.map(function (c) { return c.name; }).join('／') + '）。別人として新規追加しました。同一人物の場合は手動確認で統合してください',
            { candidates: cands.map(function (c) { return c.name; }), reviewKey: rec.key }));
        }
        var acc = toAccRow(role, rec, false);
        acc.added = cloneVals(rec.v);
        acc.touched = true;
        index[rec.key] = acc;
        rows.push(acc);
      });
    });
    rows.forEach(function (r) { recompute(role, r.v); });
    return rows;
  }

  function fileLabel(f) { return f.fileName || '(名称なし)'; }

  /**
   * @param base      parseWorkbook の結果（基準累計）
   * @param additions parseWorkbook の結果の配列（追加週）
   * @param opts {baseWeeksOverride, weekOverrides:{fileName:'W41'}, manualMappings:{正規化名:基準側名}, acknowledgeInsufficientHistory}
   */
  function planMerge(base, additions, opts) {
    opts = opts || {};
    var issues = [];
    [base].concat(additions).forEach(function (f) { f.issues.forEach(function (i) { issues.push(i); }); });
    var result = { issues: issues, canGenerate: false, needsAck: false, needsReview: false, base: base, additions: additions };
    if (!base || !additions || !additions.length) {
      issues.push(issue('error', 'INPUT_MISSING', '', '', '', '基準累計ファイルと追加週ファイルを1つ以上選択してください'));
      return finalize(result);
    }
    if (!base.ok || additions.some(function (f) { return !f.ok; })) return finalize(result);

    // --- 期間・二重計上チェック ---
    var baseWeeks = opts.baseWeeksOverride ? expandWeeks(opts.baseWeeksOverride).weeks : base.note.weeks;
    if (!baseWeeks.length) {
      issues.push(issue('error', 'BASE_PERIOD_UNKNOWN', fileLabel(base), '', SHEET_NOTE,
        '基準ファイルの対象期間を読み取れません。ファイル名だけを根拠に統合はできないため、基準期間を手入力するか、期間の記載があるファイルを選択してください'));
    }
    var addWeeks = additions.map(function (f) {
      var ov = opts.weekOverrides && opts.weekOverrides[f.fileName];
      var w = ov ? expandWeeks(ov).weeks : f.note.weeks;
      if (!w.length) {
        issues.push(issue('error', 'ADD_PERIOD_UNKNOWN', fileLabel(f), '', '集計期間',
          '追加ファイルの対象週を読み取れません。二重計上を防止できないため、対象週（例: W41）を指定してください'));
      }
      return w;
    });
    var usedWeeks = baseWeeks.slice();
    additions.forEach(function (f, i) {
      var ov = addWeeks[i].filter(function (w) { return usedWeeks.indexOf(w) >= 0; });
      if (ov.length) {
        issues.push(issue('error', 'PERIOD_OVERLAP', fileLabel(f), '', '対象期間',
          '統合済みの期間と重複しています（' + weeksLabel(ov, '〜') + '）。二重計上を防ぐため統合を停止しました。' +
          '同じ週のファイルを差し替える場合は、該当週を含まない累計（または一つ前の累計）を基準にして、修正後の週ファイルを追加し直してください'));
      }
      addWeeks[i].forEach(function (w) { if (usedWeeks.indexOf(w) < 0) usedWeeks.push(w); });
    });
    // ファイル識別情報（ハッシュ）の重複
    var knownHashes = (base.note.hashes || []).concat(base.fileHash ? [base.fileHash] : []);
    var seenHash = {};
    additions.forEach(function (f) {
      if (!f.fileHash) return;
      if (knownHashes.indexOf(f.fileHash) >= 0 || seenHash[f.fileHash]) {
        issues.push(issue('error', 'DUPLICATE_FILE', fileLabel(f), '', 'ファイル識別情報',
          '内容が同一のファイルが基準の統合履歴または他の追加ファイルに存在します。二重加算を防ぐため統合を停止しました'));
      }
      seenHash[f.fileHash] = true;
    });
    // 日付範囲の重複（日付が分かる場合）
    var usedDates = (base.note.dates || []).slice();
    additions.forEach(function (f) {
      var dr = f.note.dates || [];
      dr.forEach(function (d) {
        if (usedDates.some(function (u) { return rangesOverlap(u, d); })) {
          issues.push(issue('error', 'DATE_OVERLAP', fileLabel(f), '', '集計期間', '集計期間（' + d.start + '〜' + d.end + '）が統合済みの日付範囲と重複しています'));
        }
      });
      usedDates = usedDates.concat(dr);
    });
    // 欠週
    if (usedWeeks.length) {
      var mn = Math.min.apply(null, usedWeeks), mx = Math.max.apply(null, usedWeeks), gaps = [];
      for (var w = mn; w <= mx; w++) if (usedWeeks.indexOf(w) < 0) gaps.push(w);
      if (gaps.length) issues.push(issue('warn', 'PERIOD_GAP', '', '', '対象期間', '統合後の期間に欠けている週があります: ' + weeksLabel(gaps, '〜')));
    }
    // 統合履歴の十分性
    if (base.note.historyLevel !== 'full' && !opts.baseWeeksOverride) {
      issues.push(issue('warn', 'HISTORY_INSUFFICIENT', fileLabel(base), '', SHEET_NOTE,
        '基準ファイルに統合履歴（統合済み週・ファイル識別情報）がありません。対象期間の記載だけで重複を判定しており、同じ内容の再追加はファイル名・期間以外では検出できません。内容を確認のうえ、確認済みとして進めてください'));
      result.needsAck = !opts.acknowledgeInsufficientHistory;
    } else if (opts.baseWeeksOverride) {
      issues.push(issue('warn', 'HISTORY_INSUFFICIENT', fileLabel(base), '', SHEET_NOTE, '基準期間は手入力の値を使用しています。内容の確認は利用者の責任となります'));
      result.needsAck = !opts.acknowledgeInsufficientHistory;
    }
    if (issues.some(function (i) { return i.level === 'error'; })) return finalize(result);

    // --- ドライバー統合 ---
    var mainRows = mergeRole('main', base, additions, opts, issues);
    var simpleRows = mergeRole('simple', base, additions, opts, issues);
    result.rows = { main: mainRows, simple: simpleRows };
    result.weeks = usedWeeks.slice().sort(function (a, b) { return a - b; });
    result.addedWeeks = addWeeks;
    result.periodLabel = weeksLabel(result.weeks, '〜');
    result.fileLabel = weeksLabel(result.weeks, '-').replace(/,/g, '_');
    result.dates = usedDates;
    result.needsReview = issues.some(function (i) { return i.code === 'NAME_AMBIGUOUS'; });
    result.summary = summarize(result);
    return finalize(result);
  }

  function finalize(result) {
    var errors = result.issues.filter(function (i) { return i.level === 'error'; }).length;
    var warns = result.issues.filter(function (i) { return i.level === 'warn'; }).length;
    result.errorCount = errors;
    result.warnCount = warns;
    result.canGenerate = !!result.rows && errors === 0 && !result.needsAck;
    return result;
  }

  var PREVIEW_KEYS = ['days', 'hours', 'pkg', 'allPkg', 'km', 'kaishu', 'gohai', 'seihai'];
  function summarize(result) {
    var s = { sheets: {} };
    ['main', 'simple'].forEach(function (role) {
      var rows = result.rows[role];
      var t = { drivers: rows.length, merged: 0, added: 0, baseOnly: 0, before: {}, add: {}, after: {} };
      rows.forEach(function (r) {
        if (r.fromBase && r.touched) t.merged++;
        else if (!r.fromBase) t.added++;
        else t.baseOnly++;
        PREVIEW_KEYS.forEach(function (k) {
          if (ADDITIVE[role].indexOf(k) < 0) return;
          t.before[k] = sumNullable(t.before[k], r.before ? r.before[k] : null);
          t.add[k] = sumNullable(t.add[k], r.added ? r.added[k] : null);
          t.after[k] = sumNullable(t.after[k], r.v[k]);
        });
      });
      s.sheets[role] = t;
    });
    return s;
  }

  // ---------- 出力モデル ----------
  function columnHeader(role, col, base) {
    var h = base && base[role] && base[role].headers && base[role].headers[col.key];
    return h || col.header;
  }

  function noteRows(result, ctx) {
    ctx = ctx || {};
    var rows = [];
    var added = (ctx.addedFiles || result.additions.map(function (f) { return { name: f.fileName, hash: f.fileHash }; }));
    var nowIso = ctx.nowIso || new Date().toISOString();
    rows.push(['対象期間', result.periodLabel]);
    rows.push(['統合済み週', result.weeks.length ? weeksLabel(result.weeks, '〜') : '']);
    rows.push(['基準ファイル', result.base.fileName]);
    rows.push(['追加ファイル', added.map(function (a) { return a.name; }).join(' / ') + '（各1回のみ）']);
    rows.push(['統合キー', '配達アソシエート名（全角半角・空白・英字大小を正規化した完全一致）。順序違い・ローマ字/漢字の対応は自動統合しない']);
    rows.push(['加算項目', '稼働日数・稼働時間・配送個数・参考配送個数・距離・依頼件数（簡易版も同様）']);
    rows.push(['個/時間', '累計配送個数 ÷ 累計稼働時間（週別の効率の単純平均はしない）']);
    rows.push(['誤配率', '累計正配依頼合計 ÷ 累計配送個数(集計対象日)']);
    rows.push(['配管率', '稼働日数による加重平均（簡易版も同様）。片側が空欄の場合は値のある側を保持し、算出できない場合は空欄']);
    rows.push(['注意', '簡易版とドライバー別集計は別集計。追加済みの週・ファイルを再度追加すると統合は停止される']);
    rows.push(['統合実行日時', nowIso]);
    var hist = {
      at: nowIso,
      baseFile: result.base.fileName, baseHash: result.base.fileHash || '',
      baseWeeks: weeksLabel(result.weeks.filter(function (w) { return result.addedWeeks.every(function (aw) { return aw.indexOf(w) < 0; }); }), '〜'),
      added: added.map(function (a, i) {
        return { name: a.name, hash: a.hash || '', weeks: weeksLabel(result.addedWeeks[i], '〜'), dates: result.additions[i].note.dates || [] };
      }),
      resultWeeks: weeksLabel(result.weeks, '〜')
    };
    // 過去の統合履歴を引き継ぐ
    (result.base.note.histories || []).forEach(function (h) { rows.push(['統合履歴(JSON)', JSON.stringify(h)]); });
    rows.push(['統合履歴(JSON)', JSON.stringify(hist)]);
    added.forEach(function (a) { rows.push(['ファイル識別情報(SHA-256)', (a.name || '') + ' : ' + (a.hash || '(未取得)')]); });
    var issues = result.issues.filter(function (i) { return i.level === 'warn'; });
    rows.push(['統合時の警告件数', String(issues.length)]);
    issues.slice(0, 30).forEach(function (i) { rows.push(['警告', [i.file, i.driver, i.field, i.cause].filter(Boolean).join(' / ')]); });
    return rows;
  }

  function buildOutputModel(result, ctx) {
    if (!result || !result.canGenerate) throw new Error('統合結果が未検証、またはエラー・未確認の警告が残っているため出力できません');
    var sheets = ['main', 'simple'].map(function (role) {
      var cols = SHEETS[role].columns;
      return {
        name: SHEETS[role].title,
        freezeRow: 1,
        columns: cols.map(function (c) {
          return { header: columnHeader(role, c, result.base), width: c.width, fmt: c.fmt || null };
        }),
        rows: result.rows[role].map(function (r) {
          return cols.map(function (c) { return c.key === 'name' ? r.name : r.v[c.key]; });
        })
      };
    });
    var note = { name: SHEET_NOTE, widths: [25, 85], rows: noteRows(result, ctx), kind: 'note' };
    return {
      fileName: 'ドライバー別配送データ_累計' + result.fileLabel + '.xlsx',
      sheets: sheets.concat([note])
    };
  }

  var api = {
    SHEET_MAIN: SHEET_MAIN, SHEET_SIMPLE: SHEET_SIMPLE, SHEET_NOTE: SHEET_NOTE,
    normalizeName: normalizeName, parseNumber: parseNumber, expandWeeks: expandWeeks, weeksLabel: weeksLabel,
    parseWorkbook: parseWorkbook, planMerge: planMerge, buildOutputModel: buildOutputModel
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.DriverCumulative = api;
})(typeof window !== 'undefined' ? window : globalThis);
