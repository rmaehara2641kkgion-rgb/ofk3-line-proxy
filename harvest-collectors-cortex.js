/**
 * HARVEST Collectors (Cortex系) - Prototype 0.
 * timeWindow : 13:00必達 Time Window 素材 (entry.packages) の観測・検証
 * bag        : Bag補強 (packageAssistIndex) の観測・検証。dependsOn=['timeWindow']
 *
 * - 独自にサーバーAPIをフェッチしない。必ず window.OFK3Cortex13 の load()/getter 経由。
 * - probe結果 (load() + getter読み取り) は ctx.shared で1回に共有する。
 * - Cortex取得そのものは起動しない。人間が Cortex 拡張で回収・送信した素材を再確認するのみ。
 * - 住所・ドライバー名などPIIは details/errors に入れない (件数とコードのみ)。
 * - テンプレートリテラル不使用。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.HarvestCollectorsCortex = api;
})(this, function () {
  'use strict';

  var TRIGGER_INSTRUCTION = 'Cortex拡張パネルで「取得開始」→「Bag取得」→「OFK3へ送信」を実行';
  var SNAPSHOT_KEY = 'cortex13-snapshot';

  var BAG_SUCCESS = { captured: true, captured_null: true };
  var BAG_UNATTEMPTED = 'not_attempted';

  function todayIsoJst() {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
  }

  function joinKey(routeCode, trackingId) {
    return String(routeCode || '') + '\u0000' + String(trackingId || '').trim();
  }

  function asArray(v) {
    return Array.isArray(v) ? v : [];
  }

  function errMsg(e) {
    return String(e && e.message ? e.message : e).slice(0, 200);
  }

  function numericOnly(obj) {
    var out = {};
    if (!obj || typeof obj !== 'object') return out;
    Object.keys(obj).forEach(function (k) {
      if (typeof obj[k] === 'number' && isFinite(obj[k])) out[k] = obj[k];
    });
    return out;
  }

  function readGetter(api, name) {
    try {
      return typeof api[name] === 'function' ? api[name]() : null;
    } catch (e) {
      return null;
    }
  }

  // env: { getApi(): OFK3Cortex13-like, todayIso(): 'YYYY-MM-DD' }
  function createCortexCollectors(env) {
    env = env || {};
    var getApi = typeof env.getApi === 'function' ? env.getApi : function () {
      return typeof window !== 'undefined' ? window.OFK3Cortex13 : null;
    };
    var todayIso = typeof env.todayIso === 'function' ? env.todayIso : todayIsoJst;

    // 1回のload() + getter読み取り。両Collectorが ctx.shared 経由で共有する。
    function takeSnapshot() {
      var api = getApi();
      if (!api || typeof api.load !== 'function') {
        return Promise.resolve({ available: false });
      }
      var loadError = null;
      return Promise.resolve().then(function () {
        return api.load();
      }).catch(function (e) {
        loadError = errMsg(e);
      }).then(function () {
        var entry = readGetter(api, 'getEntry');
        return {
          available: true,
          loadError: loadError,
          today: todayIso(),
          entry: entry && typeof entry === 'object' ? entry : null,
          packages: asArray(readGetter(api, 'getPackages')),
          assistIndex: asArray(readGetter(api, 'getPackageAssistIndex')),
          assistDiagnostics: readGetter(api, 'getPackageAssistDiagnostics'),
          sequenceIndex: asArray(readGetter(api, 'getPackageSequenceIndex')),
          sequenceDiagnostics: readGetter(api, 'getPackageSequenceDiagnostics'),
          routeStops: asArray(readGetter(api, 'getRouteStops')),
          stops: asArray(readGetter(api, 'getStops'))
        };
      });
    }

    function probeShared(ctx) {
      return ctx.shared(SNAPSHOT_KEY, takeSnapshot);
    }

    function commonFailure(raw) {
      if (!raw || !raw.available) {
        return {
          status: 'error',
          counts: { success: 0, failure: 0, total: 0 },
          errors: [{ code: 'cortex13-api-missing', message: 'OFK3Cortex13 が見つかりません (ofk3-cortex-priority-ui.js 未読込)' }],
          details: {}
        };
      }
      if (raw.loadError) {
        return {
          status: 'error',
          counts: { success: 0, failure: 0, total: 0 },
          errors: [{ code: 'load-exception', message: 'OFK3Cortex13.load() 例外: ' + raw.loadError }],
          details: {}
        };
      }
      return null;
    }

    function payloadReference(kind, raw) {
      return {
        via: 'window.OFK3Cortex13',
        getters: kind === 'bag'
          ? ['getEntry', 'getPackages', 'getPackageAssistIndex', 'getPackageAssistDiagnostics']
          : ['getEntry', 'getPackages', 'getPackageSequenceIndex', 'getRouteStops', 'getStops'],
        localDate: raw && raw.localDate ? raw.localDate : null,
        note: '実データは保持しない。既存 OFK3Cortex13 getter 経由で取得する。再POST・再保存はしない。'
      };
    }

    // ---------- Time Window Collector ----------
    var timeWindow = {
      id: 'timeWindow',
      label: 'Time Window (13:00必達)',
      dependsOn: [],
      trigger: { kind: 'human-external', instruction: TRIGGER_INSTRUCTION },
      probe: probeShared,
      normalize: function (raw) {
        var fail = commonFailure(raw);
        if (fail) return fail;
        var entry = raw.entry;
        var pkgs = raw.packages;
        if (!entry || !pkgs.length) {
          return {
            status: 'awaiting-data',
            counts: { success: 0, failure: 0, total: 0 },
            errors: [{ code: 'no-packages', message: '回収データなし (未送信、または取得失敗のため原因は特定できません)' }],
            details: { localDate: entry ? String(entry.localDate || '') : null, today: raw.today }
          };
        }
        var noKey = 0;
        var noTime = 0;
        var invalid = 0;
        var routes = {};
        pkgs.forEach(function (p) {
          p = p || {};
          var hasKey = !!(p.routeCode && String(p.trackingId || '').trim());
          var hasTime = p.plannedEndTime != null || !!p.plannedEndClock;
          if (!hasKey) noKey += 1;
          if (!hasTime) noTime += 1;
          if (!hasKey || !hasTime) invalid += 1;
          if (p.routeCode) routes[p.routeCode] = true;
        });
        var total = pkgs.length;
        var success = total - invalid;
        var errors = [];
        if (noKey) errors.push({ code: 'package-missing-key', message: 'routeCode/trackingId 欠落のpackage', count: noKey });
        if (noTime) errors.push({ code: 'package-missing-time', message: '時間(plannedEnd)欠落のpackage', count: noTime });

        var seqKeys = {};
        raw.sequenceIndex.forEach(function (r) { if (r) seqKeys[joinKey(r.routeCode, r.trackingId)] = true; });
        var seqMatched = 0;
        pkgs.forEach(function (p) { if (p && seqKeys[joinKey(p.routeCode, p.trackingId)]) seqMatched += 1; });

        var localDate = String(entry.localDate || '');
        var isStale = !!localDate && localDate !== raw.today;
        var status;
        if (isStale) {
          status = 'stale';
          errors.unshift({ code: 'stale-date', message: '本日分でない (データ日付: ' + localDate + ' / 本日: ' + raw.today + ')' });
        } else if (success === 0) {
          status = 'error';
        } else if (invalid > 0) {
          status = 'partial';
        } else {
          status = 'ok';
        }
        return {
          status: status,
          counts: { success: success, failure: invalid, total: total },
          errors: errors,
          details: {
            localDate: localDate,
            today: raw.today,
            stale: isStale,
            packageCount: total,
            routeCount: Object.keys(routes).length,
            stopCount: raw.stops.length,
            routeStopCount: raw.routeStops.length,
            sequenceIndexCount: raw.sequenceIndex.length,
            sequenceMatched: seqMatched,
            sequenceDiagnostics: numericOnly(raw.sequenceDiagnostics)
          }
        };
      },
      summarize: function (result) {
        var d = result.details || {};
        var c = result.counts;
        if (result.status === 'awaiting-data') return 'データなし: 未送信または取得失敗 (13:00 package 0件)';
        if (result.status === 'error' && !d.packageCount) return '検証失敗: ' + ((result.errors[0] && result.errors[0].message) || '');
        var s = 'package ' + c.total + '件 / Route ' + (d.routeCount || 0) + '件 / 有効 ' + c.success + ' 無効 ' + c.failure;
        if (d.stale) s += ' (本日分でない: ' + d.localDate + ')';
        return s;
      },
      handoff: function (result) {
        return { payloadReference: payloadReference('timeWindow', result.details) };
      }
    };

    // ---------- Bag Collector ----------
    var bag = {
      id: 'bag',
      label: 'Bag (13:00 補強)',
      dependsOn: ['timeWindow'],
      trigger: { kind: 'human-external', instruction: TRIGGER_INSTRUCTION },
      probe: probeShared,
      normalize: function (raw) {
        var fail = commonFailure(raw);
        if (fail) return fail;
        var entry = raw.entry;
        var pkgs = raw.packages;
        var assist = raw.assistIndex;
        if (!entry || !pkgs.length || !assist.length) {
          return {
            status: 'awaiting-data',
            counts: { success: 0, failure: 0, total: 0 },
            errors: [{ code: 'no-assist-index', message: 'Route明細/Bag補強データ未回収 (packageAssistIndex 0件)' }],
            details: { assistIndexCount: assist.length, scopePackageCount: pkgs.length, today: raw.today }
          };
        }
        var byKey = {};
        assist.forEach(function (r) { if (r) byKey[joinKey(r.routeCode, r.trackingId)] = r; });

        var statusCounts = {};
        var success = 0;
        var failure = 0;
        var unattempted = 0;
        var noAssistRow = 0;
        var legacyCaptured = 0;
        var legacyUnknown = 0;
        var withBagStatus = 0;
        var skippedInvalidKey = 0;
        pkgs.forEach(function (p) {
          p = p || {};
          if (!p.routeCode || !String(p.trackingId || '').trim()) {
            skippedInvalidKey += 1;
            return;
          }
          var row = byKey[joinKey(p.routeCode, p.trackingId)];
          if (!row) {
            noAssistRow += 1;
            unattempted += 1;
            return;
          }
          var st = row.bagStatus == null || row.bagStatus === '' ? null : String(row.bagStatus);
          if (st) {
            withBagStatus += 1;
            statusCounts[st] = (statusCounts[st] || 0) + 1;
            if (BAG_SUCCESS[st]) success += 1;
            else if (st === BAG_UNATTEMPTED) unattempted += 1;
            else failure += 1;
          } else if (row.bagName || row.bagDisplay) {
            legacyCaptured += 1;
            success += 1;
          } else {
            legacyUnknown += 1;
          }
        });

        var total = pkgs.length - skippedInvalidKey;
        var errors = [];
        Object.keys(statusCounts).forEach(function (st) {
          if (!BAG_SUCCESS[st] && st !== BAG_UNATTEMPTED) {
            errors.push({ code: 'bag-' + st, message: 'Bag取得失敗: ' + st, count: statusCounts[st] });
          }
        });
        if (unattempted) {
          errors.push({ code: 'bag-not-attempted', message: 'Bag未試行 (Route明細なし含む)', count: unattempted });
        }

        var localDate = String(entry.localDate || '');
        var isStale = !!localDate && localDate !== raw.today;
        var status;
        if (isStale) {
          status = 'stale';
          errors.unshift({ code: 'stale-date', message: '本日分でない (データ日付: ' + localDate + ' / 本日: ' + raw.today + ')' });
        } else if (success === 0 && failure === 0) {
          status = 'awaiting-data';
          errors.unshift({ code: 'bag-not-collected', message: 'Bag取得の結果なし (「Bag取得」未実施、または旧データで判別不可)' });
        } else if (failure > 0 && success === 0) {
          status = 'error';
        } else if (failure > 0 || unattempted > 0) {
          status = 'partial';
        } else {
          status = 'ok';
        }
        return {
          status: status,
          counts: { success: success, failure: failure, total: total },
          errors: errors,
          details: {
            localDate: localDate,
            today: raw.today,
            stale: isStale,
            scopePackageCount: total,
            skippedInvalidKey: skippedInvalidKey,
            assistIndexCount: assist.length,
            bagStatusCounts: statusCounts,
            unattempted: unattempted,
            noAssistRow: noAssistRow,
            legacyCaptured: legacyCaptured,
            legacyUnknown: legacyUnknown,
            rowsWithBagStatus: withBagStatus,
            // bagStatus を持たない旧データ行があると「未試行」と「成功+null」を区別できない
            nullDistinguishable: legacyUnknown === 0 && legacyCaptured === 0,
            assistDiagnostics: numericOnly(raw.assistDiagnostics)
          }
        };
      },
      summarize: function (result) {
        var d = result.details || {};
        var c = result.counts;
        if (result.status === 'awaiting-data') return '回収データ待ち: Bag取得結果なし';
        if (result.status === 'error' && !d.scopePackageCount) return '検証失敗: ' + ((result.errors[0] && result.errors[0].message) || '');
        var s = '対象 ' + c.total + '件 / 成功 ' + c.success + ' 失敗 ' + c.failure + ' 未試行 ' + (d.unattempted || 0);
        if (d.legacyUnknown) s += ' / 判別不可 ' + d.legacyUnknown + ' (旧データ: 未試行とnullを区別不可)';
        return s;
      },
      handoff: function (result) {
        return { payloadReference: payloadReference('bag', result.details) };
      }
    };

    return { timeWindow: timeWindow, bag: bag, list: [timeWindow, bag] };
  }

  function registerCortexCollectors(hub, env) {
    var cols = createCortexCollectors(env);
    cols.list.forEach(function (c) { hub.register(c); });
    return cols;
  }

  return {
    TRIGGER_INSTRUCTION: TRIGGER_INSTRUCTION,
    createCortexCollectors: createCortexCollectors,
    registerCortexCollectors: registerCortexCollectors,
    todayIsoJst: todayIsoJst
  };
});
