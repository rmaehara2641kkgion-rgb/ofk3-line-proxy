// OFK3 点呼管理 - TransportID照合監査
// Amazonスケジュールを正として、DAシフト表のTransport ID登録誤りを検知する。
(function() {
  'use strict';

  var auditAmazon = null;
  var auditShift = null;
  var auditAmazonFile = '';
  var auditShiftFile = '';
  var PANEL_ID = 'tenko-transport-audit-panel';

  function normalizeName(value) {
    var s = value == null ? '' : String(value);
    try { s = s.normalize('NFKC'); } catch(e) {}
    return s.toLowerCase().replace(/[\s\u3000]+/g, ' ').trim();
  }

  function normalizeTid(value) {
    return value == null ? '' : String(value).trim().toUpperCase();
  }

  function nameVariants(name) {
    var n = normalizeName(name);
    var out = [];
    if (!n) return out;
    out.push(n);
    var parts = n.split(' ');
    if (parts.length === 2) {
      var rev = parts[1] + ' ' + parts[0];
      if (rev !== n) out.push(rev);
    }
    return out;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function readWorkbook(file, done) {
    var reader = new FileReader();
    reader.onload = function(e) {
      try {
        var data = new Uint8Array(e.target.result);
        var wb = XLSX.read(data, { type: 'array' });
        done(null, wb);
      } catch(err) {
        done(err);
      }
    };
    reader.onerror = function() { done(new Error('ファイル読込に失敗しました')); };
    reader.readAsArrayBuffer(file);
  }

  function findHeaderRow(rows, requiredHeaders) {
    for (var r = 0; r < Math.min(rows.length, 30); r++) {
      var row = rows[r] || [];
      var hit = 0;
      for (var h = 0; h < requiredHeaders.length; h++) {
        for (var c = 0; c < row.length; c++) {
          if (String(row[c] || '').trim() === requiredHeaders[h]) { hit++; break; }
        }
      }
      if (hit === requiredHeaders.length) return r;
    }
    return -1;
  }

  function findCol(row, candidates) {
    for (var c = 0; c < row.length; c++) {
      var v = String(row[c] || '').trim().toLowerCase();
      for (var i = 0; i < candidates.length; i++) {
        if (v === candidates[i].toLowerCase()) return c;
      }
    }
    return -1;
  }

  function parseAmazonSchedule(wb) {
    var bestRows = null;
    var bestSheet = '';
    var headerIndex = -1;

    for (var s = 0; s < wb.SheetNames.length; s++) {
      var sheetName = wb.SheetNames[s];
      var rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' });
      var hi = findHeaderRow(rows, ['アソシエイト名', '配達担当者ID']);
      if (hi >= 0) {
        bestRows = rows;
        bestSheet = sheetName;
        headerIndex = hi;
        if (sheetName === '登録済みワークブロック') break;
      }
    }

    if (!bestRows || headerIndex < 0) throw new Error('Amazonスケジュールの「アソシエイト名 / 配達担当者ID」列が見つかりません');

    var header = bestRows[headerIndex] || [];
    var nameCol = findCol(header, ['アソシエイト名']);
    var tidCol = findCol(header, ['配達担当者id']);
    var records = [];
    var lookup = {};
    var conflicts = [];

    for (var r = headerIndex + 1; r < bestRows.length; r++) {
      var rawName = String((bestRows[r] || [])[nameCol] || '').trim();
      var tid = normalizeTid((bestRows[r] || [])[tidCol]);
      var norm = normalizeName(rawName);
      if (!norm || !tid) continue;
      if (norm === '全記載' || norm === 'スケジュール済み合計') continue;

      var rec = { name: rawName, normalizedName: norm, transportId: tid, sheet: bestSheet };
      records.push(rec);
      var variants = nameVariants(rawName);
      for (var v = 0; v < variants.length; v++) {
        var key = variants[v];
        if (lookup[key] && lookup[key].transportId !== tid) {
          conflicts.push({ name: rawName, id1: lookup[key].transportId, id2: tid });
        } else if (!lookup[key]) {
          lookup[key] = rec;
        }
      }
    }

    return { records: records, lookup: lookup, conflicts: conflicts, sheet: bestSheet };
  }

  function parseShiftMaster(wb) {
    var sheetName = wb.SheetNames.indexOf('メイン') >= 0 ? 'メイン' : wb.SheetNames[0];
    var rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' });
    var headerIndex = -1;

    for (var r = 0; r < Math.min(rows.length, 20); r++) {
      var row = rows[r] || [];
      var romanColTest = findCol(row, ['roman character', 'ローマ字名', 'roman']);
      var tidColTest = findCol(row, ['transport id', 'transportid', 'transport id ']);
      if (romanColTest >= 0 && tidColTest >= 0) { headerIndex = r; break; }
    }

    if (headerIndex < 0) throw new Error('DAシフト表の「Roman character / Transport ID」列が見つかりません');

    var header = rows[headerIndex] || [];
    var companyCol = findCol(header, ['社　名', '社 名', '社名', 'company']);
    var jpNameCol = findCol(header, ['名　前', '名 前', '名前', 'name']);
    var romanCol = findCol(header, ['roman character', 'ローマ字名', 'roman']);
    var tidCol = findCol(header, ['transport id', 'transportid', 'transport id ']);
    var records = [];

    for (var i = headerIndex + 1; i < rows.length; i++) {
      var rowData = rows[i] || [];
      var romanName = String(rowData[romanCol] || '').trim();
      var jpName = jpNameCol >= 0 ? String(rowData[jpNameCol] || '').trim() : '';
      var company = companyCol >= 0 ? String(rowData[companyCol] || '').trim() : '';
      var tid = normalizeTid(rowData[tidCol]);
      if (!romanName || !tid) continue;
      records.push({
        name: romanName,
        japaneseName: jpName,
        company: company,
        normalizedName: normalizeName(romanName),
        transportId: tid,
        sheet: sheetName
      });
    }

    return { records: records, sheet: sheetName };
  }

  function getPanel() {
    var existing = document.getElementById(PANEL_ID);
    if (existing) return existing;

    var panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = 'card p-4 mb-4 border-2 border-slate-200';
    panel.innerHTML = '<div class="text-sm font-bold">🔎 TransportID照合</div>' +
      '<div class="text-xs text-ink-lighter mt-1">AmazonスケジュールとDAシフト表を読み込むと自動照合します。</div>';

    var tenko = document.getElementById('panel-tenko');
    if (!tenko) {
      document.body.appendChild(panel);
      return panel;
    }

    var heading = tenko.querySelector('h2');
    var headerBox = heading;
    while (headerBox && headerBox.parentNode !== tenko) headerBox = headerBox.parentNode;
    if (headerBox && headerBox.parentNode === tenko) {
      tenko.insertBefore(panel, headerBox.nextSibling);
    } else {
      tenko.insertBefore(panel, tenko.firstChild);
    }
    return panel;
  }

  function renderWaiting() {
    var panel = getPanel();
    var a = auditAmazon ? '✅ Amazonスケジュール読込済み' : '⬜ Amazonスケジュール待ち';
    var s = auditShift ? '✅ DAシフト表読込済み' : '⬜ DAシフト表待ち';
    panel.className = 'card p-4 mb-4 border-2 border-slate-200';
    panel.innerHTML = '<div class="text-sm font-bold">🔎 TransportID照合</div>' +
      '<div class="text-xs text-ink-light mt-2">' + escapeHtml(auditAmazonFile || '') + ' ' + a + '</div>' +
      '<div class="text-xs text-ink-light mt-1">' + escapeHtml(auditShiftFile || '') + ' ' + s + '</div>';
  }

  function compareNow() {
    if (!auditAmazon || !auditShift) {
      renderWaiting();
      return;
    }

    var matched = [];
    var mismatched = [];
    var shiftOnly = [];
    var usedAmazon = {};

    for (var i = 0; i < auditShift.records.length; i++) {
      var sr = auditShift.records[i];
      var variants = nameVariants(sr.name);
      var ar = null;
      var matchedKey = '';
      for (var v = 0; v < variants.length; v++) {
        if (auditAmazon.lookup[variants[v]]) {
          ar = auditAmazon.lookup[variants[v]];
          matchedKey = normalizeName(ar.name);
          break;
        }
      }

      if (!ar) {
        shiftOnly.push(sr);
        continue;
      }

      usedAmazon[matchedKey] = true;
      if (sr.transportId === ar.transportId) {
        matched.push({ shift: sr, amazon: ar });
      } else {
        mismatched.push({ shift: sr, amazon: ar });
      }
    }

    var amazonOnly = [];
    for (var a = 0; a < auditAmazon.records.length; a++) {
      var amz = auditAmazon.records[a];
      if (!usedAmazon[normalizeName(amz.name)]) amazonOnly.push(amz);
    }

    renderResult(matched, mismatched, amazonOnly, shiftOnly, auditAmazon.conflicts || []);
  }

  function renderResult(matched, mismatched, amazonOnly, shiftOnly, conflicts) {
    var panel = getPanel();
    var isOk = mismatched.length === 0 && conflicts.length === 0;
    panel.className = isOk
      ? 'card p-4 mb-4 border-2 border-emerald-400 bg-emerald-50'
      : 'card p-4 mb-4 border-2 border-red-500 bg-red-50';

    var html = '';
    if (isOk) {
      html += '<div class="text-base font-bold text-emerald-700">✅ TransportID照合：一致</div>';
      html += '<div class="text-sm font-bold text-emerald-700 mt-1">一致 ' + matched.length + '名 / 不一致 0名</div>';
      html += '<div class="text-xs text-emerald-700 mt-1">AmazonスケジュールのTransportIDとDAシフト表の登録内容は一致しています。</div>';
    } else {
      html += '<div class="text-base font-bold text-red-700">🚨 TransportID照合：不一致あり</div>';
      html += '<div class="text-sm font-bold text-red-700 mt-1">一致 ' + matched.length + '名 / 不一致 ' + mismatched.length + '名</div>';
      html += '<div class="text-xs font-bold text-red-700 mt-1">Amazonスケジュールを正として確認してください。シフト側の誤登録は点呼・コンプライアンス判定へ影響する可能性があります。</div>';
    }

    if (mismatched.length > 0) {
      html += '<div class="mt-3 space-y-2">';
      for (var i = 0; i < mismatched.length; i++) {
        var m = mismatched[i];
        var displayName = m.shift.japaneseName ? m.shift.japaneseName + ' / ' + m.shift.name : m.shift.name;
        html += '<div class="rounded-lg border border-red-300 bg-white p-3">' +
          '<div class="font-bold text-red-700">❌ ' + escapeHtml(displayName) + '</div>' +
          '<div class="text-xs text-red-700 mt-1">Amazon正：<span class="font-mono font-bold">' + escapeHtml(m.amazon.transportId) + '</span></div>' +
          '<div class="text-xs text-red-700">シフト登録：<span class="font-mono font-bold">' + escapeHtml(m.shift.transportId) + '</span></div>' +
          (m.shift.company ? '<div class="text-xs text-red-600 mt-1">所属：' + escapeHtml(m.shift.company) + '</div>' : '') +
          '</div>';
      }
      html += '</div>';
    }

    if (conflicts.length > 0) {
      html += '<div class="mt-3 text-xs font-bold text-red-700">⚠ Amazonスケジュール内で同一名に複数TransportIDが存在します：' + conflicts.length + '件</div>';
    }

    if (amazonOnly.length > 0 || shiftOnly.length > 0) {
      html += '<details class="mt-3"><summary class="text-xs font-bold text-amber-700 cursor-pointer">⚠ 未照合：Amazonのみ ' + amazonOnly.length + '名 / シフトのみ ' + shiftOnly.length + '名</summary>';
      html += '<div class="mt-2 grid grid-cols-1 md:grid-cols-2 gap-2">';
      if (amazonOnly.length > 0) {
        html += '<div class="rounded border border-amber-200 bg-amber-50 p-2"><div class="text-xs font-bold text-amber-800">Amazon側のみ</div><div class="text-xs text-amber-700 mt-1">';
        for (var a = 0; a < Math.min(amazonOnly.length, 30); a++) html += escapeHtml(amazonOnly[a].name) + '<br>';
        if (amazonOnly.length > 30) html += '...他 ' + (amazonOnly.length - 30) + '名';
        html += '</div></div>';
      }
      if (shiftOnly.length > 0) {
        html += '<div class="rounded border border-amber-200 bg-amber-50 p-2"><div class="text-xs font-bold text-amber-800">シフト側のみ</div><div class="text-xs text-amber-700 mt-1">';
        for (var s = 0; s < Math.min(shiftOnly.length, 30); s++) {
          html += escapeHtml(shiftOnly[s].japaneseName || shiftOnly[s].name) + ' / ' + escapeHtml(shiftOnly[s].name) + '<br>';
        }
        if (shiftOnly.length > 30) html += '...他 ' + (shiftOnly.length - 30) + '名';
        html += '</div></div>';
      }
      html += '</div></details>';
    }

    panel.innerHTML = html;

    if (isOk) {
      alert('✅ TransportID照合：一致\n\n一致 ' + matched.length + '名 / 不一致 0名\nAmazonスケジュールとDAシフト表のTransportIDは一致しています。');
    } else {
      alert('🚨 TransportID不一致を検知しました\n\n一致 ' + matched.length + '名 / 不一致 ' + mismatched.length + '名\n詳細は点呼管理画面の赤いTransportID照合欄を確認してください。');
    }
  }

  function handleAmazonFile(file) {
    auditAmazonFile = file.name || 'Amazonスケジュール';
    readWorkbook(file, function(err, wb) {
      if (err) {
        alert('TransportID照合：Amazonスケジュール読込エラー\n' + err.message);
        return;
      }
      try {
        auditAmazon = parseAmazonSchedule(wb);
        compareNow();
      } catch(e) {
        alert('TransportID照合：Amazonスケジュール解析エラー\n' + e.message);
      }
    });
  }

  function handleShiftFile(file) {
    auditShiftFile = file.name || 'DAシフト表';
    readWorkbook(file, function(err, wb) {
      if (err) {
        alert('TransportID照合：DAシフト表読込エラー\n' + err.message);
        return;
      }
      try {
        auditShift = parseShiftMaster(wb);
        compareNow();
      } catch(e) {
        alert('TransportID照合：DAシフト表解析エラー\n' + e.message);
      }
    });
  }

  // capture phaseでinline onchangeより先にFile参照を確保する。
  document.addEventListener('change', function(e) {
    var target = e.target;
    if (!target || !target.files || !target.files.length) return;
    var file = target.files[0];
    if (target.id === 'shift-file-input') {
      handleAmazonFile(file);
    } else if (target.id === 'shift-master-input') {
      handleShiftFile(file);
    }
  }, true);

  function initPanel() {
    if (document.getElementById('panel-tenko')) renderWaiting();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPanel);
  } else {
    initPanel();
  }
})();
