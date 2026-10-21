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
    var counts = { driverCount: results.length };
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

  /** 保存・復元されたスナップショットの形を検査する（サーバー受信時・復元時に使用） */
  function validateSnapshot(s) {
    if (!s || typeof s !== 'object') return { ok: false, reason: 'not-object' };
    if (s.schemaVersion !== SCHEMA_VERSION) return { ok: false, reason: 'schema-version' };
    if (typeof s.targetDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s.targetDate)) return { ok: false, reason: 'target-date' };
    if (typeof s.computedAt !== 'string' || isNaN(Date.parse(s.computedAt))) return { ok: false, reason: 'computed-at' };
    if (s.dataImportedAt != null && (typeof s.dataImportedAt !== 'string' || isNaN(Date.parse(s.dataImportedAt)))) return { ok: false, reason: 'data-imported-at' };
    if (typeof s.inputFingerprint !== 'string' || !s.inputFingerprint) return { ok: false, reason: 'fingerprint' };
    if (!Array.isArray(s.alerts) || s.alerts.length > 5000) return { ok: false, reason: 'alerts' };
    if (!s.counts || typeof s.counts !== 'object') return { ok: false, reason: 'counts' };
    var seen = {};
    for (var i = 0; i < s.alerts.length; i++) {
      var a = s.alerts[i];
      if (!a || ALERT_CLASSES.indexOf(a.alertClass) < 0 || typeof a.driverKey !== 'string') return { ok: false, reason: 'alert-item' };
      if (seen[a.driverKey]) return { ok: false, reason: 'duplicate-driver' };
      seen[a.driverKey] = true;
    }
    return { ok: true };
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
    isStale: isStale,
    hashString: hashString,
  };
});
