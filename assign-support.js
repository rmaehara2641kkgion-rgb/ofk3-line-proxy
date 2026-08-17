/**
 * OFK3 アサイン支援 UI（Phase 1 + 常設エリア経験DB）
 * 依存: AssignSupportCore, XLSX, transportIDs, resolveDriverKey, findDriver, parseShiftForExec
 */
(function () {
  'use strict';

  var state = {
    experience: null,
    experienceUpdatedAt: '',
    experienceLoadError: '',
    experienceSaving: false,
    pendingUpload: null,
    selectedTransportId: '',
    manifestRoutes: [],
    manifestFileNames: [],
    manifestCycleDetected: null,
    manifestCycleManual: null,
    manifestCycleAmbiguous: false,
    cycleEligibilityStats: null,
    shiftWorkers: [],
    shiftSource: '',
    shiftLinkStats: { mappedCount: 0, unmappedNames: [] },
    suggestionsGenerated: false,
    rescueCount: 0,
  };

  function el(id) {
    return document.getElementById(id);
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function getKnownTransportIds() {
    return AssignSupportCore.buildKnownTransportIdSet(typeof transportIDs !== 'undefined' ? transportIDs : {});
  }

  function getFindDriverFn() {
    return typeof findDriver === 'function' ? findDriver : null;
  }

  function getResolveDriverKeyFn() {
    return typeof resolveDriverKey === 'function' ? resolveDriverKey : null;
  }

  function getTransportIDsMap() {
    return typeof transportIDs !== 'undefined' ? transportIDs : {};
  }

  function readJsonFromLocalStorage(key) {
    try {
      return JSON.parse(localStorage.getItem(key) || '{}');
    } catch (e) {
      return {};
    }
  }

  function readTransportIdsFromLocalStorage() {
    return readJsonFromLocalStorage('transportIDs');
  }

  function readDriverJapaneseNamesForDiagnosis() {
    if (typeof driverJapaneseNames !== 'undefined') return driverJapaneseNames;
    return readJsonFromLocalStorage('driverJapaneseNames');
  }

  function gatherTransportIdsForDiagnosis() {
    var lsMap = readTransportIdsFromLocalStorage();
    var lsKeys = Object.keys(lsMap);
    var globalDefined = typeof transportIDs !== 'undefined';
    var globalMap = globalDefined ? transportIDs : {};
    var globalKeys = globalDefined ? Object.keys(globalMap) : [];
    var windowDefined = typeof window !== 'undefined' && typeof window.transportIDs !== 'undefined';
    var windowMap = windowDefined ? window.transportIDs : {};
    var windowKeys = windowDefined ? Object.keys(windowMap) : [];
    var usedMap = globalDefined ? globalMap : windowDefined ? windowMap : lsMap;
    var usedSource = globalDefined
      ? 'global transportIDs (inline script let)'
      : windowDefined
        ? 'window.transportIDs'
        : 'localStorage only (global/window transportIDs undefined)';

    return {
      globalDefined: globalDefined,
      globalCount: globalKeys.length,
      globalSample: globalKeys.slice(0, 10).map(function (k) {
        return { key: k, value: globalMap[k] };
      }),
      windowDefined: windowDefined,
      windowCount: windowKeys.length,
      windowSample: windowKeys.slice(0, 10).map(function (k) {
        return { key: k, value: windowMap[k] };
      }),
      localStorageCount: lsKeys.length,
      localStorageSample: lsKeys.slice(0, 10).map(function (k) {
        return { key: k, value: lsMap[k] };
      }),
      map: usedMap,
      usedSource: usedSource,
      mismatch: globalDefined && globalKeys.length !== lsKeys.length,
    };
  }

  function logShiftTransportIdDiagnosis(workers, linkStats) {
    if (!workers || !workers.length || typeof AssignSupportCore.diagnoseTransportIdLinking !== 'function') {
      return null;
    }

    linkStats = linkStats || {};
    var tidSources = gatherTransportIdsForDiagnosis();
    var driverDbMap = typeof driverDB !== 'undefined' ? driverDB : {};
    var driverDbCount = Object.keys(driverDbMap).length;
    var jpNames = readDriverJapaneseNamesForDiagnosis();

    var report = AssignSupportCore.diagnoseTransportIdLinking({
      workers: workers,
      transportIDs: tidSources.map,
      resolveDriverKeyFn: getResolveDriverKeyFn(),
      driverDB: driverDbMap,
      driverJapaneseNames: jpNames,
      sampleLimit: 10,
      transportIDsSource: tidSources.usedSource,
      globalTransportIDsDefined: tidSources.globalDefined,
      globalTransportIDsCount: tidSources.globalCount,
      globalTransportIDsSample: tidSources.globalSample,
      windowTransportIDsDefined: tidSources.windowDefined,
      windowTransportIDsCount: tidSources.windowCount,
      windowTransportIDsSample: tidSources.windowSample,
      localStorageCount: tidSources.localStorageCount,
      localStorageSample: tidSources.localStorageSample,
      masterLoadStatus: typeof window !== 'undefined' ? window.__ofk3MasterLoadStatus || null : null,
      shiftProcessedAt: Date.now(),
      attendanceCount: workers.length,
      mappedCount: linkStats.mappedCount || 0,
      unmappedCount: (linkStats.unmappedNames || []).length,
      unmappedNames: linkStats.unmappedNames || [],
    });

    console.group('[AssignSupport] TransportID 紐付診断');
    console.log('診断時刻:', report.at);
    console.log('自動判定:', report.inferredCase, '-', report.inferredCaseLabel);

    console.log('=== マスタ状態 ===');
    console.table([
      {
        'transportIDs.totalKeys': report.transportIDs.totalKeys,
        'localStorage件数': report.meta.localStorageCount,
        'global参照可能': report.meta.globalTransportIDsDefined,
        'global件数': report.meta.globalTransportIDsCount,
        'window.transportIDs有無': report.meta.windowTransportIDsDefined,
        'window件数': report.meta.windowTransportIDsCount,
        driverJapaneseNames件数: report.meta.driverJapaneseNamesCount,
        driverDB件数: report.meta.driverDBCount,
      },
    ]);
    console.log('transportIDs 参照ソース:', report.meta.transportIDsSource);
    console.log('__ofk3MasterLoadStatus:', report.meta.masterLoadStatus || '(未設定)');
    if (tidSources.mismatch) {
      console.warn(
        'global と localStorage の件数不一致:',
        report.meta.globalTransportIDsCount,
        'vs',
        report.meta.localStorageCount
      );
    }
    console.log('transportIDs 先頭10件:');
    console.table(report.transportIDs.first10);
    if (report.meta.localStorageSample.length) {
      console.log('localStorage transportIDs 先頭10件:', report.meta.localStorageSample);
    }

    console.log('=== シフト側 ===');
    console.table([
      {
        出勤者数: report.shift.attendanceCount,
        TransportID紐付成功数: report.shift.mappedCount,
        未紐付人数: report.shift.unmappedCount,
      },
    ]);
    if (report.shift.unmappedNames.length) {
      console.log('未紐付氏名:', report.shift.unmappedNames.join('、'));
    }

    console.log('=== 代表10名 ===');
    console.table(report.representativeTable);

    console.log('=== 代表3名 対応表 ===');
    console.table(report.representative3);

    console.log('JSON確認: copy(JSON.stringify(window.__lastShiftTidDiagnosis, null, 2))');
    console.groupEnd();

    if (typeof window !== 'undefined') {
      window.__lastShiftTidDiagnosis = report;
    }
    return report;
  }

  function getCapability(driverName, transportId) {
    return AssignSupportCore.getPackagesPerHour(
      driverName,
      transportId,
      getFindDriverFn(),
      getTransportIDsMap(),
      getResolveDriverKeyFn()
    );
  }

  function formatCapability(value) {
    if (value == null || !isFinite(value)) return '-';
    return Number(value).toFixed(1) + '個/h';
  }

  function readFileAsRows(file, cb) {
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var name = (file.name || '').toLowerCase();
        if (name.endsWith('.csv')) {
          var text = new TextDecoder('utf-8').decode(e.target.result);
          if (text.indexOf('\ufffd') >= 0) {
            text = new TextDecoder('shift-jis').decode(e.target.result);
          }
          var lines = text.split(/\r?\n/).filter(function (l) {
            return l.trim();
          });
          var rows = lines.map(function (line) {
            return line.split(',').map(function (c) {
              return c.replace(/^"|"$/g, '').trim();
            });
          });
          cb(null, rows);
          return;
        }
        var data = new Uint8Array(e.target.result);
        var wb = XLSX.read(data, { type: 'array' });
        var sheet = wb.Sheets[wb.SheetNames[0]];
        var json = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
        cb(null, json);
      } catch (err) {
        cb(err);
      }
    };
    reader.onerror = function () {
      cb(new Error('ファイル読込に失敗しました'));
    };
    reader.readAsArrayBuffer(file);
  }

  function applyExperienceDb(db, updatedAt) {
    state.experience = db;
    state.experienceUpdatedAt = updatedAt || (db && db.stats && db.stats.lastDate) || '';
  }

  function loadExperienceFromServer(cb) {
    state.experienceLoadError = '';
    fetch('/area-experience-master?action=get')
      .then(function (res) {
        return res.json();
      })
      .then(function (data) {
        if (data.status === 'ok' && data.data && data.data.records && data.data.records.length) {
          var rebuilt = AssignSupportCore.buildExperienceDbFromRecords(data.data.records, {
            knownTransportIds: getKnownTransportIds(),
          });
          if (rebuilt.ok) {
            applyExperienceDb(rebuilt, data.data.updatedAt || '');
          }
        } else if (data.status === 'error' && data.message && data.message.indexOf('not configured') >= 0) {
          state.experienceLoadError = 'GAS未設定（メモリのみ・セッション中のみ利用可）';
        } else if (data.status !== 'ok') {
          state.experienceLoadError = data.message || '読込エラー';
        }
        if (cb) cb();
      })
      .catch(function (e) {
        state.experienceLoadError = e.message || 'GAS接続エラー';
        if (cb) cb();
      });
  }

  function saveExperienceToServer(experienceDb, cb) {
    var payload = AssignSupportCore.serializeExperienceForSave(experienceDb);
    if (!payload) {
      if (cb) cb(new Error('保存データがありません'));
      return;
    }
    state.experienceSaving = true;
    renderExperienceDashboard();
    fetch('/area-experience-master?action=save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (res) {
        return res.json();
      })
      .then(function (data) {
        state.experienceSaving = false;
        if (data.status === 'ok') {
          applyExperienceDb(experienceDb, data.updatedAt || payload.updatedAt);
          state.pendingUpload = null;
          toggleUploadSection(false);
          if (cb) cb(null);
          return;
        }
        if (cb) cb(new Error(data.message || '保存に失敗しました'));
      })
      .catch(function (e) {
        state.experienceSaving = false;
        if (cb) cb(e);
      });
  }

  function toggleUploadSection(show) {
    var section = el('as-exp-upload-section');
    if (!section) return;
    if (show) section.classList.remove('hidden');
    else section.classList.add('hidden');
  }

  function renderExperienceDashboard() {
    var box = el('as-exp-dashboard-status');
    var btn = el('as-exp-update-btn');
    var uploadTitle = el('as-exp-upload-title');
    if (!box) return;

    if (btn) {
      btn.textContent = state.experience ? '経験データ更新' : '経験データ登録';
    }
    if (uploadTitle) {
      uploadTitle.textContent = state.experience ? 'エリア経験データを更新' : 'エリア経験データを登録';
    }

    if (!state.experience) {
      var emptyMsg =
        '<div class="p-4 rounded-lg bg-slate-50 border border-slate-200">' +
        '<p class="text-sm text-ink-lighter">エリア経験マスタ未登録</p>' +
        '<p class="text-xs text-ink-lighter mt-1">CSV / XLSX を登録すると、常設ダッシュボードとして保持されます（GAS保存）</p>';
      if (state.experienceLoadError) {
        emptyMsg +=
          '<p class="text-xs text-amber-700 mt-2">⚠ ' + escapeHtml(state.experienceLoadError) + '</p>';
      }
      emptyMsg += '</div>';
      box.innerHTML = emptyMsg;
      renderExperienceWarnings();
      return;
    }

    var s = state.experience.stats;
    var updatedLabel = state.experienceUpdatedAt || s.lastDate || '-';
    box.innerHTML =
      '<div class="grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">' +
      '<div class="p-3 rounded-lg bg-emerald-50 border border-emerald-200"><p class="text-xs text-emerald-700">最終更新</p><p class="font-bold text-emerald-900">' +
      escapeHtml(updatedLabel) +
      '</p></div>' +
      '<div class="p-3 rounded-lg bg-white border border-border"><p class="text-xs text-ink-lighter">登録ドライバー</p><p class="font-bold">' +
      s.drivers +
      '名</p></div>' +
      '<div class="p-3 rounded-lg bg-white border border-border"><p class="text-xs text-ink-lighter">登録エリア</p><p class="font-bold">' +
      s.areas +
      'エリア</p></div>' +
      '<div class="p-3 rounded-lg bg-white border border-border"><p class="text-xs text-ink-lighter">経験レコード</p><p class="font-bold">' +
      s.records.toLocaleString() +
      '件</p></div>' +
      '<div class="p-3 rounded-lg bg-white border border-border"><p class="text-xs text-ink-lighter">TransportID未紐付け</p><p class="font-bold text-amber-700">' +
      (s.unknownTidCount != null ? s.unknownTidCount : s.unknownTids.length) +
      '件</p></div>' +
      '</div>' +
      (state.experienceSaving
        ? '<p class="text-xs text-blue-600 mt-2">☁ GASへ保存中…</p>'
        : '') +
      (state.experienceLoadError
        ? '<p class="text-xs text-amber-700 mt-2">⚠ ' + escapeHtml(state.experienceLoadError) + '</p>'
        : '');

    renderExperienceWarnings();
  }

  function renderExperienceWarnings() {
    var warnBox = el('as-exp-warnings');
    if (!warnBox) return;
    if (!state.experience || !state.experience.stats.unknownTids.length) {
      warnBox.innerHTML = '';
      return;
    }
    var s = state.experience.stats;
    var wh =
      '<div class="mt-3 p-3 rounded-lg bg-amber-50 border border-amber-300 text-sm">' +
      '<p class="font-bold text-amber-800">⚠ TransportIDがOFK3マスタに存在しません</p>' +
      '<div class="mt-2 max-h-32 overflow-y-auto"><table class="w-full text-xs"><thead><tr>' +
      '<th class="text-left p-1">TransportID</th><th class="text-left p-1">氏名</th><th class="text-left p-1">エリア</th></tr></thead><tbody>';
    for (var i = 0; i < Math.min(s.unknownTids.length, 30); i++) {
      var u = s.unknownTids[i];
      wh +=
        '<tr class="border-t"><td class="p-1 font-mono">' +
        escapeHtml(u.transportId) +
        '</td><td class="p-1">' +
        escapeHtml(u.driverName) +
        '</td><td class="p-1">' +
        escapeHtml(u.area) +
        '</td></tr>';
    }
    if (s.unknownTids.length > 30) wh += '<tr><td colspan="3" class="p-1 text-amber-700">…他 ' + (s.unknownTids.length - 30) + '件</td></tr>';
    wh += '</tbody></table></div></div>';
    warnBox.innerHTML = wh;
  }

  function renderUploadPreview() {
    var box = el('as-exp-preview');
    if (!box) return;
    if (!state.pendingUpload) {
      box.innerHTML = '';
      return;
    }
    var s = state.pendingUpload.stats;
    box.innerHTML =
      '<div class="mt-3 p-3 rounded-lg bg-blue-50 border border-blue-200 text-sm">' +
      '<p class="font-bold text-blue-800">登録前プレビュー（既存マスタは置き換え）</p>' +
      '<ul class="mt-2 space-y-0.5">' +
      '<li>登録ドライバー：<strong>' +
      s.drivers +
      '</strong>名</li>' +
      '<li>エリア数：<strong>' +
      s.areas +
      '</strong></li>' +
      '<li>レコード数：<strong>' +
      s.records.toLocaleString() +
      '</strong>件</li>' +
      '<li>最終データ日：<strong>' +
      escapeHtml(s.lastDate || '-') +
      '</strong></li>' +
      '</ul>' +
      '<button type="button" id="as-exp-confirm-btn" class="mt-3 btn-primary text-xs px-4 py-2 rounded">' +
      (state.experience ? '更新を確定してGAS保存' : '登録を確定してGAS保存') +
      '</button>' +
      '<button type="button" id="as-exp-cancel-btn" class="mt-3 ml-2 btn-secondary text-xs px-4 py-2 rounded">キャンセル</button>' +
      '</div>';

    var confirmBtn = el('as-exp-confirm-btn');
    var cancelBtn = el('as-exp-cancel-btn');
    if (confirmBtn) {
      confirmBtn.addEventListener('click', confirmPendingUpload);
    }
    if (cancelBtn) {
      cancelBtn.addEventListener('click', function () {
        state.pendingUpload = null;
        renderUploadPreview();
      });
    }
  }

  function confirmPendingUpload() {
    if (!state.pendingUpload) return;
    var db = state.pendingUpload;
    saveExperienceToServer(db, function (err) {
      if (err) {
        alert('GAS保存エラー: ' + err.message + '\n\nRenderの AREA_EXPERIENCE_MASTER_GAS_URL を確認してください');
        renderExperienceDashboard();
        return;
      }
      markSuggestionsStale();
      renderAll();
      alert(state.experience ? 'エリア経験マスタを更新しました' : 'エリア経験マスタを登録しました');
    });
  }

  function renderExperienceTable() {
    var tbody = el('as-exp-table-body');
    var searchEl = el('as-exp-search');
    if (!tbody) return;

    if (!state.experience) {
      tbody.innerHTML =
        '<tr><td colspan="5" class="px-4 py-8 text-center text-sm text-ink-lighter">エリア経験マスタ未登録</td></tr>';
      renderDriverDetail();
      return;
    }

    var query = searchEl ? searchEl.value : '';
    var drivers = AssignSupportCore.filterExperienceDrivers(state.experience, query);

    if (!drivers.length) {
      tbody.innerHTML =
        '<tr><td colspan="5" class="px-4 py-8 text-center text-sm text-ink-lighter">該当ドライバーなし</td></tr>';
      renderDriverDetail();
      return;
    }

    var html = '';
    for (var i = 0; i < drivers.length; i++) {
      var d = drivers[i];
      var tid = d.transportId;
      var name = d.driverName || '(名前なし)';
      var cap = getCapability(name, tid);
      var latest = AssignSupportCore.getDriverLatestVisit(d);
      var areaSummary = AssignSupportCore.formatAreaSummary(d, 3);
      var selectedClass = state.selectedTransportId === tid ? ' bg-amber-50' : '';

      html +=
        '<tr class="border-b border-border hover:bg-surface/50 cursor-pointer' +
        selectedClass +
        '" data-tid="' +
        escapeHtml(tid) +
        '">' +
        '<td class="px-3 py-2.5 text-sm font-medium text-amber-800">' +
        escapeHtml(name) +
        '</td>' +
        '<td class="px-3 py-2.5 text-xs font-mono">' +
        escapeHtml(tid) +
        '</td>' +
        '<td class="px-3 py-2.5 text-sm text-right font-mono">' +
        escapeHtml(formatCapability(cap)) +
        '</td>' +
        '<td class="px-3 py-2.5 text-xs">' +
        escapeHtml(areaSummary) +
        '</td>' +
        '<td class="px-3 py-2.5 text-xs text-right">' +
        escapeHtml(AssignSupportCore.formatShortDate(latest)) +
        '</td></tr>';
    }
    tbody.innerHTML = html;

    var rows = tbody.querySelectorAll('tr[data-tid]');
    for (var r = 0; r < rows.length; r++) {
      rows[r].addEventListener('click', function () {
        state.selectedTransportId = this.getAttribute('data-tid') || '';
        renderExperienceTable();
      });
    }
    renderDriverDetail();
  }

  function renderDriverDetail() {
    var box = el('as-exp-detail');
    if (!box) return;
    if (!state.experience || !state.selectedTransportId) {
      box.classList.add('hidden');
      box.innerHTML = '';
      return;
    }
    var entry = state.experience.byTransportId[state.selectedTransportId];
    if (!entry) {
      box.classList.add('hidden');
      return;
    }

    var name = entry.driverName || '(名前なし)';
    var cap = getCapability(name, entry.transportId);
    var areaKeys = Object.keys(entry.areas).sort(function (a, b) {
      return (entry.areas[b].experienceDays || 0) - (entry.areas[a].experienceDays || 0);
    });

    var html =
      '<div class="mt-4 p-4 rounded-lg border border-amber-200 bg-amber-50/40">' +
      '<div class="flex items-start justify-between">' +
      '<h4 class="text-base font-bold">' +
      escapeHtml(name) +
      '</h4>' +
      '<button type="button" id="as-exp-detail-close" class="text-xs text-ink-lighter hover:text-ink">✕ 閉じる</button>' +
      '</div>' +
      '<div class="mt-2 grid grid-cols-1 md:grid-cols-3 gap-2 text-sm">' +
      '<div><span class="text-xs text-ink-lighter">TransportID</span><br><span class="font-mono">' +
      escapeHtml(entry.transportId) +
      '</span></div>' +
      '<div><span class="text-xs text-ink-lighter">1時間あたり能力</span><br><span class="font-mono font-bold">' +
      escapeHtml(formatCapability(cap)) +
      '</span></div>' +
      '<div><span class="text-xs text-ink-lighter">経験エリア数</span><br><span class="font-bold">' +
      entry.areaCount +
      '</span></div>' +
      '</div>' +
      '<h5 class="text-sm font-bold mt-4 mb-2">エリア経験</h5>' +
      '<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">';

    for (var i = 0; i < areaKeys.length; i++) {
      var ar = entry.areas[areaKeys[i]];
      var statusLabel = AssignSupportCore.getExperienceStatusLabel(ar.experienceDays);
      html +=
        '<div class="p-2 rounded border border-white bg-white text-xs">' +
        '<div class="font-medium">' +
        escapeHtml(ar.area) +
        '</div>' +
        '<div class="mt-1"><span class="font-bold">' +
        ar.experienceDays +
        '日</span>' +
        ' <span class="text-ink-lighter">(' +
        escapeHtml(statusLabel) +
        ')</span></div>' +
        '<div class="text-ink-lighter mt-0.5">最終 ' +
        escapeHtml(ar.lastVisitDate || '-') +
        '</div></div>';
    }

    html += '</div></div>';
    box.innerHTML = html;
    box.classList.remove('hidden');

    var closeBtn = el('as-exp-detail-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', function () {
        state.selectedTransportId = '';
        renderDriverDetail();
        renderExperienceTable();
      });
    }
  }

  function getEffectiveCycle() {
    if (state.manifestCycleManual) return state.manifestCycleManual;
    if (state.manifestCycleDetected && !state.manifestCycleAmbiguous) return state.manifestCycleDetected;
    return null;
  }

  function updateCycleEligibilityStats() {
    var cycle = getEffectiveCycle();
    if (!cycle || !state.shiftWorkers.length) {
      state.cycleEligibilityStats = null;
      return;
    }
    var filtered = AssignSupportCore.filterShiftWorkers(state.shiftWorkers);
    state.cycleEligibilityStats = AssignSupportCore.filterWorkersByCycleEligibility(filtered, cycle).stats;
  }

  function getAmazonAssignmentsForPlan() {
    if (typeof assignmentData === 'undefined' || !assignmentData || !assignmentData.length) return [];
    var tidMap = getTransportIDsMap();
    var resolveFn = getResolveDriverKeyFn();
    return assignmentData.map(function (row) {
      var name = row.driverName || '';
      var tid =
        row.transportId ||
        AssignSupportCore.resolveTransportIdForName(name, tidMap, resolveFn);
      return {
        routeCode: row.routeCode,
        driverName: name,
        serviceType: row.serviceType || '',
        transportId: tid,
        isReserve: AssignSupportCore.isReserveServiceType(row.serviceType),
      };
    });
  }

  function renderAssignModeChrome() {
    var cycle = getEffectiveCycle();
    var title = el('as-assign-section-title');
    var desc = el('as-assign-section-desc');
    var btn = el('as-generate-suggestions-btn');
    if (!title || !btn) return;
    var mode = cycle ? AssignSupportCore.getAssignModeForCycle(cycle) : null;
    if (mode === 'evaluate') {
      title.textContent = 'Amazonアサイン最適化（Cycle ' + cycle + '）';
      if (desc) {
        desc.textContent =
          'Amazon既存アサインを経験DBで評価し、変更した方がよい箇所だけ提案します（全員再配車しません）';
      }
      btn.textContent = '⚡ アサイン評価・最適化';
    } else if (mode === 'first_pick') {
      title.textContent = 'Cycle3 自力アサイン支援';
      if (desc) {
        desc.textContent = '経験・能力・シフト適格性から第一推奨アサインを生成します';
      }
      btn.textContent = '⚡ 第一推奨アサイン生成';
    } else {
      title.textContent = 'アサイン提案';
      if (desc) desc.textContent = 'ManifestのCycleに応じて処理モードが切り替わります';
      btn.textContent = '⚡ オートアサイン提案を生成';
    }
  }

  function buildPlanOptions(cycle) {
    return {
      cycle: cycle,
      rescueReserveCount: state.rescueCount,
      amazonAssignments: getAmazonAssignmentsForPlan(),
      getPackagesPerHour: function (driverName, transportId) {
        return getCapability(driverName, transportId);
      },
    };
  }

  function renderManifestSummary() {
    var box = el('as-manifest-summary');
    if (!box) return;
    if (!state.manifestRoutes.length) {
      box.innerHTML = '<p class="text-sm text-ink-lighter">マニフェスト未読込</p>';
      return;
    }

    var cycle = getEffectiveCycle();
    var html = '<div class="mb-3 p-3 rounded-lg bg-slate-50 border border-slate-200 text-sm">';
    html += '<p class="font-bold text-slate-800 mb-2">今日のマニフェスト</p>';

    if (cycle) {
      var stats = state.cycleEligibilityStats;
      var shiftLabels = stats
        ? stats.eligibleShiftLabels.join(' / ')
        : AssignSupportCore.getEligibleShiftLabelsForCycle(cycle).join(' / ');
      html += '<p class="text-xs">Cycle：<strong>Cycle ' + cycle + '</strong></p>';
      html += '<p class="text-xs mt-1">対象シフト：<strong>' + escapeHtml(shiftLabels) + '</strong></p>';
      if (stats) {
        html +=
          '<p class="text-xs mt-1">対象出勤者：<strong>' +
          stats.eligibleCount +
          '名</strong></p>';
        html +=
          '<p class="text-xs mt-1 text-ink-lighter">除外：Cycle対象外 <strong>' +
          stats.cycleIneligibleCount +
          '名</strong> / 研修 <strong>' +
          stats.nonAssignableCount +
          '名</strong></p>';
      }
      if (state.manifestCycleManual) {
        html += '<p class="text-xs text-amber-700 mt-1">Cycle：手動選択</p>';
      } else if (state.manifestCycleDetected) {
        html += '<p class="text-xs text-ink-lighter mt-1">Cycle：ファイル名から自動判定</p>';
      }
      var mode = AssignSupportCore.getAssignModeForCycle(cycle);
      if (mode === 'evaluate') {
        html += '<p class="text-xs mt-1 text-blue-800">モード：<strong>Amazonアサイン最適化</strong></p>';
      } else if (mode === 'first_pick') {
        html += '<p class="text-xs mt-1 text-blue-800">モード：<strong>Cycle3 自力アサイン支援</strong></p>';
      }
    } else {
      html +=
        '<p class="text-xs text-red-700 font-bold">⚠ Cycleを判定できません</p>';
      if (state.manifestCycleAmbiguous) {
        html += '<p class="text-xs text-red-600 mt-1">複数ファイルのCycleが一致しません</p>';
      }
      html +=
        '<div class="mt-2"><label class="text-xs font-medium">Cycle手動選択：</label> ' +
        '<select id="as-cycle-manual-select" class="text-xs border rounded px-2 py-1 ml-1">' +
        '<option value="">-- 選択 --</option>' +
        '<option value="1"' +
        (state.manifestCycleManual === 1 ? ' selected' : '') +
        '>Cycle 1</option>' +
        '<option value="2"' +
        (state.manifestCycleManual === 2 ? ' selected' : '') +
        '>Cycle 2</option>' +
        '<option value="3"' +
        (state.manifestCycleManual === 3 ? ' selected' : '') +
        '>Cycle 3</option>' +
        '</select></div>';
      if (state.manifestFileNames.length) {
        html +=
          '<p class="text-xs text-ink-lighter mt-2 break-all">ファイル：' +
          escapeHtml(state.manifestFileNames.join(', ')) +
          '</p>';
      }
    }
    html += '</div>';

    html +=
      '<p class="text-sm font-bold text-emerald-700">✅ マニフェスト ' +
      state.manifestRoutes.length +
      'コース読込</p><div class="mt-2 max-h-48 overflow-y-auto text-xs space-y-1">';
    for (var i = 0; i < state.manifestRoutes.length; i++) {
      var r = state.manifestRoutes[i];
      var areaTxt = (r.areas || [])
        .slice(0, 4)
        .map(function (a) {
          return a.label + (a.role === 'primary' ? '★' : '');
        })
        .join(' / ');
      html +=
        '<div class="border-b pb-1"><span class="font-mono font-bold">' +
        escapeHtml(r.routeCode) +
        '</span> 個口' +
        r.packages +
        ' / 件数' +
        r.stops +
        '<br><span class="text-ink-lighter">エリア: ' +
        escapeHtml(areaTxt || '?') +
        '</span></div>';
    }
    html += '</div>';
    box.innerHTML = html;

    var cycleSelect = el('as-cycle-manual-select');
    if (cycleSelect) {
      cycleSelect.addEventListener('change', function () {
        var val = Number(cycleSelect.value);
        state.manifestCycleManual = val >= 1 && val <= 3 ? val : null;
        updateCycleEligibilityStats();
        markSuggestionsStale();
        renderAll();
      });
    }
  }

  function renderShiftSummary() {
    var box = el('as-shift-summary');
    if (!box) return;
    if (!state.shiftWorkers.length) {
      box.innerHTML = '<p class="text-sm text-ink-lighter">シフト未読込</p>';
      return;
    }
    var stats = state.shiftLinkStats || { mappedCount: 0, unmappedNames: [] };
    var mapped = stats.mappedCount || 0;
    var unmapped = stats.unmappedNames || [];
    var html =
      '<p class="text-sm font-bold text-emerald-700">✅ 出勤者 ' +
      state.shiftWorkers.length +
      '名</p>' +
      '<div class="mt-2 text-xs space-y-1">' +
      '<div>TransportID紐付成功: <strong>' +
      mapped +
      '名</strong></div>' +
      '<div>未紐付: <strong class="' +
      (unmapped.length ? 'text-amber-800' : '') +
      '">' +
      unmapped.length +
      '名</strong></div>' +
      '</div>' +
      '<p class="text-xs text-ink-lighter mt-2">ソース: ' +
      escapeHtml(state.shiftSource) +
      '</p>';
    if (unmapped.length) {
      html +=
        '<div class="mt-2 p-2 rounded bg-amber-50 border border-amber-200 text-xs">' +
        '<p class="font-medium text-amber-900">未紐付氏名（マスタ管理で TransportID を確認してください）</p>' +
        '<p class="mt-1 text-amber-800 break-all">' +
        escapeHtml(unmapped.slice(0, 20).join('、')) +
        (unmapped.length > 20 ? ' …他' + (unmapped.length - 20) + '名' : '') +
        '</p></div>';
    }
    box.innerHTML = html;
  }

  function renderSuggestionsIdle() {
    var box = el('as-suggest-results');
    if (!box || state.suggestionsGenerated) return;
    renderAssignModeChrome();
    var ready =
      state.experience && state.manifestRoutes.length && state.shiftWorkers.length;
    if (!ready) {
      box.innerHTML =
        '<p class="text-sm text-ink-lighter py-4 text-center">エリア経験DB・マニフェスト・シフトの3つが揃うと候補を生成できます</p>';
      return;
    }
    var cycle = getEffectiveCycle();
    var mode = cycle ? AssignSupportCore.getAssignModeForCycle(cycle) : null;
    var msg =
      mode === 'evaluate'
        ? '準備完了。「⚡ アサイン評価・最適化」を押してください（Amazonアサインデータ必要）'
        : mode === 'first_pick'
          ? '準備完了。「⚡ 第一推奨アサイン生成」を押してください'
          : '準備完了。Cycleを確定後、生成ボタンを押してください';
    box.innerHTML = '<p class="text-sm text-ink-lighter py-4 text-center">' + msg + '</p>';
  }

  function formatAreaResults(areaResults) {
    return areaResults
      .map(function (ar) {
        if (ar.experienced) {
          return ar.area + ' ' + ar.experienceDays + '日';
        }
        return ar.area + ' 未経験';
      })
      .join(' / ');
  }

  function renderSuggestions() {
    var box = el('as-suggest-results');
    if (!box) return;
    renderAssignModeChrome();

    if (!state.experience || !state.manifestRoutes.length || !state.shiftWorkers.length) {
      box.innerHTML =
        '<p class="text-sm text-ink-lighter py-4 text-center">エリア経験DB・マニフェスト・シフトの3つが揃うと候補を表示します</p>';
      return;
    }

    var cycle = getEffectiveCycle();
    if (!cycle) {
      box.innerHTML =
        '<div class="p-4 rounded-lg bg-amber-50 border border-amber-300 text-sm text-amber-900">' +
        '<p class="font-bold">⚠ Cycleを判定できません</p>' +
        '<p class="mt-2 text-xs">マニフェストファイル名（例：OFK3_CYCLE_1_...）を確認するか、上のマニフェスト欄で Cycle を手動選択してください。</p>' +
        '</div>';
      return;
    }

    var mode = AssignSupportCore.getAssignModeForCycle(cycle);
    if (mode === 'evaluate' && !getAmazonAssignmentsForPlan().length) {
      box.innerHTML =
        '<div class="p-4 rounded-lg bg-amber-50 border border-amber-300 text-sm text-amber-900">' +
        '<p class="font-bold">⚠ Amazonアサインデータが必要です</p>' +
        '<p class="mt-2 text-xs">Cycle ' +
        cycle +
        ' はAmazon既存アサインの評価モードです。ダッシュボードで「ドライバー別配送データ」を読込んでから実行してください。</p>' +
        '</div>';
      return;
    }

    var plan = AssignSupportCore.buildAssignPlan(
      state.manifestRoutes,
      state.shiftWorkers,
      state.experience,
      buildPlanOptions(cycle)
    );

    if (plan.cycleError || plan.assignmentError) {
      box.innerHTML =
        '<div class="p-4 rounded-lg bg-red-50 border border-red-300 text-sm text-red-800">' +
        '<p class="font-bold">⚠ 処理を停止しました</p>' +
        '<p class="mt-2 text-xs">' +
        escapeHtml(plan.cycleError || plan.assignmentError || 'UNKNOWN') +
        '</p></div>';
      return;
    }

    state.suggestionsGenerated = true;
    var html = '';

    if (plan.mode === 'evaluate') {
      html += '<div class="mb-4 p-3 rounded-lg bg-slate-50 border border-slate-200 text-sm">';
      html += '<p class="font-bold text-slate-800 mb-1">Amazonアサイン評価（Cycle ' + cycle + '）</p>';
      html +=
        '<p class="text-xs text-ink-lighter">変更不要：<strong>' +
        plan.summary.okCount +
        '</strong>コース　変更候補：<strong>' +
        plan.summary.changeCandidateCount +
        '</strong>コース　管理者判断：<strong>' +
        plan.summary.adminReviewCount +
        '</strong>コース</p></div>';

      for (var ei = 0; ei < plan.routes.length; ei++) {
        var er = plan.routes[ei];
        var eAreas = (er.areas || [])
          .map(function (a) {
            return a.label + (a.role === 'primary' ? '(主)' : '(副)');
          })
          .join('・');
        html += '<div class="card p-4 mb-3 border-l-4 border-blue-400">';
        html += '<div class="font-mono font-bold text-base">' + escapeHtml(er.routeCode) + '</div>';
        html +=
          '<div class="text-xs text-ink-lighter mt-1">エリア：' +
          escapeHtml(eAreas) +
          ' / Route種別：' +
          escapeHtml(er.routeVehicleType || '?') +
          '</div>';

        if (er.evaluationStatus === 'ok') {
          html +=
            '<div class="mt-3 p-3 rounded bg-emerald-50 border border-emerald-300 text-sm text-emerald-800">' +
            '<p class="font-bold">✅ Amazonアサイン良好（変更不要）</p></div>';
        } else if (er.evaluationStatus === 'change_candidate') {
          html +=
            '<div class="mt-3 p-3 rounded bg-amber-50 border border-amber-300 text-sm text-amber-900">' +
            '<p class="font-bold">⚠ 変更候補</p>' +
            '<p class="mt-1 text-xs">現在：' +
            escapeHtml((er.amazonAssignment && er.amazonAssignment.driverName) || '?') +
            '</p>' +
            '<p class="text-xs">推奨：' +
            escapeHtml((er.suggestedChange && er.suggestedChange.driverName) || '?') +
            '</p></div>';
        } else {
          html +=
            '<div class="mt-3 p-3 rounded bg-red-50 border border-red-300 text-sm text-red-800">' +
            '<p class="font-bold">🚨 管理者判断</p></div>';
        }

        if (er.evaluationReasons && er.evaluationReasons.length) {
          html += '<ul class="mt-2 text-xs text-slate-700 space-y-0.5 list-disc list-inside">';
          for (var eri = 0; eri < er.evaluationReasons.length; eri++) {
            html += '<li>' + escapeHtml(er.evaluationReasons[eri]) + '</li>';
          }
          html += '</ul>';
        }
        html += '</div>';
      }
    } else {
      html += '<div class="mb-4 p-3 rounded-lg bg-slate-50 border border-slate-200 text-sm">';
      html += '<p class="font-bold text-slate-800 mb-1">Cycle3 推奨アサイン</p>';
      html +=
        '<p class="text-xs text-ink-lighter">推奨確定：<strong>' +
        plan.summary.confirmedCount +
        '</strong> / ' +
        plan.summary.totalRoutes +
        '　管理者判断：<strong>' +
        plan.summary.adminReviewCount +
        '</strong>　Tier A：<strong>' +
        (plan.summary.tierAAssignments || 0) +
        '</strong>　Tier B：<strong>' +
        (plan.summary.tierBAssignments || 0) +
        '</strong>　Tier C以下：<strong>' +
        (plan.summary.tierCOrLowerAssignments || 0) +
        '</strong></p>';
      html +=
        '<p class="text-xs text-ink-lighter mt-1">未使用出勤者：<strong>' +
        plan.summary.unusedWorkerCount +
        '</strong>名';
      if (plan.summary.unexperiencedPlacements > 0) {
        html += '　⚠ 未経験配置：<strong>' + plan.summary.unexperiencedPlacements + '</strong>';
      }
      if (plan.summary.sharedConfidenceOnly > 0) {
        html += '　⚠ confidence sharedのみ：<strong>' + plan.summary.sharedConfidenceOnly + '</strong>';
      }
      html += '</p>';
      if (plan.summary.unusedWorkerDetails && plan.summary.unusedWorkerDetails.length) {
        html += '<details class="mt-2 text-xs"><summary class="cursor-pointer font-medium">未使用出勤者詳細</summary><ul class="mt-1 space-y-1">';
        for (var ui = 0; ui < Math.min(plan.summary.unusedWorkerDetails.length, 12); ui++) {
          var uw = plan.summary.unusedWorkerDetails[ui];
          html += '<li>' + escapeHtml(uw.driverName);
          if (uw.tierAAreas && uw.tierAAreas.length) {
            html += ' <span class="text-ink-lighter">Tier A経験：' + escapeHtml(uw.tierAAreas.join(' / ')) + '</span>';
          }
          if (uw.packagesPerHour != null) {
            html += ' <span class="text-ink-lighter">能力：' + Number(uw.packagesPerHour).toFixed(1) + '個/h</span>';
          }
          html += '</li>';
        }
        html += '</ul></details>';
      }
      html += '</div>';

      for (var i = 0; i < plan.routes.length; i++) {
        var s = plan.routes[i];
        var areaLabels = (s.areas || [])
          .map(function (a) {
            return a.label + (a.role === 'primary' ? '(主)' : '(副)');
          })
          .join('・');

        html += '<div class="card p-4 mb-3 border-l-4 border-amber-400">';
        html += '<div class="font-mono font-bold text-base">' + escapeHtml(s.routeCode) + '</div>';
        html +=
          '<div class="text-xs text-ink-lighter mt-1">エリア：' +
          escapeHtml(areaLabels) +
          (s.routeVehicleType ? ' / Route種別：' + escapeHtml(s.routeVehicleType) : '') +
          '</div>';

        if (s.vehicleUnknown) {
          html +=
            '<div class="mt-3 p-3 rounded bg-red-50 border border-red-300 text-sm text-red-800">' +
            '<p class="font-bold">🚨 管理者判断</p>' +
            '<p class="text-xs mt-1">Bike/Standard判定不能（Amazonアサインデータの serviceType が必要）</p></div>';
        } else if (s.needsAdminReview || !s.firstRecommendation) {
          html +=
            '<div class="mt-3 p-3 rounded bg-red-50 border border-red-300 text-sm text-red-800">' +
            '<p class="font-bold">🚨 管理者判断</p>' +
            '<p>適任者を安全に特定できません。</p></div>';
        } else {
          var fr = s.firstRecommendation;
          var cap = fr.packagesPerHour != null ? Number(fr.packagesPerHour).toFixed(1) + '個/h' : '-';
          html += '<div class="mt-3 p-3 rounded bg-emerald-50 border border-emerald-300">';
          html +=
            '<p class="text-sm font-bold text-emerald-800">⚡ 第一推奨：' +
            escapeHtml(fr.driverName) +
            '</p>';
          html += '<ul class="mt-2 text-xs text-emerald-900 space-y-0.5 list-disc list-inside">';
          for (var ri = 0; ri < fr.reasons.length; ri++) {
            html += '<li>' + escapeHtml(fr.reasons[ri]) + '</li>';
          }
          html += '</ul>';
          html +=
            '<p class="text-xs text-emerald-700 mt-2">能力 ' +
            escapeHtml(cap) +
            ' / 物量 ' +
            (s.packages || 0) +
            '個</p>';
          html += '</div>';
        }

        if (s.otherCandidates && s.otherCandidates.length > 0) {
          html += '<div class="mt-3"><p class="text-xs font-bold text-slate-600">その他候補</p><ul class="mt-1 text-sm space-y-0.5">';
          for (var oc = 0; oc < Math.min(s.otherCandidates.length, 8); oc++) {
            var other = s.otherCandidates[oc];
            html +=
              '<li class="text-slate-700">' +
              escapeHtml(other.driverName) +
              ' <span class="text-xs text-ink-lighter">(主' +
              other.primaryExperienceDays +
              '日/Tier' +
              other.primaryTier +
              ')</span></li>';
          }
          html += '</ul></div>';
        }

        if (s.recommended && s.recommended.length > 0) {
          html +=
            '<details class="mt-3"><summary class="text-xs font-bold text-emerald-700 cursor-pointer">経験者候補一覧（' +
            s.recommended.length +
            '名）</summary><ol class="mt-1 space-y-1 text-sm">';
          for (var r = 0; r < Math.min(s.recommended.length, 8); r++) {
            var c = s.recommended[r];
            var cap2 = getCapability(c.driverName, c.transportId);
            html +=
              '<li><span class="font-medium">' +
              (r + 1) +
              '. ' +
              escapeHtml(c.driverName) +
              '</span> <span class="text-xs font-mono text-ink-lighter">' +
              escapeHtml(formatCapability(cap2)) +
              '</span><br><span class="text-xs text-ink-lighter">' +
              escapeHtml(formatAreaResults(c.areaResults)) +
              '</span></li>';
          }
          html += '</ol></details>';
        }

        html += '</div>';
      }
    }

    box.innerHTML = html || '<p class="text-sm text-ink-lighter">候補を生成できませんでした</p>';
    state.lastAssignPlan = plan;
  }

  function markSuggestionsStale() {
    state.suggestionsGenerated = false;
  }

  function renderAll() {
    renderExperienceDashboard();
    renderUploadPreview();
    renderExperienceTable();
    renderManifestSummary();
    renderShiftSummary();
    renderAssignModeChrome();
    if (state.suggestionsGenerated) {
      renderSuggestions();
    } else {
      renderSuggestionsIdle();
    }
  }

  function loadExperienceFile(file) {
    readFileAsRows(file, function (err, rows) {
      if (err) {
        alert(err.message);
        return;
      }
      var result = AssignSupportCore.parseExperienceRows(rows, { knownTransportIds: getKnownTransportIds() });
      if (!result.ok) {
        alert(result.error);
        return;
      }
      state.pendingUpload = result;
      toggleUploadSection(true);
      renderUploadPreview();
    });
  }

  function loadManifestFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    var routes = [];
    var sources = [];
    var pending = files.length;

    state.manifestFileNames = files.map(function (f) {
      return f.name;
    });
    state.manifestCycleManual = null;

    files.forEach(function (file) {
      var reader = new FileReader();
      reader.onload = function (e) {
        try {
          var data = new Uint8Array(e.target.result);
          var wb = XLSX.read(data, { type: 'array' });
          sources.push({ fileName: file.name, workbook: wb });
          routes = routes.concat(AssignSupportCore.parseManifestWorkbook(wb));
        } catch (err) {
          console.error('manifest parse error', file.name, err);
        }
        pending--;
        if (pending === 0) {
          var detection = AssignSupportCore.detectManifestCycleFromSources(sources);
          state.manifestCycleDetected = detection.cycle;
          state.manifestCycleAmbiguous = detection.ambiguous;
          state.manifestRoutes = routes;
          updateCycleEligibilityStats();
          markSuggestionsStale();
          renderAll();
          if (!routes.length) alert('マニフェストからコースを検出できませんでした');
        }
      };
      reader.readAsArrayBuffer(file);
    });
  }

  function syncShiftFromGlobals() {
    var workers = [];
    var source = '';
    var resolveFn = getResolveDriverKeyFn();
    var tidMap = getTransportIDsMap();

    if (typeof shiftMasterData !== 'undefined' && shiftMasterData && shiftMasterData.length) {
      workers = AssignSupportCore.extractShiftWorkersFromMaster(shiftMasterData, tidMap, resolveFn);
      source = 'DAシフト表（点呼照合と同形式）';
    } else if (typeof execShiftData !== 'undefined' && execShiftData) {
      var day = new Date().getDate();
      workers = AssignSupportCore.extractShiftWorkersFromExecData(
        execShiftData,
        day,
        resolveFn,
        tidMap
      );
      source = '経営シフト表（execShiftData・本日=' + day + '日）';
    }

    var enriched = AssignSupportCore.enrichShiftWorkersWithTransportIds(workers, tidMap, resolveFn);
    state.shiftWorkers = enriched.workers;
    if (typeof tenkoSchedule !== 'undefined' && tenkoSchedule && tenkoSchedule.length) {
      state.shiftWorkers = AssignSupportCore.mergeScheduleIntoShiftWorkers(
        state.shiftWorkers,
        tenkoSchedule,
        tidMap,
        resolveFn
      );
      source = (source || 'DAシフト') + ' + Amazon Schedule UI';
    }
    state.shiftLinkStats = {
      mappedCount: enriched.mappedCount,
      unmappedNames: enriched.unmappedNames,
    };
    state.shiftSource = source || '未検出';
    logShiftTransportIdDiagnosis(state.shiftWorkers, state.shiftLinkStats);
    updateCycleEligibilityStats();
    markSuggestionsStale();
    renderAll();
  }

  function loadShiftFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var data = new Uint8Array(e.target.result);
        var wb = XLSX.read(data, { type: 'array' });
        var sheetName = wb.SheetNames.indexOf('メイン') >= 0 ? 'メイン' : wb.SheetNames[0];
        var json = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' });

        if (typeof processShiftMaster === 'function' && json[2] && String(json[2][0] || '').indexOf('社') >= 0) {
          processShiftMaster(json);
          syncShiftFromGlobals();
          state.shiftSource = 'DAシフト表アップロード';
          renderAll();
          return;
        }

        if (typeof parseShiftForExec === 'function') {
          var dt = new DataTransfer();
          dt.items.add(file);
          parseShiftForExec(dt.files);
          setTimeout(function () {
            syncShiftFromGlobals();
            state.shiftSource = '経営シフト表アップロード';
            renderAll();
          }, 300);
          return;
        }

        alert('シフト表形式を判別できませんでした');
      } catch (err) {
        alert('シフト読込エラー: ' + err.message);
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function bindDropzone(zoneId, inputId, handler) {
    var zone = el(zoneId);
    var input = el(inputId);
    if (!zone || !input) return;
    zone.addEventListener('click', function () {
      input.click();
    });
    zone.addEventListener('dragover', function (e) {
      e.preventDefault();
      zone.classList.add('border-amber-400', 'bg-amber-50');
    });
    zone.addEventListener('dragleave', function () {
      zone.classList.remove('border-amber-400', 'bg-amber-50');
    });
    zone.addEventListener('drop', function (e) {
      e.preventDefault();
      zone.classList.remove('border-amber-400', 'bg-amber-50');
      if (e.dataTransfer.files.length) handler(e.dataTransfer.files);
    });
    input.addEventListener('change', function (e) {
      if (e.target.files.length) handler(e.target.files);
      e.target.value = '';
    });
  }

  function init() {
    bindDropzone('as-exp-dropzone', 'as-exp-input', function (files) {
      loadExperienceFile(files[0]);
    });
    bindDropzone('as-manifest-dropzone', 'as-manifest-input', loadManifestFiles);
    bindDropzone('as-shift-dropzone', 'as-shift-input', function (files) {
      loadShiftFile(files[0]);
    });

    var genBtn = el('as-generate-suggestions-btn');
    if (genBtn) {
      genBtn.addEventListener('click', function () {
        if (!state.experience) {
          alert('エリア経験DBを先に登録してください');
          return;
        }
        if (!state.manifestRoutes.length) {
          alert('マニフェストを先に読み込んでください');
          return;
        }
        if (!state.shiftWorkers.length) {
          alert('シフトを先に読み込んでください');
          return;
        }
        if (!getEffectiveCycle()) {
          alert(
            'Cycleを判定できません。マニフェストファイル名（OFK3_CYCLE_1 等）を確認するか、Cycleを手動選択してください'
          );
          return;
        }
        var genCycle = getEffectiveCycle();
        if (
          AssignSupportCore.getAssignModeForCycle(genCycle) === 'evaluate' &&
          !getAmazonAssignmentsForPlan().length
        ) {
          alert(
            'Cycle ' +
              genCycle +
              ' はAmazonアサイン評価モードです。先にダッシュボードでドライバー別配送データを読込んでください'
          );
          return;
        }
        renderSuggestions();
      });
    }

    var search = el('as-exp-search');
    if (search) search.addEventListener('input', renderExperienceTable);

    var rescue = el('as-rescue-count');
    if (rescue) {
      rescue.addEventListener('change', function () {
        state.rescueCount = Number(rescue.value) || 0;
        if (state.suggestionsGenerated) {
          renderSuggestions();
        }
      });
    }

    var updateBtn = el('as-exp-update-btn');
    if (updateBtn) {
      updateBtn.addEventListener('click', function () {
        toggleUploadSection(true);
        var section = el('as-exp-upload-section');
        if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }

    loadExperienceFromServer(function () {
      syncShiftFromGlobals();
      renderAll();
    });
  }

  window.AssignSupport = {
    init: init,
    getState: function () {
      return state;
    },
    getExperienceDb: function () {
      return state.experience;
    },
    syncShiftFromGlobals: syncShiftFromGlobals,
    renderAll: renderAll,
    reloadExperienceFromServer: loadExperienceFromServer,
    debugTransportIdLink: function () {
      return logShiftTransportIdDiagnosis(state.shiftWorkers, state.shiftLinkStats);
    },
    gatherTransportIdsForDiagnosis: gatherTransportIdsForDiagnosis,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
