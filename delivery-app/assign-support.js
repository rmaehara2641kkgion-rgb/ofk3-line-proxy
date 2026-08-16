/**
 * OFK3 アサイン支援 UI（Phase 1）
 * 依存: AssignSupportCore, XLSX, 既存 transportIDs / resolveDriverKey / parseShiftForExec / execShiftData
 */
(function () {
  'use strict';

  var SESSION_KEY = 'ofk3_assign_support_experience_v1';
  var MAX_SESSION_BYTES = 2 * 1024 * 1024;

  var state = {
    experience: null,
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

  function tryPersistExperience(db) {
    try {
      var payload = JSON.stringify({ savedAt: new Date().toISOString(), db: db });
      if (payload.length > MAX_SESSION_BYTES) {
        sessionStorage.removeItem(SESSION_KEY);
        return { ok: false, reason: 'データが大きいためセッション保存をスキップしました（メモリのみ）' };
      }
      sessionStorage.setItem(SESSION_KEY, payload);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: 'セッション保存に失敗: ' + e.message };
    }
  }

  function restoreExperienceFromSession() {
    try {
      var raw = sessionStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return parsed.db || null;
    } catch (e) {
      return null;
    }
  }

  function renderExperienceSummary() {
    var box = el('as-exp-summary');
    if (!box) return;
    if (!state.experience) {
      box.innerHTML = '<p class="text-sm text-ink-lighter">エリア経験データ未読込</p>';
      el('as-exp-warnings').innerHTML = '';
      el('as-exp-list').innerHTML = '';
      return;
    }
    var s = state.experience.stats;
    box.innerHTML =
      '<div class="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-sm">' +
      '<p class="font-bold text-emerald-800">✅ エリア経験データ読み込み完了</p>' +
      '<ul class="mt-2 space-y-0.5 text-slate-700">' +
      '<li>登録ドライバー：<strong>' +
      s.drivers +
      '</strong>名</li>' +
      '<li>登録エリア：<strong>' +
      s.areas +
      '</strong></li>' +
      '<li>経験レコード：<strong>' +
      s.records.toLocaleString() +
      '</strong>件</li>' +
      '<li>最終データ日：<strong>' +
      escapeHtml(s.lastDate || '-') +
      '</strong></li>' +
      '<li>TransportID未紐付け（マスタ）：<strong>' +
      (s.unknownTidCount != null ? s.unknownTidCount : s.unknownTids.length) +
      '</strong>件</li>' +
      '</ul></div>';

    var warnBox = el('as-exp-warnings');
    if (s.unknownTids.length > 0) {
      var wh =
        '<div class="mt-3 p-3 rounded-lg bg-amber-50 border border-amber-300 text-sm">' +
        '<p class="font-bold text-amber-800">⚠ TransportIDがOFK3マスタに存在しません</p>' +
        '<div class="mt-2 max-h-40 overflow-y-auto"><table class="w-full text-xs"><thead><tr>' +
        '<th class="text-left p-1">TransportID</th><th class="text-left p-1">氏名</th><th class="text-left p-1">エリア</th></tr></thead><tbody>';
      for (var i = 0; i < Math.min(s.unknownTids.length, 50); i++) {
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
      if (s.unknownTids.length > 50) wh += '<tr><td colspan="3" class="p-1 text-amber-700">…他 ' + (s.unknownTids.length - 50) + '件</td></tr>';
      wh += '</tbody></table></div></div>';
      warnBox.innerHTML = wh;
    } else {
      warnBox.innerHTML = '';
    }
    renderExperienceList();
  }

  function renderExperienceList() {
    var listEl = el('as-exp-list');
    var searchEl = el('as-exp-search');
    if (!listEl || !state.experience) return;
    var q = (searchEl && searchEl.value ? searchEl.value : '').trim().toLowerCase();
    var drivers = Object.keys(state.experience.byTransportId).sort(function (a, b) {
      var na = state.experience.byTransportId[a].driverName || a;
      var nb = state.experience.byTransportId[b].driverName || b;
      return na.localeCompare(nb, 'ja');
    });

    var html = '';
    var shown = 0;
    for (var i = 0; i < drivers.length; i++) {
      var tid = drivers[i];
      var d = state.experience.byTransportId[tid];
      var name = d.driverName || '(名前なし)';
      if (q && name.toLowerCase().indexOf(q) < 0 && tid.toLowerCase().indexOf(q) < 0) continue;
      shown++;
      var areaKeys = Object.keys(d.areas).sort(function (a, b) {
        return (d.areas[b].experienceDays || 0) - (d.areas[a].experienceDays || 0);
      });
      html += '<div class="border border-border rounded-lg p-3 mb-2 bg-white">';
      html += '<div class="font-bold text-sm">' + escapeHtml(name) + '</div>';
      html += '<div class="text-xs text-ink-lighter font-mono">TransportID ' + escapeHtml(tid) + '</div>';
      html += '<ul class="mt-2 text-xs space-y-1">';
      for (var j = 0; j < areaKeys.length; j++) {
        var ar = d.areas[areaKeys[j]];
        var lv = ar.lastVisitDate ? ar.lastVisitDate.replace(/^(\d{4})-(\d{2})-(\d{2}).*/, '$2/$3') : '-';
        html +=
          '<li><span class="font-medium">' +
          escapeHtml(ar.area) +
          '</span>　' +
          ar.experienceDays +
          '日　最終 ' +
          escapeHtml(lv) +
          '</li>';
      }
      html += '</ul><div class="text-xs text-ink-lighter mt-1">経験エリア数：' + d.areaCount + '</div></div>';
    }
    if (!shown) html = '<p class="text-sm text-ink-lighter">該当ドライバーなし</p>';
    listEl.innerHTML = html;
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
          html +=
            '<li><span class="font-medium">' +
            (r + 1) +
            '. ' +
            escapeHtml(c.driverName) +
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
    renderExperienceSummary();
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
      var known = AssignSupportCore.buildKnownTransportIdSet(typeof transportIDs !== 'undefined' ? transportIDs : {});
      var result = AssignSupportCore.parseExperienceRows(rows, { knownTransportIds: known });
      if (!result.ok) {
        alert(result.error);
        return;
      }
      state.experience = result;
      var persist = tryPersistExperience(result);
      if (!persist.ok) console.warn(persist.reason);
      renderAll();
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
        typeof resolveDriverKey === 'function' ? resolveDriverKey : null,
        typeof transportIDs !== 'undefined' ? transportIDs : {}
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
    var restored = restoreExperienceFromSession();
    if (restored) state.experience = restored;

    bindDropzone('as-exp-dropzone', 'as-exp-input', function (files) {
      loadExperienceFile(files[0]);
    });
    bindDropzone('as-manifest-dropzone', 'as-manifest-input', loadManifestFiles);
    bindDropzone('as-shift-dropzone', 'as-shift-input', function (files) {
      loadShiftFile(files[0]);
    });

    var search = el('as-exp-search');
    if (search) search.addEventListener('input', renderExperienceList);

    var rescue = el('as-rescue-count');
    if (rescue) {
      rescue.addEventListener('change', function () {
        state.rescueCount = Number(rescue.value) || 0;
        renderSuggestions();
      });
    }

    syncShiftFromGlobals();
    renderAll();
  }

  window.AssignSupport = {
    init: init,
    getState: function () {
      return state;
    },
    syncShiftFromGlobals: syncShiftFromGlobals,
    renderAll: renderAll,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
