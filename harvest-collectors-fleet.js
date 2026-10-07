/**
 * HARVEST Collector (台数照合 / GDS) - Prototype 1.
 * fleetCapacity : 台数照合タブに読み込み済みの Cortex GDS Weekly Report と InputFile の
 *                 台数を、取得元の意味のまま (cortexCount / inputCount) 保持する。
 *
 * - 取得元は window.OFK3GdsFleetAudit.getState() のみ (read-only)。
 *   既存GDS処理の起動・再計算・変更はしない。照合結果や判定済みの値は読まない。
 * - 事実の回収だけを行う。件数の比較、不足の算出、重要度の付与、業務判断はしない。
 *   expected / actual への変換は下流 (INOICHI側Adapter) の責務。
 * - category は既存stateのキーをそのまま保持: block6_5 / block4_5 / eightB / bike2h / bike3h。
 *   値が無い・読めない場合は 0 にせず null とし、理由コードを併記する。
 * - state語彙はP0と同じ: awaiting-data / error / partial / ok。stale の独自定義はしない。
 * - provenance は payloadReference.provenance に保持する。存在しない値は推測しない。
 * - 氏名・住所などPIIは扱わない (台数のみ)。
 * - テンプレートリテラル不使用。ネットワーク取得・定期実行・DOM監視は使わない。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.HarvestCollectorsFleet = api;
})(this, function () {
  'use strict';

  var COLLECTOR_ID = 'fleetCapacity';
  var SNAPSHOT_KEY = 'fleet-snapshot';
  var VIA = 'window.OFK3GdsFleetAudit';
  var TRIGGER_INSTRUCTION = '台数照合タブで Cortex GDS Weekly Report(CSV) と InputFile(XLSM) を読み込む';
  var CATEGORIES = ['block6_5', 'block4_5', 'eightB', 'bike2h', 'bike3h'];

  function isObj(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function isCount(v) {
    return typeof v === 'number' && isFinite(v) && v >= 0;
  }

  function hasOwn(o, k) {
    return Object.prototype.hasOwnProperty.call(o, k);
  }

  function errMsg(e) {
    return String(e && e.message ? e.message : e).slice(0, 200);
  }

  function strOrNull(v) {
    return typeof v === 'string' && v !== '' ? v.slice(0, 200) : null;
  }

  function numOrNull(v) {
    return typeof v === 'number' && isFinite(v) ? v : null;
  }

  // state.cortex / state.input の片側を、数値と既存metaだけを複製した値に変換する。
  // 元オブジェクトへの参照は保持しない。
  function extractSide(side) {
    if (side === null || side === undefined) return { state: 'absent' };
    if (!isObj(side)) return { state: 'malformed', reason: 'side-not-object' };
    var fileName = strOrNull(side.fileName);
    if (side.ok === false) {
      return { state: 'failed', fileName: fileName, error: strOrNull(side.error) };
    }
    if (side.ok !== true) return { state: 'malformed', reason: 'ok-flag-missing', fileName: fileName };
    if (!isObj(side.byDate)) return { state: 'malformed', reason: 'byDate-invalid', fileName: fileName };

    var dates = {};
    Object.keys(side.byDate).forEach(function (d) {
      var bucket = side.byDate[d];
      if (!isObj(bucket)) {
        dates[d] = { valid: false, values: {} };
        return;
      }
      var values = {};
      CATEGORIES.forEach(function (k) {
        if (hasOwn(bucket, k)) values[k] = bucket[k];
      });
      dates[d] = { valid: true, values: values };
    });

    var meta = isObj(side.meta) ? side.meta : {};
    return {
      state: 'ready',
      fileName: fileName,
      dates: dates,
      ofk3Rows: numOrNull(meta.ofk3Rows),
      totalRows: numOrNull(meta.totalRows),
      headerRowIndex: numOrNull(meta.headerRowIndex)
    };
  }

  function sideMissingReason(side) {
    if (side.state === 'absent') return 'source-not-loaded';
    if (side.state === 'failed') return 'source-parse-failed';
    return 'source-malformed';
  }

  // 1セル (日付 x category x 片側)。値が無い場合は 0 にせず null + 理由。
  function readCell(side, date, category) {
    if (side.state !== 'ready') return { count: null, missing: sideMissingReason(side) };
    var entry = side.dates[date];
    if (!entry) return { count: null, missing: 'missing-date' };
    if (!entry.valid) return { count: null, missing: 'bucket-invalid' };
    if (!hasOwn(entry.values, category)) return { count: null, missing: 'missing-category' };
    var v = entry.values[category];
    if (!isCount(v)) return { count: null, missing: 'invalid-value' };
    return { count: v, missing: null };
  }

  function sortedDates(sides) {
    var seen = {};
    sides.forEach(function (s) {
      if (s.state === 'ready') Object.keys(s.dates).forEach(function (d) { seen[d] = true; });
    });
    return Object.keys(seen).sort();
  }

  function sideProvenance(side, range) {
    var p = { state: side.state, fileName: side.fileName == null ? null : side.fileName };
    if (side.state === 'ready') {
      var ds = Object.keys(side.dates).sort();
      p.dateFrom = ds.length ? ds[0] : null;
      p.dateTo = ds.length ? ds[ds.length - 1] : null;
      p.dateCount = ds.length;
      p.ofk3Rows = side.ofk3Rows;
      p.totalRows = side.totalRows;
      p.headerRowIndex = side.headerRowIndex;
    }
    return p;
  }

  function fail(code, message) {
    return {
      status: 'error',
      counts: { success: 0, failure: 0, total: 0 },
      errors: [{ code: code, message: message }],
      details: {}
    };
  }

  // env: { getApi(): OFK3GdsFleetAudit-like }
  function createFleetCollector(env) {
    env = env || {};
    var getApi = typeof env.getApi === 'function' ? env.getApi : function () {
      return typeof window !== 'undefined' ? window.OFK3GdsFleetAudit : null;
    };

    function takeSnapshot() {
      var api = getApi();
      if (!api || typeof api.getState !== 'function') return { available: false };
      var st = null;
      try {
        st = api.getState();
      } catch (e) {
        return { available: true, stateError: errMsg(e) };
      }
      if (!isObj(st)) return { available: true, malformed: true };
      return { available: true, cortex: extractSide(st.cortex), input: extractSide(st.input) };
    }

    return {
      id: COLLECTOR_ID,
      label: '台数照合 (GDS)',
      dependsOn: [],
      trigger: { kind: 'human-file-upload', instruction: TRIGGER_INSTRUCTION },
      probe: function (ctx) {
        return ctx.shared(SNAPSHOT_KEY, takeSnapshot);
      },
      normalize: function (raw, ctx) {
        if (!raw || !raw.available) {
          return fail('fleet-api-missing', 'OFK3GdsFleetAudit.getState が見つかりません (ofk3-gds-fleet-audit-ui.js 未読込)');
        }
        if (raw.stateError) return fail('getstate-exception', 'OFK3GdsFleetAudit.getState() 例外: ' + raw.stateError);
        if (raw.malformed || !raw.cortex || !raw.input) {
          return fail('malformed-state', 'getState() の戻り値が想定した構造ではありません');
        }

        var cortex = raw.cortex;
        var input = raw.input;
        var errors = [];

        if (cortex.state === 'absent' && input.state === 'absent') {
          return {
            status: 'awaiting-data',
            counts: { success: 0, failure: 0, total: 0 },
            errors: [{ code: 'no-fleet-files', message: '台数照合ファイル未投入 (Cortex GDS Weekly Report / InputFile)' }],
            details: { sides: { cortex: { state: 'absent' }, input: { state: 'absent' } } }
          };
        }

        [['cortex', cortex], ['input', input]].forEach(function (pair) {
          var name = pair[0];
          var s = pair[1];
          if (s.state === 'absent') errors.push({ code: name + '-not-loaded', message: name + ' 側のファイルが未投入です' });
          else if (s.state === 'failed') errors.push({ code: name + '-parse-failed', message: name + ' 側の読込に失敗: ' + (s.error || '') });
          else if (s.state === 'malformed') errors.push({ code: name + '-malformed', message: name + ' 側のstateが想定した構造ではありません (' + s.reason + ')' });
        });

        if (cortex.state !== 'ready' && input.state !== 'ready') {
          return {
            status: 'error',
            counts: { success: 0, failure: 0, total: 0 },
            errors: errors,
            details: { sides: { cortex: sideProvenance(cortex), input: sideProvenance(input) } }
          };
        }

        var dates = sortedDates([cortex, input]);
        if (!dates.length) {
          errors.push({ code: 'no-dates', message: '読み込み済みファイルに日付データがありません' });
          return {
            status: 'awaiting-data',
            counts: { success: 0, failure: 0, total: 0 },
            errors: errors,
            details: { sides: { cortex: sideProvenance(cortex), input: sideProvenance(input) } }
          };
        }

        var byDate = {};
        var missingReasons = {};
        var success = 0;
        var failure = 0;
        dates.forEach(function (d) {
          var row = {};
          CATEGORIES.forEach(function (k) {
            var c = readCell(cortex, d, k);
            var i = readCell(input, d, k);
            row[k] = { cortexCount: c.count, inputCount: i.count, cortexMissing: c.missing, inputMissing: i.missing };
            if (c.missing) missingReasons['cortex:' + c.missing] = (missingReasons['cortex:' + c.missing] || 0) + 1;
            if (i.missing) missingReasons['input:' + i.missing] = (missingReasons['input:' + i.missing] || 0) + 1;
            if (c.count !== null && i.count !== null) success += 1;
            else failure += 1;
          });
          byDate[d] = row;
        });

        if (failure > 0) {
          errors.push({ code: 'fleet-cell-unavailable', message: '片側または両側の値が取得できない日付 x category', count: failure });
        }

        var observedAt = null;
        try {
          observedAt = ctx && typeof ctx.now === 'function' ? ctx.now() : null;
        } catch (e) {
          observedAt = null;
        }

        return {
          status: failure === 0 ? 'ok' : 'partial',
          counts: { success: success, failure: failure, total: success + failure },
          errors: errors,
          details: {
            categories: CATEGORIES.slice(),
            dateCount: dates.length,
            byDate: byDate,
            missingReasons: missingReasons,
            sides: { cortex: sideProvenance(cortex), input: sideProvenance(input) },
            provenance: {
              via: VIA,
              getter: 'getState',
              observedAt: observedAt,
              loadedAt: null,
              loadedAtNote: '既存stateに読込時刻は無いため保持しない',
              dateFrom: dates[0],
              dateTo: dates[dates.length - 1],
              dates: dates.slice(),
              cortex: sideProvenance(cortex),
              input: sideProvenance(input)
            }
          }
        };
      },
      summarize: function (result) {
        var d = result.details || {};
        var c = result.counts;
        if (result.status === 'awaiting-data') return 'データなし: 台数照合ファイル未投入';
        if (result.status === 'error' && !d.dateCount) return '検証失敗: ' + ((result.errors[0] && result.errors[0].message) || '');
        return d.dateCount + '日 x ' + CATEGORIES.length + 'category / 両側取得 ' + c.success + ' / 取得不可 ' + c.failure
          + ' (cortexCount と inputCount を保持。不足判定は行いません)';
      },
      handoff: function (result) {
        var d = result.details || {};
        return {
          payloadReference: {
            via: VIA,
            getters: ['getState'],
            categories: CATEGORIES.slice(),
            provenance: d.provenance ? JSON.parse(JSON.stringify(d.provenance)) : null,
            note: '実データは保持しない。既存 OFK3GdsFleetAudit.getState() 経由で取得する。cortexCount / inputCount は取得元の値で、expected / actual への変換は下流の責務。'
          }
        };
      }
    };
  }

  function registerFleetCollector(hub, env) {
    var col = createFleetCollector(env);
    hub.register(col);
    return col;
  }

  return {
    COLLECTOR_ID: COLLECTOR_ID,
    CATEGORIES: CATEGORIES.slice(),
    TRIGGER_INSTRUCTION: TRIGGER_INSTRUCTION,
    createFleetCollector: createFleetCollector,
    registerFleetCollector: registerFleetCollector
  };
});
