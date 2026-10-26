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
  function jst(iso) {
    var t = Date.parse(iso || '');
    if (!isFinite(t)) return '—';
    return new Date(t + 9 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
  }
  function hours(v) {
    if (typeof v !== 'number' || !isFinite(v)) return '算出不可';
    return (Math.round(v * 100) / 100).toFixed(2).replace(/\.?0+$/, '') + 'h';
  }
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

  function aggregate() {
    var ref = STATE.referenceDate || Board.jstDate(nowIso());
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
    var board = Board.buildBoard({
      executed: executed,
      referenceDate: ref,
      generatedAt: nowIso(),
      files: {
        shift: { name: STATE.shift ? STATE.shift.name : '', ok: !!STATE.shift, range: STATE.shift ? STATE.shift.range : null, importedAt: STATE.shift ? STATE.shift.importedAt : null },
        daily: { name: STATE.daily ? STATE.daily.name : '', ok: !!STATE.daily, range: STATE.daily ? STATE.daily.range : null, importedAt: STATE.daily ? STATE.daily.importedAt : null },
      },
      names: names(),
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
    STATE.store.save(board, summary).then(function () {
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
  function badge(status, label) {
    var colors = { exceed: '#dc2626', approach: '#d97706', partial: '#7c3aed', undetermined: '#6b7280', clear: '#059669' };
    return '<span style="background:' + (colors[status] || '#6b7280') + ';color:#fff;border-radius:9999px;padding:2px 8px;font-size:12px;white-space:nowrap;">' + esc(label) + '</span>';
  }

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
    h += '<input type="file" accept=".xlsx,.xls" data-file="' + kind + '" style="max-width:100%;">';
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
      '<button type="button" id="local60-run" class="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-bold">集計実行</button></div>';
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
        return r === 'age-over-limit' ? '集計から' + Math.floor((fresh.ageMinutes || 0) / 60) + '時間以上経過' : r === 'reference-date-not-today' ? '基準日が今日ではありません' : '';
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

  function renderBoard() {
    var board = STATE.board;
    if (!board) return '<div class="card p-4 text-sm">集計結果がありません。「データ取込」でExcelを取り込み、集計を実行してください。</div>';
    var c = board.counts;
    var h = banner(board);
    h += '<p class="text-xs text-ink-lighter mb-2">最終集計日時 <b>' + esc(jst(board.generatedAt)) + '</b>　基準日 ' + esc(board.referenceDate) +
      '　対象7日 ' + esc(board.windowStart + ' 〜 ' + board.referenceDate) +
      '<br>シフト: ' + esc(board.files.shift.name || '未取込') + '　Daily: ' + esc(board.files.daily.name || '未取込') + '</p>';
    h += '<div class="grid grid-cols-2 md:grid-cols-6 gap-2 mb-3">';
    [['超過', c.exceed, 'exceed'], ['接近', c.approach, 'approach'], ['部分欠損', c.partial, 'partial'], ['判定不能', c.undetermined, 'undetermined'], ['正常', c.clear, 'clear'], ['対象', c.driverCount, '']].forEach(function (x) {
      h += '<div class="card p-2"><div class="text-xs text-ink-lighter">' + x[0] + '</div><div class="text-xl font-bold">' + x[1] + '</div></div>';
    });
    h += '</div>';
    h += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;">' +
      '<input id="local60-q" class="border rounded px-3 py-2 text-sm" style="min-width:220px;" placeholder="氏名・DA番号" value="' + esc(STATE.query) + '">' +
      '<select id="local60-sort" class="border rounded px-2 py-2 text-sm">' +
      [['risk', 'リスク順'], ['margin', '余裕が少ない順'], ['name', '氏名順']].map(function (o) { return '<option value="' + o[0] + '"' + (STATE.sort === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') +
      '</select></div>';
    var rows = Board.sortRows(Board.filterRows(board.rows, STATE.query), STATE.sort);
    h += '<div class="overflow-x-auto card"><table class="w-full text-sm"><thead><tr>' +
      ['氏名', 'DA番号', '判定', '過去6日', '勤務可能上限', '今日の予定', '7日合計（予測）', '予定終了後の余裕', '欠損'].map(function (t) { return '<th class="text-left p-2">' + t + '</th>'; }).join('') +
      '</tr></thead><tbody>';
    if (!rows.length) h += '<tr><td class="p-2" colspan="9">該当なし</td></tr>';
    rows.forEach(function (r) {
      var provisional = function (obj) { return obj.confirmed ? '' : ' <span style="color:#92400e;font-size:11px;">暫定</span>'; };
      h += '<tr class="border-t" data-tid="' + esc(r.transportId) + '" style="cursor:pointer;">' +
        '<td class="p-2">' + esc(r.name || '氏名なし') + '</td><td class="p-2">' + esc(r.transportId) + '</td>' +
        '<td class="p-2">' + badge(r.status, r.statusLabel) + (r.statusDetail ? '<div style="font-size:11px;">' + esc(r.statusDetail) + '</div>' : '') + '</td>' +
        '<td class="p-2">' + hours(r.past6.hours) + (r.past6.kind ? '<div style="font-size:11px;">' + esc(r.past6.kind) + '</div>' : '') + '</td>' +
        '<td class="p-2">' + hours(r.workable.hours) + (r.workable.hours == null ? '' : provisional(r.workable)) + (r.workable.note && r.workable.hours == null ? '<div style="font-size:11px;">' + esc(r.workable.note) + '</div>' : '') + '</td>' +
        '<td class="p-2">' + (r.todayPlan == null ? '予定なし' : hours(r.todayPlan)) + '</td>' +
        '<td class="p-2">' + hours(r.forecast.hours) + (r.forecast.kind ? '<div style="font-size:11px;">' + esc(r.forecast.kind) + '</div>' : '') + '</td>' +
        '<td class="p-2">' + hours(r.marginAfterPlan.hours) + (r.marginAfterPlan.hours == null ? '' : provisional(r.marginAfterPlan)) + '</td>' +
        '<td class="p-2" style="font-size:12px;">' + esc(r.gaps.map(function (g) { return (g.date || '') + ' ' + g.reason; }).join('、')) + '</td></tr>';
      if (STATE.selected === r.transportId) {
        h += '<tr><td class="p-2" colspan="9" style="background:#f9fafb;font-size:12px;">7日の内訳（' + esc(r.windowStart + ' 〜 ' + r.windowEnd) + '）: ' +
          r.days.map(function (d) { return esc(d.date) + ' ' + esc(d.adopted) + ' ' + (d.hours == null ? '—' : hours(d.hours)); }).join(' ／ ') + '</td></tr>';
      }
    });
    h += '</tbody></table></div>';
    h += '<p class="text-xs text-ink-lighter mt-2">' + esc(board.notice) + ' 「暫定」は予定を含む値、「算出不可」は欠損のため確定値を出していません。</p>';
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

  function init() {
    if (STATE.ready || !root()) return;
    STATE.ready = true;
    STATE.store = global.Rolling60hLocalStore.create({
      indexedDB: global.indexedDB,
      localStorage: (function () { try { return global.localStorage; } catch (e) { return null; } })(),
      validate: Board.validateBoard,
    });
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
    return STATE.store.loadBoard().then(function (board) {
      return Board.buildFridaySummary(board && Board.validateBoard(board) ? board : null, nowIso());
    });
  }

  global.Rolling60hBoardUI = {
    onShown: function () { init(); render(); },
    getFridaySummary: getFridaySummary,
    _state: STATE,
  };
})(typeof window !== 'undefined' ? window : this);
