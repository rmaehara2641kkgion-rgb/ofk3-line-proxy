/**
 * INO-1 ダッシュボードの表示用アダプター。
 *
 * 既存のアラートストア、欠車判定、台数の3点照合、ローリング60hの
 * 結果を共通の表示項目へ揃える。検知ルールは追加しない。
 * 未実装の項目は契約だけを返し、異常としては数えない。
 * 取得できていない台数は null のままにし、0 にはしない。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.InoichiAlertView = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var COMMAND_SCHEMA_VERSION = '1';

  var CATEGORIES = [
    { id: 'fleet_count', label: '台数照合', tab: 'fleet' },
    { id: 'da_shift', label: 'DA・シフト', tab: 'da' },
    { id: 'data_fetch', label: 'データ取得', tab: 'fetch' },
    { id: 'processing_error', label: '処理エラー', tab: 'process' },
    { id: 'system_status', label: 'システム状態', tab: 'system' }
  ];

  var TABS = [
    { id: 'overview', label: '概要' },
    { id: 'fleet', label: '台数照合' },
    { id: 'da', label: 'DA・シフト' },
    { id: 'fetch', label: 'データ取得' },
    { id: 'process', label: '処理エラー' },
    { id: 'system', label: 'システム状態' },
    { id: 'history', label: 'アラート履歴' }
  ];

  var DA_CONTRACT = [
    { id: 'shift_unregistered', label: 'シフト未登録', implemented: false },
    { id: 'da_shortage', label: 'DA割当不足', implemented: false },
    { id: 'da_duplicate', label: '同一DAの重複割当', implemented: false },
    { id: 'cycle_conflict', label: 'サイクル間の配置矛盾', implemented: false },
    { id: 'plan_actual_gap', label: '予定と実績の不一致', implemented: false }
  ];

  var FLEET_SOURCES = [
    { id: 'amazon_input', label: 'Amazon車両台数入力サイト' },
    { id: 'amazon_schedule', label: 'Amazonスケジュール画面' },
    { id: 'internal_excel', label: '社内Excel InputFile' }
  ];

  var SOURCE_LABEL = {
    amazon_input: 'Amazon入力',
    amazon_schedule: 'Amazon予定',
    internal_excel: '社内Excel'
  };

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function isArr(v) { return Array.isArray(v); }

  function businessDate(value) {
    if (value == null || value === '') return '';
    var text = String(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
    var parsed = new Date(text);
    if (isNaN(parsed.getTime())) return '';
    try {
      var parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Tokyo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).formatToParts(parsed);
      var year = '';
      var month = '';
      var day = '';
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].type === 'year') year = parts[i].value;
        if (parts[i].type === 'month') month = parts[i].value;
        if (parts[i].type === 'day') day = parts[i].value;
      }
      if (year && month && day) return year + '-' + month + '-' + day;
    } catch (e) {}
    return '';
  }

  function makeAlert(fields) {
    return {
      alert_id: fields.alert_id,
      category: fields.category,
      severity: fields.severity || 'info',
      status: fields.status || 'unknown',
      source: fields.source || '',
      occurred_at: fields.occurred_at || '',
      updated_at: fields.updated_at || '',
      target_date: fields.target_date || '',
      cycle: fields.cycle || '',
      site: fields.site || '',
      summary: fields.summary || '',
      detail: fields.detail || '',
      action_required: fields.action_required || ''
    };
  }

  function dedupe(list) {
    var map = {};
    var order = [];
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (!item || !item.alert_id) continue;
      if (!Object.prototype.hasOwnProperty.call(map, item.alert_id)) order.push(item.alert_id);
      map[item.alert_id] = item;
    }
    var out = [];
    for (var j = 0; j < order.length; j++) out.push(map[order[j]]);
    return out;
  }

  function storeStatus(status) {
    if (status === 'OPEN' || status === 'ONGOING' || status === 'REOPENED') return 'active';
    if (status === 'RESOLVED') return 'resolved';
    return 'unknown';
  }

  function storeSeverity(severity) {
    if (severity === 'critical' || severity === 'warning' || severity === 'info') return severity;
    return 'info';
  }

  function fromStore(records) {
    var out = [];
    if (!isArr(records)) return out;
    for (var i = 0; i < records.length; i++) {
      var record = records[i];
      if (!isObj(record) || !record.alertKey) continue;
      var evidence = isObj(record.evidence) ? record.evidence : {};
      var summary = '欠車リスク';
      var date = record.localDate || evidence.localDate || '';
      if (date) summary += ' ' + date;
      if (evidence.block) summary += ' / ' + evidence.block;
      if (typeof evidence.shortage === 'number') summary += ' / 不足' + evidence.shortage;
      out.push(makeAlert({
        alert_id: String(record.alertKey),
        category: 'da_shift',
        severity: storeSeverity(record.severity),
        status: storeStatus(record.status),
        source: record.ruleId || record.category || 'fleet-capacity',
        occurred_at: record.firstDetectedAt || '',
        updated_at: record.lastDetectedAt || '',
        target_date: date,
        summary: summary,
        detail: '既存の欠車判定です。',
        action_required: storeStatus(record.status) === 'active' ? '計画台数を確認' : ''
      }));
    }
    return out;
  }

  function divergentSources(counts) {
    var ids = ['amazon_input', 'amazon_schedule', 'internal_excel'];
    var present = [];
    for (var i = 0; i < ids.length; i++) {
      var value = counts[ids[i]];
      if (typeof value === 'number' && isFinite(value)) present.push({ id: ids[i], value: value });
    }
    if (present.length < 2) return [];
    var freq = {};
    for (var j = 0; j < present.length; j++) {
      var key = String(present[j].value);
      freq[key] = (freq[key] || 0) + 1;
    }
    var best = 0;
    var keys = Object.keys(freq);
    for (var k = 0; k < keys.length; k++) {
      if (freq[keys[k]] > best) best = freq[keys[k]];
    }
    if (best === 1) return present.map(function (item) { return item.id; });
    var majority = null;
    for (var m = 0; m < keys.length; m++) {
      if (freq[keys[m]] === best) majority = Number(keys[m]);
    }
    var odd = [];
    for (var n = 0; n < present.length; n++) {
      if (present[n].value !== majority) odd.push(present[n].id);
    }
    return odd;
  }

  function sourceNames(ids) {
    if (!ids || !ids.length) return '';
    if (ids.length >= 3) return '3系統すべて不一致';
    var labels = [];
    for (var i = 0; i < ids.length; i++) labels.push(SOURCE_LABEL[ids[i]] || ids[i]);
    return labels.join('・') + 'が不一致';
  }

  function latestFetched(fetchedAt) {
    if (!isObj(fetchedAt)) return '';
    var ids = ['amazon_input', 'amazon_schedule', 'internal_excel'];
    var best = '';
    for (var i = 0; i < ids.length; i++) {
      var value = fetchedAt[ids[i]];
      if (value && String(value) > best) best = String(value);
    }
    return best;
  }

  function conflictSource(counts) {
    var ids = ['amazon_input', 'amazon_schedule', 'internal_excel'];
    for (var i = 0; i < ids.length; i++) {
      if (Array.isArray(counts[ids[i]])) return ids[i];
    }
    return '';
  }

  function fromThreeWay(threeWay) {
    var alerts = [];
    var rows = [];
    var notes = [];
    if (!isObj(threeWay)) return { alerts: alerts, rows: rows, notes: notes };
    var list = isArr(threeWay.rows) ? threeWay.rows : [];
    for (var i = 0; i < list.length; i++) {
      var row = list[i];
      if (!isObj(row)) continue;
      var counts = isObj(row.counts) ? row.counts : {};
      var odd = row.status === 'mismatch' ? divergentSources(counts) : [];
      var judgment = '判定保留';
      if (row.status === 'match') judgment = '一致';
      else if (row.status === 'mismatch') judgment = '不一致';
      var display = {
        date: row.date || '',
        cycle: row.cycle || '',
        vehicle: row.vehicle || '',
        measure: row.measure || '',
        site: row.site || row.node || '',
        counts: {
          amazon_input: counts.amazon_input == null ? null : counts.amazon_input,
          amazon_schedule: counts.amazon_schedule == null ? null : counts.amazon_schedule,
          internal_excel: counts.internal_excel == null ? null : counts.internal_excel
        },
        judgment: judgment,
        divergentLabel: row.status === 'mismatch' ? sourceNames(odd) : (row.status === 'source_conflict' ? '同一ソース内で数値が衝突' : (row.status === 'missing' ? '未取得の系統がある' : '')),
        note: row.note || ''
      };
      rows.push(display);
      var identity = ['fleet', display.date, display.cycle, display.vehicle, display.measure].join('|');
      var seenAt = latestFetched(row.fetchedAt);
      if (row.status === 'mismatch') {
        alerts.push(makeAlert({
          alert_id: identity,
          category: 'fleet_count',
          severity: 'warning',
          status: 'active',
          source: odd.join(','),
          occurred_at: seenAt,
          updated_at: seenAt,
          target_date: display.date,
          cycle: display.cycle,
          site: display.site,
          summary: (display.date || '日付未確認') + ' ' + (display.cycle || 'サイクル未確認') + ' ' + (display.vehicle || '') + ' 台数不一致',
          detail: display.divergentLabel || '3系統の台数が一致しない',
          action_required: '不一致の系統を確認'
        }));
      } else if (row.status === 'source_conflict') {
        alerts.push(makeAlert({
          alert_id: 'conflict|' + identity,
          category: 'processing_error',
          severity: 'warning',
          status: 'active',
          source: conflictSource(counts),
          occurred_at: seenAt,
          updated_at: seenAt,
          target_date: display.date,
          cycle: display.cycle,
          site: display.site,
          summary: '同一ソース内の数値が衝突',
          detail: row.note || '同じソースから違う台数が来ています',
          action_required: '取得結果を確認'
        }));
      }
    }
    var splits = isArr(threeWay.measureSplits) ? threeWay.measureSplits : [];
    for (var s = 0; s < splits.length; s++) {
      var split = splits[s];
      if (!isObj(split)) continue;
      notes.push((split.date || '日付未確認') + ' ' + (split.cycle || '') + ' ' + (split.vehicle || '') + ' ' + (split.note || '人数とコース台数は別件数'));
    }
    var rejected = isArr(threeWay.rejected) ? threeWay.rejected : [];
    for (var r = 0; r < rejected.length; r++) {
      var bad = rejected[r] || {};
      var problems = isArr(bad.problems) ? bad.problems.join(',') : '';
      alerts.push(makeAlert({
        alert_id: ['reject', r, bad.source || '', bad.date || '', bad.cycle || '', problems].join('|'),
        category: 'processing_error',
        severity: 'warning',
        status: 'active',
        source: bad.source || '',
        occurred_at: bad.fetchedAt || '',
        updated_at: bad.fetchedAt || '',
        target_date: bad.date || '',
        cycle: bad.cycle || '',
        summary: '台数データの形式が不正',
        detail: problems ? ('不足している項目: ' + problems) : '照合できる形ではありません',
        action_required: '入力形式を確認'
      }));
    }
    return { alerts: alerts, rows: rows, notes: notes };
  }

  function connectionLabel(connection) {
    if (connection === 'connected') return '接続済み';
    if (connection === 'not_connected') return '未接続';
    if (connection === 'not_fetched') return '未取得';
    if (connection === 'failed') return '取得失敗';
    if (connection === 'partial') return '一部未取得';
    if (connection === 'stale') return '古い';
    return '未確認';
  }

  function blockedMap(threeWay) {
    var map = {};
    var list = threeWay && isArr(threeWay.blockedSources) ? threeWay.blockedSources : [];
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (!isObj(item) || !item.source) continue;
      map[item.source] = item.reason || '未接続';
    }
    return map;
  }

  function buildFleetSources(threeWay) {
    var sources = [];
    var blocked = blockedMap(threeWay);
    var rows = threeWay && isArr(threeWay.rows) ? threeWay.rows : [];
    for (var i = 0; i < FLEET_SOURCES.length; i++) {
      var spec = FLEET_SOURCES[i];
      var seen = 0;
      var missing = 0;
      var latest = '';
      for (var r = 0; r < rows.length; r++) {
        var counts = isObj(rows[r].counts) ? rows[r].counts : {};
        var fetched = isObj(rows[r].fetchedAt) ? rows[r].fetchedAt[spec.id] : '';
        if (fetched && String(fetched) > latest) latest = String(fetched);
        var value = counts[spec.id];
        if (value == null || value === '') missing += 1;
        else seen += 1;
      }
      var connection = 'not_connected';
      var result = '未接続';
      var reason = '台数照合の入力が渡されていません';
      if (threeWay && blocked[spec.id] && seen === 0) {
        connection = /見つかりません|形式|不正/.test(blocked[spec.id]) ? 'failed' : 'not_connected';
        result = connection === 'failed' ? '取得失敗' : '未接続';
        reason = blocked[spec.id];
      } else if (threeWay && seen === 0) {
        connection = blocked[spec.id] ? 'not_connected' : 'not_fetched';
        result = connection === 'not_connected' ? '未接続' : '未取得';
        reason = blocked[spec.id] || 'このソースの台数は届いていません';
      } else if (threeWay && (missing > 0 || blocked[spec.id] || threeWay.acquisitionComplete === false)) {
        connection = 'partial';
        result = missing > 0 ? '一部未取得' : '取得済み（完了未確認）';
        reason = blocked[spec.id] || (threeWay.acquisitionComplete === false ? '取得完了とは記録されていません' : '');
      } else if (threeWay) {
        connection = 'connected';
        result = '取得済み';
        reason = '';
      }
      sources.push({
        id: spec.id,
        name: spec.label,
        connection: connection,
        connectionLabel: connectionLabel(connection),
        lastFetchedAt: latest,
        lastResult: result,
        failureReason: reason,
        freshness: connection === 'stale' ? '古い' : '未確認'
      });
    }
    return sources;
  }

  function rollingSource(view) {
    view = isObj(view) ? view : {};
    var status = view.fetchStatus || 'missing';
    var connection = 'unknown';
    if (status === 'success') connection = 'connected';
    else if (status === 'failed') connection = 'failed';
    else if (status === 'expired') connection = 'stale';
    else if (status === 'missing') connection = 'not_fetched';
    return {
      id: 'rolling60h',
      name: 'ローリング60h集計',
      connection: connection,
      connectionLabel: connectionLabel(connection),
      lastFetchedAt: view.checkedAt || '',
      lastResult: view.fetchLabel || connectionLabel(connection),
      failureReason: (status === 'failed' || status === 'expired') ? (view.fetchLabel || connectionLabel(connection)) : '',
      freshness: status === 'expired' ? '古い' : '未確認'
    };
  }

  function capacitySource(state) {
    var diagnostics = isObj(state.diagnostics) ? state.diagnostics : {};
    var sample = !!(state.meta && state.meta.sampleMode);
    var inputs = diagnostics.inputCount || 0;
    var missing = diagnostics.missingActualCount || 0;
    var connection = 'unknown';
    var result = '未確認';
    var reason = '';
    if (sample) {
      connection = 'not_connected';
      result = 'サンプル（本番未接続）';
      reason = '本番の計画台数には接続していません';
    } else if (!inputs) {
      connection = 'unknown';
      result = '未確認';
    } else if (missing > 0) {
      connection = 'partial';
      result = '一部未取得';
      reason = 'actual未取得 ' + missing + '件';
    } else {
      connection = 'connected';
      result = '取得済み';
    }
    return {
      id: 'fleet_capacity_input',
      name: '欠車判定の計画台数',
      connection: connection,
      connectionLabel: connectionLabel(connection),
      lastFetchedAt: diagnostics.lastEvaluatedAt || '',
      lastResult: result,
      failureReason: reason,
      freshness: '未確認'
    };
  }

  function fromRolling(view) {
    var out = [];
    if (!isObj(view) || !isArr(view.alerts)) return out;
    if (view.fetchStatus !== 'success') return out;
    for (var i = 0; i < view.alerts.length; i++) {
      var row = view.alerts[i];
      if (!isObj(row)) continue;
      var disposition = row.disposition || '';
      var change = row.change || '';
      var status = '';
      var severity = 'info';
      if (change === '超過解消' || disposition === 'resolved') {
        status = 'resolved';
      } else if (disposition === 'exceed') {
        status = 'active';
        severity = 'critical';
      } else if (disposition === 'partial-exceed' || disposition === 'approach' || disposition === 'partial-approach') {
        status = 'active';
        severity = 'warning';
      } else if (disposition === 'undetermined') {
        status = 'unknown';
      } else {
        continue;
      }
      out.push(makeAlert({
        alert_id: ['rolling', row.name || 'unknown', row.endDate || '', disposition, change].join('|'),
        category: 'da_shift',
        severity: severity,
        status: status,
        source: 'rolling60h',
        occurred_at: row.checkedAt || view.checkedAt || '',
        updated_at: row.checkedAt || view.checkedAt || '',
        target_date: row.endDate || '',
        summary: 'ローリング60h ' + (row.statusLabel || disposition || '未確認'),
        detail: '既存のローリング60h検知です。',
        action_required: status === 'active' ? '勤務時間を確認' : ''
      }));
    }
    return out;
  }

  function fromDiagnostics(diagnostics) {
    var out = [];
    diagnostics = isObj(diagnostics) ? diagnostics : {};
    if (diagnostics.invalidCount > 0) {
      out.push(makeAlert({
        alert_id: 'process|invalid-canonical',
        category: 'processing_error',
        severity: 'warning',
        status: 'active',
        source: 'fleet-capacity',
        occurred_at: diagnostics.lastEvaluatedAt || '',
        updated_at: diagnostics.lastEvaluatedAt || '',
        summary: '形式が不正な入力が ' + diagnostics.invalidCount + '件',
        detail: '既存の診断で数えた不正入力です。',
        action_required: '入力形式を確認'
      }));
    }
    if (diagnostics.persistenceErrors) {
      out.push(makeAlert({
        alert_id: 'process|persistence',
        category: 'processing_error',
        severity: 'warning',
        status: 'active',
        source: 'alert-store',
        occurred_at: '',
        updated_at: diagnostics.lastEvaluatedAt || '',
        summary: '保存に失敗した記録があります',
        detail: 'アラートストアの保存エラーです。',
        action_required: '保存状態を確認'
      }));
    }
    return out;
  }

  function countToday(alerts, today, severity) {
    var count = 0;
    for (var i = 0; i < alerts.length; i++) {
      var item = alerts[i];
      if (!item || item.status !== 'active') continue;
      if (!today || item.target_date !== today) continue;
      if (severity && item.severity !== severity) continue;
      if (!severity && item.severity !== 'critical' && item.severity !== 'warning' && item.severity !== 'info') continue;
      count += 1;
    }
    return count;
  }

  function latestStamp(alerts) {
    var latest = '';
    for (var i = 0; i < alerts.length; i++) {
      var stamp = alerts[i].updated_at || alerts[i].occurred_at || '';
      if (stamp >= latest) latest = stamp;
    }
    return latest;
  }

  function highestSeverity(alerts) {
    var rank = { critical: 3, warning: 2, info: 1 };
    var best = '';
    var score = 0;
    for (var i = 0; i < alerts.length; i++) {
      var next = rank[alerts[i].severity] || 0;
      if (next > score) {
        score = next;
        best = alerts[i].severity;
      }
    }
    return best;
  }

  function activeProblems(alerts, category) {
    var out = [];
    for (var i = 0; i < alerts.length; i++) {
      var item = alerts[i];
      if (item.category !== category || item.status !== 'active') continue;
      if (item.severity === 'critical' || item.severity === 'warning') out.push(item);
    }
    return out;
  }

  function fetchHeadline(sources) {
    var connections = [];
    for (var i = 0; i < sources.length; i++) connections.push(sources[i].connection);
    if (connections.indexOf('failed') >= 0) return '取得失敗';
    if (connections.indexOf('stale') >= 0) return '古いデータ';
    if (connections.indexOf('not_connected') >= 0) return '未接続';
    if (connections.indexOf('not_fetched') >= 0) return '未取得';
    if (connections.indexOf('partial') >= 0) return '一部未取得';
    if (connections.length && connections.every(function (item) { return item === 'connected'; })) return '取得済み';
    return '未確認';
  }

  function cardBase(id, label, tab) {
    return {
      id: id,
      label: label,
      tab: tab,
      tone: 'unknown',
      countLabel: '—',
      severityLabel: '未確認',
      lastAt: '',
      summary: '未確認'
    };
  }

  function severityWord(severity) {
    if (severity === 'critical') return '重大';
    if (severity === 'warning') return '注意';
    if (severity === 'info') return '情報';
    return '未確認';
  }

  function fleetCard(threeWay, fleetRows, fleetSources, alerts) {
    var card = cardBase('fleet_count', '台数照合', 'fleet');
    if (!threeWay) {
      card.summary = '未接続';
      return card;
    }
    var problems = activeProblems(alerts, 'fleet_count');
    if (problems.length) {
      card.tone = highestSeverity(problems) === 'critical' ? 'critical' : 'warning';
      card.countLabel = String(problems.length);
      card.severityLabel = severityWord(highestSeverity(problems));
      card.lastAt = latestStamp(problems);
      card.summary = '不一致' + problems.length + '件';
      return card;
    }
    var pending = 0;
    for (var i = 0; i < fleetRows.length; i++) {
      if (fleetRows[i].judgment === '判定保留') pending += 1;
    }
    if (pending) {
      card.summary = '判定保留';
      return card;
    }
    var incomplete = threeWay.acquisitionComplete === false;
    var bad = false;
    for (var s = 0; s < fleetSources.length; s++) {
      if (fleetSources[s].connection !== 'connected') bad = true;
    }
    if (incomplete || bad) {
      var failed = false;
      var partial = false;
      var missing = false;
      for (var f = 0; f < fleetSources.length; f++) {
        if (fleetSources[f].connection === 'failed') failed = true;
        if (fleetSources[f].connection === 'partial') partial = true;
        if (fleetSources[f].connection === 'not_fetched') missing = true;
      }
      if (failed) card.summary = '取得失敗';
      else if (partial) card.summary = '一部未取得';
      else if (missing) card.summary = '未取得';
      else card.summary = '未接続';
      return card;
    }
    var matches = 0;
    for (var m = 0; m < fleetRows.length; m++) {
      if (fleetRows[m].judgment === '一致') matches += 1;
    }
    if (matches > 0) {
      card.tone = 'clear';
      card.countLabel = '0';
      card.severityLabel = '正常';
      card.summary = '一致';
      return card;
    }
    return card;
  }

  function daCard(alerts, rollingView) {
    var card = cardBase('da_shift', 'DA・シフト', 'da');
    var problems = activeProblems(alerts, 'da_shift');
    var unknown = false;
    for (var i = 0; i < alerts.length; i++) {
      if (alerts[i].category === 'da_shift' && alerts[i].status === 'unknown') unknown = true;
    }
    var unimplemented = false;
    for (var c = 0; c < DA_CONTRACT.length; c++) {
      if (!DA_CONTRACT[c].implemented) unimplemented = true;
    }
    var rollingState = isObj(rollingView) ? (rollingView.fetchStatus || 'missing') : 'missing';
    if (problems.length) {
      var severity = highestSeverity(problems);
      card.tone = severity === 'critical' ? 'critical' : 'warning';
      card.countLabel = String(problems.length);
      card.severityLabel = severityWord(severity);
      card.lastAt = latestStamp(problems);
      card.summary = '異常' + problems.length + '件';
      if (unimplemented) card.summary += '。未実装の検知があります';
      return card;
    }
    if (unimplemented || unknown || rollingState !== 'success') {
      card.summary = unimplemented ? '未実装の検知があります' : '未確認';
      if (rollingState !== 'success') card.summary += '。ローリング60hは未取得';
      return card;
    }
    card.tone = 'clear';
    card.countLabel = '0';
    card.severityLabel = '正常';
    card.summary = '異常なし';
    return card;
  }

  function fetchCard(sources) {
    var card = cardBase('data_fetch', 'データ取得', 'fetch');
    var headline = fetchHeadline(sources);
    card.summary = headline;
    if (headline === '取得済み') {
      card.tone = 'clear';
      card.countLabel = '0';
      card.severityLabel = '正常';
      return card;
    }
    if (headline === '取得失敗' || headline === '古いデータ') {
      var count = 0;
      for (var i = 0; i < sources.length; i++) {
        if (sources[i].connection === 'failed' || sources[i].connection === 'stale') count += 1;
      }
      card.tone = 'warning';
      card.countLabel = String(count);
      card.severityLabel = '注意';
      return card;
    }
    return card;
  }

  function processingEvaluated(diagnostics, threeWay) {
    diagnostics = isObj(diagnostics) ? diagnostics : {};
    if (diagnostics.inputCount > 0) return true;
    if (diagnostics.persistenceErrors === true) return true;
    if (threeWay && ((isArr(threeWay.rows) && threeWay.rows.length > 0) || (isArr(threeWay.rejected) && threeWay.rejected.length > 0))) return true;
    return false;
  }

  function processCard(alerts, evaluated) {
    var card = cardBase('processing_error', '処理エラー', 'process');
    var problems = activeProblems(alerts, 'processing_error');
    if (problems.length) {
      var severity = highestSeverity(problems);
      card.tone = severity === 'critical' ? 'critical' : 'warning';
      card.countLabel = String(problems.length);
      card.severityLabel = severityWord(severity);
      card.lastAt = latestStamp(problems);
      card.summary = problems[0].summary;
      return card;
    }
    if (!evaluated) {
      card.summary = '未確認';
      return card;
    }
    card.tone = 'clear';
    card.countLabel = '0';
    card.severityLabel = '正常';
    card.summary = '異常なし';
    return card;
  }

  function systemCard(meta, processProblems) {
    var card = cardBase('system_status', 'システム状態', 'system');
    if (processProblems.length) {
      card.tone = 'warning';
      card.severityLabel = '注意';
      card.summary = 'エラーあり';
      card.lastAt = latestStamp(processProblems);
      return card;
    }
    card.summary = meta && meta.sampleMode ? 'サンプル表示' : '未確認';
    return card;
  }

  function uniqueSorted(values) {
    var seen = {};
    var out = [];
    for (var i = 0; i < values.length; i++) {
      var value = values[i];
      if (!value || seen[value]) continue;
      seen[value] = true;
      out.push(value);
    }
    out.sort();
    return out;
  }

  function monitoredText(diagnostics, threeWay, rollingView) {
    diagnostics = isObj(diagnostics) ? diagnostics : {};
    var fleet = diagnostics.inputCount > 0 ? String(diagnostics.inputCount) + '件' : '未確認';
    var compared = '未接続';
    if (threeWay && isArr(threeWay.rows)) compared = String(threeWay.rows.length) + '行';
    var drivers = '未確認';
    var counts = rollingView && isObj(rollingView.counts) ? rollingView.counts : {};
    if (typeof counts.driverCount === 'number') drivers = String(counts.driverCount) + '名';
    return '欠車判定 ' + fleet + ' / 台数照合 ' + compared + ' / ローリング60h ' + drivers;
  }

  function buildCommandCenter(state) {
    state = isObj(state) ? state : {};
    var meta = isObj(state.meta) ? state.meta : {};
    var diagnostics = isObj(state.diagnostics) ? state.diagnostics : {};
    var rollingView = isObj(state.rollingView) ? state.rollingView : { fetchStatus: 'missing', alerts: [] };
    var threeWay = isObj(state.threeWay) ? state.threeWay : null;
    var fleet = fromThreeWay(threeWay);
    var alerts = dedupe([].concat(
      fromStore(state.alertHistory),
      fromRolling(rollingView),
      fleet.alerts,
      fromDiagnostics(diagnostics)
    ));
    alerts.sort(function (a, b) {
      return String(a.occurred_at).localeCompare(String(b.occurred_at));
    });
    var fleetSources = buildFleetSources(threeWay);
    var sources = fleetSources.concat([rollingSource(rollingView), capacitySource(state)]);
    var today = businessDate(meta.generatedAt);
    var evaluated = processingEvaluated(diagnostics, threeWay);
    var processProblems = activeProblems(alerts, 'processing_error');
    var categories = [
      fleetCard(threeWay, fleet.rows, fleetSources, alerts),
      daCard(alerts, rollingView),
      fetchCard(sources),
      processCard(alerts, evaluated),
      systemCard(meta, processProblems)
    ];
    var dates = [];
    var cycles = [];
    for (var i = 0; i < alerts.length; i++) {
      dates.push(alerts[i].target_date);
      cycles.push(alerts[i].cycle);
    }
    for (var r = 0; r < fleet.rows.length; r++) {
      dates.push(fleet.rows[r].date);
      cycles.push(fleet.rows[r].cycle);
    }
    var unconnected = [];
    for (var d = 0; d < DA_CONTRACT.length; d++) {
      if (!DA_CONTRACT[d].implemented) unconnected.push(DA_CONTRACT[d].label);
    }
    for (var s = 0; s < fleetSources.length; s++) {
      if (fleetSources[s].connection === 'not_connected') unconnected.push(fleetSources[s].name);
    }
    var available = [];
    if (meta.generatedAt) available.push('画面生成時刻');
    available.push('アラートストア');
    if (diagnostics.inputCount > 0) available.push('欠車判定の入力');
    if (threeWay) available.push('台数照合の結果');
    if (rollingView.fetchStatus) available.push('ローリング60hの取得状態');
    return {
      schemaVersion: COMMAND_SCHEMA_VERSION,
      today: today,
      runningLabel: meta.sampleMode ? 'サンプル表示' : '未確認',
      todayTotal: today ? countToday(alerts, today) : null,
      critical: today ? countToday(alerts, today, 'critical') : null,
      warning: today ? countToday(alerts, today, 'warning') : null,
      fetchLabel: fetchHeadline(sources),
      updatedAt: meta.generatedAt || '',
      categories: categories,
      alerts: alerts,
      fleetRows: fleet.rows,
      fleetNotes: fleet.notes,
      sources: sources,
      daContract: DA_CONTRACT.map(function (item) {
        return { id: item.id, label: item.label, implemented: item.implemented };
      }),
      dates: uniqueSorted(dates),
      cycles: uniqueSorted(cycles),
      system: {
        running: meta.sampleMode ? 'サンプル表示（本番未接続）' : '未確認',
        lastSuccess: processProblems.length ? '' : (diagnostics.lastEvaluatedAt || ''),
        lastError: processProblems.length ? processProblems[0].summary : '',
        monitored: monitoredText(diagnostics, threeWay, rollingView),
        unconnected: unconnected,
        available: available,
        dataSource: meta.dataSource || ''
      },
      processingEvaluated: evaluated
    };
  }

  return {
    COMMAND_SCHEMA_VERSION: COMMAND_SCHEMA_VERSION,
    CATEGORIES: CATEGORIES,
    TABS: TABS,
    DA_CONTRACT: DA_CONTRACT,
    businessDate: businessDate,
    dedupe: dedupe,
    divergentSources: divergentSources,
    buildCommandCenter: buildCommandCenter
  };
}));
