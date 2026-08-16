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
    shiftWorkers: [],
    shiftSource: '',
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

  function renderManifestSummary() {
    var box = el('as-manifest-summary');
    if (!box) return;
    if (!state.manifestRoutes.length) {
      box.innerHTML = '<p class="text-sm text-ink-lighter">マニフェスト未読込</p>';
      return;
    }
    var html =
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
  }

  function renderShiftSummary() {
    var box = el('as-shift-summary');
    if (!box) return;
    if (!state.shiftWorkers.length) {
      box.innerHTML = '<p class="text-sm text-ink-lighter">シフト未読込</p>';
      return;
    }
    var withTid = state.shiftWorkers.filter(function (w) {
      return w.transportId;
    }).length;
    box.innerHTML =
      '<p class="text-sm font-bold text-emerald-700">✅ 出勤者 ' +
      state.shiftWorkers.length +
      '名（TransportID紐付 ' +
      withTid +
      '名）</p>' +
      '<p class="text-xs text-ink-lighter mt-1">ソース: ' +
      escapeHtml(state.shiftSource) +
      '</p>';
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

    if (!state.experience || !state.manifestRoutes.length || !state.shiftWorkers.length) {
      box.innerHTML =
        '<p class="text-sm text-ink-lighter py-4 text-center">エリア経験DB・マニフェスト・シフトの3つが揃うと候補を表示します</p>';
      return;
    }

    var suggestions = AssignSupportCore.buildAssignSuggestions(
      state.manifestRoutes,
      state.shiftWorkers,
      state.experience,
      { rescueReserveCount: state.rescueCount }
    );

    var html = '';
    for (var i = 0; i < suggestions.length; i++) {
      var s = suggestions[i];
      var areaLabels = (s.areas || [])
        .map(function (a) {
          return a.label + (a.role === 'primary' ? '(主)' : '(副)');
        })
        .join('・');

      html += '<div class="card p-4 mb-3 border-l-4 border-amber-400">';
      html += '<div class="font-mono font-bold text-base">' + escapeHtml(s.routeCode) + '</div>';
      html += '<div class="text-xs text-ink-lighter mt-1">エリア：' + escapeHtml(areaLabels) + '</div>';

      if (s.noExperiencedDriver) {
        html +=
          '<div class="mt-3 p-3 rounded bg-red-50 border border-red-300 text-sm text-red-800">' +
          '<p class="font-bold">🚨 経験者なし</p>' +
          '<p>このコースを十分経験している出勤者がいません。管理者判断が必要です。</p></div>';
      } else {
        html += '<div class="mt-3"><p class="text-xs font-bold text-emerald-700">推奨候補</p><ol class="mt-1 space-y-1 text-sm">';
        for (var r = 0; r < Math.min(s.recommended.length, 5); r++) {
          var c = s.recommended[r];
          var cap = getCapability(c.driverName, c.transportId);
          html +=
            '<li><span class="font-medium">' +
            (r + 1) +
            '. ' +
            escapeHtml(c.driverName) +
            '</span> <span class="text-xs font-mono text-ink-lighter">' +
            escapeHtml(formatCapability(cap)) +
            '</span><br><span class="text-xs text-ink-lighter">' +
            escapeHtml(formatAreaResults(c.areaResults)) +
            '</span></li>';
        }
        html += '</ol></div>';
      }

      if (s.partial.length > 0) {
        html += '<div class="mt-3"><p class="text-xs font-bold text-amber-700">⚠ 経験浅い / 一部未経験</p><ul class="mt-1 space-y-1 text-sm">';
        for (var p = 0; p < Math.min(s.partial.length, 5); p++) {
          var pc = s.partial[p];
          html +=
            '<li class="text-amber-800"><span class="font-medium">⚠ ' +
            escapeHtml(pc.driverName) +
            '</span><br><span class="text-xs">' +
            escapeHtml(formatAreaResults(pc.areaResults)) +
            '</span></li>';
        }
        html += '</ul></div>';
      }

      if (s.unexperienced.length > 0 && s.unexperienced.length <= 8) {
        html += '<div class="mt-2"><p class="text-xs font-bold text-red-600">🚫 未経験（通常候補外）</p><ul class="mt-1 text-xs text-red-700">';
        for (var u = 0; u < s.unexperienced.length; u++) {
          var uc = s.unexperienced[u];
          html += '<li>🚫 ' + escapeHtml(uc.driverName) + ' — ' + escapeHtml(formatAreaResults(uc.areaResults)) + '</li>';
        }
        html += '</ul></div>';
      }

      html += '</div>';
    }

    box.innerHTML = html || '<p class="text-sm text-ink-lighter">候補を生成できませんでした</p>';
  }

  function renderAll() {
    renderExperienceDashboard();
    renderUploadPreview();
    renderExperienceTable();
    renderManifestSummary();
    renderShiftSummary();
    renderSuggestions();
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
    var pending = files.length;

    files.forEach(function (file) {
      var reader = new FileReader();
      reader.onload = function (e) {
        try {
          var data = new Uint8Array(e.target.result);
          var wb = XLSX.read(data, { type: 'array' });
          routes = routes.concat(AssignSupportCore.parseManifestWorkbook(wb));
        } catch (err) {
          console.error('manifest parse error', file.name, err);
        }
        pending--;
        if (pending === 0) {
          state.manifestRoutes = routes;
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

    if (typeof shiftMasterData !== 'undefined' && shiftMasterData && shiftMasterData.length) {
      workers = AssignSupportCore.extractShiftWorkersFromMaster(shiftMasterData);
      source = 'DAシフト表（点呼照合と同形式）';
    } else if (typeof execShiftData !== 'undefined' && execShiftData) {
      var day = new Date().getDate();
      workers = AssignSupportCore.extractShiftWorkersFromExecData(
        execShiftData,
        day,
        getResolveDriverKeyFn(),
        getTransportIDsMap()
      );
      source = '経営シフト表（execShiftData・本日=' + day + '日）';
    }

    state.shiftWorkers = workers;
    state.shiftSource = source || '未検出';
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

    var search = el('as-exp-search');
    if (search) search.addEventListener('input', renderExperienceTable);

    var rescue = el('as-rescue-count');
    if (rescue) {
      rescue.addEventListener('change', function () {
        state.rescueCount = Number(rescue.value) || 0;
        renderSuggestions();
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
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
