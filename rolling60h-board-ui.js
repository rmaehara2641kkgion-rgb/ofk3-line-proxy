/**
 * WH60管理タブ内の「データ取込」「残り時間・リスク一覧」。
 * Excelはブラウザ内で解析・集計し、GAS・Render・HARVESTは使わない。
 * 判定は既存エンジン（HarvestRolling60hRun → RollingCore）の出力をそのまま使う。
 * 既存の格子表示（rolling60h-ui.js）は 3つ目のサブタブとして残す。
 * FRIDAY連携: ここでは window イベントと関数で要約を公開するだけで、HARVESTへの引き渡し送信は行わない（接続はCursor側）。
 */
(function (global) {
  'use strict';

  var Board = global.Rolling60hLocalBoard;
  var MAX_SHIFT_FILES = 3; // 前月・当月・翌月
  var STATE = {
    ready: false,
    sub: 'import',
    shift: null, // 読み込み済みシフト表全体の要約 { name, importedAt, range, ok, names, months }。実体は shiftFiles
    shiftFiles: [], // [{ name, workbook, importedAt, range, rangeMax, names, months }] 月ごとのファイルを同時に保持（最大 MAX_SHIFT_FILES）
    daily: null, // { name, rows, importedAt, range, ok, error }
    board: null,
    saved: null, // 'ok' | 'failed' | 'skipped' | null
    query: '',
    sort: 'risk',
    selected: '',
    referenceDate: '',
    message: '',
    store: null,
  };

  function esc(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function nowIso() { return new Date().toISOString(); }

  // 履歴補完（HARVESTが過去日の実績を再利用する仕組み）はこの画面にはない。
  var NO_HISTORY_NOTICE = 'この画面はアップロードされたExcelを基準に集計しています。HARVESTの過去履歴補完を含まないため、結果が異なる場合があります。';
  function noHistoryBadge() {
    return '<span style="display:inline-block;background:#e5e7eb;color:#374151;border-radius:9999px;padding:2px 8px;font-size:12px;">履歴補完なし</span>';
  }
  function noHistoryNotice() {
    return '<div class="text-xs" style="margin:8px 0;padding:8px 10px;background:#f3f4f6;border-radius:6px;">' + noHistoryBadge() + ' ' + esc(NO_HISTORY_NOTICE) + '</div>';
  }
  function jst(iso) {
    var t = Date.parse(iso || '');
    if (!isFinite(t)) return '—';
    return new Date(t + 9 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
  }
  function clock(v) {
    var format = global.DutyHoursFormat;
    if (format && typeof format.clockText === 'function') return format.clockText(v);
    if (typeof v !== 'number' || !isFinite(v)) return '要確認';
    var sign = v < 0 ? -1 : 1;
    var total = Math.round(Math.abs(v) * 60);
    var hour = Math.floor(total / 60);
    var minute = total % 60;
    var hourText = hour < 10 ? '0' + hour : String(hour);
    var minuteText = minute < 10 ? '0' + minute : String(minute);
    return (sign < 0 ? '-' : '') + hourText + ':' + minuteText;
  }
  var TIME_STYLE = 'white-space:nowrap;font-variant-numeric:tabular-nums;font-family:ui-monospace,Consolas,monospace;text-align:right;font-size:18px;line-height:1.2;padding:10px 12px;';
  var JUDGMENT_COLOR = { 'actual-exceed': '#9f1239', 'forecast-exceed': '#c2410c', caution: '#b45309', review: '#92400e', ok: '#15803d' };
  function root() { return document.getElementById('wh60-local-root'); }

  // ---- 取込 ----
  function readWorkbook(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        try { resolve(global.XLSX.read(new Uint8Array(reader.result), { type: 'array', cellDates: true })); } catch (e) { reject(e); }
      };
      reader.onerror = function () { reject(new Error('read-failed')); };
      reader.readAsArrayBuffer(file);
    });
  }

  function sheetRows(wb, name) {
    return global.XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null });
  }

  function inspectShift(wb) {
    var Core = global.RollingCore;
    var skip = global.HarvestRolling60hRun.ROSTER_SKIP || {};
    var names = {};
    var min = '';
    var max = '';
    var withId = 0;
    var monthCells = {};
    (wb.SheetNames || []).forEach(function (sheet) {
      if (skip[sheet] || sheet === 'Report5_Daily_Data') return;
      var parsed = Core.parseMonthlyRosterSheetRows(sheetRows(wb, sheet));
      (parsed.records || []).forEach(function (rec) {
        if (rec.rawCode === '' || rec.rawCode == null) return;
        var ym = String(rec.date).slice(0, 7);
        monthCells[ym] = (monthCells[ym] || 0) + 1;
      });
      var grouped = Core.groupRosterRecordsByDriver(parsed.records || []);
      Object.keys(grouped).forEach(function (key) {
        var meta = grouped[key].meta || {};
        if (!meta.transportId || key.indexOf('NAME:') === 0) return;
        withId++;
        if (meta.name && !names[meta.transportId]) names[meta.transportId] = meta.name;
      });
      if (parsed.meta && parsed.meta.dateRange) {
        if (!min || parsed.meta.dateRange.min < min) min = parsed.meta.dateRange.min;
        if (!max || parsed.meta.dateRange.max > max) max = parsed.meta.dateRange.max;
      }
    });
    if (!withId) return { ok: false, error: 'Transport IDを持つシフト行が見つかりません（シフト表の形式を確認してください）' };
    var months = Core.describeRosterMonths({ f: monthCells })[0].months;
    return { ok: true, names: names, range: min && max ? { min: min, max: max } : null, count: withId, months: months };
  }

  function inspectDaily(wb) {
    var Core = global.RollingCore;
    var sheet = Core.pickReport5Sheet(wb.SheetNames || []);
    if (!sheet) return { ok: false, error: 'Report5_Daily_Data シートがありません（Amazon Daily Working Hour のファイルではない可能性）' };
    var rows = sheetRows(wb, sheet);
    var parsed = Core.parseAmazonDailyRows(rows, { stationFilter: 'OFK3', allowHeaderlessFallback: false });
    if (!parsed.records || !parsed.records.length) {
      var missing = (parsed.warnings || []).some(function (w) { return w.type === 'missing_columns'; });
      return { ok: false, error: missing ? '必要な列（transporter_id / working_day / estimated_working_hour）がありません' : 'OFK3の行がありません' };
    }
    return { ok: true, rows: rows, range: parsed.dateRange, count: parsed.records.length };
  }

  function importFile(kind, file) {
    if (!file) return Promise.resolve();
    STATE.picked = STATE.picked || {};
    STATE.picked[kind] = file.name;
    if (!/\.xlsx?$/i.test(file.name)) {
      STATE.message = file.name + ': xlsx / xls ファイルを選択してください。';
      return render();
    }
    return readWorkbook(file).then(function (wb) {
      var checked = kind === 'shift' ? inspectShift(wb) : inspectDaily(wb);
      var entry = { name: file.name, importedAt: nowIso(), ok: checked.ok, error: checked.error || '', range: checked.range || null, count: checked.count || 0 };
      if (checked.ok) {
        STATE.message = '';
        if (kind === 'shift') {
          // 月ごとのファイルを同時に保持する。同名ファイルの再読込は置き換え（重複計上しない）。
          entry.workbook = wb;
          entry.names = checked.names;
          entry.months = checked.months || [];
          entry.rangeMax = checked.range ? checked.range.max : '';
          entry.label = file.name;
          entry.modified = typeof file.lastModified === 'number' ? file.lastModified : undefined;
          var up = global.RollingCore.upsertRosterSource(STATE.shiftFiles, entry, MAX_SHIFT_FILES, { neededMonths: global.RollingCore.neededMonthsForReference(refDate()) });
          STATE.shiftFiles = up.list;
          STATE.shift = aggregateShift();
          if (up.keptNewer) STATE.message = file.name + ' は取込済みのファイルより更新日時が古いため、新しい方をそのまま残しました（置き換えていません）。';
          else if (up.rejected) STATE.message = file.name + ' は取り込めませんでした: 上限' + MAX_SHIFT_FILES + 'ファイルで、すべて基準日の判定に必要な月のため外せません。不要なファイルを「クリア」してから取り込んでください。';
          else if (up.evicted) STATE.message = '上限' + MAX_SHIFT_FILES + 'ファイルのため、判定に不要な最も古い月の「' + up.evicted.name + '」を外しました。';
          else if (up.replaced) STATE.message = file.name + ' は取込済みのため置き換えました（二重には計上しません）。';
        } else {
          entry.rows = checked.rows;
          STATE[kind] = entry; // 成功したときだけ差し替える（失敗した取込は前の正常な取込を壊さない）
        }
      } else {
        STATE.message = (kind === 'shift' ? 'シフト表' : 'Daily実績') + 'の取込に失敗: ' + file.name + '（' + checked.error + '）。' + (STATE[kind] ? '前回取り込んだファイルはそのまま残しています。' : '');
        STATE.lastFailed = STATE.lastFailed || {};
        STATE.lastFailed[kind] = entry;
      }
      render();
    }).catch(function () {
      STATE.message = file.name + ' を読み込めませんでした（壊れている、またはExcel形式ではありません）。前回の取込と保存済みの集計は変更していません。';
      render();
    });
  }

  function refDate() {
    return STATE.referenceDate || Board.jstDate(nowIso());
  }

  function shiftCoverage() {
    var loaded = (STATE.shiftFiles || []).map(function (f) { return { label: f.name, months: f.months || [] }; });
    return global.RollingCore.checkRosterCoverage(loaded, refDate());
  }

  function aggregateShift() {
    var files = STATE.shiftFiles || [];
    if (!files.length) return null;
    var names = {};
    var min = '';
    var max = '';
    var importedAt = '';
    var months = {};
    files.forEach(function (f) {
      Object.keys(f.names || {}).forEach(function (tid) { if (!names[tid]) names[tid] = f.names[tid]; });
      if (f.range) {
        if (!min || f.range.min < min) min = f.range.min;
        if (!max || f.range.max > max) max = f.range.max;
      }
      if (!importedAt || f.importedAt > importedAt) importedAt = f.importedAt;
      (f.months || []).forEach(function (ym) { months[ym] = true; });
    });
    return {
      name: files.map(function (f) { return f.name; }).join(' + '),
      importedAt: importedAt,
      range: min && max ? { min: min, max: max } : null,
      ok: true,
      names: names,
      months: Object.keys(months).sort(),
    };
  }

  function monthLabel(ym) {
    var m = /^(\d{4})-(\d{2})$/.exec(ym || '');
    return m ? m[1] + '年' + Number(m[2]) + '月' : ym;
  }

  function names() {
    var out = {};
    var shiftNames = STATE.shift && STATE.shift.names ? STATE.shift.names : {};
    Object.keys(shiftNames).forEach(function (k) { out[k] = shiftNames[k]; });
    return out;
  }

  function withMasterNames(board) {
    if (typeof global.resolveDutyRiskMasterName !== 'function') return;
    board.rows.forEach(function (row) {
      if (row.name) return;
      try {
        var rec = global.resolveDutyRiskMasterName(row.transportId);
        var name = rec && (typeof rec === 'string' ? rec : (rec.japaneseName || rec.englishName));
        if (name) row.name = String(name).trim();
      } catch (e) {}
    });
  }

  function publishDispatch(ref) {
    try {
      if (!global.RollingUI || typeof global.RollingUI.ingestLoadedFiles !== 'function') return;
      if (!STATE.shiftFiles || !STATE.shiftFiles.length) return;
      global.RollingUI.ingestLoadedFiles({
        workbooks: STATE.shiftFiles.map(function (f) { return { name: f.name, workbook: f.workbook }; }),
        amazonRows: STATE.daily && STATE.daily.rows ? STATE.daily.rows : null,
        referenceDate: ref,
        rosterLabel: STATE.shift.name || 'シフト'
      });
    } catch (e) {}
  }

  function actualDays() {
    var rows = STATE.daily && STATE.daily.rows;
    if (!rows || !global.RollingCore || typeof global.RollingCore.parseAmazonDailyRows !== 'function') return [];
    var parsed = global.RollingCore.parseAmazonDailyRows(rows, { stationFilter: 'OFK3', allowHeaderlessFallback: false });
    return (parsed.records || []).filter(function (rec) {
      return rec && rec.transportId && rec.hoursOk !== false && typeof rec.hours === 'number';
    }).map(function (rec) {
      return { transportId: rec.transportId, date: rec.date, hours: rec.hours };
    });
  }

  function aggregate() {
    var ref = STATE.referenceDate || Board.jstDate(nowIso());
    // InoichiRollingDryRun はサーバーが index.html に差し込む（既存のRolling画面と共通）。無いときは集計しない。
    if (!global.InoichiRollingDryRun || !global.HarvestRolling60hRun || !global.DutyRiskDashboard || !global.DutyRiskSnapshot || !global.RollingCore || !global.HarvestDailyManifest || !global.XLSX) {
      STATE.message = '集計に必要なモジュールを読み込めていません。ページを再読込してください。前回の保存済み集計は変更していません。';
      return render();
    }
    if (!STATE.shift && !STATE.daily) { STATE.message = 'シフト表とDaily実績のExcelを取り込んでください。'; return render(); }
    var executed;
    try {
      executed = global.HarvestRolling60hRun.capture({
        xlsx: global.XLSX,
        rolling: global.RollingCore,
        harvest: global.HarvestDailyManifest,
        dryRun: global.InoichiRollingDryRun,
        dailyRows: STATE.daily ? STATE.daily.rows : null,
        dailyFileName: STATE.daily ? STATE.daily.name : '',
        shiftBooks: (STATE.shiftFiles || []).map(function (f) { return { name: f.name, workbook: f.workbook }; }),
        referenceDate: ref,
      });
    } catch (e) {
      STATE.message = '集計に失敗しました（内部エラー）。前回の保存済み集計は変更していません。';
      return render();
    }
    if (!executed.drivers.length) {
      STATE.message = '集計対象者が0人でした。ファイルの内容を確認してください。前回の保存済み集計は変更していません。';
      return render();
    }
    publishDispatch(ref);
    var board = Board.buildBoard({
      executed: executed,
      referenceDate: ref,
      generatedAt: nowIso(),
      files: {
        shift: { name: STATE.shift ? STATE.shift.name : '', ok: !!STATE.shift, range: STATE.shift ? STATE.shift.range : null, importedAt: STATE.shift ? STATE.shift.importedAt : null, months: STATE.shift ? STATE.shift.months : [], fileCount: (STATE.shiftFiles || []).length, missingMonths: STATE.shiftFiles && STATE.shiftFiles.length ? shiftCoverage().missing : [] },
        daily: { name: STATE.daily ? STATE.daily.name : '', ok: !!STATE.daily, range: STATE.daily ? STATE.daily.range : null, importedAt: STATE.daily ? STATE.daily.importedAt : null },
      },
      names: names(),
      actualDays: actualDays(),
    }, { analyze: global.DutyRiskDashboard.analyzePrediction, dispositionOf: global.DutyRiskSnapshot.dispositionOf });
    withMasterNames(board);
    STATE.board = board;
    STATE.message = '';
    var summary = Board.buildFridaySummary(board, nowIso());
    var missing = board.files && board.files.shift && board.files.shift.missingMonths;
    if (missing && missing.length) {
      h += '<div class="card p-3 mb-3 text-sm" style="background:#fef2f2;color:#b91c1c;">⚠ 基準日の判定に必要な ' + esc(missing.join('・')) + ' のシフト表が未読込です。該当日は未取得のままで、判定不能が増えます。</div>';
    }
    if (board.completeness === 'incomplete-input') {
      // 片方の入力が欠けた集計は表示だけ。保存済みの正常な集計は置き換えない。
      STATE.saved = 'skipped';
      STATE.sub = 'board';
      return render();
    }
    STATE.sub = 'board';
    STATE.saved = null;
    render();
    ensureStore().save(board, summary).then(function () {
      STATE.saved = 'ok';
      publish(summary);
      render();
    }, function () {
      STATE.saved = 'failed';
      render();
    });
  }

  function publish(summary) {
    try { global.dispatchEvent(new CustomEvent('ofk3:rolling60h-summary', { detail: summary })); } catch (e) {}
  }

  // ---- 描画 ----
  function tabBar() {
    function btn(id, label) {
      var on = STATE.sub === id;
      return '<button type="button" data-sub="' + id + '" style="padding:8px 14px;border:none;border-bottom:2px solid ' + (on ? '#2563eb' : 'transparent') + ';background:none;font-weight:' + (on ? '700' : '400') + ';cursor:pointer;">' + label + '</button>';
    }
    return '<div style="display:flex;gap:4px;border-bottom:1px solid #e5e7eb;margin-bottom:12px;">' +
      btn('import', 'データ取込') + btn('board', '残り時間・リスク一覧') + btn('grid', 'シフト格子（既存）') + '</div>';
  }

  function fileCard(kind, title, hint) {
    var entry = STATE[kind];
    var failed = STATE.lastFailed && STATE.lastFailed[kind];
    var h = '<div class="card p-4"><h3 class="text-sm font-bold mb-2">' + title + '</h3><p class="text-xs text-ink-lighter mb-2">' + hint + '</p>';
    // index.html の全体CSS（input[type="file"] { display: none; }）で入力欄そのものは隠れるため、
    // ラベルをボタンにして選択できるようにする（他画面のCSSには手を入れない）。
    h += '<label class="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-bold" data-pick="' + kind + '" style="display:inline-block;cursor:pointer;">📂 ファイルを選択' +
      '<input type="file" accept=".xlsx,.xls" data-file="' + kind + '"></label>';
    if (STATE.picked && STATE.picked[kind]) {
      h += '<div class="text-xs mt-2" data-picked="' + kind + '">選択したファイル: <b>' + esc(STATE.picked[kind]) + '</b></div>';
    }
    if (kind === 'shift' && STATE.shiftFiles && STATE.shiftFiles.length) {
      var allMonths = entry && entry.months ? entry.months : [];
      h += '<div class="text-xs mt-2" data-shift-months="1"><b>読込済みの月: ' + (allMonths.length ? esc(allMonths.map(monthLabel).join('・')) : '不明') + '</b>' +
        '（最大' + MAX_SHIFT_FILES + 'ファイル。別の月のファイルを追加しても前の月は消えません）</div>';
      STATE.shiftFiles.forEach(function (f) {
        h += '<div class="text-xs mt-1">✅ <b>' + esc(f.name) + '</b>：' + (f.months && f.months.length ? esc(f.months.map(monthLabel).join('・')) : '月不明') +
          '／取込 ' + esc(jst(f.importedAt)) + '</div>';
      });
      shiftCoverage().warnings.forEach(function (w) {
        h += '<div class="text-xs mt-1" role="alert" data-shift-coverage="1" style="color:#b91c1c;">⚠ ' + esc(w) + '</div>';
      });
      h += '<div class="text-xs mt-1 text-ink-lighter">同じ日付が複数ファイルにあるときは、空白より勤務記号を採用し、記号が食い違う日は判定不能にします。</div>';
    } else if (entry) {
      h += '<div class="text-xs mt-2">✅ 読込成功: <b>' + esc(entry.name) + '</b><br>取込日時 ' + esc(jst(entry.importedAt)) +
        '<br>対象期間 ' + (entry.range ? esc(entry.range.min + ' 〜 ' + entry.range.max) : '不明') + '</div>';
    } else {
      h += '<div class="text-xs mt-2 text-ink-lighter">未取込</div>';
    }
    if (failed && !failed.ok && (!entry || failed.importedAt > entry.importedAt)) {
      h += '<div class="text-xs mt-2" style="color:#dc2626;">❌ 直近の取込に失敗: ' + esc(failed.name) + '（' + esc(failed.error) + '）</div>';
    }
    return h + '</div>';
  }

  function renderImport() {
    var h = '<div class="grid grid-cols-2 gap-4 mb-4">';
    h += fileCard('shift', '① シフト表（月間Excel）', 'DSP別シートからTransport IDと勤務記号を読みます。ファイルはこのブラウザ内で処理され、送信されません。');
    h += fileCard('daily', '② Amazon Daily Working Hour', 'Report5_Daily_Data の estimated_working_hour（推定）だけを読みます。');
    h += '</div>';
    h += '<div class="card p-4 mb-4" style="display:flex;flex-wrap:wrap;gap:12px;align-items:end;">' +
      '<div><label class="block text-xs text-ink-lighter mb-1">基準日（この日を終端とする7日窓を表示）</label>' +
      '<input type="date" id="local60-ref" class="border rounded px-2 py-1 text-sm" value="' + esc(STATE.referenceDate || Board.jstDate(nowIso())) + '"></div>' +
      '<button type="button" id="local60-run" class="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-bold">集計実行</button>' +
      '<div style="flex-basis:100%;">' + noHistoryNotice() + '</div></div>';
    if (STATE.message) h += '<div class="card p-3 mb-4 text-sm" role="alert" style="color:#b91c1c;">' + esc(STATE.message) + '</div>';
    h += '<p class="text-xs text-ink-lighter">集計結果は「このブラウザ」のIndexedDBにだけ保存されます（他のPC・ブラウザ・シークレットウィンドウとは共有されません）。' +
      'ファイル自体は保存しないため、ブラウザを再読込した後は保存済みの集計結果の表示になります。</p>';
    return h;
  }

  function banner(board) {
    var fresh = Board.freshness(board, nowIso());
    var h = '';
    if (fresh.status !== 'fresh') {
      var why = fresh.reasons.map(function (r) {
        return r === 'age-over-limit' ? '集計から' + Math.floor((fresh.ageMinutes || 0) / 60) + '時間以上経過' : r === 'reference-date-not-today' ? '基準日 ' + board.referenceDate + ' は今日（' + Board.jstDate(nowIso()) + '）ではありません' : '';
      }).filter(Boolean).join('、');
      h += '<div class="card p-3 mb-3 text-sm" style="background:#fffbeb;color:#92400e;">⚠ 古いデータです（' + esc(why) + '）。最新のExcelを取り込み直してください。</div>';
    }
    if (board.completeness === 'incomplete-input') {
      h += '<div class="card p-3 mb-3 text-sm" style="background:#fef2f2;color:#b91c1c;">❌ ' +
        (!board.inputs.daily ? 'Daily実績が未取込' : 'シフト表が未取込') + 'のため、この集計は暫定です。確定判定として扱わないでください。保存済みの集計は置き換えていません。</div>';
    }
    if (STATE.saved === 'failed') h += '<div class="card p-3 mb-3 text-sm" style="color:#b91c1c;">このブラウザへの保存に失敗しました。今回の表示のみです。保存済みの前回集計は変更していません。</div>';
    if (STATE.saved === 'ok') h += '<div class="text-xs mb-2" style="color:#059669;">✓ このブラウザに保存しました</div>';
    return h;
  }

  function overClock(hours) {
    if (typeof hours !== 'number' || !isFinite(hours) || hours <= 60) return '00:00';
    return clock(hours - 60);
  }

  function renderEvidence(r, period, title) {
    var items = (r.evidence || []).filter(function (item) { return item.period === period && item.exceeds; });
    var h = '<div style="margin:8px 0 4px;font-weight:700;">' + title + (items.length ? '' : '：なし') + '</div>';
    items.forEach(function (item) {
      h += '<div style="margin-top:6px;">' + esc(item.periodLabel) + ' ' + esc(item.start + ' 〜 ' + item.end) +
        '　合計 ' + esc(clock(item.totalHours)) +
        '　超過 ' + esc(clock(item.overBy)) +
        '　' + esc(item.confirmedActual ? '実績確定' : '予定込みの暫定') +
        ((item.gaps && item.gaps.length) ? '　欠損あり' : '　欠損なし') +
        '</div>';
      h += '<div style="white-space:nowrap;overflow-x:auto;">' + (item.days || []).map(function (d) {
        return esc(d.date) + ' ' + esc(d.adopted) + ' ' + (d.hours == null ? '要確認' : esc(clock(d.hours)));
      }).join(' ／ ') + '</div>';
      if (item.gaps && item.gaps.length) {
        h += '<div>欠損: ' + esc(item.gaps.map(function (g) { return (g.date || '日付不明') + ' ' + g.reason; }).join('、')) + '</div>';
      }
    });
    return h;
  }

  function renderDetail(r) {
    var gapText = (r.gaps || []).map(function (g) { return (g.date || '日付不明') + ' ' + g.reason; }).join('、');
    var h = '<tr data-detail="' + esc(r.transportId) + '"><td colspan="5" style="background:#f8fafc;padding:10px 12px;font-size:13px;">';
    h += '<div style="margin-bottom:6px;">DA ID ' + esc(r.transportId || 'なし') + '</div>';
    if (!String(r.name || '').trim()) {
      h += '<div style="font-weight:700;">照合不能</div>';
      h += '<div>' + esc(r.unmatchedReason || 'シフト表とDAマスタにこの Transport ID の氏名がありません') + '</div>';
      h += '<div style="margin-top:4px;">取得済み実績: ' + ((r.recordedActuals || []).length ? (r.recordedActuals || []).map(function (d) {
        return esc(d.date) + ' ' + esc(clock(d.hours));
      }).join('、') : 'なし') + '</div>';
    }
    h += '<div style="margin:8px 0 4px;font-weight:700;">今日の7日間 ' + esc((r.windowStart || '') + ' 〜 ' + (r.windowEnd || '')) + '</div>';
    h += '<div>合計 ' + esc(clock(r.forecast && r.forecast.hours)) + '　超過 ' + esc(overClock(r.forecast && r.forecast.hours)) + '　' + esc(r.dataClass || '') +
      (r.todayPlan == null ? '' : '　今日の予定 ' + esc(clock(r.todayPlan))) + '</div>';
    h += '<div style="white-space:nowrap;overflow-x:auto;margin-top:4px;">' + (r.days || []).map(function (d) {
      return esc(d.date) + ' ' + esc(d.adopted) + ' ' + (d.hours == null ? '要確認' : esc(clock(d.hours)));
    }).join(' ／ ') + '</div>';
    if (gapText) h += '<div style="margin-top:6px;">欠損: ' + esc(gapText) + '</div>';
    h += renderEvidence(r, 'future', '将来の超過');
    h += renderEvidence(r, 'past', '過去の超過');
    if (r.forecast && r.forecast.note) h += '<div style="margin-top:4px;">' + esc(r.forecast.note) + '</div>';
    if (r.workable && r.workable.note) h += '<div>' + esc(r.workable.note) + '</div>';
    h += '</td></tr>';
    return h;
  }

  function sortLabel(mode) {
    if (mode === 'name') return '氏名順';
    if (mode === 'margin') return '余裕が少ない順';
    return 'リスク順';
  }

  function shownHours(block) {
    var hours = block && block.hours;
    if (typeof hours !== 'number' || !isFinite(hours)) return clock(null);
    return clock(hours);
  }

  function judgmentMark(row) {
    var code = (row && row.judgment) || 'review';
    var marks = {
      'actual-exceed': '■',
      exceed: '■',
      'forecast-exceed': '▲',
      caution: '●',
      approach: '●',
      review: '？',
      partial: '？',
      undetermined: '？',
      ok: '○',
      clear: '○',
    };
    return marks[code] || '？';
  }

  function judgmentClass(row) {
    var code = (row && row.judgment) || 'review';
    if (code === 'actual-exceed' || code === 'exceed') return 'risk-actual';
    if (code === 'forecast-exceed') return 'risk-forecast';
    if (code === 'caution' || code === 'approach') return 'risk-caution';
    if (code === 'ok' || code === 'clear') return 'risk-ok';
    return 'risk-review';
  }

  function judgmentLabel(row) {
    var text = Board && Board.judgmentText
      ? Board.judgmentText(row)
      : (((row && row.judgmentLabel) || '要確認') + (row && row.judgmentProvisional ? '・暫定' : ''));
    return judgmentMark(row) + text + (row && row.otherStation ? '・' + row.otherStation.label : '');
  }

  function futureLine(row) {
    var future = row && row.futureExceed;
    if (!future) return '';
    return future.start + '〜' + future.end + (future.count > 1 ? ' ほか' + (future.count - 1) + '件' : '');
  }

  function visibleRows(board, query, sort) {
    var rows = (board && board.rows) || [];
    if (!Board || !Board.filterRows || !Board.sortRows) return rows.slice();
    return Board.sortRows(Board.filterRows(rows, query), sort);
  }

  function periodText(board) {
    var start = board && board.windowStart ? String(board.windowStart) : '';
    var end = board && board.referenceDate ? String(board.referenceDate) : '';
    if (!start && !end) return '不明';
    return start + ' 〜 ' + end;
  }

  function printHtml(board, query, sort, printedAt) {
    var printed = jst(printedAt || nowIso());
    var mode = sort === 'name' || sort === 'margin' ? sort : 'risk';
    var q = String(query || '').trim();
    var head = '<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>残り時間・リスク一覧</title><style>';
    head += '@page{size:A4 landscape;margin:6mm;}';
    head += 'html,body{margin:0;padding:0;color:#111;background:#fff;}';
    head += 'body{font-family:"Yu Gothic UI","Yu Gothic","Meiryo","Hiragino Kaku Gothic ProN","Noto Sans CJK JP","Noto Sans JP",sans-serif;font-size:11px;line-height:1.35;}';
    head += 'h1{font-size:16px;margin:0 0 4px;}p{margin:0 0 4px;}';
    head += 'table{width:100%;border-collapse:collapse;table-layout:fixed;}';
    head += 'thead{display:table-header-group;}tr,th,td{break-inside:avoid;page-break-inside:avoid;}';
    head += 'th,td{border:1px solid #222;padding:3px 4px;vertical-align:top;word-break:break-word;}th{font-weight:700;text-align:left;}';
    head += '.col-name{width:16%;}.col-actual{width:12%;}.col-forecast{width:14%;}.col-remain{width:14%;}.col-risk{width:24%;}.col-period{width:20%;}';
    head += 'td.num{text-align:right;font-variant-numeric:tabular-nums;font-family:ui-monospace,Consolas,monospace;white-space:nowrap;}';
    head += '.risk{font-weight:700;}.risk-actual{color:#9f1239;}.risk-forecast{color:#c2410c;}.risk-caution{color:#b45309;}.risk-review{color:#92400e;}.risk-ok{color:#15803d;}';
    head += '.no-print{margin:0 0 8px;}@media print{.no-print{display:none !important;}}';
    head += '</style></head><body>';
    head += '<div class="no-print"><button type="button" onclick="window.print()">印刷／PDF保存</button>';
    head += '<p>印刷画面の送信先で「PDFに保存」または Microsoft Print to PDF を選ぶと、この用紙をPDFにできます。用紙はA4横です。</p></div>';
    if (!board) {
      return head + '<h1>残り時間・リスク一覧</h1><p>出力日時 ' + esc(printed) + '</p><p>集計結果がありません。</p></body></html>';
    }
    var rows = visibleRows(board, q, mode);
    var html = head + '<h1>残り時間・リスク一覧</h1>';
    html += '<p>対象日 ' + esc(board.referenceDate || '不明') + '</p>';
    html += '<p>判定対象期間 ' + esc(periodText(board)) + '</p>';
    html += '<p>出力日時 ' + esc(printed) + '</p>';
    html += '<p>最終集計日時 ' + esc(jst(board.generatedAt)) + '</p>';
    html += '<p>検索条件 ' + esc(q || 'なし') + '。並び順 ' + esc(sortLabel(mode)) + '。</p>';
    html += '<p>記号 ■実績超過 ▲超過予測 ●注意 ○正常 ？要確認。要確認は時間を決められない状態で、0時間にはしていません。時間は HH:MM です。</p>';
    html += '<table><colgroup><col class="col-name"><col class="col-actual"><col class="col-forecast"><col class="col-remain"><col class="col-risk"><col class="col-period"></colgroup>';
    html += '<thead><tr>';
    ['DA名', '実績累計', '予定込み予測', '残り許容時間', 'リスク判定', '判定対象期間'].forEach(function (header) {
      html += '<th>' + esc(header) + '</th>';
    });
    html += '</tr></thead><tbody>';
    if (!rows.length) html += '<tr><td colspan="6">該当なし</td></tr>';
    rows.forEach(function (row) {
      var extra = futureLine(row);
      html += '<tr>';
      html += '<td>' + esc(Board && Board.displayName ? Board.displayName(row) : ((row && row.name) || '未照合DA')) + '</td>';
      html += '<td class="num">' + esc(shownHours(row && row.past6)) + '</td>';
      html += '<td class="num">' + esc(shownHours(row && row.forecast)) + '</td>';
      html += '<td class="num">' + esc(shownHours(row && row.workable)) + '</td>';
      html += '<td class="risk ' + judgmentClass(row) + '">' + esc(judgmentLabel(row)) + '</td>';
      html += '<td>' + esc(periodText(board)) + (extra ? '<br>' + esc(extra) : '') + '</td>';
      html += '</tr>';
    });
    html += '</tbody></table>';
    if (global.RollingUI && typeof global.RollingUI.prefixApproachPrintHtml === 'function') {
      html += global.RollingUI.prefixApproachPrintHtml();
    }
    html += '<script>window.addEventListener("load",function(){window.print();});<\/script></body></html>';
    return html;
  }

  function openPrint() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return false;
    var html = printHtml(STATE.board, STATE.query, STATE.sort, nowIso());
    var opened = window.open('', '_blank');
    if (!opened) {
      window.alert('印刷用の画面を開けませんでした。ブラウザのポップアップを許可して、もう一度押してください。');
      return false;
    }
    opened.document.open();
    opened.document.write(html);
    opened.document.close();
    opened.focus();
    return true;
  }

  function renderBoard() {
    var board = STATE.board;
    if (!board) return '<div class="card p-4 text-sm">集計結果がありません。「データ取込」でExcelを取り込み、集計を実行してください。</div>';
    var c = board.counts;
    var h = banner(board);
    var genDay = Board.jstDate(board.generatedAt);
    h += '<div class="mb-1">' + noHistoryBadge() + '</div>';
    h += '<p class="text-xs text-ink-lighter mb-2">最終集計日時（この集計を実行した時刻） <b>' + esc(jst(board.generatedAt)) + '</b>' +
      '<br>基準日（7日窓の終端） <b>' + esc(board.referenceDate) + '</b>　対象7日 ' + esc(board.windowStart + ' 〜 ' + board.referenceDate) +
      (genDay && genDay !== board.referenceDate ? '<br><span style="color:#92400e;">⚠ 基準日（' + esc(board.referenceDate) + '）は集計日（' + esc(genDay) + '）と異なります。表示は基準日時点の7日窓です。</span>' : '') +
      '<br>シフト: ' + esc(board.files.shift.name || '未取込') + '　Daily: ' + esc(board.files.daily.name || '未取込') + '</p>';
    var judged = { 'actual-exceed': 0, 'forecast-exceed': 0, caution: 0, review: 0, ok: 0 };
    (board.rows || []).forEach(function (r) {
      var code = r.judgment && Object.prototype.hasOwnProperty.call(judged, r.judgment) ? r.judgment : '';
      if (code) judged[code] += 1;
    });
    var useJudgment = (board.rows || []).length > 0 && (board.rows || []).every(function (r) { return !!r.judgment; });
    h += '<div class="grid grid-cols-2 md:grid-cols-6 gap-2 mb-3">';
    var cards = useJudgment
      ? [['実績超過', judged['actual-exceed'], 'actual-exceed'], ['超過予測', judged['forecast-exceed'], 'forecast-exceed'], ['注意', judged.caution, 'caution'], ['要確認', judged.review, 'review'], ['正常', judged.ok, 'ok'], ['対象', c.driverCount, '']]
      : [['超過', c.exceed, 'exceed'], ['接近', c.approach, 'approach'], ['部分欠損', c.partial, 'partial'], ['要確認', c.undetermined, 'undetermined'], ['正常', c.clear, 'clear'], ['対象', c.driverCount, '']];
    cards.forEach(function (x) {
      h += '<div class="card p-2"><div class="text-xs text-ink-lighter">' + x[0] + '</div><div class="text-xl font-bold">' + x[1] + '</div></div>';
    });
    h += '</div>';
    h += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;">' +
      '<input id="local60-q" class="border rounded px-3 py-2 text-sm" style="min-width:220px;" placeholder="氏名・DA番号" value="' + esc(STATE.query) + '">' +
      '<select id="local60-sort" class="border rounded px-2 py-2 text-sm">' +
      [['risk', 'リスク順'], ['margin', '余裕が少ない順'], ['name', '氏名順']].map(function (o) { return '<option value="' + o[0] + '"' + (STATE.sort === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') +
      '</select>' +
      '<button type="button" id="local60-print" data-local60-print="1" class="no-print px-3 py-1 rounded text-sm border border-slate-800">印刷／PDF保存</button></div>';
    var rows = Board.sortRows(Board.filterRows(board.rows, STATE.query), STATE.sort);
    h += '<div class="overflow-x-auto card"><table class="w-full" style="border-collapse:collapse;min-width:720px;"><thead><tr>' +
      [['DA名', 'left'], ['実績累計', 'right'], ['予定込み予測', 'right'], ['残り許容', 'right'], ['判定', 'left']].map(function (col) {
        return '<th style="text-align:' + col[1] + ';padding:10px 12px;white-space:nowrap;font-size:13px;">' + col[0] + '</th>';
      }).join('') +
      '</tr></thead><tbody>';
    if (!rows.length) h += '<tr><td class="p-2" colspan="5">該当なし</td></tr>';
    rows.forEach(function (r) {
      var code = r.judgment || 'review';
      var label = Board.judgmentText ? Board.judgmentText(r) : ((r.judgmentLabel || '要確認') + (r.judgmentProvisional ? '・暫定' : ''));
      if (r.otherStation) label += '・' + r.otherStation.label;
      var color = JUDGMENT_COLOR[code] || JUDGMENT_COLOR.review;
      var tint = code === 'actual-exceed' ? '#fff1f2' : code === 'forecast-exceed' ? '#fff7ed' : code === 'caution' ? '#fffbeb' : code === 'review' ? '#fffbeb' : (r.futureExceed ? '#fffbeb' : '');
      var futureLine = r.futureExceed ? (r.futureExceed.start + '〜' + r.futureExceed.end + (r.futureExceed.count > 1 ? ' ほか' + (r.futureExceed.count - 1) + '件' : '')) : '';
      h += '<tr class="border-t" data-tid="' + esc(r.transportId) + '" style="cursor:pointer;' + (tint ? 'background:' + tint + ';' : '') + '">' +
        '<td style="padding:10px 12px;white-space:nowrap;font-weight:700;font-size:16px;">' + esc(Board.displayName ? Board.displayName(r) : (r.name || '未照合DA')) + '</td>' +
        '<td style="' + TIME_STYLE + '" title="' + esc(r.past6.note || '') + '">' + clock(r.past6.hours) + '</td>' +
        '<td style="' + TIME_STYLE + '" title="' + esc(r.forecast.note || '') + '">' + clock(r.forecast.hours) + '</td>' +
        '<td style="' + TIME_STYLE + '" title="' + esc(r.workable.note || '') + '">' + clock(r.workable.hours) + '</td>' +
        '<td style="padding:10px 12px;white-space:nowrap;"><span style="background:' + color + ';color:#fff;border-radius:9999px;padding:2px 8px;font-size:13px;white-space:nowrap;">' + esc(label) + '</span>' +
        (futureLine ? '<div style="margin-top:4px;color:#c2410c;font-size:12px;font-weight:700;">' + esc(futureLine) + '</div>' : '') +
        '</td></tr>';
      if (STATE.selected === r.transportId) h += renderDetail(r);
    });
    h += '</tbody></table></div>';
    if (global.RollingUI && typeof global.RollingUI.prefixApproachHtml === 'function') {
      h += global.RollingUI.prefixApproachHtml();
    }
    h += '<p class="text-xs text-ink-lighter mt-2">' + esc(board.notice) + ' 時間は HH:MM です。超過予測は、基準日を終端とする7日間の予定込み予測が60時間を超える人です。別の期間の超過は、この判定を上書きしません。将来の超過は一覧に「将来超過あり」と期間を出します。過去の超過は判定欄を開くと履歴で確認できます。実績超過は予定を足す前から超えている人です。「・暫定」は予定を含む値です。要確認は、今日の7日間を判断する情報が足りない人です。</p>';
    h += noHistoryNotice();
    return h;
  }

  function render() {
    var el = root();
    if (!el) return;
    var gridPanel = document.getElementById('wh60-rolling-subpanel');
    if (gridPanel) gridPanel.style.display = STATE.sub === 'grid' ? '' : 'none';
    el.innerHTML = tabBar() + (STATE.sub === 'import' ? renderImport() : STATE.sub === 'board' ? renderBoard() : '');
    bind(el);
  }

  function bind(el) {
    Array.prototype.forEach.call(el.querySelectorAll('[data-sub]'), function (b) {
      b.addEventListener('click', function () {
        STATE.sub = b.getAttribute('data-sub');
        render();
        if (STATE.sub === 'grid' && global.RollingUI && global.RollingUI.onShown) global.RollingUI.onShown();
      });
    });
    Array.prototype.forEach.call(el.querySelectorAll('[data-file]'), function (inp) {
      inp.addEventListener('change', function () { importFile(inp.getAttribute('data-file'), inp.files && inp.files[0]); });
    });
    var run = el.querySelector('#local60-run');
    if (run) run.addEventListener('click', function () {
      var ref = el.querySelector('#local60-ref');
      STATE.referenceDate = ref && /^\d{4}-\d{2}-\d{2}$/.test(ref.value) ? ref.value : '';
      aggregate();
    });
    var q = el.querySelector('#local60-q');
    if (q) q.addEventListener('input', function () {
      STATE.query = q.value;
      render();
      var again = document.getElementById('local60-q');
      if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
    });
    var sort = el.querySelector('#local60-sort');
    if (sort) sort.addEventListener('change', function () { STATE.sort = sort.value; render(); });
    var printButton = el.querySelector('[data-local60-print]');
    if (printButton) printButton.addEventListener('click', function () { openPrint(); });
    Array.prototype.forEach.call(el.querySelectorAll('tr[data-tid]'), function (tr) {
      tr.addEventListener('click', function () {
        var id = tr.getAttribute('data-tid');
        STATE.selected = STATE.selected === id ? '' : id;
        render();
      });
    });
  }

  // 保存先への接続は画面を開かなくても使えるよう、遅延作成にする（FRIDAY向け要約の取得用）。
  function ensureStore() {
    if (!STATE.store) {
      STATE.store = global.Rolling60hLocalStore.create({
        indexedDB: global.indexedDB,
        localStorage: (function () { try { return global.localStorage; } catch (e) { return null; } })(),
        validate: Board.validateBoard,
      });
    }
    return STATE.store;
  }

  function init() {
    if (STATE.ready || !root()) return;
    STATE.ready = true;
    ensureStore();
    render();
    STATE.store.loadBoard().then(function (saved) {
      if (saved && Board.validateBoard(saved) && !STATE.board) {
        STATE.board = saved;
        STATE.sub = 'board';
        render();
      }
    }, function () {});
  }

  function getFridaySummary() {
    return ensureStore().loadBoard().then(function (board) {
      return Board.buildFridaySummary(board && Board.validateBoard(board) ? board : null, nowIso());
    });
  }

  global.Rolling60hBoardUI = {
    onShown: function () { init(); render(); },
    getFridaySummary: getFridaySummary,
    printHtml: printHtml,
    _state: STATE,
  };
})(typeof window !== 'undefined' ? window : this);
