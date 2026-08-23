// OFK3 点呼管理 - TransportID照合監査
// Amazonスケジュールを正として、DAシフト表メイン在籍者のTransport ID登録誤りを検知する。
(function() {
  'use strict';

  var auditAmazon = null;
  var auditShift = null;
  var auditAmazonFile = '';
  var auditShiftFile = '';
  var PANEL_ID = 'tenko-transport-audit-panel';
  var lastAuditStats = null;

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

  function namesMatch(nameA, nameB) {
    var variantsA = nameVariants(nameA);
    var variantsB = nameVariants(nameB);
    for (var i = 0; i < variantsA.length; i++) {
      for (var j = 0; j < variantsB.length; j++) {
        if (variantsA[i] === variantsB[j]) return true;
      }
    }
    return false;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function displayShiftName(record) {
    return record.japaneseName ? record.japaneseName + ' / ' + record.name : record.name;
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
    var personTids = {};
    var conflicts = [];

    for (var r = headerIndex + 1; r < bestRows.length; r++) {
      var rawName = String((bestRows[r] || [])[nameCol] || '').trim();
      var tid = normalizeTid((bestRows[r] || [])[tidCol]);
      var norm = normalizeName(rawName);
      if (!norm || !tid) continue;
      if (norm === '全記載' || norm === 'スケジュール済み合計') continue;

      var rec = {
        name: rawName,
        normalizedName: norm,
        transportId: tid,
        sheet: bestSheet,
        sourceRow: r + 1
      };
      records.push(rec);

      var personKey = norm;
      var variants = nameVariants(rawName);
      for (var vi = 0; vi < variants.length; vi++) {
        if (!personTids[variants[vi]]) personTids[variants[vi]] = {};
        personTids[variants[vi]][tid] = true;
      }

      for (var v = 0; v < variants.length; v++) {
        var key = variants[v];
        if (lookup[key] && lookup[key].transportId !== tid) {
          conflicts.push({
            name: rawName,
            normalizedName: norm,
            id1: lookup[key].transportId,
            id2: tid,
            row1: lookup[key].sourceRow,
            row2: rec.sourceRow
          });
        } else if (!lookup[key]) {
          lookup[key] = rec;
        }
      }
    }

    var amazonTidConflicts = [];
    var seenConflict = {};
    for (var ci = 0; ci < conflicts.length; ci++) {
      var c = conflicts[ci];
      var cKey = c.normalizedName + '|' + c.id1 + '|' + c.id2;
      if (seenConflict[cKey]) continue;
      seenConflict[cKey] = true;
      amazonTidConflicts.push(c);
    }

    return {
      records: records,
      lookup: lookup,
      conflicts: conflicts,
      amazonTidConflicts: amazonTidConflicts,
      personTids: personTids,
      sheet: bestSheet
    };
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
        sheet: sheetName,
        sourceRow: i + 1
      });
    }

    return { records: records, sheet: sheetName };
  }

  function buildShiftAuditPopulation(records) {
    var groups = [];

    for (var i = 0; i < records.length; i++) {
      var rec = records[i];
      var groupIndex = -1;
      for (var g = 0; g < groups.length; g++) {
        if (namesMatch(rec.name, groups[g].records[0].name)) {
          groupIndex = g;
          break;
        }
      }
      if (groupIndex >= 0) {
        groups[groupIndex].records.push(rec);
      } else {
        groups.push({ records: [rec] });
      }
    }

    var auditRecords = [];
    var shiftTidConflicts = [];
    var exactDuplicateRows = 0;

    for (var gi = 0; gi < groups.length; gi++) {
      var groupRecords = groups[gi].records;
      var tidMap = {};
      for (var j = 0; j < groupRecords.length; j++) {
        var tid = groupRecords[j].transportId;
        if (!tidMap[tid]) tidMap[tid] = [];
        tidMap[tid].push(groupRecords[j]);
      }

      var tids = Object.keys(tidMap);
      if (tids.length > 1) {
        var conflictEntry = {
          person: groupRecords[0],
          records: groupRecords.slice(),
          transportIds: tids.slice(),
          sourceRows: groupRecords.map(function(x) { return x.sourceRow; })
        };
        shiftTidConflicts.push(conflictEntry);
        auditRecords.push({
          name: groupRecords[0].name,
          japaneseName: groupRecords[0].japaneseName,
          company: groupRecords[0].company,
          normalizedName: groupRecords[0].normalizedName,
          transportId: groupRecords[0].transportId,
          sheet: groupRecords[0].sheet,
          sourceRow: groupRecords[0].sourceRow,
          isShiftTidConflict: true,
          shiftTransportIds: tids.slice(),
          sourceRows: groupRecords.map(function(x) { return x.sourceRow; }),
          rawRecords: groupRecords.slice()
        });
        continue;
      }

      var rows = tidMap[tids[0]];
      var merged = rows.length - 1;
      exactDuplicateRows += merged;
      auditRecords.push({
        name: rows[0].name,
        japaneseName: rows[0].japaneseName,
        company: rows[0].company,
        normalizedName: rows[0].normalizedName,
        transportId: rows[0].transportId,
        sheet: rows[0].sheet,
        sourceRow: rows[0].sourceRow,
        isShiftTidConflict: false,
        sourceRows: rows.map(function(x) { return x.sourceRow; }),
        rawRecords: rows.slice(),
        exactDuplicateMerged: merged
      });
    }

    return {
      rawShiftRows: records.length,
      auditRecords: auditRecords,
      shiftTidConflicts: shiftTidConflicts,
      exactDuplicateRows: exactDuplicateRows,
      uniqueShiftPeople: auditRecords.length,
      shiftTidConflictPeople: shiftTidConflicts.length
    };
  }

  function findAmazonRecord(shiftRecord, amazonData) {
    var variants = nameVariants(shiftRecord.name);
    var found = null;
    for (var v = 0; v < variants.length; v++) {
      if (amazonData.lookup[variants[v]]) {
        if (found && found.transportId !== amazonData.lookup[variants[v]].transportId) {
          return {
            conflict: true,
            name: found.name,
            normalizedName: found.normalizedName,
            transportIds: [found.transportId, amazonData.lookup[variants[v]].transportId],
            records: [found, amazonData.lookup[variants[v]]]
          };
        }
        found = amazonData.lookup[variants[v]];
      }
    }
    return found;
  }

  function getAmazonTidsForPerson(shiftRecord, amazonData) {
    var tids = {};
    var variants = nameVariants(shiftRecord.name);
    for (var v = 0; v < variants.length; v++) {
      var bucket = amazonData.personTids[variants[v]];
      if (bucket) {
        var keys = Object.keys(bucket);
        for (var k = 0; k < keys.length; k++) tids[keys[k]] = true;
      }
    }
    return Object.keys(tids);
  }

  function runTransportAudit(amazonData, shiftData) {
    var population = buildShiftAuditPopulation(shiftData.records);
    var matched = [];
    var mismatched = [];
    var amazonUnconfirmed = [];
    var shiftTidConflictResults = [];
    var usedAmazon = {};
    var amazonMatched = 0;

    for (var i = 0; i < population.auditRecords.length; i++) {
      var shiftRecord = population.auditRecords[i];

      if (shiftRecord.isShiftTidConflict) {
        var amazonForConflict = findAmazonRecord(shiftRecord, amazonData);
        var amazonTidsForPerson = getAmazonTidsForPerson(shiftRecord, amazonData);
        var amazonConflictForPerson = amazonTidsForPerson.length > 1;
        shiftTidConflictResults.push({
          shift: shiftRecord,
          amazon: amazonForConflict && !amazonForConflict.conflict ? amazonForConflict : null,
          shiftTransportIds: shiftRecord.shiftTransportIds,
          amazonTransportIds: amazonTidsForPerson,
          amazonTidConflict: amazonConflictForPerson
        });
        if (amazonForConflict && !amazonForConflict.conflict) {
          usedAmazon[normalizeName(amazonForConflict.name)] = true;
          amazonMatched++;
        } else if (amazonTidsForPerson.length > 0) {
          amazonMatched++;
          var lookupRec = findAmazonRecord({ name: shiftRecord.name }, amazonData);
          if (lookupRec && !lookupRec.conflict) usedAmazon[normalizeName(lookupRec.name)] = true;
        }
        continue;
      }

      var amazonRecord = findAmazonRecord(shiftRecord, amazonData);
      var personAmazonTids = getAmazonTidsForPerson(shiftRecord, amazonData);

      if (!amazonRecord) {
        amazonUnconfirmed.push({ shift: shiftRecord });
        continue;
      }

      if (amazonRecord.conflict || personAmazonTids.length > 1) {
        mismatched.push({
          shift: shiftRecord,
          amazon: amazonRecord.records ? amazonRecord.records[0] : amazonRecord,
          amazonTidConflict: true,
          amazonTransportIds: personAmazonTids.length > 1 ? personAmazonTids : amazonRecord.transportIds
        });
        usedAmazon[normalizeName(amazonRecord.normalizedName || (amazonRecord.name || shiftRecord.name))] = true;
        amazonMatched++;
        continue;
      }

      usedAmazon[normalizeName(amazonRecord.name)] = true;
      amazonMatched++;
      if (shiftRecord.transportId === amazonRecord.transportId) {
        matched.push({ shift: shiftRecord, amazon: amazonRecord });
      } else {
        mismatched.push({ shift: shiftRecord, amazon: amazonRecord });
      }
    }

    var amazonOnlyIgnored = 0;
    var countedAmazon = {};
    for (var a = 0; a < amazonData.records.length; a++) {
      var amz = amazonData.records[a];
      var amzKey = normalizeName(amz.name);
      if (usedAmazon[amzKey] || countedAmazon[amzKey]) continue;
      countedAmazon[amzKey] = true;
      amazonOnlyIgnored++;
    }

    var stats = {
      rawShiftRows: population.rawShiftRows,
      uniqueShiftPeople: population.uniqueShiftPeople,
      exactDuplicateRows: population.exactDuplicateRows,
      shiftTidConflictPeople: population.shiftTidConflictPeople,
      amazonRecordCount: amazonData.records.length,
      amazonMatched: amazonMatched,
      matched: matched.length,
      mismatched: mismatched.length,
      shiftOnly: amazonUnconfirmed.length,
      amazonOnlyIgnored: amazonOnlyIgnored,
      amazonTidConflicts: (amazonData.amazonTidConflicts || []).length
    };

    stats.auditEquationOk =
      stats.matched + stats.mismatched + stats.shiftOnly + stats.shiftTidConflictPeople === stats.uniqueShiftPeople;

    return {
      matched: matched,
      mismatched: mismatched,
      amazonUnconfirmed: amazonUnconfirmed,
      shiftTidConflicts: shiftTidConflictResults,
      amazonTidConflicts: amazonData.amazonTidConflicts || [],
      stats: stats,
      population: population
    };
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

  function renderSummaryLine(stats) {
    var line = '一致 ' + stats.matched + '名 / 不一致 ' + stats.mismatched + '名 / Amazon側未確認 ' + stats.shiftOnly + '名';
    if (stats.shiftTidConflictPeople > 0) {
      line += ' / シフト内TID重複 ' + stats.shiftTidConflictPeople + '名';
    }
    if (stats.amazonTidConflicts > 0) {
      line += ' / Amazon側TID競合 ' + stats.amazonTidConflicts + '名';
    }
    return line;
  }

  function compareNow() {
    if (!auditAmazon || !auditShift) {
      renderWaiting();
      return;
    }

    var result = runTransportAudit(auditAmazon, auditShift);
    lastAuditStats = result.stats;
    window.__tenkoTransportAuditStats = result.stats;
    renderResult(result);
  }

  function renderResult(result) {
    var panel = getPanel();
    var matched = result.matched;
    var mismatched = result.mismatched;
    var amazonUnconfirmed = result.amazonUnconfirmed;
    var shiftTidConflicts = result.shiftTidConflicts;
    var amazonTidConflicts = result.amazonTidConflicts;
    var stats = result.stats;

    var hasProblems = mismatched.length > 0 ||
      shiftTidConflicts.length > 0 ||
      amazonTidConflicts.length > 0;

    panel.className = hasProblems
      ? 'card p-4 mb-4 border-2 border-red-500 bg-red-50'
      : 'card p-4 mb-4 border-2 border-emerald-400 bg-emerald-50';

    var html = '';
    if (hasProblems) {
      html += '<div class="text-base font-bold text-red-700">🚨 TransportID照合：不一致あり</div>';
      html += '<div class="text-sm font-bold text-red-700 mt-1">' + escapeHtml(renderSummaryLine(stats)) + '</div>';
      html += '<div class="text-xs font-bold text-red-700 mt-1">Amazonスケジュールを正として確認してください。シフト側のTransportID誤登録は、点呼対象者の誤認識やコンプライアンス判定へ影響する可能性があります。</div>';
    } else {
      html += '<div class="text-base font-bold text-emerald-700">✅ TransportID照合：一致</div>';
      html += '<div class="text-sm font-bold text-emerald-700 mt-1">' + escapeHtml(renderSummaryLine(stats)) + '</div>';
      html += '<div class="text-xs text-emerald-700 mt-1">Amazonスケジュールで確認できたシフト登録者のTransportIDはすべて一致しています。</div>';
    }

    if (stats.exactDuplicateRows > 0) {
      html += '<div class="text-xs text-ink-light mt-1">完全重複統合：' + stats.exactDuplicateRows + '行（raw ' + stats.rawShiftRows + '行 → ユニーク ' + stats.uniqueShiftPeople + '名）</div>';
    }

    if (shiftTidConflicts.length > 0) {
      html += '<div class="mt-3 space-y-2">';
      for (var sc = 0; sc < shiftTidConflicts.length; sc++) {
        var conflict = shiftTidConflicts[sc];
        var shiftRec = conflict.shift;
        html += '<div class="rounded-lg border border-red-400 bg-white p-3">' +
          '<div class="font-bold text-red-700">🚨 シフト表内TransportID重複</div>' +
          '<div class="font-bold text-red-700 mt-1">' + escapeHtml(displayShiftName(shiftRec)) + '</div>' +
          '<div class="text-xs text-red-700 mt-1">シフト登録：<span class="font-mono font-bold">' + escapeHtml(conflict.shiftTransportIds.join(' / ')) + '</span></div>';
        if (conflict.amazon) {
          html += '<div class="text-xs text-red-700">Amazon正：<span class="font-mono font-bold">' + escapeHtml(conflict.amazon.transportId) + '</span></div>';
        } else if (conflict.amazonTransportIds && conflict.amazonTransportIds.length > 0) {
          html += '<div class="text-xs text-red-700">Amazon正：<span class="font-mono font-bold">' + escapeHtml(conflict.amazonTransportIds.join(' / ')) + '</span></div>';
        }
        html += '<div class="text-xs text-red-600 mt-1">同一人物に複数TransportIDが登録されています。</div>' +
          '</div>';
      }
      html += '</div>';
    }

    if (mismatched.length > 0) {
      html += '<div class="mt-3 space-y-2">';
      for (var i = 0; i < mismatched.length; i++) {
        var m = mismatched[i];
        html += '<div class="rounded-lg border border-red-300 bg-white p-3">' +
          '<div class="font-bold text-red-700">🚨 TransportID不一致</div>' +
          '<div class="font-bold text-red-700 mt-1">' + escapeHtml(displayShiftName(m.shift)) + '</div>' +
          '<div class="text-xs text-red-700 mt-1">Amazon正：<span class="font-mono font-bold">' + escapeHtml(m.amazon.transportId) + '</span></div>' +
          '<div class="text-xs text-red-700">シフト登録：<span class="font-mono font-bold">' + escapeHtml(m.shift.transportId) + '</span></div>';
        if (m.amazonTidConflict && m.amazonTransportIds) {
          html += '<div class="text-xs text-red-700">Amazon側TID競合：<span class="font-mono font-bold">' + escapeHtml(m.amazonTransportIds.join(' / ')) + '</span></div>';
        }
        if (m.shift.company) {
          html += '<div class="text-xs text-red-600 mt-1">所属：' + escapeHtml(m.shift.company) + '</div>';
        }
        html += '</div>';
      }
      html += '</div>';
    }

    if (amazonUnconfirmed.length > 0) {
      html += '<div class="mt-3 space-y-2">';
      for (var u = 0; u < amazonUnconfirmed.length; u++) {
        var unconfirmed = amazonUnconfirmed[u].shift;
        html += '<div class="rounded-lg border border-amber-300 bg-amber-50 p-3">' +
          '<div class="font-bold text-amber-800">⚠ Amazon側未確認</div>' +
          '<div class="text-xs text-amber-800 mt-1">' + escapeHtml(displayShiftName(unconfirmed)) + '</div>' +
          '<div class="text-xs text-amber-700 mt-1">シフト登録：<span class="font-mono font-bold">' + escapeHtml(unconfirmed.transportId) + '</span></div>' +
          (unconfirmed.company ? '<div class="text-xs text-amber-700 mt-1">所属：' + escapeHtml(unconfirmed.company) + '</div>' : '') +
          '</div>';
      }
      html += '</div>';
    }

    if (amazonTidConflicts.length > 0) {
      html += '<div class="mt-3 space-y-2">';
      html += '<div class="text-xs font-bold text-red-700">⚠ Amazon側TransportID競合：' + amazonTidConflicts.length + '件</div>';
      for (var ac = 0; ac < Math.min(amazonTidConflicts.length, 20); ac++) {
        var amzC = amazonTidConflicts[ac];
        html += '<div class="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">' +
          escapeHtml(amzC.name) + '：' + escapeHtml(amzC.id1) + ' / ' + escapeHtml(amzC.id2) +
          '</div>';
      }
      html += '</div>';
    }

    if (matched.length > 0) {
      html += '<details class="mt-3"><summary class="text-xs font-bold text-emerald-700 cursor-pointer">✅ TransportID一致（' + matched.length + '名）</summary>';
      html += '<div class="mt-2 space-y-1">';
      for (var m2 = 0; m2 < Math.min(matched.length, 50); m2++) {
        html += '<div class="text-xs text-emerald-700">✅ ' + escapeHtml(displayShiftName(matched[m2].shift)) + ' / ' + escapeHtml(matched[m2].shift.transportId) + '</div>';
      }
      if (matched.length > 50) html += '<div class="text-xs text-emerald-700">...他 ' + (matched.length - 50) + '名</div>';
      html += '</div></details>';
    }

    panel.innerHTML = html;
    mirrorToTenkoMatch(panel);
  }

  function mirrorToTenkoMatch(panel) {
    var matchPanel = document.getElementById('panel-tenko-match');
    if (!matchPanel) return;
    var mirror = document.getElementById('tenko-transport-audit-mirror');
    if (!mirror) {
      mirror = document.createElement('div');
      mirror.id = 'tenko-transport-audit-mirror';
      matchPanel.insertBefore(mirror, matchPanel.firstChild);
    }
    mirror.className = panel.className;
    mirror.innerHTML = panel.innerHTML;
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

  window.__tenkoTransportAudit = {
    normalizeName: normalizeName,
    normalizeTid: normalizeTid,
    nameVariants: nameVariants,
    namesMatch: namesMatch,
    parseAmazonSchedule: parseAmazonSchedule,
    parseShiftMaster: parseShiftMaster,
    buildShiftAuditPopulation: buildShiftAuditPopulation,
    runTransportAudit: runTransportAudit,
    getLastAuditStats: function() { return lastAuditStats; }
  };
})();
