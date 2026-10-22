/**
 * ローカルだけの Mentor 起動通知。
 * ブラウザが閉じている間は取得も読み上げも進まない。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var Notice = require('./mentor-startup-notice.js');
var Schedule = require('./mentor-startup-schedule.js');

function isLoopback(remote) {
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}

function remoteOf(req) {
  var ip = req && req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : '';
  return String(ip);
}

function createApi(opts) {
  var io = opts && opts.fs ? opts.fs : fs;
  var dir = opts && opts.dir ? opts.dir : path.join(__dirname, 'local');
  var staleMs = opts && typeof opts.staleMs === 'number' ? opts.staleMs : Schedule.DEFAULT_STALE_MS;
  var log = opts && typeof opts.log === 'function' ? opts.log : function () {};
  var noticeFile = path.join(dir, 'mentor-startup-notice.json');
  var spokenFile = path.join(dir, 'mentor-startup-spoken.json');
  var settingsFile = path.join(dir, 'mentor-startup-settings.json');

  function readJson(file, fallback) {
    try {
      return JSON.parse(io.readFileSync(file, 'utf8'));
    } catch (e) {
      return fallback;
    }
  }

  function writeJson(file, value) {
    io.mkdirSync(dir, { recursive: true });
    var temp = file + '.tmp';
    io.writeFileSync(temp, JSON.stringify(value));
    io.renameSync(temp, file);
  }

  function readNotices() {
    var saved = readJson(noticeFile, null);
    if (!saved) return [];
    if (saved.version === 2 && Array.isArray(saved.notices)) return saved.notices;
    if (saved.version === 1) return [saved];
    return [];
  }

  function orderedNotices(notices) {
    return notices.slice().sort(function (a, b) {
      var left = a && a.cycle ? a.cycle : '99';
      var right = b && b.cycle ? b.cycle : '99';
      return left < right ? -1 : (left > right ? 1 : 0);
    });
  }

  function choose(notices, config, spoken, now) {
    var limit = limitFor(config);
    var minute = Schedule.tokyoMinute(now);
    var numbered = notices.filter(function (notice) { return notice && notice.cycle; });
    function slot(notice) {
      return config && config.cycles ? config.cycles[notice.cycle] : null;
    }
    var due = numbered.filter(function (notice) {
      var item = slot(notice);
      return !!(item && item.time && item.time === minute);
    });
    var timed = numbered.filter(function (notice) {
      var item = slot(notice);
      return !!(item && item.time);
    });
    var overallConfigured = !!(config && config.overallTime);
    var overallDue = overallConfigured && config.overallTime === minute;
    due.sort(function (a, b) { return String(a.cycle).localeCompare(String(b.cycle), 'en'); });
    var state = spoken;
    var texts = [];
    var keys = [];
    var outcome = '';
    var notice = null;
    var scope = '';
    due.forEach(function (item) {
      var result = Schedule.plan(item, config, state, now, limit);
      if (result.spoken) state = result.spoken;
      if (!result.speak) return;
      texts.push(result.text);
      keys.push(result.key);
      if (!outcome) outcome = result.outcome;
      if (!notice) notice = item;
      scope = 'cycle';
    });
    if (overallDue) {
      var aggregate = Notice.overallFromNotices(notices);
      var overall = Schedule.planOverall(aggregate, config, state, now, limit);
      if (overall.spoken) state = overall.spoken;
      if (overall.speak) {
        texts.push(overall.text);
        keys.push(overall.key);
        if (!notice) {
          notice = aggregate;
          outcome = overall.outcome;
          scope = 'overall';
        }
      } else if (!texts.length) {
        return { speak: false, reason: overall.reason, notice: aggregate, text: overall.text, outcome: overall.outcome, key: overall.key || '', scope: 'overall' };
      }
    }
    if (!texts.length && due.length) {
      var blocked = Schedule.plan(due[0], config, spoken, now, limit);
      return { speak: false, reason: blocked.reason, notice: due[0], text: blocked.text, outcome: blocked.outcome, key: blocked.key || '', scope: 'cycle' };
    }
    if (!texts.length) {
      var sample = timed[0] || numbered[0] || notices[0] || null;
      var said = Schedule.speech(sample, now, limit);
      return { speak: false, reason: timed.length || overallConfigured ? 'not-due' : 'unset', notice: sample, text: said.text, outcome: said.outcome, scope: '' };
    }
    return { speak: true, reason: 'due', notice: notice, text: texts.join(''), outcome: outcome, spoken: state, key: keys[0], keys: keys, scope: scope };
  }

  function readSettings() {
    var saved = readJson(settingsFile, null);
    return saved && saved.version === 1 ? Schedule.normalizeSettings(saved) : Schedule.defaultSettings();
  }

  function readSpoken() {
    var saved = readJson(spokenFile, null);
    if (!saved || !saved.confirmed || !saved.pending) return Schedule.blankSpoken();
    return saved;
  }

  function speechSummary(notice, said) {
    var body = { outcome: said.outcome, text: said.text };
    if (said.outcome === 'unavailable' && notice && notice.outcome !== 'unavailable') body.outcomeReason = '期限切れ';
    return body;
  }

  function limitFor(settings) {
    return settings && typeof settings.freshnessMs === 'number' ? settings.freshnessMs : staleMs;
  }

  function noticeFingerprint(notice) {
    var people = (Array.isArray(notice && notice.unconfirmed) ? notice.unconfirmed : []).map(function (row) {
      return [row && row.schedulingId || '', row && row.name || '', row && row.status || ''].join('~');
    }).join(';');
    return [
      notice && notice.date || '',
      notice && notice.cycle || '',
      notice && notice.outcome || '',
      notice && notice.outcomeReason || '',
      notice && notice.evaluatedCount,
      notice && notice.suspectCount,
      notice && notice.undeterminedCount,
      notice && notice.activeCandidateCount,
      notice && notice.schedulingCapturedAt || '',
      notice && notice.mentorCapturedAt || '',
      people
    ].join('|');
  }

  function keepExistingJudgedAt(existing, incoming) {
    var previous = {};
    (existing || []).forEach(function (notice) {
      previous[noticeFingerprint(notice)] = notice;
    });
    return (incoming || []).map(function (notice) {
      var stored = previous[noticeFingerprint(notice)];
      if (!stored || !stored.judgedAt) return notice;
      notice.judgedAt = stored.judgedAt;
      return notice;
    });
  }

  function summary(notice) {
    return {
      ok: true,
      date: notice ? notice.date : null,
      cycle: notice ? notice.cycle : null,
      outcome: notice ? notice.outcome : 'unavailable',
      outcomeReason: notice ? notice.outcomeReason : '未取得',
      scheduledCount: null,
      evaluatedCount: notice ? notice.evaluatedCount : null,
      activeCandidateCount: notice ? notice.activeCandidateCount : null,
      endedReferenceCount: notice ? notice.endedReferenceCount : null,
      suspectCount: notice ? notice.suspectCount : null,
      undeterminedCount: notice ? notice.undeterminedCount : null,
      confirmedUnstartedCount: notice ? notice.confirmedUnstartedCount : 0,
      mentorCapturedAt: notice ? notice.mentorCapturedAt || null : null,
      judgedAt: notice ? notice.judgedAt || null : null,
      sample: !!(notice && notice.sample),
      people: Array.isArray(notice && notice.unconfirmed) ? notice.unconfirmed.map(function (row) {
        return {
          schedulingId: row && typeof row.schedulingId === 'string' ? row.schedulingId : '',
          name: row && typeof row.name === 'string' ? row.name : '',
          status: row && typeof row.status === 'string' ? row.status : ''
        };
      }) : []
    };
  }

  function handle(request) {
    var remote = request && request.remote ? request.remote : '';
    if (!isLoopback(remote)) return { status: 403, body: { ok: false, reason: 'forbidden' } };
    var now = request && request.now instanceof Date ? request.now : new Date();
    var method = request && request.method ? request.method : 'GET';
    var pathname = request && request.path ? request.path : '';
    var body = request && request.body ? request.body : {};
    try {
      if (method === 'POST' && pathname === '/mentor-startup/notice') {
        var notices = Notice.noticesFromSuspectView(body.view, {
          identities: body.identities,
          assignments: body.assignments,
          schedulingCapturedAt: body.schedulingCapturedAt,
          mentorCapturedAt: body.mentorCapturedAt,
          judgedAt: body.judgedAt,
          sample: body.sample === true
        });
        var existing = readNotices();
        var incomingUnavailable = notices.length > 0 && notices.every(function (notice) { return notice.outcome === 'unavailable'; });
        var existingUseful = existing.some(function (notice) { return notice && notice.outcome && notice.outcome !== 'unavailable'; });
        if (incomingUnavailable && existingUseful) {
          return { status: 200, body: Object.assign(summary(existing[0]), { kept: true }) };
        }
        notices = keepExistingJudgedAt(existing, notices);
        writeJson(noticeFile, { version: 2, notices: notices });
        log('mentor-startup saved notices=' + notices.length + ' cycles=' + notices.map(function (notice) { return notice.cycle || '-'; }).join(','));
        if (notices.length === 1) return { status: 200, body: summary(notices[0]) };
        return { status: 200, body: { ok: true, notices: notices.map(summary) } };
      }
      if (method === 'GET' && pathname === '/mentor-startup/notice') {
        var stored = readNotices();
        if (!stored.length) return { status: 200, body: summary(null) };
        if (stored.length === 1) return { status: 200, body: Object.assign({}, stored[0], { notices: stored }) };
        return { status: 200, body: { ok: true, version: 2, notices: stored } };
      }
      if (method === 'GET' && pathname === '/mentor-startup/settings') {
        return { status: 200, body: readSettings() };
      }
      if (method === 'POST' && pathname === '/mentor-startup/settings') {
        var error = Schedule.settingsError(body);
        if (error) return { status: 400, body: { ok: false, reason: error } };
        var settings = Schedule.normalizeSettings(body);
        writeJson(settingsFile, settings);
        log('mentor-startup settings cycles=' + Object.keys(settings.cycles).length);
        return { status: 200, body: settings };
      }
      if (method === 'POST' && pathname === '/mentor-startup/ack') {
        var key = typeof body.key === 'string' ? body.key : '';
        if (!key || key.length > 400 || key.indexOf('\n') >= 0) return { status: 400, body: { ok: false, reason: 'key' } };
        var acked = Schedule.ack(readSpoken(), key, body.ok === true, now);
        writeJson(spokenFile, acked);
        log('mentor-startup ack ok=' + (body.ok === true));
        return { status: 200, body: { ok: true, kept: body.ok !== true } };
      }
      if (method === 'POST' && pathname === '/mentor-startup/reconcile') {
        var remembered = Schedule.remember(readSpoken(), body.keys, now);
        writeJson(spokenFile, remembered);
        return { status: 200, body: { ok: true } };
      }
      if (method === 'GET' && (pathname === '/mentor-startup/plan' || pathname === '/mentor-startup/manual')) {
        var currentNotices = orderedNotices(readNotices());
        var config = readSettings();
        if (pathname === '/mentor-startup/manual') {
          var day = Schedule.speechOverall(Notice.overallFromNotices(currentNotices), now, limitFor(config));
          var manualText = day.text + currentNotices.map(function (notice) {
            return Schedule.speech(notice, now, limitFor(config)).text;
          }).join('');
          var manualNotice = currentNotices[0] || null;
          return { status: 200, body: Object.assign(summary(manualNotice), { speak: false, text: manualText || Schedule.FAILURE, reason: 'manual', scope: 'overall', notices: currentNotices.map(summary) }) };
        }
        var spoken = readSpoken();
        var result = choose(currentNotices, config, spoken, now);
        if (result.spoken) writeJson(spokenFile, result.spoken);
        if (result.speak) log('mentor-startup due outcome=' + result.outcome + ' scope=' + (result.scope || '-'));
        return { status: 200, body: Object.assign(summary(result.notice), speechSummary(result.notice, result), { speak: result.speak, text: result.text, key: result.key || '', keys: result.keys || [], reason: result.reason, scope: result.scope || '' }) };
      }
      return { status: 404, body: { ok: false, reason: 'not-found' } };
    } catch (e) {
      log('mentor-startup store-failed');
      return { status: 500, body: { ok: false, reason: 'store' } };
    }
  }

  return { handle: handle };
}

function mount(app, opts) {
  var api = createApi(opts || {});
  function send(req, res, method, pathname) {
    var result = api.handle({
      method: method,
      path: pathname,
      body: req.body,
      remote: remoteOf(req),
      now: new Date()
    });
    res.status(result.status).json(result.body);
  }
  app.post('/mentor-startup/notice', function (req, res) { send(req, res, 'POST', '/mentor-startup/notice'); });
  app.get('/mentor-startup/notice', function (req, res) { send(req, res, 'GET', '/mentor-startup/notice'); });
  app.get('/mentor-startup/settings', function (req, res) { send(req, res, 'GET', '/mentor-startup/settings'); });
  app.post('/mentor-startup/settings', function (req, res) { send(req, res, 'POST', '/mentor-startup/settings'); });
  app.get('/mentor-startup/plan', function (req, res) { send(req, res, 'GET', '/mentor-startup/plan'); });
  app.get('/mentor-startup/manual', function (req, res) { send(req, res, 'GET', '/mentor-startup/manual'); });
  app.post('/mentor-startup/ack', function (req, res) { send(req, res, 'POST', '/mentor-startup/ack'); });
  app.post('/mentor-startup/reconcile', function (req, res) { send(req, res, 'POST', '/mentor-startup/reconcile'); });
}

function handle(request) {
  return createApi(request || {}).handle(request || {});
}

module.exports = {
  mount: mount,
  handle: handle,
  isLoopback: isLoopback
};
