/**
 * OFK3 運行実績集計 UI（経営ダッシュボードタブ #panel-exec の末尾にカードを追加するだけ）
 *
 * - 既存の経営ダッシュボード要素・関数（parseShiftForExec / recalcExecDashboard 等）には触れない。
 * - 計算はすべて run-summary-core.js（RunSummaryCore）で行う。
 * - 月選択 → シフト表（＋任意でアルコールチェック）読込 → 集計 → 所属別サマリー／ドライバー別内訳 → Excel出力
 *
 * 制約: index.html と同じくテンプレートリテラル禁止（文字列連結のみ）。
 */
(function () {
  'use strict';

  var PANEL_ID = 'panel-exec';
  var ROOT_ID = 'run-summary-root';

  var state = {
    shift: null, // { fileName, sheets, order }
    alcohol: null, // { fileName, sheet, parsed }（AlcoholAuditCore.parseAlcoholRows の結果）
    result: null,
    audit: null,
    expanded: {},
  };

  function core() {
    return window.RunSummaryCore || null;
  }

  function alcoholCore() {
    return window.AlcoholAuditCore || null;
  }

  var ALIAS_STORAGE_KEY = 'runSummaryAlcoholAliases';

  function loadAliasText() {
    try { return localStorage.getItem(ALIAS_STORAGE_KEY) || ''; } catch (e) { return ''; }
  }

  function saveAliasText(t) {
    try { localStorage.setItem(ALIAS_STORAGE_KEY, t); } catch (e) {}
  }

  /** 「CSV表記,シフト表表記」形式（1行1件）→ 名前対応 */
  function parseAliasText(text) {
    var rows = [['CSV表記', 'シフト表表記']];
    String(text || '').split(/\r?\n/).forEach(function (line) {
      var parts = line.split(/[,，\t]/);
      if (parts.length >= 2) rows.push([parts[0], parts[1]]);
    });
    return alcoholCore().parseAliasRows(rows);
  }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function defaultMonth() {
    // 月次集計は通常「前月」を対象にする
    var d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - 1);
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2);
  }

  function $(id) {
    return document.getElementById(id);
  }

  function buildRootHtml() {
    return (
      '<div class="card p-4 mb-4">' +
      '  <div class="flex items-center justify-between flex-wrap gap-2 mb-3">' +
      '    <h3 class="text-sm font-bold">📊 運行実績集計（月次・所属別／ドライバー別）</h3>' +
      '    <div class="flex items-center gap-2 flex-wrap">' +
      '      <label class="text-xs text-ink-lighter">対象月:</label>' +
      '      <input type="month" id="rs-month" class="text-xs border border-border rounded px-2 py-1">' +
      '      <button type="button" id="rs-run" class="btn-secondary text-xs px-3 py-1.5 rounded">集計</button>' +
      '      <button type="button" id="rs-export" class="btn-secondary text-xs px-3 py-1.5 rounded" disabled>📥 Excel出力</button>' +
      '    </div>' +
      '  </div>' +
      '  <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">' +
      '    <div class="upload-zone rounded-lg p-4 text-center cursor-pointer" id="rs-shift-drop">' +
      '      <p class="text-sm font-medium text-ink-lighter">① DAシフト表（xlsx）をドロップ／クリック</p>' +
      '      <p class="text-xs text-ink-lighter mt-1">シフト回数・運行種類はシフト表を正とします（「メイン」シート優先）</p>' +
      '      <input type="file" id="rs-shift-file" accept=".xlsx,.xls" class="hidden">' +
      '      <p id="rs-shift-status" class="text-xs mt-2"></p>' +
      '    </div>' +
      '    <div class="upload-zone rounded-lg p-4 text-center cursor-pointer" id="rs-alc-drop">' +
      '      <p class="text-sm font-medium text-ink-lighter">② アルコールチェック原体（任意・xlsx/csv）</p>' +
      '      <p class="text-xs text-ink-lighter mt-1">照合（監査）のみに使用し、シフト数は変更しません</p>' +
      '      <input type="file" id="rs-alc-file" accept=".xlsx,.xls,.csv" class="hidden">' +
      '      <p id="rs-alc-status" class="text-xs mt-2"></p>' +
      '    </div>' +
      '  </div>' +
      '  <div class="mb-3">' +
      '    <details><summary class="text-xs text-ink-lighter cursor-pointer">名前対応（アルコールCSVの氏名とシフト表の氏名が異なる人：1行に「CSV表記,シフト表表記」）</summary>' +
      '    <textarea id="rs-alc-aliases" rows="4" class="w-full text-xs border border-border rounded p-2 mt-1" placeholder="田中安香音,辻　安香音"></textarea></details>' +
      '  </div>' +
      '  <div id="rs-result"></div>' +
      '</div>'
    );
  }

  function readWorkbookFile(file, cb) {
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var wb;
        if (/\.csv$/i.test(file.name || '') && alcoholCore()) {
          // 検知器CSVは Shift_JIS。値の自動変換（日時→シリアル値等）をさせず文字列のまま読む
          var text = alcoholCore().decodeCsvBytes(new Uint8Array(e.target.result));
          wb = XLSX.read(text, { type: 'string', raw: true });
        } else {
          wb = XLSX.read(e.target.result, { type: 'array' });
        }
        var sheets = {};
        wb.SheetNames.forEach(function (sn) {
          sheets[sn] = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: '' });
        });
        cb(null, { fileName: file.name, sheets: sheets, order: wb.SheetNames.slice() });
      } catch (err) {
        cb(err);
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function onShiftFile(file) {
    $('rs-shift-status').textContent = '読み込み中...';
    readWorkbookFile(file, function (err, wb) {
      if (err) {
        $('rs-shift-status').innerHTML = '<span class="text-red-600">読込エラー: ' + esc(err.message) + '</span>';
        return;
      }
      state.shift = wb;
      $('rs-shift-status').innerHTML = '<span class="text-emerald-600 font-bold">✅ ' + esc(wb.fileName) + '</span>';
      run();
    });
  }

  function onAlcoholFile(file) {
    $('rs-alc-status').textContent = '読み込み中...';
    readWorkbookFile(file, function (err, wb) {
      if (err) {
        $('rs-alc-status').innerHTML = '<span class="text-red-600">読込エラー: ' + esc(err.message) + '</span>';
        return;
      }
      // ヘッダーを検出できた最初のシートを使う
      var A = alcoholCore();
      if (!A) return;
      var picked = null;
      for (var i = 0; i < wb.order.length; i++) {
        var p = A.parseAlcoholRows(wb.sheets[wb.order[i]]);
        if (p.ok) {
          picked = { sheet: wb.order[i], parsed: p };
          break;
        }
      }
      if (!picked) {
        state.alcohol = null;
        $('rs-alc-status').innerHTML = '<span class="text-red-600">氏名・測定日時の列を検出できませんでした</span>';
        return;
      }
      state.alcohol = { fileName: wb.fileName, sheet: picked.sheet, parsed: picked.parsed };
      $('rs-alc-status').innerHTML =
        '<span class="text-emerald-600 font-bold">✅ ' + esc(wb.fileName) + '（' + esc(picked.sheet) + '／' + picked.parsed.records.length + '件）</span>';
      run();
    });
  }

  function run() {
    var C = core();
    if (!C) return;
    if (!state.shift) {
      $('rs-result').innerHTML = '<p class="text-xs text-ink-lighter">シフト表を読み込んでください。</p>';
      return;
    }
    var month = $('rs-month').value || defaultMonth();
    var isNonDriverRow =
      typeof AssignSupportCore !== 'undefined' && AssignSupportCore.isShiftNonDriverRow ? AssignSupportCore.isShiftNonDriverRow : null;
    state.result = C.summarizeShiftWorkbook(state.shift.sheets, state.shift.order, { month: month, isNonDriverRow: isNonDriverRow });
    state.audit =
      state.alcohol && alcoholCore()
        ? alcoholCore().auditAlcohol(state.result, state.alcohol.parsed.records, { aliases: parseAliasText($('rs-alc-aliases').value) })
        : null;
    state.expanded = {};
    render();
  }

  function codeHeaderCells() {
    return core().TARGET_CODES.map(function (c) {
      return '<th class="px-2 py-2 text-right text-xs font-medium text-ink-lighter">' + esc(c.label) + '</th>';
    }).join('');
  }

  function countCells(counts) {
    return core().TARGET_CODES.map(function (c) {
      var v = counts[c.key] || 0;
      return '<td class="px-2 py-1.5 text-right text-xs' + (v ? '' : ' text-ink-lighter') + '">' + v + '</td>';
    }).join('');
  }

  function renderKpis(r) {
    var tiles = [{ label: '総シフト数', value: r.totals.total, strong: true }].concat(
      core().TARGET_CODES.map(function (c) {
        return { label: c.label, value: r.totals.counts[c.key] || 0 };
      })
    );
    return (
      '<div class="grid grid-cols-4 md:grid-cols-8 gap-2 mb-4">' +
      tiles.map(function (t) {
        return (
          '<div class="rounded-lg border border-border p-2 text-center' + (t.strong ? ' bg-yellow-50 border-yellow-300' : '') + '">' +
          '<div class="text-xs text-ink-lighter">' + esc(t.label) + '</div>' +
          '<div class="text-lg font-black">' + t.value + '</div>' +
          '</div>'
        );
      }).join('') +
      '</div>'
    );
  }

  function renderSummaryTable(r) {
    var html =
      '<h4 class="text-xs font-bold text-ink-lighter mb-2">🏢 所属別サマリー（行クリックでドライバー別内訳を展開）</h4>' +
      '<div class="overflow-x-auto mb-4"><table class="w-full text-sm">' +
      '<thead><tr class="border-b border-border bg-surface">' +
      '<th class="px-2 py-2 text-left text-xs font-medium text-ink-lighter">所属</th>' +
      '<th class="px-2 py-2 text-left text-xs font-medium text-ink-lighter">ドライバー名</th>' +
      '<th class="px-2 py-2 text-right text-xs font-medium text-ink-lighter">合計シフト</th>' +
      codeHeaderCells() +
      '<th class="px-2 py-2 text-right text-xs font-medium text-ink-lighter">構成人数</th>' +
      '</tr></thead><tbody>';
    r.affiliations.forEach(function (a, idx) {
      var open = !!state.expanded[idx];
      html +=
        '<tr class="border-b border-border cursor-pointer hover:bg-yellow-50" data-rs-aff="' + idx + '">' +
        '<td class="px-2 py-1.5 text-xs font-bold">' + (open ? '▼ ' : '▶ ') + esc(a.company) + '</td>' +
        '<td class="px-2 py-1.5 text-xs text-ink-lighter">' + a.drivers.length + '名</td>' +
        '<td class="px-2 py-1.5 text-right text-xs font-bold">' + a.total + '</td>' +
        countCells(a.counts) +
        '<td class="px-2 py-1.5 text-right text-xs">' + a.headcount + '</td>' +
        '</tr>';
      if (open) {
        a.drivers.forEach(function (d) {
          html +=
            '<tr class="border-b border-border bg-surface">' +
            '<td class="px-2 py-1 text-xs text-ink-lighter">' + esc(a.company) + '</td>' +
            '<td class="px-2 py-1 text-xs">' + esc(d.name) + '</td>' +
            '<td class="px-2 py-1 text-right text-xs font-bold">' + d.total + '</td>' +
            countCells(d.counts) +
            '<td></td></tr>';
        });
        html +=
          '<tr class="border-b-2 border-gray-300 bg-surface">' +
          '<td class="px-2 py-1 text-xs font-bold" colspan="2">' + esc(a.company) + ' 合計</td>' +
          '<td class="px-2 py-1 text-right text-xs font-bold">' + a.total + '</td>' +
          countCells(a.counts) +
          '<td class="px-2 py-1 text-right text-xs">' + a.headcount + '</td></tr>';
        if (a.zeroShiftDrivers.length) {
          html +=
            '<tr class="bg-surface"><td colspan="12" class="px-2 py-1 text-xs text-ink-lighter">対象月のシフトなし（構成人数に含めない）: ' +
            esc(a.zeroShiftDrivers.map(function (p) { return p.name; }).join('、')) + '</td></tr>';
        }
      }
    });
    html +=
      '<tr class="border-t-2 border-gray-400 font-bold">' +
      '<td class="px-2 py-2 text-xs" colspan="2">全社合計</td>' +
      '<td class="px-2 py-2 text-right text-xs">' + r.totals.total + '</td>' +
      countCells(r.totals.counts) +
      '<td class="px-2 py-2 text-right text-xs">' + r.totals.headcount + '</td></tr>';
    html += '</tbody></table></div>';
    return html;
  }

  var WARNING_LABELS = {
    MERGED_DUPLICATE_ROWS: '同一人物の重複行を統合',
    DUPLICATE_SHIFT_SAME_DAY: '重複行の同日同記号（1回として計上）',
    SAME_NAME_DIFFERENT_TID: '同名・別TransportID（別人として集計）',
    SAME_NAME_MULTIPLE_COMPANIES: '同名が複数所属に存在（統合せず）',
    COMPANY_LABEL_VARIANTS: '所属表記ゆれ',
    COUNT_COLUMN_MISMATCH: 'シフト表「回数」列と集計値が不一致',
    SHEET_MONTH_DIFFERS_FROM_SELECTED: 'シフト表の年月と選択月が不一致',
    NAME_HEADER_NOT_FOUND: '氏名ヘッダー未検出のシート',
    DATE_HEADER_NOT_FOUND: '日付ヘッダー未検出のシート',
    MONTH_UNRESOLVED: '年月を特定できないシート',
    COMPANY_HEADER_NOT_FOUND: '所属（社名）列が見つからないシート',
    NO_SHIFT_SHEET_PARSED: 'シフトを読み取れるシートがありません',
  };

  function describeWarning(w) {
    var parts = [];
    if (w.sheet) parts.push('シート:' + w.sheet);
    if (w.company) parts.push(w.company);
    if (w.name) parts.push(w.name);
    if (w.date) parts.push(w.date);
    if (w.rawNames) parts.push('表記: ' + w.rawNames.join(' / '));
    if (w.transportIds) parts.push('TID: ' + w.transportIds.join(' / '));
    if (w.companies) parts.push('所属: ' + w.companies.join(' / '));
    if (w.variants) parts.push('表記: ' + w.variants.join(' / '));
    if (w.sheetCount !== undefined) parts.push('回数列=' + w.sheetCount + ' / 集計=' + w.computed);
    if (w.sheetMonth) parts.push(w.sheetMonth + ' ≠ ' + w.selected);
    return parts.join('　');
  }

  function renderDiagnostics(r) {
    var html = '<h4 class="text-xs font-bold text-ink-lighter mb-2 mt-2">🔎 確認事項</h4><div class="text-xs space-y-1 mb-4">';
    html +=
      '<div>対象期間: ' + (r.dateRange ? esc(r.dateRange.min + '〜' + r.dateRange.max) : '-') +
      '　／ 使用シート: ' + esc((r.sheetsUsed || []).map(function (m) { return m.sheet; }).join('、') || '-') +
      '　／ 非稼働（休など）: ' + r.nonWorkingCount + '件' +
      (r.outOfMonthCells ? '　／ 対象月外の記号: ' + r.outOfMonthCells + '件（集計外）' : '') +
      '</div>';
    if (r.unknownShifts.length) {
      html += '<div class="text-red-600 font-bold">⚠ UNKNOWN_SHIFT（未知のシフトコード）: ' + r.unknownShifts.length + '件 — 集計に含めていません</div><ul class="ml-4 list-disc text-red-600">';
      r.unknownShifts.slice(0, 50).forEach(function (u) {
        html += '<li>' + esc(u.company + '　' + u.name + '　' + u.date + '　「' + u.raw + '」（' + u.sheet + '!' + (u.cell || u.row + '行') + '）') + '</li>';
      });
      if (r.unknownShifts.length > 50) html += '<li>…ほか' + (r.unknownShifts.length - 50) + '件（Excel出力で全件確認できます）</li>';
      html += '</ul>';
    } else {
      html += '<div class="text-emerald-600">✓ UNKNOWN_SHIFT なし</div>';
    }
    var conv = r.convertedCodes || [];
    if (conv.length) {
      var labelOf = {};
      core().TARGET_CODES.forEach(function (c) { labelOf[c.key] = c.label; });
      html += '<details><summary class="cursor-pointer text-ink-lighter">読み替え（研修→○ / 研C1→C1 / C319・C320→C3）: ' + conv.length + '件</summary><ul class="ml-4 list-disc">';
      conv.forEach(function (x) {
        html += '<li>' + esc(x.company + '　' + x.name + '　' + x.date + '　「' + x.raw + '」→' + labelOf[x.code] + '（' + x.sheet + '!' + x.cell + '）') + '</li>';
      });
      html += '</ul></details>';
    }
    var others = Object.keys(r.otherCodes);
    if (others.length) {
      html += '<div class="text-ink-lighter">集計対象外コード: ' + esc(others.map(function (k) { return k + ' ' + r.otherCodes[k] + '件'; }).join('、')) + '</div>';
    }
    var byType = {};
    r.warnings.forEach(function (w) {
      if (w.type === 'DUPLICATE_DATE_COLUMN_RESOLVED') return;
      (byType[w.type] = byType[w.type] || []).push(w);
    });
    Object.keys(byType).forEach(function (t) {
      var list = byType[t];
      html += '<details><summary class="cursor-pointer text-amber-700">⚠ ' + esc(WARNING_LABELS[t] || t) + '（' + list.length + '件）</summary><ul class="ml-4 list-disc">';
      list.slice(0, 50).forEach(function (w) { html += '<li>' + esc(describeWarning(w)) + '</li>'; });
      html += '</ul></details>';
    });
    html += '</div>';
    return html;
  }

  function renderAlcohol() {
    if (!state.audit) return '';
    var c = state.audit.counts;
    var rows = [
      ['OK（出発前・帰着後とも測定、全てA）', c.OK],
      ['軽微（帰着後未測定）', c['軽微']],
      ['重大（A以外の判定、または出発前未測定）', c['重大']],
      ['未測定（シフトありで測定なし）', c['未測定']],
      ['シフト外（休・空欄の日に測定あり）', c['シフト外']],
      ['シフトあり＋出発前測定あり／なし', c.shiftWithBefore + ' ／ ' + c.shiftWithoutBefore],
      ['シフトあり＋帰着後測定あり／なし', c.shiftWithAfter + ' ／ ' + c.shiftWithoutAfter],
    ];
    var html = '<h4 class="text-xs font-bold text-ink-lighter mb-2">🍺 アルコールチェック照合（監査用・シフト数には影響しません）</h4><table class="text-xs mb-2">';
    rows.forEach(function (r) {
      html += '<tr><td class="pr-4 py-0.5">' + esc(r[0]) + '</td><td class="text-right font-bold">' + r[1] + '</td></tr>';
    });
    html += '</table>';
    var serious = state.audit.days.filter(function (d) { return d.result === '重大' || d.result === '未測定'; });
    if (serious.length) {
      html += '<details class="mb-2"><summary class="text-xs text-red-600 cursor-pointer">重大・未測定の明細（' + serious.length + '件）</summary><ul class="ml-4 list-disc text-xs">';
      serious.forEach(function (d) {
        html += '<li>' + esc(d.date + '　' + d.company + '　' + d.name + '　' + d.result + (d.note ? '（' + d.note + '）' : '')) + '</li>';
      });
      html += '</ul></details>';
    }
    var unmatched = Object.keys(state.audit.unmatchedNames);
    if (unmatched.length) html += '<div class="text-xs text-amber-700">シフト表に氏名が見つからない測定者（名前対応に追加してください）: ' + esc(unmatched.join('、')) + '</div>';
    var ambiguous = Object.keys(state.audit.ambiguousNames);
    if (ambiguous.length) html += '<div class="text-xs text-amber-700">同名が複数いるため自動照合しなかった氏名: ' + esc(ambiguous.join('、')) + '</div>';
    if (state.audit.sharedRecords.length) html += '<div class="text-xs text-ink-lighter">共用ID（flex / biker / テスト）の測定 ' + state.audit.sharedRecords.length + '件は照合対象外</div>';
    return html;
  }

  function render() {
    var r = state.result;
    var box = $('rs-result');
    if (!r) {
      box.innerHTML = '';
      $('rs-export').disabled = true;
      return;
    }
    if (!r.affiliations.length) {
      box.innerHTML =
        '<p class="text-xs text-red-600 mb-2">対象月（' + esc(r.month) + '）の集計対象シフトがありません。対象月とシフト表を確認してください。</p>' + renderDiagnostics(r);
      $('rs-export').disabled = true;
      return;
    }
    box.innerHTML = renderKpis(r) + renderSummaryTable(r) + renderAlcohol() + renderDiagnostics(r);
    $('rs-export').disabled = false;
    var trs = box.querySelectorAll('tr[data-rs-aff]');
    for (var i = 0; i < trs.length; i++) {
      trs[i].addEventListener('click', function () {
        var idx = this.getAttribute('data-rs-aff');
        state.expanded[idx] = !state.expanded[idx];
        render();
      });
    }
  }

  function exportExcel() {
    var C = core();
    var r = state.result;
    if (!C || !r || typeof XLSX === 'undefined') return;
    var wb = XLSX.utils.book_new();
    var ws = XLSX.utils.aoa_to_sheet(C.buildSummaryAoa(r));
    ws['!cols'] = [{ wch: 18 }, { wch: 18 }, { wch: 10 }, { wch: 6 }, { wch: 6 }, { wch: 6 }, { wch: 6 }, { wch: 6 }, { wch: 6 }, { wch: 6 }];
    XLSX.utils.book_append_sheet(wb, ws, '所属別運行集計');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(C.buildUnknownAoa(r)), 'UNKNOWN_SHIFT');
    if (state.audit) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(alcoholCore().buildAlcoholAoa(state.audit)), 'アルコール照合');
    XLSX.writeFile(wb, '所属別運行集計_' + r.month + '.xlsx');
  }

  function wireDrop(dropId, inputId, handler) {
    var drop = $(dropId);
    var input = $(inputId);
    drop.addEventListener('click', function (e) {
      if (e.target !== input) input.click();
    });
    input.addEventListener('change', function () {
      if (input.files && input.files[0]) handler(input.files[0]);
      input.value = '';
    });
    drop.addEventListener('dragover', function (e) {
      e.preventDefault();
      drop.classList.add('border-accent');
    });
    drop.addEventListener('dragleave', function () {
      drop.classList.remove('border-accent');
    });
    drop.addEventListener('drop', function (e) {
      e.preventDefault();
      drop.classList.remove('border-accent');
      var files = e.dataTransfer && e.dataTransfer.files;
      if (files && files[0]) handler(files[0]);
    });
  }

  function insertRoot() {
    var panel = $(PANEL_ID);
    if (!panel || $(ROOT_ID) || !core()) return;
    var root = document.createElement('div');
    root.id = ROOT_ID;
    root.innerHTML = buildRootHtml();
    panel.appendChild(root);
    $('rs-month').value = defaultMonth();
    $('rs-month').addEventListener('change', run);
    $('rs-run').addEventListener('click', run);
    $('rs-export').addEventListener('click', exportExcel);
    wireDrop('rs-shift-drop', 'rs-shift-file', onShiftFile);
    wireDrop('rs-alc-drop', 'rs-alc-file', onAlcoholFile);
    $('rs-alc-aliases').value = loadAliasText();
    $('rs-alc-aliases').addEventListener('change', function () {
      saveAliasText(this.value);
      if (state.alcohol) run();
    });
  }

  function boot() {
    try { insertRoot(); } catch (e) {}
  }

  window.OFK3RunSummary = {
    getState: function () { return state; },
    run: run,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
