(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.InoichiLiveMonitor = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * INO-1 live monitor state builder.
   *
   * Pure function over what OFK3 already computed. It never recomputes
   * Rolling60h hours and never turns missing data into "normal" or "0".
   */

  var STATUS = {
    OK: 'ok',                  // 正常: real data fetched and judged normal
    WARN: 'warn',              // 警告: risk detected from real data
    UNDETERMINED: 'undetermined', // 未判定: required data is missing
    FAILED: 'failed',          // 取得失敗: source unreachable / invalid
    STALE: 'stale',            // データ遅延: last update older than allowed
    UNSUPPORTED: 'unsupported' // 未対応: not implemented yet
  };

  var STATUS_LABEL = {
    ok: '正常',
    warn: '警告',
    undetermined: '未判定',
    failed: '取得失敗',
    stale: 'データ遅延',
    unsupported: '未対応'
  };

  // Allowed age of the OFK3 feed's own calculation time.
  var DEFAULT_STALE_MS = 15 * 60 * 1000;

  var GAP_REASON = {
    'update-stopped': 'Amazon実績の保管が前日分まで届いていません（更新停止）',
    'not-archived': '実績がまだ保管されていません',
    'actuals-insufficient': '過去6日の実績が不足しているため判定できません',
    'shift-missing': '必要な日のシフトが無いため判定できません',
    'ambiguous-shift': '対象のシフトファイルを一意に特定できません',
    'shift-unmatched': 'シフトと実績を照合できた対象者がいません'
  };

  var CATEGORY_LABEL = {
    forecast_exceed: '60時間超過見込み',
    approach: '60時間接近',
    duty_unconfirmed: '勤務未確定（判定不能）',
    insufficient: '判定不能'
  };

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function isArr(v) { return Array.isArray(v); }
  function toMs(v) {
    if (!v) return NaN;
    var t = new Date(v).getTime();
    return t;
  }

  function card(id, title, status, reason, extra) {
    var c = {
      id: id,
      title: title,
      status: status,
      statusLabel: STATUS_LABEL[status],
      reason: reason || '',
      source: '',
      judgedAt: null,
      sourceUpdatedAt: null,
      metrics: [],
      rows: [],
      notes: []
    };
    if (extra) Object.keys(extra).forEach(function (k) { c[k] = extra[k]; });
    return c;
  }

  function classifyAlerts(alerts) {
    var out = { exceed: [], approach: [], undetermined: [] };
    alerts.forEach(function (a) {
      if (!isObj(a)) return;
      if (a.category === 'forecast_exceed') out.exceed.push(a);
      else if (a.category === 'approach') out.approach.push(a);
      else out.undetermined.push(a);
    });
    return out;
  }

  function alertRow(a) {
    return {
      driver: a.driver || '氏名未設定',
      transportId: a.transportId || '',
      scope: a.scope === 'tomorrow' ? '翌日' : (a.scope === 'today' ? '当日' : ''),
      category: a.category || '',
      categoryLabel: CATEGORY_LABEL[a.category] || '判定不能',
      period: a.period || '',
      forecastHours: typeof a.forecastHours === 'number' ? a.forecastHours : null,
      requiredCutHours: typeof a.requiredCutHours === 'number' ? a.requiredCutHours : null,
      avoidable: typeof a.avoidable === 'boolean' ? a.avoidable : null,
      reason: a.reason || ''
    };
  }

  /**
   * fetchResult: { ok, payload, error, fetchedAt, source }
   *   payload = OFK3 GET /harvest/rolling60h/alerts body (already computed by OFK3)
   */
  function judgeRolling60h(fetchResult, nowMs, opts) {
    opts = opts || {};
    var staleMs = typeof opts.staleMs === 'number' ? opts.staleMs : DEFAULT_STALE_MS;
    var title = 'Rolling60h';
    var f = isObj(fetchResult) ? fetchResult : {};
    var source = f.source || 'OFK3 /harvest/rolling60h/alerts';

    if (!f.ok) {
      return card('rolling60h', title, STATUS.FAILED,
        'OFK3 から取得できません（' + (f.error || 'unknown') + '）。値は表示しません。',
        { source: source });
    }
    var p = f.payload;
    if (!isObj(p) || p.app !== 'harvest-rolling60h' || !isArr(p.alerts)) {
      return card('rolling60h', title, STATUS.FAILED,
        'OFK3 の応答が想定の形式ではありません。値は表示しません。', { source: source });
    }

    var judgedAt = p.checkedAt || null;
    var base = {
      source: source,
      judgedAt: judgedAt,
      sourceUpdatedAt: p.actualThrough || null,
      referenceDate: p.referenceDate || ''
    };
    var gap = typeof p.gap === 'string' ? p.gap : '';

    if (p.ok !== true || p.connected !== true) {
      var undetStatus = (gap === 'update-stopped' || gap === 'not-archived') ? STATUS.STALE : STATUS.UNDETERMINED;
      var why = GAP_REASON[gap] || 'OFK3 側で必要なデータが揃っていないため判定できません（未取得）';
      return card('rolling60h', title, undetStatus, why, base);
    }

    var cls = classifyAlerts(p.alerts);
    var rows = [];
    cls.exceed.concat(cls.approach, cls.undetermined).forEach(function (a) { rows.push(alertRow(a)); });

    var metrics = [
      { label: '60時間超過見込み', value: cls.exceed.length },
      { label: '60時間接近', value: cls.approach.length },
      { label: '判定不能', value: cls.undetermined.length }
    ];

    var notes = [
      '残り稼働可能時間・連続勤務・12時間超過リスクはOFK3の現行フィードに含まれないため未対応です（INO-1では独自計算しません）。'
    ];

    var status;
    var reason;
    var judgedMs = toMs(judgedAt);
    var feedStale = p.stale === true || (!isNaN(judgedMs) && nowMs - judgedMs > staleMs);
    if (!judgedAt || isNaN(judgedMs)) feedStale = true;

    if (feedStale) {
      status = STATUS.STALE;
      reason = 'OFK3 の判定が許容時間を超えて古いため、現在値として扱いません。';
    } else if (cls.exceed.length || cls.approach.length) {
      status = STATUS.WARN;
      reason = '超過見込み ' + cls.exceed.length + ' 名 / 接近 ' + cls.approach.length + ' 名'
        + (cls.undetermined.length ? ' / 判定不能 ' + cls.undetermined.length + ' 名（安全扱いにしていません）' : '');
    } else if (cls.undetermined.length || p.safe !== true) {
      status = STATUS.UNDETERMINED;
      reason = '判定不能 ' + cls.undetermined.length + ' 名。超過は検出されていませんが、安全とは判定できません。';
    } else {
      status = STATUS.OK;
      reason = 'OFK3 の判定で超過・接近・判定不能は検出されていません。';
    }

    base.metrics = metrics;
    base.rows = rows;
    base.notes = notes;
    return card('rolling60h', title, status, reason, base);
  }

  // ---- Mentor (OFK3 GET /mentor-startup/notice) ----
  // Reads the notice OFK3 already built from its own suspectView. No matching or
  // classification is redone here; INO-1 only maps the result to display states.

  var MENTOR_STALE_MS = 15 * 60 * 1000; // same limit as mentor-startup-schedule.js
  var MENTOR_OUTCOMES = { clear: true, withheld: true, unavailable: true };
  var MENTOR_STATUS_LABEL = {
    'Mentor未起動疑い（要確認）': 'Mentor未起動疑い（要確認）',
    '判定不能（原因付き）': '判定不能（原因付き）'
  };

  function ageMs(iso, nowMs) {
    var t = Date.parse(iso || '');
    return isFinite(t) ? nowMs - t : Infinity;
  }

  // Same rule as OFK3: scheduling capture, Mentor capture and judgment must all be <= 15 min old.
  function mentorFresh(n, nowMs, limit) {
    return ageMs(n.schedulingCapturedAt, nowMs) <= limit
      && ageMs(n.mentorCapturedAt, nowMs) <= limit
      && ageMs(n.judgedAt, nowMs) <= limit;
  }

  function numOrNull(v) { return typeof v === 'number' && isFinite(v) ? v : null; }

  function noticesOf(p) {
    if (isArr(p.notices) && p.notices.length) return p.notices;
    if (typeof p.outcome === 'string' && p.version === 1) return [p];
    return [];
  }

  function judgeMentor(fetchResult, nowMs, opts) {
    var title = 'Mentor監視';
    if (fetchResult === undefined) {
      return card('mentor', title, STATUS.UNSUPPORTED,
        'Mentor起動状況のデータ源が未接続です。未起動0件ではなく「未判定」として扱います。', { source: '未接続' });
    }
    var limit = opts && typeof opts.mentorStaleMs === 'number' ? opts.mentorStaleMs : MENTOR_STALE_MS;
    var f = isObj(fetchResult) ? fetchResult : {};
    var source = f.source || 'OFK3 /mentor-startup/notice';
    if (!f.ok) {
      return card('mentor', title, STATUS.FAILED,
        'OFK3 から取得できません（' + (f.error || 'unknown') + '）。値は表示しません。', { source: source });
    }
    var p = f.payload;
    // OFK3 single-cycle responses are the stored notice itself (no `ok`), with `notices` attached.
    if (!isObj(p) || !(p.ok === true || isArr(p.notices))) {
      return card('mentor', title, STATUS.FAILED, 'OFK3 の応答が想定の形式ではありません。値は表示しません。', { source: source });
    }
    var raw = noticesOf(p);
    var bad = raw.some(function (n) { return !isObj(n) || !MENTOR_OUTCOMES[n.outcome]; });
    if (bad) {
      return card('mentor', title, STATUS.FAILED, 'OFK3 の Mentor 通知の形式が想定外です。値は表示しません。', { source: source });
    }
    if (!raw.length) {
      return card('mentor', title, STATUS.UNDETERMINED,
        'OFK3 にMentor起動通知がまだありません（未取得）。拡張機能・Scheduling・Mentor のタブが取得を送っていない可能性があります。未起動0件とは扱いません。',
        { source: source, notes: ['対象ドライバー数・起動確認数・未起動疑い数は取得できていません。'] });
    }

    var sumKeys = { evaluated: 'evaluatedCount', active: 'activeCandidateCount', ended: 'endedReferenceCount', suspect: 'suspectCount', undetermined: 'undeterminedCount' };
    var totals = { evaluated: 0, active: 0, ended: 0, suspect: 0, undetermined: 0 };
    var usable = 0;
    var unavailable = 0;
    var stale = 0;
    var rows = [];
    var notes = [];
    var cycles = [];
    var anyUnknownCount = false;
    var oldestJudged = null;
    var oldestCapture = null;
    var firstDate = '';
    var allClear = true;

    raw.forEach(function (n) {
      var cyc = typeof n.cycle === 'string' && n.cycle ? 'サイクル' + n.cycle : 'サイクル不明';
      if (!firstDate && typeof n.date === 'string') firstDate = n.date;
      [n.schedulingCapturedAt, n.mentorCapturedAt].forEach(function (t) {
        var ms = Date.parse(t || '');
        if (isFinite(ms) && (oldestCapture === null || ms < Date.parse(oldestCapture))) oldestCapture = t;
      });
      var jms = Date.parse(n.judgedAt || '');
      if (isFinite(jms) && (oldestJudged === null || jms < Date.parse(oldestJudged))) oldestJudged = n.judgedAt;

      var src = isObj(n.sources) ? n.sources : {};
      var basis = cyc + ': スケジュール=' + (src.scheduling || '不明') + ' / Mentor=' + (src.mentor || '不明')
        + (n.cycleReason ? ' / サイクル判定理由=' + n.cycleReason : '');

      if (n.outcome === 'unavailable') {
        unavailable += 1;
        allClear = false;
        notes.push(basis + ' — 判定不可（' + (n.outcomeReason || '未取得') + '）');
        rows.push({ driver: cyc, scope: '', category: 'cycle', categoryLabel: '判定不可', period: '', forecastHours: null, reason: n.outcomeReason || '未取得' });
        return;
      }
      if (!mentorFresh(n, nowMs, limit)) {
        stale += 1;
        allClear = false;
        notes.push(basis + ' — 取得が15分を超えて古いため現在値として扱いません');
        rows.push({ driver: cyc, scope: '', category: 'cycle', categoryLabel: 'データ遅延', period: '', forecastHours: null, reason: '期限切れ（15分超）' });
        return;
      }
      usable += 1;
      cycles.push(cyc);
      Object.keys(sumKeys).forEach(function (k) {
        var v = numOrNull(n[sumKeys[k]]);
        if (v === null) anyUnknownCount = true; else totals[k] += v;
      });
      var sus = numOrNull(n.suspectCount) || 0;
      var und = numOrNull(n.undeterminedCount) || 0;
      if (!(n.outcome === 'clear' && sus === 0 && und === 0)) allClear = false;
      notes.push(basis);
      rows.push({
        driver: cyc, scope: '', category: 'cycle',
        categoryLabel: n.outcome === 'clear' ? '未起動疑いなし' : '要確認あり',
        period: '', forecastHours: null,
        reason: 'Active確認候補 ' + (numOrNull(n.activeCandidateCount) === null ? '—' : n.activeCandidateCount)
          + ' / 当日終了履歴 ' + (numOrNull(n.endedReferenceCount) === null ? '—' : n.endedReferenceCount)
          + ' / 未起動疑い ' + (numOrNull(n.suspectCount) === null ? '—' : n.suspectCount)
          + ' / 判定不能 ' + (numOrNull(n.undeterminedCount) === null ? '—' : n.undeterminedCount)
      });
      // Whitelisted fields only: scheduling IDs and anything else from OFK3 are never passed on.
      (isArr(n.unconfirmed) ? n.unconfirmed : []).forEach(function (u) {
        if (!isObj(u) || !MENTOR_STATUS_LABEL[u.status]) return;
        rows.push({
          driver: typeof u.name === 'string' && u.name ? u.name : '氏名非表示',
          scope: cyc,
          category: u.status === 'Mentor未起動疑い（要確認）' ? 'suspect' : 'undetermined',
          categoryLabel: MENTOR_STATUS_LABEL[u.status],
          period: '', forecastHours: null,
          reason: typeof u.cause === 'string' ? u.cause : ''
        });
      });
    });

    function val(k) { return usable ? totals[k] : null; }
    var metrics = [
      { label: '評価対象', value: usable ? val('evaluated') : null },
      { label: 'Active確認候補', value: usable ? val('active') : null },
      { label: '当日終了履歴（参考）', value: usable ? val('ended') : null },
      { label: 'Mentor未起動疑い（要確認）', value: usable ? val('suspect') : null },
      { label: '判定不能', value: usable ? val('undetermined') : null }
    ];
    notes.unshift('「未起動疑い」は未起動の確定ではありません。Active確認候補は本人確認・点呼完了ではありません。');
    notes.push('対象サイクル: ' + (cycles.length ? cycles.join('、') : '—'));
    if (usable && (unavailable || stale)) notes.push('判定不可・遅延のサイクルは件数に含めていません。');
    if (anyUnknownCount) notes.push('一部の件数がOFK3から提供されていません。');

    var status;
    var reason;
    if (usable && totals.suspect > 0) {
      status = STATUS.WARN;
      reason = '未起動疑い（要確認）' + totals.suspect + ' 名 / 判定不能 ' + totals.undetermined + ' 名'
        + (unavailable || stale ? '（判定できていないサイクルあり）' : '') + '。未起動の確定ではありません。';
    } else if (stale && !usable) {
      status = STATUS.STALE;
      reason = 'OFK3 のMentor判定が15分を超えて古いため、現在値として扱いません。';
    } else if (stale) {
      status = STATUS.STALE;
      reason = '一部サイクルのMentor判定が15分を超えて古いため、全体を正常とは扱いません。';
    } else if (unavailable || totals.undetermined > 0 || anyUnknownCount || !usable) {
      status = STATUS.UNDETERMINED;
      reason = totals.undetermined > 0
        ? '判定不能 ' + totals.undetermined + ' 名。未起動疑いは検出されていませんが、完全な正常とは判定できません。'
        : 'OFK3 側で判定できていません（取得または照合のデータ不足）。';
    } else if (allClear) {
      status = STATUS.OK;
      reason = '未起動疑いは検出されていません（評価 ' + totals.evaluated + ' 名がActive確認候補または当日終了履歴あり）。';
    } else {
      status = STATUS.UNDETERMINED;
      reason = '判定結果を正常と確定できません。';
    }

    return card('mentor', title, status, reason, {
      source: source,
      judgedAt: oldestJudged,
      sourceUpdatedAt: oldestCapture,
      referenceDate: firstDate,
      metrics: metrics,
      rows: rows,
      notes: notes
    });
  }

  function judgeToday() {
    return card('today', '当日稼働状況', STATUS.UNSUPPORTED,
      '当日稼働状況のデータ源が未接続です。',
      { source: '未接続' });
  }

  function judgeEngine() {
    return card('engine', '検知エンジン', STATUS.UNSUPPORTED,
      '検知ルールへ渡す実データ入力が未接続のため、ルール評価は実行されていません（最終実行: なし）。',
      { source: 'inoichi-detection-core / 入力未接続' });
  }

  function judgeErrors(cards) {
    var failed = cards.filter(function (c) { return c.status === STATUS.FAILED; });
    var stale = cards.filter(function (c) { return c.status === STATUS.STALE; });
    var rows = failed.concat(stale).map(function (c) {
      return { driver: c.title, categoryLabel: c.statusLabel, reason: c.reason };
    });
    var status = failed.length ? STATUS.FAILED : (stale.length ? STATUS.STALE : STATUS.OK);
    var reason = failed.length
      ? '取得失敗 ' + failed.length + ' 件'
      : stale.length ? 'データ遅延 ' + stale.length + ' 件' : '取得エラーなし（対象のデータ源のみ）';
    return card('errors', 'データ取得エラー', status, reason, {
      source: 'INO-1 取得処理',
      rows: rows
    });
  }

  function judgeImportant(cards) {
    var warnRows = [];
    var judged = 0;
    var uncovered = [];
    cards.forEach(function (c) {
      if (c.id === 'rolling60h' || c.id === 'mentor' || c.id === 'today') {
        if (c.status === STATUS.OK || c.status === STATUS.WARN) judged += 1;
        else uncovered.push(c.title);
      }
      if (c.status === STATUS.WARN) {
        (c.rows || []).forEach(function (r) {
          if (r.category === 'forecast_exceed' || r.category === 'approach' || r.category === 'suspect') {
            warnRows.push({ driver: r.driver, categoryLabel: c.title + ' / ' + r.categoryLabel, reason: r.period || r.reason });
          }
        });
      }
    });
    var status;
    var reason;
    if (warnRows.length) {
      status = STATUS.WARN;
      reason = '警告 ' + warnRows.length + ' 件' + (uncovered.length ? '（未判定の監視あり: ' + uncovered.join('、') + '）' : '');
    } else if (uncovered.length) {
      status = STATUS.UNDETERMINED;
      reason = '判定できていない監視があるため「アラート0件」とは言えません（' + uncovered.join('、') + '）。';
    } else {
      status = STATUS.OK;
      reason = '全監視で警告は検出されていません。';
    }
    return card('important', '重要アラート', status, reason, {
      source: '各監視カードの集約',
      metrics: [{ label: '警告件数（判定できた監視のみ）', value: judged ? warnRows.length : null }],
      rows: warnRows
    });
  }

  /**
   * input: { fetches: { rolling60h: fetchResult }, now: ms }
   */
  function buildMonitorState(input) {
    input = input || {};
    var nowMs = typeof input.now === 'number' ? input.now : Date.now();
    var fetches = input.fetches || {};
    var rolling = judgeRolling60h(fetches.rolling60h, nowMs, input);
    var mentor = judgeMentor(fetches.mentor, nowMs, input);
    var today = judgeToday();
    var engine = judgeEngine();
    var errors = judgeErrors([rolling, mentor, today, engine]);
    var important = judgeImportant([rolling, mentor, today, engine]);

    var feedCards = [rolling, mentor].filter(function (c) { return c.status !== STATUS.UNSUPPORTED; });
    var link = feedCards.some(function (c) { return c.status === STATUS.FAILED; }) ? STATUS.FAILED
      : feedCards.some(function (c) { return c.status === STATUS.STALE; }) ? STATUS.STALE
      : rolling.status === STATUS.UNDETERMINED && !rolling.judgedAt ? STATUS.UNDETERMINED
      : STATUS.OK;

    var f = fetches.rolling60h || {};
    var fetchedTimes = [f.fetchedAt, (fetches.mentor || {}).fetchedAt].filter(Boolean).sort();
    return {
      app: 'INO-1',
      generatedAt: new Date(nowMs).toISOString(),
      lastFetchedAt: fetchedTimes.length ? fetchedTimes[0] : null,
      referenceDate: rolling.referenceDate || '',
      link: { status: link, statusLabel: STATUS_LABEL[link], source: rolling.source + (fetches.mentor ? ' / ' + mentor.source : '') },
      engine: { status: engine.status, statusLabel: engine.statusLabel },
      cards: [important, mentor, rolling, today, errors, engine]
    };
  }

  return {
    STATUS: STATUS,
    STATUS_LABEL: STATUS_LABEL,
    DEFAULT_STALE_MS: DEFAULT_STALE_MS,
    judgeRolling60h: judgeRolling60h,
    judgeMentor: judgeMentor,
    MENTOR_STALE_MS: MENTOR_STALE_MS,
    buildMonitorState: buildMonitorState
  };
});
