/**
 * OFK3 ローリングシフト アラート者判定 — 純粋ロジック（DOM・XLSX・fs 非依存）
 *
 * 「対象日（基準日）を当日とした直近7暦日 = 過去6日 + 当日」を判定する。
 * 既存の RollingCore（rolling60h-core.js）の日次系列（buildContinuousDailySeries /
 * mergeActualAndRoster の出力）を入力にし、勤務記号の時間表・パーサは再実装しない。
 * RollingCore.computeRolling60h（任意7日窓の全スライド判定）は変更しない。
 *
 * 判定ルール（rolling-alert-v1）:
 *   - 過去6日は実績優先（日ごとの source で実績/予定を区別）。当日は勤務予定時間。
 *   - 60h超 = 超過。ちょうど60hは超過ではない。
 *   - 実績だけで60h超 → 超過確定 / 予定を含めて60h超 → 超過予測
 *   - 接近警告: 過去6日が49〜60h、かつ当日の勤務が確認できる（当日>0h）人だけ。
 *     当日休は除外。当日予定が不明なら「勤務予定未確認」。
 *     過去6日＋当日が60h超になる場合は超過予測を優先（接近と二重計上しない）。
 *   - 空白セル・データ無し・未定義記号の日は 0h にしない（未取得として扱う）。
 *     過去6日に未取得日があり超過でもない人は「判定不能」（アラート一覧には載せない）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.RollingAlertCore = api;
})(this, function () {
  'use strict';

  var RULE_VERSION = 'rolling-alert-v1';
  var SCHEMA_VERSION = 1;
  var LIMIT_HOURS = 60;
  var APPROACH_FROM_HOURS = 49;

  var CLASS_LABEL = {
    exceed_confirmed: '超過確定',
    exceed_forecast: '超過予測',
    approach: '接近警告',
    schedule_unconfirmed: '勤務予定未確認',
    undetermined: '判定不能',
    day_off: '当日休（除外）',
    normal: '該当なし',
  };
  var ALERT_CLASSES = ['exceed_confirmed', 'exceed_forecast', 'approach', 'schedule_unconfirmed'];

  function r2(n) {
    return Math.round(n * 100) / 100;
  }

  function addDays(dateStr, n) {
    var p = dateStr.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
    return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2);
  }

  /** 日次レコード（RollingCore.buildDayRecord の出力）→ 時間・出所・未取得理由 */
  function readDay(date, rec) {
    if (!rec || rec.noData) return { date: date, hours: null, source: null, missing: 'no-data' };
    if (rec.hasUnconfirmed) return { date: date, hours: null, source: null, missing: 'unconfirmed' };
    if (rec.hasUndefinedHours) return { date: date, hours: null, source: null, missing: 'undefined-code' };
    if (!rec.blocks || rec.blocks.length === 0) {
      // 空白セルを 0h（休）と断定しない。明示の「休」だけが 0h。
      return { date: date, hours: null, source: null, missing: 'blank' };
    }
    var hasActual = rec.blocks.some(function (b) { return b.source === 'actual'; });
    return {
      date: date,
      hours: r2(rec.dailyTotalHours),
      actualHours: r2(rec.actualHours || 0),
      source: hasActual ? 'actual' : 'roster',
      missing: null,
    };
  }

  var MISSING_LABEL = {
    'no-data': 'データなし',
    unconfirmed: '未確定の空白',
    blank: '空白',
    'undefined-code': '時間未定義の記号',
  };

  function fmt(h) {
    return r2(h).toFixed(1) + 'h';
  }

  /**
   * 1人分を判定する。
   * @param {{key:string, meta:{name:string,transportId?:string,company?:string}, series:Array}} driver
   *        series は RollingCore.buildContinuousDailySeries 系の日次レコード配列
   * @param {{targetDate:string, limitHours?:number, approachFromHours?:number}} opts
   */
  function evaluateDriver(driver, opts) {
    var target = opts.targetDate;
    var limit = opts.limitHours != null ? opts.limitHours : LIMIT_HOURS;
    var approachFrom = opts.approachFromHours != null ? opts.approachFromHours : APPROACH_FROM_HOURS;

    var byDate = {};
    (driver.series || []).forEach(function (d) { byDate[d.date] = d; });

    var past = [];
    for (var i = 6; i >= 1; i--) {
      var pd = addDays(target, -i);
      past.push(readDay(pd, byDate[pd]));
    }
    var today = readDay(target, byDate[target]);

    var pastKnown = 0;
    var pastActual = 0; // 実績由来の時間のみ
    var pastPlan = 0;
    var missingPast = [];
    past.forEach(function (d) {
      if (d.missing) { missingPast.push(d.date); return; }
      pastKnown += d.hours;
      if (d.source === 'actual') pastActual += d.hours;
      else pastPlan += d.hours;
    });
    pastKnown = r2(pastKnown);
    pastActual = r2(pastActual);
    pastPlan = r2(pastPlan);
    var pastComplete = missingPast.length === 0;

    var todayStatus = today.missing ? 'unknown' : today.hours > 0 ? 'work' : 'off';
    var todayHours = today.missing ? null : today.hours;
    var totalKnown = r2(pastKnown + (todayHours || 0));
    var totalHours = todayHours === null ? null : totalKnown;
    var lowerBound = !pastComplete || todayStatus === 'unknown';

    var cls;
    var basis;
    var gapNote = missingPast.length > 0
      ? '／未取得 ' + missingPast.length + '日（' + missingPast.map(function (d) { return d.slice(5); }).join(',') + '）は加算していません'
      : '';
    if (pastActual > limit) {
      cls = 'exceed_confirmed';
      basis = '過去6日の実績 ' + fmt(pastActual) + ' が ' + fmt(limit) + ' を超過（実績のみで確定。当日予定は加算前）' + gapNote;
    } else if (totalKnown > limit) {
      cls = 'exceed_forecast';
      basis = '過去6日 ' + fmt(pastKnown) + (pastPlan > 0 ? '（うち予定 ' + fmt(pastPlan) + '）' : '') +
        (todayHours !== null ? ' ＋ 当日予定 ' + fmt(todayHours) : '') + ' = ' + fmt(totalKnown) + ' が ' + fmt(limit) + ' を超過（予定を含む予測）' + gapNote;
    } else if (!pastComplete) {
      cls = 'undetermined';
      basis = '過去6日に未取得日があり判定できません（' + missingPast.map(function (d) {
        var m = past.filter(function (x) { return x.date === d; })[0].missing;
        return d.slice(5) + ':' + MISSING_LABEL[m];
      }).join('、') + '）。既知分 ' + fmt(pastKnown);
    } else {
      var inBand = pastKnown >= approachFrom && pastKnown <= limit;
      if (todayStatus === 'unknown') {
        if (inBand) {
          cls = 'schedule_unconfirmed';
          basis = '過去6日 ' + fmt(pastKnown) + '（' + fmt(approachFrom) + '〜' + fmt(limit) + '）だが当日の勤務予定が未確認（' + MISSING_LABEL[today.missing] + '）';
        } else {
          cls = 'normal';
          basis = '過去6日 ' + fmt(pastKnown) + ' は接近範囲外。当日予定は未確認';
        }
      } else if (todayStatus === 'off') {
        cls = inBand ? 'day_off' : 'normal';
        basis = inBand
          ? '過去6日 ' + fmt(pastKnown) + ' だが当日は休みのため接近警告から除外'
          : '過去6日 ' + fmt(pastKnown) + '、当日休。合計 ' + fmt(totalKnown) + ' で ' + fmt(limit) + ' 以内';
      } else if (inBand) {
        cls = 'approach';
        basis = '過去6日 ' + fmt(pastKnown) + '（' + fmt(approachFrom) + '〜' + fmt(limit) + '）＋ 当日予定 ' + fmt(todayHours) + ' = ' + fmt(totalKnown) + '（' + fmt(limit) + ' 以内）';
      } else {
        cls = 'normal';
        basis = '過去6日 ' + fmt(pastKnown) + ' ＋ 当日予定 ' + fmt(todayHours) + ' = ' + fmt(totalKnown) + '（' + fmt(limit) + ' 以内）';
      }
    }

    var ref = totalHours !== null ? totalHours : pastKnown;
    if (cls === 'exceed_confirmed') ref = Math.max(ref, pastActual);
    var meta = driver.meta || {};
    return {
      driverKey: driver.key,
      name: meta.name || '',
      transportId: meta.transportId || '',
      company: meta.company || '',
      targetDate: target,
      alertClass: cls,
      label: CLASS_LABEL[cls],
      past6Hours: pastComplete ? pastKnown : null,
      past6KnownHours: pastKnown,
      past6ActualHours: pastActual,
      past6PlanHours: pastPlan,
      past6MissingDates: missingPast,
      todayStatus: todayStatus,
      todayHours: todayHours,
      todayMissingReason: today.missing || null,
      rollingTotalHours: totalHours,
      // 正 = 60hまでの残り、負 = 超過。未取得日/当日未確認を含む場合は既知分だけの参考値（remainingExact:false）
      remainingHours: r2(limit - ref),
      remainingExact: !lowerBound,
      basis: basis,
      days: past.concat([today]).map(function (d) {
        return { date: d.date, hours: d.hours, source: d.source, missing: d.missing };
      }),
    };
  }

  /** 非暗号の安定ハッシュ（cyrb53）。重複投入の検知用で、改ざん耐性は目的外。 */
  function hashString(str) {
    var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (var i = 0; i < str.length; i++) {
      var ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
  }

  function fingerprintOf(results, targetDate, limit, approachFrom) {
    var rows = results.map(function (r) {
      return [r.driverKey, r.days.map(function (d) { return d.date + ':' + d.hours + ':' + d.source + ':' + d.missing; }).join(',')].join('|');
    }).sort();
    return hashString([RULE_VERSION, targetDate, limit, approachFrom].concat(rows).join('\n'));
  }

  function classRank(cls) {
    return ALERT_CLASSES.indexOf(cls);
  }

  /**
   * ドライバー群からスナップショット（画面表示・保存の単位）を作る。
   * ドライバーキー（Transport ID、無ければ氏名）ごとに1件。同一キーは後勝ちで二重計上しない。
   * @param {Array} drivers
   * @param {{targetDate:string, dataImportedAt:string, computedAt:string, sources?:Array, limitHours?:number, approachFromHours?:number}} ctx
   */
  function buildSnapshot(drivers, ctx) {
    var limit = ctx.limitHours != null ? ctx.limitHours : LIMIT_HOURS;
    var approachFrom = ctx.approachFromHours != null ? ctx.approachFromHours : APPROACH_FROM_HOURS;
    var byKey = {};
    (drivers || []).forEach(function (d) {
      byKey[d.key] = evaluateDriver(d, { targetDate: ctx.targetDate, limitHours: limit, approachFromHours: approachFrom });
    });
    var results = Object.keys(byKey).map(function (k) { return byKey[k]; });
    var counts = { driverCount: results.length, skippedShortSeries: ctx.skippedShortSeries || 0 };
    Object.keys(CLASS_LABEL).forEach(function (c) { counts[c] = 0; });
    results.forEach(function (r) { counts[r.alertClass]++; });
    var alerts = results
      .filter(function (r) { return ALERT_CLASSES.indexOf(r.alertClass) >= 0; })
      .sort(function (a, b) {
        var d = classRank(a.alertClass) - classRank(b.alertClass);
        if (d) return d;
        var ta = a.rollingTotalHours != null ? a.rollingTotalHours : a.past6KnownHours;
        var tb = b.rollingTotalHours != null ? b.rollingTotalHours : b.past6KnownHours;
        if (tb !== ta) return tb - ta;
        return String(a.name).localeCompare(String(b.name), 'ja');
      });
    counts.alertCount = alerts.length;
    return {
      schemaVersion: SCHEMA_VERSION,
      ruleVersion: RULE_VERSION,
      targetDate: ctx.targetDate,
      limitHours: limit,
      approachFromHours: approachFrom,
      dataImportedAt: ctx.dataImportedAt || null,
      computedAt: ctx.computedAt,
      sources: ctx.sources || [],
      inputFingerprint: fingerprintOf(results, ctx.targetDate, limit, approachFrom),
      counts: counts,
      alerts: alerts,
    };
  }

  // ---- 保存データの検証（サーバー受信時・復元時）----
  var LIMITS = {
    maxAlerts: 2000,
    maxSources: 10,
    maxStr: 200,
    maxBasis: 600,
    maxNum: 1000,
    futureSkewMs: 10 * 60 * 1000, // 端末時計のずれ許容（未来方向）
    targetDateWindowDays: 400,
  };
  var TODAY_STATUS = ['work', 'off', 'unknown'];
  var DAY_SOURCE = [null, 'actual', 'roster'];
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  function isDate(v) {
    if (typeof v !== 'string' || !DATE_RE.test(v)) return false;
    var t = Date.parse(v + 'T00:00:00Z');
    return !isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
  }
  function str(v, max) {
    return typeof v === 'string' ? v.slice(0, max || LIMITS.maxStr) : '';
  }
  function numOrNull(v) {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'number' || !isFinite(v) || Math.abs(v) > LIMITS.maxNum) throw new Error('number');
    return v;
  }
  function iso(v, field, now, allowNull) {
    if (v === null || v === undefined) {
      if (allowNull) return null;
      throw new Error(field);
    }
    var t = typeof v === 'string' ? Date.parse(v) : NaN;
    if (isNaN(t) || t > now + LIMITS.futureSkewMs || t < Date.UTC(2020, 0, 1)) throw new Error(field);
    return new Date(t).toISOString();
  }

  function sanitizeAlert(a) {
    if (!a || typeof a !== 'object') throw new Error('alert-item');
    if (ALERT_CLASSES.indexOf(a.alertClass) < 0) throw new Error('alert-class');
    if (typeof a.driverKey !== 'string' || !a.driverKey || a.driverKey.length > LIMITS.maxStr) throw new Error('driver-key');
    if (!isDate(a.targetDate)) throw new Error('alert-target-date');
    if (TODAY_STATUS.indexOf(a.todayStatus) < 0) throw new Error('today-status');
    if (typeof a.remainingExact !== 'boolean') throw new Error('remaining-exact');
    if (!Array.isArray(a.days) || a.days.length > 7) throw new Error('days');
    if (!Array.isArray(a.past6MissingDates) || a.past6MissingDates.length > 6 || !a.past6MissingDates.every(isDate)) throw new Error('missing-dates');
    return {
      driverKey: a.driverKey,
      name: str(a.name),
      transportId: str(a.transportId, 64),
      company: str(a.company),
      targetDate: a.targetDate,
      alertClass: a.alertClass,
      label: CLASS_LABEL[a.alertClass],
      past6Hours: numOrNull(a.past6Hours),
      past6KnownHours: numOrNull(a.past6KnownHours),
      past6ActualHours: numOrNull(a.past6ActualHours),
      past6PlanHours: numOrNull(a.past6PlanHours),
      past6MissingDates: a.past6MissingDates.slice(),
      todayStatus: a.todayStatus,
      todayHours: numOrNull(a.todayHours),
      todayMissingReason: a.todayMissingReason == null ? null : str(a.todayMissingReason, 40),
      rollingTotalHours: numOrNull(a.rollingTotalHours),
      remainingHours: numOrNull(a.remainingHours),
      remainingExact: a.remainingExact,
      basis: str(a.basis, LIMITS.maxBasis),
      days: a.days.map(function (d) {
        if (!d || !isDate(d.date) || DAY_SOURCE.indexOf(d.source === undefined ? null : d.source) < 0) throw new Error('day');
        return { date: d.date, hours: numOrNull(d.hours), source: d.source === undefined ? null : d.source, missing: d.missing == null ? null : str(d.missing, 40) };
      }),
    };
  }

  /**
   * 外部から届いた/復元したスナップショットを検査し、既知の項目だけで作り直す。
   * 未知の項目は捨てる。形式・サイズ・日時が不正なら ok:false（呼び出し側は既存結果を触らない）。
   * @return {{ok:true, snapshot:Object}|{ok:false, reason:string}}
   */
  function sanitizeSnapshot(s, options) {
    var now = options && options.now != null ? options.now : Date.now();
    try {
      if (!s || typeof s !== 'object' || Array.isArray(s)) return { ok: false, reason: 'not-object' };
      if (s.schemaVersion !== SCHEMA_VERSION) return { ok: false, reason: 'schema-version' };
      if (s.ruleVersion !== RULE_VERSION) return { ok: false, reason: 'rule-version' };
      if (!isDate(s.targetDate)) return { ok: false, reason: 'target-date' };
      var dayDiff = Math.abs(Date.parse(s.targetDate + 'T00:00:00Z') - now) / 86400000;
      if (dayDiff > LIMITS.targetDateWindowDays) return { ok: false, reason: 'target-date-range' };
      if (typeof s.inputFingerprint !== 'string' || !/^[0-9a-f]{1,32}$/.test(s.inputFingerprint)) return { ok: false, reason: 'fingerprint' };
      if (!Array.isArray(s.alerts) || s.alerts.length > LIMITS.maxAlerts) return { ok: false, reason: 'alerts' };
      if (!s.counts || typeof s.counts !== 'object' || Array.isArray(s.counts)) return { ok: false, reason: 'counts' };
      var computedAt, importedAt;
      try {
        computedAt = iso(s.computedAt, 'computed-at', now, false);
        importedAt = iso(s.dataImportedAt, 'data-imported-at', now, true);
      } catch (e) { return { ok: false, reason: e.message }; }
      var counts = {};
      Object.keys(CLASS_LABEL).concat(['driverCount', 'alertCount', 'skippedShortSeries']).forEach(function (k) {
        var v = s.counts[k];
        if (v === undefined && k === 'skippedShortSeries') v = 0;
        if (typeof v !== 'number' || !isFinite(v) || v < 0 || v > 1e6 || Math.floor(v) !== v) throw new Error('counts');
        counts[k] = v;
      });
      var seen = {};
      var alerts = s.alerts.map(function (a) {
        var clean = sanitizeAlert(a);
        if (seen[clean.driverKey]) throw new Error('duplicate-driver');
        seen[clean.driverKey] = true;
        return clean;
      });
      if (counts.alertCount !== alerts.length) return { ok: false, reason: 'counts-mismatch' };
      var sources = Array.isArray(s.sources) ? s.sources.slice(0, LIMITS.maxSources).map(function (x) { return str(x, 120); }) : [];
      return {
        ok: true,
        snapshot: {
          schemaVersion: SCHEMA_VERSION,
          ruleVersion: RULE_VERSION,
          targetDate: s.targetDate,
          limitHours: numOrNull(s.limitHours),
          approachFromHours: numOrNull(s.approachFromHours),
          dataImportedAt: importedAt,
          computedAt: computedAt,
          sources: sources,
          inputFingerprint: s.inputFingerprint,
          counts: counts,
          alerts: alerts,
        },
      };
    } catch (e) {
      return { ok: false, reason: e && e.message ? e.message : 'invalid' };
    }
  }

  function validateSnapshot(s, options) {
    var r = sanitizeSnapshot(s, options);
    return r.ok ? { ok: true } : r;
  }

  /** 表示中の対象日（基準日）と異なるスナップショットは古い結果として扱う */
  function isStale(snapshot, currentTargetDate) {
    return !snapshot || snapshot.targetDate !== currentTargetDate;
  }

  return {
    RULE_VERSION: RULE_VERSION,
    SCHEMA_VERSION: SCHEMA_VERSION,
    LIMIT_HOURS: LIMIT_HOURS,
    APPROACH_FROM_HOURS: APPROACH_FROM_HOURS,
    CLASS_LABEL: CLASS_LABEL,
    ALERT_CLASSES: ALERT_CLASSES,
    evaluateDriver: evaluateDriver,
    buildSnapshot: buildSnapshot,
    validateSnapshot: validateSnapshot,
    sanitizeSnapshot: sanitizeSnapshot,
    LIMITS: LIMITS,
    isStale: isStale,
    hashString: hashString,
  };
});
