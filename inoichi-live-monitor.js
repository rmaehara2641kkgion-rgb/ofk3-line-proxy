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

  function judgeMentor() {
    return card('mentor', 'Mentor監視', STATUS.UNSUPPORTED,
      'Mentor起動状況をINO-1が読めるサーバー側データ源が未接続です（OFK3のMentor判定はブラウザ内のみ）。未起動0件ではなく「未判定」として扱います。',
      {
        source: '未接続',
        notes: [
          '対象ドライバー数・起動確認数・未起動疑い数・判定不能数・最終確認時刻・対象サイクルは取得できていません。',
          '未起動疑いを未起動確定として扱う設計は維持します。'
        ]
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
      if (c.id === 'rolling60h' || c.id === 'mentor') {
        if (c.status === STATUS.OK || c.status === STATUS.WARN) judged += 1;
        else uncovered.push(c.title);
      }
      if (c.status === STATUS.WARN) {
        (c.rows || []).forEach(function (r) {
          if (r.category === 'forecast_exceed' || r.category === 'approach') {
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
    var mentor = judgeMentor();
    var today = judgeToday();
    var engine = judgeEngine();
    var errors = judgeErrors([rolling, mentor, today, engine]);
    var important = judgeImportant([rolling, mentor, today, engine]);

    var link = rolling.status === STATUS.FAILED ? STATUS.FAILED
      : rolling.status === STATUS.STALE ? STATUS.STALE
      : rolling.status === STATUS.UNDETERMINED && !rolling.judgedAt ? STATUS.UNDETERMINED
      : STATUS.OK;

    var f = fetches.rolling60h || {};
    return {
      app: 'INO-1',
      generatedAt: new Date(nowMs).toISOString(),
      lastFetchedAt: f.fetchedAt || null,
      referenceDate: rolling.referenceDate || '',
      link: { status: link, statusLabel: STATUS_LABEL[link], source: rolling.source },
      engine: { status: engine.status, statusLabel: engine.statusLabel },
      cards: [important, mentor, rolling, today, errors, engine]
    };
  }

  return {
    STATUS: STATUS,
    STATUS_LABEL: STATUS_LABEL,
    DEFAULT_STALE_MS: DEFAULT_STALE_MS,
    judgeRolling60h: judgeRolling60h,
    buildMonitorState: buildMonitorState
  };
});
