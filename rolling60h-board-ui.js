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
  var STATE = {
    ready: false,
    sub: 'import',
    shift: null, // { name, workbook, importedAt, range, ok, error, names }
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
    (wb.SheetNames || []).forEach(function (sheet) {
      if (skip[sheet] || sheet === 'Report5_Daily_Data') return;
      var parsed = Core.parseMonthlyRosterSheetRows(sheetRows(wb, sheet));
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
    return { ok: true, names: names, range: min && max ? { min: min, max: max } : null, count: withId };
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
        if (kind === 'shift') { entry.workbook = wb; entry.names = checked.names; } else { entry.rows = checked.rows; }
        STATE[kind] = entry; // 成功したときだけ差し替える（失敗した取込は前の正常な取込を壊さない）
        STATE.message = '';
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
      if (!STATE.shift || !STATE.shift.workbook) return;
      global.RollingUI.ingestLoadedFiles({
        workbook: STATE.shift.workbook,
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
        shiftBook: STATE.shift ? STATE.shift.workbook : null,
        shiftFileName: STATE.shift ? STATE.shift.name : '',
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
        shift: { name: STATE.shift ? STATE.shift.name : '', ok: !!STATE.shift, range: STATE.shift ? STATE.shift.range : null, importedAt: STATE.shift ? STATE.shift.importedAt : null },
        daily: { name: STATE.daily ? STATE.daily.name : '', ok: !!STATE.daily, range: STATE.daily ? STATE.daily.range : null, importedAt: STATE.daily ? STATE.daily.importedAt : null },
      },
      names: names(),
      actualDays: actualDays(),
    }, { analyze: global.DutyRiskDashboard.analyzePrediction, dispositionOf: global.DutyRiskSnapshot.dispositionOf });
    withMasterNames(board);
    STATE.board = board;
    STATE.message = '';
    var summary = Board.buildFridaySummary(board, nowIso());
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
    if (entry) {
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
      '</select></div>';
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
    _state: STATE,
  };
})(typeof window !== 'undefined' ? window : this);
