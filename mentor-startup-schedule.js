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
  var FETCH_MISSED = '最新のメンター判定を取得できませんでした';
  var SAMPLE = 'これはテストデータです。本番の起動状況としては報告しません。';
  var WITHHELD = 'Mentor起動状況を報告します。確認対象0名のうち、未起動の疑いはありません。';
  var SUSPECT = 'Mentor未起動疑い（要確認）';
  var UNKNOWN = '判定不能（原因付き）';
  var DEFAULT_STALE_MS = 15 * 60 * 1000;
  var PENDING_MS = 3 * 60 * 1000;
  var NAME_LIMIT = 5;
  var DUE_GRACE_MINUTES = 2;
  var SLOT_WINDOW_MINUTES = 15;
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

  function tokyoDate(now) {
    var parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(now);
    var year = '';
    var month = '';
    var day = '';
    parts.forEach(function (part) {
      if (part.type === 'year') year = part.value;
      if (part.type === 'month') month = part.value;
      if (part.type === 'day') day = part.value;
    });
    return year && month && day ? year + '-' + month + '-' + day : '';
  }

  function minuteIndex(value) {
    var match = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(value || '');
    if (!match) return null;
    return Number(match[1]) * 60 + Number(match[2]);
  }

  function slotDue(time, now) {
    var target = minuteIndex(time);
    var current = minuteIndex(tokyoMinute(now));
    if (target == null || current == null) return false;
    var delta = current - target;
    if (delta < 0) delta += 1440;
    return delta <= DUE_GRACE_MINUTES;
  }

  function dated(notice, now) {
    return !!(notice && notice.date && now && notice.date === tokyoDate(now));
  }

  function sourcesReady(notice) {
    var sources = notice && notice.sources;
    if (!sources) return true;
    return sources.scheduling === 'ready' && sources.mentor === 'ready';
  }

  function personWho(row) {
    var name = speakableName(row && row.name);
    if (name) return name + 'さん';
    var id = row && typeof row.schedulingId === 'string' ? row.schedulingId.trim() : '';
    if (!id || id.length > 40 || /[。、\n\r<>]/.test(id)) return '';
    return '識別子' + id;
  }

  function listedPeople(rows, status) {
    var names = [];
    var hidden = 0;
    (Array.isArray(rows) ? rows : []).forEach(function (row) {
      if (!row || row.status !== status) return;
      var who = personWho(row);
      if (!who || names.length >= NAME_LIMIT) {
        hidden += 1;
        return;
      }
      names.push(who);
    });
    return { names: names, hidden: hidden };
  }

  function nameList(group, label) {
    if (!group.names.length && !group.hidden) return '';
    var text = '';
    if (group.names.length) text += label + group.names.join('、') + 'です。';
    if (group.hidden > 0) text += 'ほか' + group.hidden + '名は画面で確認してください。';
    return text;
  }

  function reportText(notice) {
    var scope = notice && notice.cycle ? cyclePhrase(notice.cycle) : '';
    var evaluated = notice && typeof notice.evaluatedCount === 'number' ? notice.evaluatedCount : 0;
    var suspects = notice && notice.suspectCount > 0 ? notice.suspectCount : 0;
    var unknown = notice && notice.undeterminedCount > 0 ? notice.undeterminedCount : 0;
    var text = 'Mentor起動状況を報告します。' + scope + '確認対象' + evaluated + '名のうち、';
    if (!suspects) {
      text += '未起動の疑いはありません。';
    } else {
      var suspectsNamed = listedPeople(notice && notice.unconfirmed, SUSPECT);
      text += '未起動の疑いがある方は' + suspects + '名です。';
      text += nameList(suspectsNamed, '対象者は、');
      text += '確認をお願いします。';
    }
    if (unknown) {
      var unknownNamed = listedPeople(notice && notice.unconfirmed, UNKNOWN);
      text += '判定不能は' + unknown + '名です。';
      text += nameList(unknownNamed, '判定不能の対象者は、');
      if (!suspects) text += '確認をお願いします。';
    }
    return text;
  }

  function clearText(cycle, evaluated) {
    return reportText({ cycle: cycle || '', evaluatedCount: evaluated || 0, suspectCount: 0, undeterminedCount: 0, unconfirmed: [] });
  }

  function countText(cycle, suspectCount, undeterminedCount) {
    return reportText({
      cycle: cycle || '',
      evaluatedCount: (suspectCount || 0) + (undeterminedCount || 0),
      suspectCount: suspectCount || 0,
      undeterminedCount: undeterminedCount || 0,
      unconfirmed: []
    });
  }

  function confirmedSentence(cycle, names) {
    var list = Array.isArray(names) ? names : [];
    return reportText({
      cycle: cycle || '',
      evaluatedCount: list.length,
      suspectCount: list.length,
      undeterminedCount: 0,
      unconfirmed: list.map(function (name) { return { name: name, status: SUSPECT }; })
    });
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
    if (notice && notice.sample === true) return { outcome: 'sample', text: SAMPLE };
    if (!notice || notice.outcome === 'unavailable' || !fresh(notice, now, staleMs) || !dated(notice, now) || !sourcesReady(notice)) {
      return { outcome: 'unavailable', text: FAILURE };
    }
    var suspects = notice.suspectCount > 0;
    var unknown = notice.undeterminedCount > 0;
    return { outcome: suspects || unknown ? 'withheld' : 'clear', text: reportText(notice) };
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

  function overallText(suspectCount, undeterminedCount, evaluatedCount) {
    return reportText({
      cycle: '',
      evaluatedCount: typeof evaluatedCount === 'number' ? evaluatedCount : (suspectCount || 0) + (undeterminedCount || 0),
      suspectCount: suspectCount || 0,
      undeterminedCount: undeterminedCount || 0,
      unconfirmed: []
    });
  }

  function speechOverall(notice, now, staleMs) {
    if (notice && notice.sample === true) return { outcome: 'sample', text: SAMPLE };
    if (!notice || notice.outcome === 'unavailable' || !fresh(notice, now, staleMs) || !dated(notice, now) || !sourcesReady(notice)) {
      return { outcome: 'unavailable', text: FAILURE };
    }
    var spoken = speech(Object.assign({}, notice, { cycle: '', sample: false }), now, staleMs);
    return { outcome: spoken.outcome, text: spoken.text };
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

  function defaultSlots() {
    return [
      { id: '1', time: '09:05', enabled: false },
      { id: '2', time: '11:10', enabled: false },
      { id: '3', time: '11:35', enabled: false },
      { id: '4', time: '15:00', enabled: false }
    ];
  }

  function slotIdOk(value) {
    return value === '1' || value === '2' || value === '3' || value === '4';
  }

  function normalizeSlots(input) {
    var defaults = defaultSlots();
    var source = input && Array.isArray(input.slots) ? input.slots : null;
    if (!source) return defaults;
    var byId = {};
    source.forEach(function (slot) {
      if (slot && slotIdOk(slot.id)) byId[slot.id] = slot;
    });
    return defaults.map(function (item) {
      var found = byId[item.id];
      if (!found) return { id: item.id, time: item.time, enabled: false };
      var time = typeof found.time === 'string' && TIME_RE.test(found.time) ? found.time : item.time;
      return { id: item.id, time: time, enabled: found.enabled === true };
    });
  }

  function settingsError(input) {
    if (!isObj(input)) return 'invalid';
    if (input.freshnessMs != null && (typeof input.freshnessMs !== 'number' || !isFinite(input.freshnessMs) || input.freshnessMs < 0)) return 'freshness';
    if (input.slots != null) {
      if (!Array.isArray(input.slots) || input.slots.length !== 4) return 'slots';
      var seen = {};
      var times = {};
      for (var s = 0; s < input.slots.length; s++) {
        var slot = input.slots[s];
        if (!isObj(slot) || !slotIdOk(slot.id) || seen[slot.id]) return 'slots';
        if (typeof slot.time !== 'string' || !TIME_RE.test(slot.time)) return 'slot-time';
        if (slot.enabled !== true && slot.enabled !== false) return 'slot-enabled';
        if (times[slot.time]) return 'duplicate-time';
        seen[slot.id] = true;
        times[slot.time] = true;
      }
    }
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
    return { version: 1, freshnessMs: freshness, slots: normalizeSlots(input), cycles: cycles };
  }

  function defaultSettings() {
    return { version: 1, freshnessMs: null, slots: defaultSlots(), cycles: {} };
  }

  function enabledSlots(settings) {
    return (settings && Array.isArray(settings.slots) ? settings.slots : []).filter(function (slot) {
      return slot && slot.enabled === true && TIME_RE.test(slot.time);
    }).slice().sort(function (a, b) {
      return minuteIndex(a.time) - minuteIndex(b.time);
    });
  }

  function openSlot(settings, now) {
    var slots = enabledSlots(settings);
    var current = minuteIndex(tokyoMinute(now));
    if (current == null) return null;
    var open = null;
    slots.forEach(function (slot) {
      var start = minuteIndex(slot.time);
      if (start == null) return;
      var delta = current - start;
      if (delta >= 0 && delta <= SLOT_WINDOW_MINUTES) open = slot;
    });
    return open;
  }

  function pendingLive(spoken, key, now) {
    var at = spoken && spoken.pending ? spoken.pending[key] : '';
    var time = Date.parse(at || '');
    return isFinite(time) && now.getTime() - time < PENDING_MS;
  }

  function slotKey(notice, scope, time) {
    return [
      notice && notice.date || '',
      scope === 'overall' ? 'overall' : (notice && notice.cycle || ''),
      time || ''
    ].join('|');
  }

  function plan(notice, settings, spoken, now, staleMs) {
    var state = spoken && spoken.confirmed && spoken.pending ? spoken : blankSpoken();
    var time = notice && notice.cycle && settings && settings.cycles && settings.cycles[notice.cycle]
      ? settings.cycles[notice.cycle].time
      : null;
    if (notice && notice.sample === true) return { speak: false, text: SAMPLE, key: '', outcome: 'sample', reason: 'sample' };
    var said = speech(notice, now, staleMs);
    var key = slotKey(notice, '', time);
    if (!time) return { speak: false, text: said.text, key: key, outcome: said.outcome, reason: 'unset' };
    if (state.confirmed[key]) return { speak: false, text: said.text, key: key, outcome: said.outcome, reason: 'already-spoken' };
    if (pendingLive(state, key, now)) return { speak: false, text: said.text, key: key, outcome: said.outcome, reason: 'in-flight' };
    if (!slotDue(time, now)) return { speak: false, text: said.text, key: key, outcome: said.outcome, reason: 'not-due' };
    state.pending[key] = now.toISOString();
    return { speak: true, text: said.text, key: key, outcome: said.outcome, reason: 'due', spoken: state };
  }

  function planSlots(notice, settings, spoken, now, staleMs) {
    var state = spoken && spoken.confirmed && spoken.pending ? spoken : blankSpoken();
    var enabled = enabledSlots(settings);
    var open = openSlot(settings, now);
    if (!enabled.length) return { speak: false, text: '', key: '', outcome: '', reason: 'unset', scope: 'slot', slotId: '' };
    if (!open) return { speak: false, text: '', key: '', outcome: '', reason: 'not-due', scope: 'slot', slotId: '' };
    if (notice && notice.sample === true) {
      var sampleKey = [notice.date || '', 'slot', open.id].join('|');
      return { speak: false, text: SAMPLE, key: sampleKey, outcome: 'sample', reason: 'sample', scope: 'slot', slotId: open.id };
    }
    var said = speechOverall(notice, now, staleMs);
    var missed = !said || said.outcome === 'unavailable';
    var key = missed
      ? [tokyoDate(now), 'slot', open.id, 'fetch-missed'].join('|')
      : [notice && notice.date || '', 'slot', open.id].join('|');
    if (state.confirmed[key]) return { speak: false, text: missed ? FETCH_MISSED : '', key: key, outcome: missed ? 'unavailable' : '', reason: 'already-spoken', scope: 'slot', slotId: open.id };
    if (pendingLive(state, key, now)) return { speak: false, text: missed ? FETCH_MISSED : said.text, key: key, outcome: missed ? 'unavailable' : said.outcome, reason: 'in-flight', scope: 'slot', slotId: open.id };
    if (missed) {
      state.pending[key] = now.toISOString();
      return { speak: true, text: FETCH_MISSED, key: key, outcome: 'unavailable', reason: 'not-ready', spoken: state, scope: 'slot', slotId: open.id };
    }
    state.pending[key] = now.toISOString();
    return { speak: true, text: said.text, key: key, outcome: said.outcome, reason: 'due', spoken: state, scope: 'slot', slotId: open.id };
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
    FETCH_MISSED: FETCH_MISSED,
    SAMPLE: SAMPLE,
    WITHHELD: WITHHELD,
    NAME_LIMIT: NAME_LIMIT,
    DEFAULT_STALE_MS: DEFAULT_STALE_MS,
    speech: speech,
    confirmedSentence: confirmedSentence,
    tokyoMinute: tokyoMinute,
    tokyoDate: tokyoDate,
    slotDue: slotDue,
    slotKey: slotKey,
    generationKey: generationKey,
    settingsError: settingsError,
    normalizeSettings: normalizeSettings,
    defaultSettings: defaultSettings,
    blankSpoken: blankSpoken,
    plan: plan,
    planSlots: planSlots,
    defaultSlots: defaultSlots,
    enabledSlots: enabledSlots,
    openSlot: openSlot,
    speechOverall: speechOverall,
    overallText: overallText,
    ack: ack,
    remember: remember,
    clearText: clearText,
    countText: countText
  };
});
