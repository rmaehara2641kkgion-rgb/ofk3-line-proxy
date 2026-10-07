/**
 * OFK3 エリア経験DB — Snapshot Layer + Experience Event Layer（純粋関数・UI/GAS非依存）
 *
 * Snapshot Layer:
 *   外部週次ツールの累積XLSX（areaExperience + importHistory）。rawRows は1行も捨てず
 *   読み取り専用で保持する。累積値（experienceDays / primaryCount / splitCount /
 *   rescueCount / stops / packages / confidence / lastVisitDate）は再計算しない。
 *   snapshotThroughDate は importHistory の max(dateTo) から取得・検証する（固定値なし）。
 *
 * Experience Event Layer:
 *   serviceDate + routeCode 単位の取得情報（最新状態で上書き）から
 *   TransportID + normalizedArea + serviceDate の一意な経験イベントを再構築する。
 *
 * 結合:
 *   experienceDays = snapshotExperienceDays + (serviceDate > snapshotThroughDate のユニーク日数)
 *   lastVisitDate  = max(snapshotLastVisitDate, eventLastVisitDate)
 *   出力は従来どおり byTransportId[tid].areas[area] 形式（アサイン評価ロジックは無変更で利用）。
 *
 * エリア抽出・正規化は assign-support-core.js の extractAreaLabelsFromAddresses /
 * normalizeAreaToken を再利用する（独自変換は持たない）。
 */
(function (global) {
  'use strict';

  var Core =
    global.AssignSupportCore ||
    (typeof require === 'function' ? require('./assign-support-core.js') : null);

  var AREA_SHEET_NAME = 'areaexperience';
  var HISTORY_SHEET_NAME = 'importhistory';

  var HISTORY_COLUMNS = {
    weekKey: ['weekkey', 'week'],
    dateFrom: ['datefrom', 'from'],
    dateTo: ['dateto', 'to'],
    importedAt: ['importedat'],
    sourceFingerprint: ['sourcefingerprint', 'fingerprint'],
    rowCount: ['rowcount'],
    source: ['source', 'sourcefile'],
  };

  // ===== 日付ユーティリティ =====

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function isValidYmd(y, m, d) {
    if (m < 1 || m > 12 || d < 1 || d > 31) return false;
    var dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }

  /** 'YYYY-MM-DD' / 'YYYY/M/D' / Date / Excelシリアル値 → 'YYYY-MM-DD'（解析不能は ''） */
  function toIsoDate(value) {
    if (value == null || value === '') return '';
    if (value instanceof Date) {
      if (isNaN(value.getTime())) return '';
      return value.getUTCFullYear() + '-' + pad2(value.getUTCMonth() + 1) + '-' + pad2(value.getUTCDate());
    }
    if (typeof value === 'number') {
      if (!isFinite(value) || value <= 0) return '';
      return toIsoDate(new Date(Math.round((value - 25569) * 86400000)));
    }
    var m = String(value).trim().match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})(?:$|[T\s])/);
    if (!m) return '';
    var y = Number(m[1]);
    var mo = Number(m[2]);
    var d = Number(m[3]);
    if (!isValidYmd(y, mo, d)) return '';
    return y + '-' + pad2(mo) + '-' + pad2(d);
  }

  function addDays(isoDate, days) {
    var p = isoDate.split('-');
    var dt = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]) + days));
    return dt.getUTCFullYear() + '-' + pad2(dt.getUTCMonth() + 1) + '-' + pad2(dt.getUTCDate());
  }

  function maxIso(a, b) {
    return !a ? b || '' : !b ? a : a > b ? a : b;
  }

  // ===== 氏名正規化（安全な表記ゆれのみ） =====

  /**
   * 全角半角(NFKC)・前後空白・連続空白・姓名間スペース有無・大文字小文字のみ吸収。
   * 部分一致・類似度・姓名入替は行わない。
   */
  function normalizeDriverNameForMatch(name) {
    var s = String(name == null ? '' : name);
    if (typeof s.normalize === 'function') s = s.normalize('NFKC');
    return s.replace(/[\s　]+/g, '').toLowerCase();
  }

  // 一意解決時の resolutionMethod（同一TIDに複数経路がある場合は先頭を採用）
  var RESOLUTION_METHOD_ORDER = ['exact_name', 'master_japanese_name', 'alias'];

  function isNameReversalOf(a, b) {
    var pa = String(a || '').trim().split(/[\s　]+/);
    var pb = String(b || '').trim().split(/[\s　]+/);
    if (pa.length !== 2 || pb.length !== 2) return false;
    return normalizeDriverNameForMatch(pa[1] + pa[0]) === normalizeDriverNameForMatch(pb[0] + pb[1]);
  }

  /**
   * ドライバーマスタから 正規化氏名 → TransportID候補 の索引を作る。
   *   transportIDs        : {masterName: tid}                  → exact_name
   *   driverJapaneseNames : {masterName: jpName}               → master_japanese_name
   *   driverNameAliases   : {alias: canonicalMasterName}       → alias
   * alias は「正キーが transportIDs 上で空でないTIDに明示的に紐付く」場合のみ使う。
   * resolveDriverKey の姓名入替で自動登録されたと判別できる alias（正キーの姓名入替と同一）は使わない。
   */
  function buildDriverNameIndex(transportIDs, driverJapaneseNames, driverNameAliases) {
    var byKey = {};
    var noTidByKey = {};
    var excludedAliases = [];
    transportIDs = transportIDs || {};
    driverJapaneseNames = driverJapaneseNames || {};
    driverNameAliases = driverNameAliases || {};

    function add(nameForMatch, masterName, tid, method) {
      var key = normalizeDriverNameForMatch(nameForMatch);
      if (!key) return;
      if (!tid) {
        if (!noTidByKey[key]) noTidByKey[key] = { masterNames: [], methods: [] };
        if (noTidByKey[key].masterNames.indexOf(masterName) < 0) noTidByKey[key].masterNames.push(masterName);
        if (noTidByKey[key].methods.indexOf(method) < 0) noTidByKey[key].methods.push(method);
        return;
      }
      if (!byKey[key]) byKey[key] = {};
      if (!byKey[key][tid]) byKey[key][tid] = { masterNames: [], methods: [] };
      var slot = byKey[key][tid];
      if (slot.masterNames.indexOf(masterName) < 0) slot.masterNames.push(masterName);
      if (slot.methods.indexOf(method) < 0) slot.methods.push(method);
    }

    var names = Object.keys(transportIDs);
    for (var i = 0; i < names.length; i++) {
      var masterName = names[i];
      var tid = String(transportIDs[masterName] || '').trim();
      add(masterName, masterName, tid, 'exact_name');
      var jp = driverJapaneseNames[masterName];
      if (jp) add(jp, masterName, tid, 'master_japanese_name');
    }
    var jpKeys = Object.keys(driverJapaneseNames);
    for (var j = 0; j < jpKeys.length; j++) {
      if (Object.prototype.hasOwnProperty.call(transportIDs, jpKeys[j])) continue;
      add(driverJapaneseNames[jpKeys[j]], jpKeys[j], '', 'master_japanese_name');
    }
    var aliasKeys = Object.keys(driverNameAliases);
    for (var a = 0; a < aliasKeys.length; a++) {
      var alias = aliasKeys[a];
      var canonical = driverNameAliases[alias];
      if (!Object.prototype.hasOwnProperty.call(transportIDs, canonical)) {
        excludedAliases.push({ alias: alias, canonical: canonical, reason: 'canonical_not_in_master' });
        continue;
      }
      var aliasTid = String(transportIDs[canonical] || '').trim();
      if (!aliasTid) {
        excludedAliases.push({ alias: alias, canonical: canonical, reason: 'canonical_has_no_transport_id' });
        continue;
      }
      if (isNameReversalOf(alias, canonical)) {
        excludedAliases.push({ alias: alias, canonical: canonical, reason: 'name_reversal_alias' });
        continue;
      }
      add(alias, canonical, aliasTid, 'alias');
    }
    return { byKey: byKey, noTidByKey: noTidByKey, excludedAliases: excludedAliases };
  }

  /**
   * 1氏名 → { transportId, resolutionMethod } または { reason, candidates }。
   * 優先順位: exact_name → master_japanese_name → alias → unresolved。
   * 上位の段で一意なら確定（下位の段は見ない）。上位の段で複数候補、または上位の段に
   * TransportID未登録のマスタ行がある場合は、下位（alias等）へ進まず未解決にする。
   */
  function resolveTransportIdByExactName(name, nameIndex) {
    var key = normalizeDriverNameForMatch(name);
    if (!key) return { transportId: '', resolutionMethod: 'unresolved', reason: 'empty_name', candidates: [] };
    var hit = nameIndex.byKey[key] || {};
    var noTid = nameIndex.noTidByKey[key] || null;
    var allTids = Object.keys(hit);
    var toCandidate = function (t) {
      return { transportId: t, masterNames: hit[t].masterNames, methods: hit[t].methods };
    };
    for (var i = 0; i < RESOLUTION_METHOD_ORDER.length; i++) {
      var method = RESOLUTION_METHOD_ORDER[i];
      var tierTids = allTids.filter(function (t) {
        return hit[t].methods.indexOf(method) >= 0;
      });
      if (tierTids.length === 1) {
        return {
          transportId: tierTids[0],
          resolutionMethod: method,
          reason: '',
          candidates: [toCandidate(tierTids[0])],
          lowerTierCandidates: allTids
            .filter(function (t) {
              return t !== tierTids[0];
            })
            .map(toCandidate),
        };
      }
      if (tierTids.length > 1) {
        return { transportId: '', resolutionMethod: 'unresolved', reason: 'multiple_candidates', candidates: tierTids.map(toCandidate) };
      }
      if (noTid && noTid.methods.indexOf(method) >= 0) {
        return {
          transportId: '',
          resolutionMethod: 'unresolved',
          reason: 'master_has_no_transport_id',
          candidates: noTid.masterNames.map(function (n) {
            return { transportId: '', masterNames: [n], methods: [method] };
          }),
        };
      }
    }
    return { transportId: '', resolutionMethod: 'unresolved', reason: 'not_in_master', candidates: [] };
  }

  // ===== XLSX 全シート解析 =====

  function normalizeSheetName(name) {
    return String(name || '')
      .toLowerCase()
      .replace(/[\s_\-]/g, '');
  }

  function findSheetName(sheetNames, target) {
    for (var i = 0; i < sheetNames.length; i++) {
      if (normalizeSheetName(sheetNames[i]) === target) return sheetNames[i];
    }
    return '';
  }

  function parseImportHistoryRows(rows) {
    if (!rows || rows.length < 1) return [];
    var headers = rows[0].map(function (h) {
      return normalizeSheetName(h);
    });
    var idx = {};
    for (var field in HISTORY_COLUMNS) {
      for (var i = 0; i < headers.length; i++) {
        if (HISTORY_COLUMNS[field].indexOf(headers[i]) >= 0) {
          idx[field] = i;
          break;
        }
      }
    }
    var out = [];
    for (var r = 1; r < rows.length; r++) {
      var row = rows[r];
      if (!row || !row.some(function (c) { return String(c == null ? '' : c).trim() !== ''; })) continue;
      var get = function (f) {
        return idx[f] === undefined ? '' : row[idx[f]];
      };
      out.push({
        weekKey: String(get('weekKey') == null ? '' : get('weekKey')).trim(),
        dateFromRaw: get('dateFrom'),
        dateToRaw: get('dateTo'),
        dateFrom: toIsoDate(get('dateFrom')),
        dateTo: toIsoDate(get('dateTo')),
        importedAt: String(get('importedAt') == null ? '' : get('importedAt')).trim(),
        sourceFingerprint: String(get('sourceFingerprint') == null ? '' : get('sourceFingerprint')).trim(),
        rowCount: Number(get('rowCount')) || 0,
        source: String(get('source') == null ? '' : get('source')).trim(),
        rawRow: row.slice(),
      });
    }
    return out;
  }

  /**
   * XLSX workbook（SheetJS）→ areaExperience / importHistory の生データ。
   * areaExperience シートが名前で見つからない場合は先頭シート（従来の取込と同じ）を使う。
   */
  function parseExperienceWorkbook(workbook, xlsxLib, options) {
    options = options || {};
    if (!workbook || !workbook.SheetNames || !workbook.SheetNames.length) {
      return { ok: false, error: 'シートがありません' };
    }
    var X = xlsxLib || global.XLSX;
    if (!X || !X.utils) return { ok: false, error: 'XLSXライブラリがありません' };

    var sheetNames = workbook.SheetNames.slice();
    var areaSheet = findSheetName(sheetNames, AREA_SHEET_NAME) || sheetNames[0];
    var historySheet = findSheetName(sheetNames, HISTORY_SHEET_NAME);
    var toRows = function (name) {
      return X.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: '' });
    };
    var areaRows = toRows(areaSheet);
    var historyRows = historySheet ? toRows(historySheet) : [];

    return {
      ok: true,
      sourceFile: options.fileName || '',
      sheetNames: sheetNames,
      areaSheetName: areaSheet,
      historySheetName: historySheet,
      areaRows: areaRows,
      importHistory: parseImportHistoryRows(historyRows),
      hasImportHistory: !!historySheet,
    };
  }

  // ===== importHistory 検証 =====

  function detectImportHistoryPeriods(importHistory) {
    var entries = (importHistory || [])
      .filter(function (h) {
        return !!h.dateTo;
      })
      .slice()
      .sort(function (a, b) {
        return a.dateTo < b.dateTo ? -1 : a.dateTo > b.dateTo ? 1 : 0;
      });
    var missingPeriods = [];
    var overlaps = [];
    var unverifiable = [];
    for (var i = 1; i < entries.length; i++) {
      var prev = entries[i - 1];
      var cur = entries[i];
      if (!cur.dateFrom) {
        unverifiable.push({ weekKey: cur.weekKey, reason: 'dateFrom_missing' });
        continue;
      }
      var expected = addDays(prev.dateTo, 1);
      if (cur.dateFrom > expected) {
        missingPeriods.push({
          from: expected,
          to: addDays(cur.dateFrom, -1),
          afterWeekKey: prev.weekKey,
          beforeWeekKey: cur.weekKey,
        });
      } else if (cur.dateFrom <= prev.dateTo) {
        overlaps.push({ weekKeyA: prev.weekKey, weekKeyB: cur.weekKey, from: cur.dateFrom, to: prev.dateTo });
      }
    }
    return { missingPeriods: missingPeriods, overlaps: overlaps, unverifiable: unverifiable };
  }

  // ===== Snapshot Layer =====

  function toRecordFromRow(row, cols, tid) {
    // assign-support-core.js parseExperienceRows と同一の値変換（既存表示との互換）
    return {
      transportId: tid,
      driverName: cols.driverName !== undefined ? String(row[cols.driverName] || '').trim() : '',
      area: String(row[cols.area] || '').trim(),
      experienceDays: Number(row[cols.experienceDays]),
      lastVisitDate: cols.lastVisitDate !== undefined ? String(row[cols.lastVisitDate] || '').trim() : '',
      stops: cols.stops !== undefined ? Number(row[cols.stops]) || 0 : 0,
      packages: cols.packages !== undefined ? Number(row[cols.packages]) || 0 : 0,
      primaryCount: cols.primaryCount !== undefined ? Number(row[cols.primaryCount]) || 0 : 0,
      splitCount: cols.splitCount !== undefined ? Number(row[cols.splitCount]) || 0 : 0,
      rescueCount: cols.rescueCount !== undefined ? Number(row[cols.rescueCount]) || 0 : 0,
      confidence: cols.confidence !== undefined ? String(row[cols.confidence] || '').trim() : '',
    };
  }

  /**
   * parseExperienceWorkbook の結果 → Snapshot Layer。
   * options: { transportIDs, driverJapaneseNames, sourceFile }
   * rawRows は入力のまま（コピー）保持し、一切書き換えない。
   */
  function buildSnapshotLayer(parsed, options) {
    options = options || {};
    var errors = [];
    var warnings = [];
    var areaRows = (parsed && parsed.areaRows) || [];
    if (areaRows.length < 2) {
      return { ok: false, errors: ['areaExperience のデータ行がありません'] };
    }
    var header = areaRows[0].map(function (h) {
      return String(h == null ? '' : h).trim();
    });
    var cols = Core.mapExperienceColumns(header);
    if (cols.transportId === undefined) errors.push('TransportID列が見つかりません');
    if (cols.area === undefined) errors.push('area列が見つかりません');
    if (cols.experienceDays === undefined) errors.push('experienceDays列が見つかりません');
    if (errors.length) return { ok: false, errors: errors };

    var rawRows = areaRows.slice(1).map(function (r) {
      return Array.isArray(r) ? r.slice() : [];
    });

    // --- importHistory / snapshotThroughDate ---
    var importHistory = (parsed && parsed.importHistory) || [];
    if (!parsed || !parsed.hasImportHistory) errors.push('importHistory シートがありません（snapshotThroughDate を決定できません）');
    else if (!importHistory.length) errors.push('importHistory に行がありません');
    var unparsedDateTo = importHistory.filter(function (h) {
      return !h.dateTo;
    });
    if (unparsedDateTo.length) {
      errors.push(
        'importHistory.dateTo を日付として解析できない行があります: ' +
          unparsedDateTo
            .map(function (h) {
              return (h.weekKey || '?') + '=' + String(h.dateToRaw);
            })
            .join(', ')
      );
    }
    var maxDateTo = '';
    for (var h = 0; h < importHistory.length; h++) maxDateTo = maxIso(maxDateTo, importHistory[h].dateTo);
    var periods = detectImportHistoryPeriods(importHistory);
    if (periods.missingPeriods.length) {
      warnings.push(
        '経験データ欠損期間: ' +
          periods.missingPeriods
            .map(function (p) {
              return p.from + '〜' + p.to;
            })
            .join(', ')
      );
    }
    if (periods.overlaps.length) warnings.push('importHistory の期間重複: ' + periods.overlaps.length + '件');

    // --- 氏名→TID 安全解決（TransportID空欄行のみ） ---
    var fileTidSet = {};
    var blankNameRows = {};
    var blankTidRowCount = 0;
    for (var r0 = 0; r0 < rawRows.length; r0++) {
      var row0 = rawRows[r0];
      var tid0 = String(row0[cols.transportId] || '').trim();
      if (tid0) {
        fileTidSet[tid0] = true;
        continue;
      }
      blankTidRowCount++;
      var nm0 = cols.driverName !== undefined ? String(row0[cols.driverName] || '').trim() : '';
      if (!blankNameRows[nm0]) blankNameRows[nm0] = [];
      blankNameRows[nm0].push(r0);
    }
    var nameIndex = buildDriverNameIndex(options.transportIDs, options.driverJapaneseNames, options.driverNameAliases);
    var resolvedByName = {};
    var unresolvedDrivers = [];
    var tidClaims = {};
    var blankNames = Object.keys(blankNameRows);
    // fixedResolution: 登録時に確定した解決結果（GAS保存値）。再読込時はマスタ変化に左右されずこれを使う。
    var fixed = options.fixedResolution || null;
    for (var b = 0; b < blankNames.length; b++) {
      var res;
      if (fixed) {
        var fx = fixed[blankNames[b]];
        res = fx && fx.transportId
          ? { transportId: fx.transportId, resolutionMethod: fx.resolutionMethod || 'exact_name', reason: '', candidates: [{ transportId: fx.transportId, masterNames: fx.masterNames || [], methods: [] }] }
          : { transportId: '', resolutionMethod: 'unresolved', reason: (fx && fx.reason) || 'not_in_master', candidates: (fx && fx.candidates) || [] };
      } else {
        res = resolveTransportIdByExactName(blankNames[b], nameIndex);
      }
      if (res.transportId && fileTidSet[res.transportId]) {
        res = { transportId: '', resolutionMethod: 'unresolved', reason: 'tid_already_in_snapshot', candidates: res.candidates };
      }
      if (res.transportId) {
        if (!tidClaims[res.transportId]) tidClaims[res.transportId] = [];
        tidClaims[res.transportId].push(blankNames[b]);
      }
      resolvedByName[blankNames[b]] = res;
    }
    // 別名義の複数氏名が同一TIDへ解決される場合は誤紐付けの恐れがあるため全員未解決
    Object.keys(tidClaims).forEach(function (t) {
      if (tidClaims[t].length > 1) {
        tidClaims[t].forEach(function (nm) {
          resolvedByName[nm] = {
            transportId: '',
            resolutionMethod: 'unresolved',
            reason: 'tid_shared_by_multiple_names',
            candidates: [{ transportId: t, masterNames: tidClaims[t].slice(), methods: [] }],
          };
        });
      }
    });

    // --- records（既存と同一形状） + 行メタ ---
    var records = [];
    var recordMeta = [];
    var invalidRows = [];
    var maxLastVisit = '';
    var unparsedLastVisit = 0;
    var areaSetByName = {};
    var latestByName = {};
    for (var r = 0; r < rawRows.length; r++) {
      var row = rawRows[r];
      var fileTid = String(row[cols.transportId] || '').trim();
      var area = String(row[cols.area] || '').trim();
      var lv = cols.lastVisitDate !== undefined ? row[cols.lastVisitDate] : '';
      var lvIso = toIsoDate(lv);
      if (lv !== '' && lv != null && !lvIso) unparsedLastVisit++;
      maxLastVisit = maxIso(maxLastVisit, lvIso);

      var tid = fileTid;
      var tidSource = 'file';
      if (!fileTid) {
        var nm = cols.driverName !== undefined ? String(row[cols.driverName] || '').trim() : '';
        if (!areaSetByName[nm]) areaSetByName[nm] = {};
        if (area) areaSetByName[nm][area] = true;
        latestByName[nm] = maxIso(latestByName[nm] || '', lvIso);
        var rr = resolvedByName[nm];
        tid = rr && rr.transportId ? rr.transportId : '';
        tidSource = tid ? 'name' : 'unresolved';
      }
      var days = Number(row[cols.experienceDays]);
      if (!area || !isFinite(days) || days < 0) {
        invalidRows.push({ rowIndex: r, reason: !area ? 'area_empty' : 'experienceDays_invalid' });
        continue;
      }
      if (!tid) continue;
      records.push(toRecordFromRow(row, cols, tid));
      recordMeta.push({ rowIndex: r, tidSource: tidSource, fileTransportId: fileTid });
    }

    Object.keys(resolvedByName).forEach(function (nm) {
      var rr2 = resolvedByName[nm];
      if (rr2.transportId) return;
      unresolvedDrivers.push({
        driverName: nm,
        reason: rr2.reason,
        resolutionMethod: 'unresolved',
        rowCount: blankNameRows[nm].length,
        areaCount: Object.keys(areaSetByName[nm] || {}).length,
        latestLastVisitDate: latestByName[nm] || '',
        candidateTransportIds: rr2.candidates.map(function (c) {
          return c.transportId;
        }),
        candidates: rr2.candidates,
      });
    });
    unresolvedDrivers.sort(function (a, b2) {
      return b2.rowCount - a.rowCount;
    });

    var resolvedDrivers = Object.keys(resolvedByName)
      .filter(function (nm) {
        return !!resolvedByName[nm].transportId;
      })
      .map(function (nm) {
        return {
          driverName: nm,
          resolvedTransportId: resolvedByName[nm].transportId,
          resolutionMethod: resolvedByName[nm].resolutionMethod,
          masterNames: resolvedByName[nm].candidates[0].masterNames,
          rowCount: blankNameRows[nm].length,
          areaCount: Object.keys(areaSetByName[nm] || {}).length,
          latestLastVisitDate: latestByName[nm] || '',
        };
      });
    var resolution = {};
    Object.keys(resolvedByName).forEach(function (nm) {
      var rv = resolvedByName[nm];
      resolution[nm] = rv.transportId
        ? { transportId: rv.transportId, resolutionMethod: rv.resolutionMethod, masterNames: rv.candidates[0].masterNames }
        : { transportId: '', resolutionMethod: 'unresolved', reason: rv.reason, candidates: rv.candidates };
    });
    var methodCounts = {};
    resolvedDrivers.forEach(function (d) {
      methodCounts[d.resolutionMethod] = (methodCounts[d.resolutionMethod] || 0) + 1;
    });

    // --- TransportID + area 重複（統合しない・警告のみ） ---
    var seen = {};
    var duplicates = [];
    for (var k = 0; k < records.length; k++) {
      var dk = records[k].transportId + '|' + records[k].area;
      if (seen[dk] === undefined) seen[dk] = k;
      else duplicates.push({ transportId: records[k].transportId, area: records[k].area, rowIndexes: [recordMeta[seen[dk]].rowIndex, recordMeta[k].rowIndex] });
    }
    if (duplicates.length) warnings.push('TransportID+area 重複 ' + duplicates.length + '件（統合せず、従来どおり後の行を表示に使用）');
    if (blankTidRowCount) warnings.push('TransportID空欄 ' + blankTidRowCount + '行（氏名照合: 解決 ' + resolvedDrivers.length + '名 / 未解決 ' + unresolvedDrivers.length + '名）');
    if (invalidRows.length) warnings.push('area空欄 または experienceDays 不正の行 ' + invalidRows.length + '行（経験計算対象外・rawRowsには保持）');
    if (unparsedLastVisit) warnings.push('lastVisitDate を日付として解析できない行 ' + unparsedLastVisit + '行');

    if (maxDateTo && maxLastVisit && maxLastVisit > maxDateTo) {
      errors.push('lastVisitDate の最大値 ' + maxLastVisit + ' が importHistory.dateTo の最大値 ' + maxDateTo + ' より後です');
    } else if (maxDateTo && maxLastVisit && maxLastVisit < maxDateTo) {
      warnings.push('lastVisitDate の最大値 ' + maxLastVisit + ' は importHistory.dateTo の最大値 ' + maxDateTo + ' より前です');
    }

    var ok = errors.length === 0;
    return {
      ok: ok,
      errors: errors,
      warnings: warnings,
      sourceFile: options.sourceFile || (parsed && parsed.sourceFile) || '',
      header: header,
      columns: cols,
      rawRows: rawRows,
      importHistory: importHistory,
      snapshotThroughDate: ok ? maxDateTo : '',
      records: records,
      recordMeta: recordMeta,
      resolvedDrivers: resolvedDrivers,
      unresolvedDrivers: unresolvedDrivers,
      resolution: resolution,
      resolutionSummary: {
        fileTransportIdDriverCount: Object.keys(fileTidSet).length,
        blankTidDriverCount: blankNames.length,
        blankTidRowCount: blankTidRowCount,
        resolvedCount: resolvedDrivers.length,
        resolvedRowCount: resolvedDrivers.reduce(function (acc, d) {
          return acc + d.rowCount;
        }, 0),
        unresolvedCount: unresolvedDrivers.length,
        methodCounts: methodCounts,
        usedFixedResolution: !!fixed,
      },
      excludedAliases: nameIndex.excludedAliases,
      validation: {
        maxDateTo: maxDateTo,
        maxLastVisitDate: maxLastVisit,
        missingPeriods: periods.missingPeriods,
        overlaps: periods.overlaps,
        unverifiablePeriods: periods.unverifiable,
        duplicates: duplicates,
        rawRowCount: rawRows.length,
        blankTidRowCount: blankTidRowCount,
        fileTransportIdCount: Object.keys(fileTidSet).length,
        invalidRowCount: invalidRows.length,
        unparsedLastVisitCount: unparsedLastVisit,
      },
    };
  }

  // ===== Experience Event Layer =====

  function routeCaptureKey(serviceDate, routeCode) {
    return serviceDate + '|' + routeCode;
  }

  /**
   * Cortex等のルート取得結果 → 正規化した serviceDate+routeCode 単位の取得情報。
   * エリアは extractAreaLabelsFromAddresses（既存）でのみ求める。
   */
  function normalizeRouteCapture(capture) {
    capture = capture || {};
    var serviceDate = toIsoDate(capture.serviceDate);
    var routeCode = String(capture.routeCode || '').trim();
    var transporterId = String(capture.transporterId || '').trim();
    if (!serviceDate) return { ok: false, reason: 'serviceDate_invalid' };
    if (!routeCode) return { ok: false, reason: 'routeCode_missing' };
    var labels = Core.extractAreaLabelsFromAddresses(capture.addresses || []).map(function (a) {
      return a.label;
    });
    return {
      ok: true,
      capture: {
        key: routeCaptureKey(serviceDate, routeCode),
        serviceDate: serviceDate,
        routeCode: routeCode,
        transporterId: transporterId,
        areas: labels,
        addressCount: (capture.addresses || []).length,
        capturedAt: String(capture.capturedAt || ''),
        source: String(capture.source || ''),
      },
    };
  }

  /**
   * serviceDate+routeCode 単位で最新状態に置き換える（冪等）。入力storeは変更しない。
   * capturedAt が既存より古い取得は無視する（同時刻は後着で置換＝同一内容なら結果不変）。
   */
  function upsertRouteCaptures(store, captures) {
    var next = {};
    var keys = Object.keys(store || {});
    for (var i = 0; i < keys.length; i++) next[keys[i]] = store[keys[i]];
    var applied = 0;
    var ignoredStale = 0;
    var invalid = [];
    (captures || []).forEach(function (c) {
      var n = normalizeRouteCapture(c);
      if (!n.ok) {
        invalid.push({ routeCode: c && c.routeCode, serviceDate: c && c.serviceDate, reason: n.reason });
        return;
      }
      var cur = next[n.capture.key];
      if (cur && cur.capturedAt && n.capture.capturedAt && n.capture.capturedAt < cur.capturedAt) {
        ignoredStale++;
        return;
      }
      next[n.capture.key] = n.capture;
      applied++;
    });
    return { store: next, applied: applied, ignoredStale: ignoredStale, invalid: invalid };
  }

  /**
   * Route最新状態 → 経験イベント（TransportID + normalizedArea + serviceDate で一意）。
   * transporterId が差し替わったRouteは旧ドライバーのイベントを生まない（毎回再構築）。
   */
  function deriveExperienceEvents(routeStore) {
    var events = {};
    var keys = Object.keys(routeStore || {}).sort();
    for (var i = 0; i < keys.length; i++) {
      var rc = routeStore[keys[i]];
      if (!rc || !rc.transporterId) continue;
      var seenArea = {};
      for (var j = 0; j < (rc.areas || []).length; j++) {
        var label = rc.areas[j];
        var norm = Core.normalizeAreaToken(label);
        if (!norm || seenArea[norm]) continue;
        seenArea[norm] = true;
        var ek = rc.transporterId + '|' + norm + '|' + rc.serviceDate;
        if (!events[ek]) {
          events[ek] = {
            key: ek,
            transportId: rc.transporterId,
            normalizedArea: norm,
            areaLabel: label,
            serviceDate: rc.serviceDate,
            routeCodes: [],
          };
        }
        events[ek].routeCodes.push(rc.routeCode);
      }
    }
    return Object.keys(events).map(function (k) {
      return events[k];
    });
  }

  // ===== Snapshot + Event 結合 =====

  function cloneRecord(rec) {
    var out = {};
    for (var k in rec) out[k] = rec[k];
    return out;
  }

  /**
   * options: { knownTransportIds:Set, driverNameByTid:{tid:name} }
   * 戻り値は buildExperienceDbFromRecords と同形（+ meta）。snapshot.records は変更しない。
   */
  function mergeSnapshotAndEvents(snapshot, events, options) {
    options = options || {};
    var through = snapshot && snapshot.snapshotThroughDate;
    var baseRecords = ((snapshot && snapshot.records) || []).map(cloneRecord);
    var base = baseRecords.length
      ? Core.buildExperienceDbFromRecords(baseRecords, { knownTransportIds: options.knownTransportIds })
      : { ok: true, records: [], byTransportId: {}, stats: { drivers: 0, areas: 0, records: 0, lastDate: '', unknownTids: [], unknownTidCount: 0 } };

    var meta = {
      snapshotThroughDate: through || '',
      eventsTotal: (events || []).length,
      eventsCounted: 0,
      eventsBeforeThrough: 0,
      eventLastDate: '',
      unresolvedAreas: [],
      ambiguousAreas: [],
      newDriversFromEvents: [],
      warnings: [],
    };
    if (!through) {
      if ((events || []).length) meta.warnings.push('snapshotThroughDate 未確定のためイベントを経験計算に含めていません');
      base.meta = meta;
      return base;
    }

    // スナップショット全体の既知エリア（normalizeAreaToken後） → 元表記
    var knownAreaByNorm = {};
    baseRecords.forEach(function (rec) {
      var n = Core.normalizeAreaToken(rec.area);
      if (!knownAreaByNorm[n]) knownAreaByNorm[n] = {};
      knownAreaByNorm[n][rec.area] = true;
    });

    // TID → normArea → { label, dates{} }
    var grouped = {};
    (events || []).forEach(function (ev) {
      if (!ev || !ev.transportId || !ev.normalizedArea || !ev.serviceDate) return;
      if (ev.serviceDate <= through) {
        meta.eventsBeforeThrough++;
        return;
      }
      if (!grouped[ev.transportId]) grouped[ev.transportId] = {};
      var g = grouped[ev.transportId][ev.normalizedArea];
      if (!g) g = grouped[ev.transportId][ev.normalizedArea] = { label: ev.areaLabel || ev.normalizedArea, dates: {} };
      g.dates[ev.serviceDate] = true;
    });

    var byTid = base.byTransportId;
    var records = base.records;
    var unresolvedSeen = {};
    Object.keys(grouped).forEach(function (tid) {
      var entry = byTid[tid];
      if (!entry) {
        entry = byTid[tid] = {
          transportId: tid,
          driverName: (options.driverNameByTid && options.driverNameByTid[tid]) || '',
          areas: {},
          areaCount: 0,
        };
        meta.newDriversFromEvents.push(tid);
      }
      Object.keys(grouped[tid]).forEach(function (normArea) {
        var g = grouped[tid][normArea];
        var dates = Object.keys(g.dates).sort();
        var lastDate = dates[dates.length - 1];
        var matches = Object.keys(entry.areas).filter(function (key) {
          return Core.normalizeAreaToken(key) === normArea;
        });
        if (matches.length > 1) {
          meta.ambiguousAreas.push({ transportId: tid, area: g.label, snapshotAreas: matches, days: dates.length });
          return;
        }
        meta.eventsCounted += dates.length;
        meta.eventLastDate = maxIso(meta.eventLastDate, lastDate);
        if (matches.length === 1) {
          var prev = entry.areas[matches[0]];
          var upd = cloneRecord(prev);
          upd.experienceDays = (Number(prev.experienceDays) || 0) + dates.length;
          upd.lastVisitDate = maxIso(prev.lastVisitDate, lastDate);
          entry.areas[matches[0]] = upd;
          var idx = records.indexOf(prev);
          if (idx >= 0) records[idx] = upd;
          return;
        }
        var rec = {
          transportId: tid,
          driverName: entry.driverName,
          area: g.label,
          experienceDays: dates.length,
          lastVisitDate: lastDate,
          stops: 0,
          packages: 0,
          primaryCount: 0,
          splitCount: 0,
          rescueCount: 0,
          confidence: '',
        };
        entry.areas[g.label] = rec;
        records.push(rec);
        if (!knownAreaByNorm[normArea] && !unresolvedSeen[normArea]) {
          unresolvedSeen[normArea] = true;
          var similar = Object.keys(knownAreaByNorm).filter(function (kn) {
            return kn && (kn.indexOf(normArea) >= 0 || normArea.indexOf(kn) >= 0);
          });
          meta.unresolvedAreas.push({ area: g.label, normalizedArea: normArea, reason: 'not_in_snapshot', similarSnapshotAreas: similar });
        }
      });
      entry.areaCount = Object.keys(entry.areas).length;
    });

    var areaSet = {};
    var lastDateAll = '';
    records.forEach(function (rec) {
      areaSet[rec.area] = true;
      lastDateAll = maxIso(lastDateAll, rec.lastVisitDate);
    });
    var known = options.knownTransportIds;
    var unknownTids = [];
    if (known && known.size > 0) {
      Object.keys(byTid).forEach(function (t) {
        if (!known.has(t)) {
          var anyArea = Object.keys(byTid[t].areas)[0] || '';
          unknownTids.push({ transportId: t, driverName: byTid[t].driverName, area: anyArea });
        }
      });
    }
    base.stats = {
      drivers: Object.keys(byTid).length,
      areas: Object.keys(areaSet).length,
      records: records.length,
      lastDate: lastDateAll,
      unknownTids: known && known.size > 0 ? unknownTids : base.stats.unknownTids,
      unknownTidCount: known && known.size > 0 ? unknownTids.length : base.stats.unknownTidCount,
    };
    base.meta = meta;
    return base;
  }

  // ===== 保存・復元（GAS areaExperienceMaster.json） =====

  /**
   * スナップショット登録時のGAS保存ペイロード。
   * records / stats / updatedAt は既存形式（旧クライアント互換）。rawRows は変更せずそのまま保存し、
   * 氏名→TID解決結果は snapshot.resolution として別保持する。
   */
  function buildSnapshotSavePayload(snapshot, options) {
    options = options || {};
    if (!snapshot || !snapshot.ok) return null;
    var db = mergeSnapshotAndEvents(snapshot, [], { knownTransportIds: options.knownTransportIds });
    return {
      updatedAt: options.updatedAt || '',
      records: snapshot.records,
      stats: db.stats,
      snapshot: {
        schemaVersion: 2,
        sourceFile: snapshot.sourceFile,
        registeredAt: options.registeredAt || '',
        header: snapshot.header,
        rawRows: snapshot.rawRows,
        importHistory: snapshot.importHistory.map(function (h) {
          return {
            weekKey: h.weekKey,
            dateFrom: h.dateFrom,
            dateTo: h.dateTo,
            importedAt: h.importedAt,
            sourceFingerprint: h.sourceFingerprint,
            rowCount: h.rowCount,
            source: h.source,
          };
        }),
        snapshotThroughDate: snapshot.snapshotThroughDate,
        missingPeriods: snapshot.validation.missingPeriods,
        resolution: snapshot.resolution,
        resolutionSummary: snapshot.resolutionSummary,
        validation: {
          maxDateTo: snapshot.validation.maxDateTo,
          maxLastVisitDate: snapshot.validation.maxLastVisitDate,
          rawRowCount: snapshot.validation.rawRowCount,
          blankTidRowCount: snapshot.validation.blankTidRowCount,
          duplicateCount: snapshot.validation.duplicates.length,
          warnings: snapshot.warnings,
        },
      },
      unresolved: { drivers: snapshot.unresolvedDrivers },
    };
  }

  /** GAS保存済み snapshot → Snapshot Layer（登録時の解決結果を使い、マスタの後変化に影響されない） */
  function restoreSnapshotLayer(saved) {
    if (!saved || !Array.isArray(saved.rawRows) || !Array.isArray(saved.header)) {
      return { ok: false, errors: ['保存済みスナップショットが不完全です'] };
    }
    var parsed = {
      ok: true,
      sourceFile: saved.sourceFile || '',
      areaRows: [saved.header].concat(saved.rawRows),
      importHistory: (saved.importHistory || []).map(function (h) {
        return {
          weekKey: h.weekKey || '',
          dateFromRaw: h.dateFrom,
          dateToRaw: h.dateTo,
          dateFrom: toIsoDate(h.dateFrom),
          dateTo: toIsoDate(h.dateTo),
          importedAt: h.importedAt || '',
          sourceFingerprint: h.sourceFingerprint || '',
          rowCount: Number(h.rowCount) || 0,
          source: h.source || '',
        };
      }),
      hasImportHistory: true,
    };
    return buildSnapshotLayer(parsed, { fixedResolution: saved.resolution || {}, sourceFile: saved.sourceFile });
  }

  function experienceEventKey(transportId, normalizedArea, serviceDate) {
    return transportId + '|' + normalizedArea + '|' + serviceDate;
  }

  /** 直接送信される経験イベント（Route文脈なし）の正規化 */
  function normalizeExperienceEventItem(item) {
    item = item || {};
    var tid = String(item.transportId || '').trim();
    var date = toIsoDate(item.serviceDate);
    var label = String(item.areaLabel || item.area || item.normalizedArea || '').trim();
    var norm = Core.normalizeAreaToken(item.normalizedArea || label);
    if (!tid || !date || !norm) return { ok: false, reason: 'transportId/serviceDate/area required' };
    return {
      ok: true,
      event: {
        key: experienceEventKey(tid, norm, date),
        transportId: tid,
        normalizedArea: norm,
        areaLabel: label || norm,
        serviceDate: date,
        source: String(item.source || ''),
      },
    };
  }

  /**
   * GAS appendEvents と同一規則の冪等マージ（GAS側実装の仕様基準）。入力は変更しない。
   *   routeCaptures: serviceDate|routeCode 単位で最新 capturedAt に置換（古い取得は無視）
   *   items        : TransportID|normalizedArea|serviceDate 単位の集合（同一キーは上書きのみ）
   */
  function applyAppendEvents(eventsStore, body) {
    eventsStore = eventsStore || {};
    var captures = upsertRouteCaptures(eventsStore.routeCaptures || {}, (body && body.routeCaptures) || []);
    var items = {};
    Object.keys(eventsStore.items || {}).forEach(function (k) {
      items[k] = eventsStore.items[k];
    });
    var added = 0;
    var unchanged = 0;
    var invalid = captures.invalid.slice();
    ((body && body.events) || []).forEach(function (raw) {
      var n = normalizeExperienceEventItem(raw);
      if (!n.ok) {
        invalid.push({ reason: n.reason });
        return;
      }
      if (items[n.event.key]) unchanged++;
      else added++;
      items[n.event.key] = n.event;
    });
    return {
      store: { routeCaptures: captures.store, items: items },
      capturesApplied: captures.applied,
      capturesStale: captures.ignoredStale,
      eventsAdded: added,
      eventsUnchanged: unchanged,
      invalid: invalid,
    };
  }

  /** 保存済み events（routeCaptures + items）→ 経験イベント配列（キー重複なし） */
  function collectExperienceEvents(eventsStore) {
    eventsStore = eventsStore || {};
    var derived = deriveExperienceEvents(eventsStore.routeCaptures || {});
    var byKey = {};
    derived.forEach(function (e) {
      byKey[e.key] = e;
    });
    Object.keys(eventsStore.items || {}).forEach(function (k) {
      var it = eventsStore.items[k];
      if (!it || byKey[k]) return;
      byKey[k] = {
        key: k,
        transportId: it.transportId,
        normalizedArea: it.normalizedArea,
        areaLabel: it.areaLabel || it.normalizedArea,
        serviceDate: it.serviceDate,
        routeCodes: [],
      };
    });
    return Object.keys(byKey)
      .sort()
      .map(function (k) {
        return byKey[k];
      });
  }

  // ===== 一覧（driver master ∪ snapshot ∪ events） =====

  function buildExperienceDriverList(experienceDb, transportIDs) {
    var byTid = (experienceDb && experienceDb.byTransportId) || {};
    var items = {};
    var masterNames = Object.keys(transportIDs || {});
    for (var i = 0; i < masterNames.length; i++) {
      var tid = String(transportIDs[masterNames[i]] || '').trim();
      if (!tid || items[tid]) continue;
      items[tid] = { transportId: tid, masterName: masterNames[i], inMaster: true };
    }
    Object.keys(byTid).forEach(function (t) {
      if (!items[t]) items[t] = { transportId: t, masterName: '', inMaster: false };
    });
    var list = Object.keys(items).map(function (t) {
      var it = items[t];
      var entry = byTid[t] || null;
      return {
        transportId: t,
        driverName: (entry && entry.driverName) || it.masterName || '',
        masterName: it.masterName,
        inMaster: it.inMaster,
        entry: entry,
        hasExperience: !!(entry && entry.areaCount > 0),
      };
    });
    list.sort(function (a, b) {
      return (a.driverName || a.transportId).localeCompare(b.driverName || b.transportId, 'ja');
    });
    return list;
  }

  function filterExperienceDriverList(list, query, options) {
    options = options || {};
    var q = String(query || '').trim().toLowerCase();
    return (list || []).filter(function (it) {
      if (options.onlyWithoutExperience && it.hasExperience) return false;
      if (!q) return true;
      if ((it.driverName || '').toLowerCase().indexOf(q) >= 0) return true;
      if ((it.masterName || '').toLowerCase().indexOf(q) >= 0) return true;
      if (it.transportId.toLowerCase().indexOf(q) >= 0) return true;
      var areas = Object.keys((it.entry && it.entry.areas) || {});
      for (var j = 0; j < areas.length; j++) {
        if (areas[j].toLowerCase().indexOf(q) >= 0 || Core.normalizeAreaToken(areas[j]).toLowerCase().indexOf(q) >= 0) return true;
      }
      return false;
    });
  }

  function buildExperienceOverviewStats(list, snapshot, mergedDb) {
    var masterTids = 0;
    var withExp = 0;
    (list || []).forEach(function (it) {
      if (it.inMaster) masterTids++;
      if (it.hasExperience) withExp++;
    });
    var meta = (mergedDb && mergedDb.meta) || {};
    return {
      masterDriverCount: masterTids,
      listedDriverCount: (list || []).length,
      withExperienceCount: withExp,
      withoutExperienceCount: (list || []).length - withExp,
      unresolvedDriverCount: ((snapshot && snapshot.unresolvedDrivers) || []).length,
      snapshotThroughDate: (snapshot && snapshot.snapshotThroughDate) || '',
      eventLastDate: meta.eventLastDate || '',
      missingPeriods: (snapshot && snapshot.validation && snapshot.validation.missingPeriods) || [],
    };
  }

  var AreaExperienceCore = {
    toIsoDate: toIsoDate,
    addDays: addDays,
    normalizeDriverNameForMatch: normalizeDriverNameForMatch,
    buildDriverNameIndex: buildDriverNameIndex,
    resolveTransportIdByExactName: resolveTransportIdByExactName,
    parseImportHistoryRows: parseImportHistoryRows,
    parseExperienceWorkbook: parseExperienceWorkbook,
    detectImportHistoryPeriods: detectImportHistoryPeriods,
    buildSnapshotLayer: buildSnapshotLayer,
    routeCaptureKey: routeCaptureKey,
    normalizeRouteCapture: normalizeRouteCapture,
    upsertRouteCaptures: upsertRouteCaptures,
    deriveExperienceEvents: deriveExperienceEvents,
    mergeSnapshotAndEvents: mergeSnapshotAndEvents,
    buildSnapshotSavePayload: buildSnapshotSavePayload,
    restoreSnapshotLayer: restoreSnapshotLayer,
    experienceEventKey: experienceEventKey,
    normalizeExperienceEventItem: normalizeExperienceEventItem,
    applyAppendEvents: applyAppendEvents,
    collectExperienceEvents: collectExperienceEvents,
    buildExperienceDriverList: buildExperienceDriverList,
    filterExperienceDriverList: filterExperienceDriverList,
    buildExperienceOverviewStats: buildExperienceOverviewStats,
  };

  global.AreaExperienceCore = AreaExperienceCore;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = AreaExperienceCore;
  }
})(typeof window !== 'undefined' ? window : global);
