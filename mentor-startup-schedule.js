/**
 * FRIDAY の定刻判定と読み上げ文。
 * 時刻の初期値は持たない。未起動と断定できない氏名は読み上げない。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MentorStartupSchedule = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var FAILURE = 'Mentorの最新起動状況を確認できませんでした。画面を確認してください。';
  var WITHHELD = 'Mentor起動状況を報告します。未起動と断定できる人はいません。画面で確認してください。';
  var DEFAULT_STALE_MS = 15 * 60 * 1000;
  var PENDING_MS = 3 * 60 * 1000;
  var TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
  var CYCLE_RE = /^[1-9][0-9]{0,2}$/;

  function isObj(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function cyclePhrase(cycle) {
    return cycle ? ('サイクル' + cycle + 'の') : '';
  }

  function speakableName(value) {
    if (typeof value !== 'string') return '';
    var text = value.trim();
    if (!text || text.length > 40 || /[。、\n\r<>]/.test(text)) return '';
    return text;
  }

  function clearText(cycle) {
    return 'Mentor起動状況を確認しました。' + cyclePhrase(cycle) + '未起動者は0名です。';
  }

  function countText(cycle, suspectCount, undeterminedCount) {
    var suspects = suspectCount > 0;
    var unknown = undeterminedCount > 0;
    if (!suspects && !unknown) return WITHHELD;
    var where = cycle ? ('サイクル' + cycle + 'で') : '';
    var parts = [];
    if (suspects) parts.push(where + '未起動の疑いが' + suspectCount + '名います。');
    if (unknown) parts.push((suspects ? '' : where) + '判定不能は' + undeterminedCount + '名です。');
    return 'Mentor起動状況を報告します。' + parts.join('') + '画面で確認してください。';
  }

  function confirmedSentence(cycle, names) {
    var scope = cycle ? ('サイクル' + cycle + 'の出勤予定者のうち、') : '';
    return 'Mentor起動状況を報告します。' + scope + '未起動者は' + names.length + '名です。' + names.map(function (name) { return name + 'さん'; }).join('、') + '。確認をお願いします。';
  }

  function fresh(notice, now, staleMs) {
    var limit = typeof staleMs === 'number' && isFinite(staleMs) && staleMs >= 0 ? staleMs : DEFAULT_STALE_MS;
    function age(iso) {
      var time = Date.parse(iso || '');
      return isFinite(time) ? now.getTime() - time : Infinity;
    }
    return !!(notice && now) && age(notice.schedulingCapturedAt) <= limit && age(notice.mentorCapturedAt) <= limit && age(notice.judgedAt) <= limit;
  }

  function speech(notice, now, staleMs) {
    if (!notice || notice.outcome === 'unavailable' || !fresh(notice, now, staleMs)) {
      return { outcome: 'unavailable', text: FAILURE };
    }
    if (notice.outcome === 'clear') return { outcome: 'clear', text: clearText(notice.cycle) };
    if ((notice.suspectCount || 0) > 0 || (notice.undeterminedCount || 0) > 0) {
      return {
        outcome: 'withheld',
        text: countText(notice.cycle, notice.suspectCount || 0, notice.undeterminedCount || 0)
      };
    }
    var people = Array.isArray(notice.confirmedUnstarted) ? notice.confirmedUnstarted : [];
    if (notice.confirmedUnstartedCount > 0 && people.length === notice.confirmedUnstartedCount) {
      var names = [];
      var named = people.every(function (person) {
        var name = speakableName(person && person.name);
        if (!name) return false;
        names.push(name);
        return true;
      });
      if (named && names.length) return { outcome: 'confirmed', text: confirmedSentence(notice.cycle, names) };
    }
    return { outcome: 'withheld', text: WITHHELD };
  }

  function tokyoMinute(now) {
    var parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Tokyo',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(now);
    var hour = '00';
    var minute = '00';
    parts.forEach(function (part) {
      if (part.type === 'hour') hour = part.value;
      if (part.type === 'minute') minute = part.value;
    });
    if (hour === '24') hour = '00';
    return hour + ':' + minute;
  }

  function overallText(suspectCount, undeterminedCount) {
    return 'Mentor起動状況を報告します。本日の未起動の疑いは' + suspectCount + '名、判定不能は' + undeterminedCount + '名です。画面で確認してください。';
  }

  function speechOverall(notice, now, staleMs) {
    if (!notice || notice.outcome === 'unavailable' || !fresh(notice, now, staleMs)) {
      return { outcome: 'unavailable', text: FAILURE };
    }
    return {
      outcome: 'withheld',
      text: overallText(notice.suspectCount || 0, notice.undeterminedCount || 0)
    };
  }

  function generationKey(notice, outcome, scope) {
    return [
      notice && notice.date || '',
      scope === 'overall' ? 'overall' : (notice && notice.cycle || ''),
      notice && notice.schedulingCapturedAt || '',
      notice && notice.mentorCapturedAt || '',
      notice && notice.judgedAt || '',
      outcome || ''
    ].join('|');
  }

  function blankSpoken() {
    return { version: 1, confirmed: {}, pending: {} };
  }

  function settingsError(input) {
    if (!isObj(input)) return 'invalid';
    if (input.freshnessMs != null && (typeof input.freshnessMs !== 'number' || !isFinite(input.freshnessMs) || input.freshnessMs < 0)) return 'freshness';
    if (input.overallTime != null && input.overallTime !== '' && (typeof input.overallTime !== 'string' || !TIME_RE.test(input.overallTime))) return 'overall-time';
    var cycles = input.cycles == null ? {} : input.cycles;
    if (!isObj(cycles)) return 'cycles';
    var keys = Object.keys(cycles);
    for (var i = 0; i < keys.length; i++) {
      if (!CYCLE_RE.test(keys[i])) return 'cycle';
      var time = cycles[keys[i]] && cycles[keys[i]].time;
      if (!(time == null || time === '' || (typeof time === 'string' && TIME_RE.test(time)))) return 'time';
    }
    return '';
  }

  function normalizeSettings(input) {
    var cycles = {};
    var source = input && isObj(input.cycles) ? input.cycles : {};
    Object.keys(source).forEach(function (key) {
      if (!CYCLE_RE.test(key)) return;
      var time = source[key] && source[key].time;
      cycles[key] = { time: typeof time === 'string' && TIME_RE.test(time) ? time : null };
    });
    var freshness = input && typeof input.freshnessMs === 'number' && isFinite(input.freshnessMs) && input.freshnessMs >= 0 ? input.freshnessMs : null;
    var overallTime = input && typeof input.overallTime === 'string' && TIME_RE.test(input.overallTime) ? input.overallTime : null;
    return { version: 1, freshnessMs: freshness, overallTime: overallTime, cycles: cycles };
  }

  function defaultSettings() {
    return { version: 1, freshnessMs: null, overallTime: null, cycles: {} };
  }

  function pendingLive(spoken, key, now) {
    var at = spoken && spoken.pending ? spoken.pending[key] : '';
    var time = Date.parse(at || '');
    return isFinite(time) && now.getTime() - time < PENDING_MS;
  }

  function plan(notice, settings, spoken, now, staleMs) {
    var state = spoken && spoken.confirmed && spoken.pending ? spoken : blankSpoken();
    var said = speech(notice, now, staleMs);
    var key = generationKey(notice, said.outcome);
    var time = notice && notice.cycle && settings && settings.cycles && settings.cycles[notice.cycle]
      ? settings.cycles[notice.cycle].time
      : null;
    var due = !!(time && tokyoMinute(now) === time);
    if (state.confirmed[key]) return { speak: false, text: said.text, key: key, outcome: said.outcome, reason: 'already-spoken' };
    if (pendingLive(state, key, now)) return { speak: false, text: said.text, key: key, outcome: said.outcome, reason: 'in-flight' };
    if (!due) return { speak: false, text: said.text, key: key, outcome: said.outcome, reason: time ? 'not-due' : 'unset' };
    state.pending[key] = now.toISOString();
    return { speak: true, text: said.text, key: key, outcome: said.outcome, reason: 'due', spoken: state };
  }

  function planOverall(notice, settings, spoken, now, staleMs) {
    var state = spoken && spoken.confirmed && spoken.pending ? spoken : blankSpoken();
    var said = speechOverall(notice, now, staleMs);
    var key = generationKey(notice, said.outcome, 'overall');
    var time = settings && typeof settings.overallTime === 'string' ? settings.overallTime : null;
    var due = !!(time && tokyoMinute(now) === time);
    if (state.confirmed[key]) return { speak: false, text: said.text, key: key, outcome: said.outcome, reason: 'already-spoken', scope: 'overall' };
    if (pendingLive(state, key, now)) return { speak: false, text: said.text, key: key, outcome: said.outcome, reason: 'in-flight', scope: 'overall' };
    if (!due) return { speak: false, text: said.text, key: key, outcome: said.outcome, reason: time ? 'not-due' : 'unset', scope: 'overall' };
    state.pending[key] = now.toISOString();
    return { speak: true, text: said.text, key: key, outcome: said.outcome, reason: 'due', spoken: state, scope: 'overall' };
  }

  function ack(spoken, key, ok, now) {
    var state = spoken && spoken.confirmed && spoken.pending ? spoken : blankSpoken();
    if (ok) state.confirmed[key] = now.toISOString();
    delete state.pending[key];
    return state;
  }

  function remember(spoken, keys, now) {
    var state = spoken && spoken.confirmed && spoken.pending ? spoken : blankSpoken();
    (Array.isArray(keys) ? keys : []).forEach(function (key) {
      if (typeof key !== 'string' || !key || key.length > 400 || key.indexOf('\n') >= 0) return;
      state.confirmed[key] = now.toISOString();
      delete state.pending[key];
    });
    return state;
  }

  return {
    FAILURE: FAILURE,
    WITHHELD: WITHHELD,
    DEFAULT_STALE_MS: DEFAULT_STALE_MS,
    speech: speech,
    confirmedSentence: confirmedSentence,
    tokyoMinute: tokyoMinute,
    generationKey: generationKey,
    settingsError: settingsError,
    normalizeSettings: normalizeSettings,
    defaultSettings: defaultSettings,
    blankSpoken: blankSpoken,
    plan: plan,
    planOverall: planOverall,
    speechOverall: speechOverall,
    overallText: overallText,
    ack: ack,
    remember: remember,
    clearText: clearText,
    countText: countText
  };
});
