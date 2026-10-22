/**
 * 既存の suspectView を INO-1 の通知へ写す。
 * 照合や未起動判定はしない。疑いと判定不能は未起動に数えない。
 */
var MentorStartupCycle = (function () {
  try { return require('./mentor-startup-cycle.js'); }
  catch (e) { return null; }
})();

(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MentorStartupNotice = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var ACTIVE = '現在Active確認候補';
  var ENDED = '当日終了履歴あり（参考）';
  var SUSPECT = 'Mentor未起動疑い（要確認）';
  var UNKNOWN = '判定不能（原因付き）';

  function isObj(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function cycleOf(value) {
    return typeof value === 'string' && /^[1-9][0-9]{0,2}$/.test(value) ? value : null;
  }

  function stamp(value) {
    return typeof value === 'string' && value ? value : null;
  }

  function count(value) {
    return typeof value === 'number' && isFinite(value) ? value : null;
  }

  function storedName(value) {
    if (typeof value !== 'string') return '';
    var text = value.trim();
    if (!text || text === '要確認' || text === '取得不可') return '';
    return text;
  }

  function blankCounts() {
    return { total: 0, active: 0, ended: 0, suspect: 0, undetermined: 0 };
  }

  function addCount(counts, status) {
    counts.total += 1;
    if (status === ACTIVE) counts.active += 1;
    else if (status === ENDED) counts.ended += 1;
    else if (status === SUSPECT) counts.suspect += 1;
    else counts.undetermined += 1;
  }

  function fromSuspectView(view, meta) {
    meta = isObj(meta) ? meta : {};
    var counts = isObj(view && view.counts) ? view.counts : {};
    var sources = {
      scheduling: isObj(view) && typeof (view.sources && view.sources.scheduling) === 'string' ? view.sources.scheduling : 'missing',
      mentor: isObj(view) && typeof (view.sources && view.sources.mentor) === 'string' ? view.sources.mentor : 'missing'
    };
    var evaluated = count(counts.total);
    var active = count(counts.active);
    var ended = count(counts.ended);
    var suspect = count(counts.suspect);
    var undetermined = count(counts.undetermined);
    var reason = '判定不能';
    if (!isObj(view)) reason = '未取得';
    else if (sources.scheduling === 'failed') reason = 'スケジュール取得失敗';
    else if (sources.scheduling === 'missing') reason = 'スケジュール未取得';
    else if (sources.mentor === 'failed') reason = 'Mentor取得失敗';
    else if (sources.mentor === 'missing') reason = 'Mentor未取得';
    else if (sources.scheduling === 'stale' || sources.mentor === 'stale' || view.reason === '15分超過') reason = '期限切れ';
    else if (view.enabled !== true || view.reason) reason = 'データ未取得';
    else if ((suspect || 0) > 0) reason = '未起動疑い';
    else if ((undetermined || 0) > 0) reason = '判定不能';
    else if ((evaluated || 0) > 0 && evaluated === (active || 0) + (ended || 0)) reason = '未起動者なし';
    var outcome = reason === '未起動者なし' ? 'clear' : (reason === '未起動疑い' || reason === '判定不能' ? 'withheld' : 'unavailable');
    var identities = Array.isArray(meta.identities) ? meta.identities : [];
    var unconfirmed = [];
    (Array.isArray(view && view.rows) ? view.rows : []).forEach(function (row, index) {
      if (!isObj(row) || (row.status !== SUSPECT && row.status !== UNKNOWN)) return;
      var identity = isObj(identities[index]) ? identities[index] : {};
      unconfirmed.push({
        schedulingId: typeof identity.schedulingId === 'string' ? identity.schedulingId : '',
        name: storedName(row.schedulingName),
        status: row.status,
        cause: typeof row.cause === 'string' ? row.cause : ''
      });
    });
    return {
      version: 1,
      date: isObj(view) && typeof view.date === 'string' && view.date ? view.date : null,
      cycle: cycleOf(meta.cycle),
      cycleReason: typeof meta.cycleReason === 'string' ? meta.cycleReason : '',
      scheduledCount: null,
      evaluatedCount: evaluated,
      activeCandidateCount: active,
      endedReferenceCount: ended,
      suspectCount: suspect,
      undeterminedCount: undetermined,
      confirmedUnstartedCount: 0,
      confirmedUnstarted: [],
      unconfirmed: unconfirmed,
      schedulingCapturedAt: stamp(meta.schedulingCapturedAt),
      mentorCapturedAt: stamp(meta.mentorCapturedAt),
      judgedAt: stamp(meta.judgedAt),
      sample: meta.sample === true,
      outcome: outcome,
      outcomeReason: reason,
      sources: sources
    };
  }

  function noticeForRows(view, meta, rows, identities, cycle, cycleReason) {
    var counts = blankCounts();
    rows.forEach(function (row) { addCount(counts, row && row.status); });
    var sliced = {
      enabled: view.enabled,
      reason: view.reason,
      date: view.date,
      counts: counts,
      sources: view.sources,
      rows: rows
    };
    var notice = fromSuspectView(sliced, {
      cycle: cycle,
      cycleReason: cycleReason,
      identities: identities,
      schedulingCapturedAt: meta.schedulingCapturedAt,
      mentorCapturedAt: meta.mentorCapturedAt,
      judgedAt: meta.judgedAt,
      sample: meta.sample === true
    });
    notice.confirmedUnstartedCount = 0;
    notice.confirmedUnstarted = [];
    return notice;
  }

  function noticesFromSuspectView(view, meta) {
    meta = isObj(meta) ? meta : {};
    var base = fromSuspectView(view, {
      identities: meta.identities,
      schedulingCapturedAt: meta.schedulingCapturedAt,
      mentorCapturedAt: meta.mentorCapturedAt,
      judgedAt: meta.judgedAt,
      sample: meta.sample === true
    });
    if (base.outcome === 'unavailable' || !Array.isArray(meta.assignments)) {
      if (!base.cycle) base.cycleReason = base.outcome === 'unavailable' ? base.outcomeReason : (MentorStartupCycle ? MentorStartupCycle.NO_FIELD : '');
      return [base];
    }
    var rows = Array.isArray(view.rows) ? view.rows : [];
    var identities = Array.isArray(meta.identities) ? meta.identities : [];
    if (!rows.length) {
      base.cycle = null;
      base.cycleReason = MentorStartupCycle ? MentorStartupCycle.NO_ASSIGNMENT : '';
      return [base];
    }
    var byId = MentorStartupCycle.routesByTransportId(meta.assignments);
    var buckets = Object.create(null);
    rows.forEach(function (row, index) {
      var identity = isObj(identities[index]) ? identities[index] : {};
      var id = typeof identity.schedulingId === 'string' ? identity.schedulingId : '';
      var judged = MentorStartupCycle.cycleForRoutes(id && byId[id] ? byId[id] : []);
      var key = judged.cycle || '';
      if (!buckets[key]) buckets[key] = { cycle: judged.cycle, reason: judged.reason, rows: [], identities: [] };
      if (buckets[key].reason && buckets[key].reason !== judged.reason) buckets[key].reason = 'サイクル未確定';
      buckets[key].rows.push(row);
      buckets[key].identities.push(identity);
    });
    return Object.keys(buckets).sort().map(function (key) {
      var bucket = buckets[key];
      return noticeForRows(view, meta, bucket.rows, bucket.identities, bucket.cycle, bucket.reason);
    });
  }

  function overallFromNotices(notices) {
    var list = (Array.isArray(notices) ? notices : []).filter(isObj);
    var first = list[0] || null;
    if (!first) return null;
    var unavailable = list.some(function (notice) { return notice.outcome === 'unavailable'; });
    var seen = Object.create(null);
    var suspect = 0;
    var undetermined = 0;
    var people = [];
    if (!unavailable) {
      list.forEach(function (notice) {
        (Array.isArray(notice.unconfirmed) ? notice.unconfirmed : []).forEach(function (row) {
          if (!isObj(row)) return;
          var id = typeof row.schedulingId === 'string' ? row.schedulingId : '';
          if (id) {
            if (seen[id]) return;
            seen[id] = true;
          }
          if (row.status === SUSPECT) suspect += 1;
          else if (row.status === UNKNOWN) undetermined += 1;
          people.push({ schedulingId: id, name: typeof row.name === 'string' ? row.name : '', status: row.status || '' });
        });
      });
    }
    return {
      version: 1,
      scope: 'overall',
      date: first.date || null,
      cycle: null,
      suspectCount: unavailable ? null : suspect,
      undeterminedCount: unavailable ? null : undetermined,
      confirmedUnstartedCount: 0,
      confirmedUnstarted: [],
      unconfirmed: people,
      sample: list.some(function (notice) { return notice.sample === true; }),
      outcome: unavailable ? 'unavailable' : 'withheld',
      outcomeReason: unavailable ? (first.outcomeReason || '未取得') : '全体',
      schedulingCapturedAt: first.schedulingCapturedAt || null,
      mentorCapturedAt: first.mentorCapturedAt || null,
      judgedAt: first.judgedAt || null
    };
  }

  return {
    ACTIVE: ACTIVE,
    ENDED: ENDED,
    SUSPECT: SUSPECT,
    UNKNOWN: UNKNOWN,
    fromSuspectView: fromSuspectView,
    noticesFromSuspectView: noticesFromSuspectView,
    overallFromNotices: overallFromNotices
  };
});
