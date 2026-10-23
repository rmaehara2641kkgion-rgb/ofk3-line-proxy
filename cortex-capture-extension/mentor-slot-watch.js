/**
 * 定刻前の再取得判断と、3000停止中の送信控え。
 * Amazonへのログインはしない。タブの再読み込みは1枠につき1日1回まで。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.OFK3MentorSlotWatch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SLOTS = [
    { id: '1', time: '09:05' },
    { id: '2', time: '11:10' },
    { id: '3', time: '11:35' },
    { id: '4', time: '15:00' }
  ];
  var PREP_LEAD_MINUTES = 2;
  var FRESH_MS = 15 * 60 * 1000;
  var SLOT_WINDOW_MINUTES = 15;
  var OUTBOX_LIMIT = 8;
  var OUTBOX_ALARM = 'mentor-outbox';
  var PREP_PREFIX = 'mentor-prep-';

  function tokyoParts(now) {
    var fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    });
    var out = { year: '', month: '', day: '', hour: '', minute: '' };
    fmt.formatToParts(now).forEach(function (part) {
      if (Object.prototype.hasOwnProperty.call(out, part.type)) out[part.type] = part.value;
    });
    if (out.hour === '24') out.hour = '00';
    return out;
  }

  function tokyoDate(now) {
    var parts = tokyoParts(now);
    return parts.year && parts.month && parts.day ? parts.year + '-' + parts.month + '-' + parts.day : '';
  }

  function minuteIndex(value) {
    var match = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(value || '');
    if (!match) return null;
    return Number(match[1]) * 60 + Number(match[2]);
  }

  function prepTime(slotTime) {
    var mins = minuteIndex(slotTime);
    if (mins == null) return '';
    var prep = mins - PREP_LEAD_MINUTES;
    if (prep < 0) prep += 1440;
    var hour = Math.floor(prep / 60);
    var minute = prep % 60;
    return (hour < 10 ? '0' : '') + hour + ':' + (minute < 10 ? '0' : '') + minute;
  }

  function nextStamp(hhmm, now) {
    var parts = tokyoParts(now);
    if (!parts.year || minuteIndex(hhmm) == null) return 0;
    var base = Date.parse(parts.year + '-' + parts.month + '-' + parts.day + 'T' + hhmm + ':00+09:00');
    if (!isFinite(base)) return 0;
    if (base <= now.getTime()) base += 86400000;
    return base;
  }

  function alarmPlan(now) {
    var alarms = SLOTS.map(function (slot) {
      var when = prepTime(slot.time);
      return {
        name: PREP_PREFIX + slot.id,
        slotId: slot.id,
        time: when,
        when: nextStamp(when, now),
        periodInMinutes: 1440
      };
    });
    alarms.push({
      name: OUTBOX_ALARM,
      slotId: '',
      time: '',
      when: now.getTime() + 60000,
      periodInMinutes: 1
    });
    return alarms;
  }

  function ageMs(iso, now) {
    var time = Date.parse(iso || '');
    if (!isFinite(time)) return Infinity;
    return now.getTime() - time;
  }

  function captureFresh(stamps, now, freshMs) {
    var limit = typeof freshMs === 'number' ? freshMs : FRESH_MS;
    if (!stamps || !now) return false;
    return ageMs(stamps.schedulingCapturedAt, now) <= limit && ageMs(stamps.mentorCapturedAt, now) <= limit;
  }

  function prepAction(state, slotId, now) {
    var key = tokyoDate(now) + '|' + slotId;
    var mark = state && state.reloads ? state.reloads[key] : '';
    var fresh = captureFresh(state && state.stamps, now, FRESH_MS);
    if (mark === 'reload') return { resend: true, reload: false, reason: 'reload-used', reloadKey: key, mark: 'reload' };
    if (fresh && mark === 'resend') return { resend: false, reload: false, reason: 'already-fresh', reloadKey: key, mark: 'resend' };
    if (fresh) return { resend: true, reload: false, reason: 'fresh', reloadKey: key, mark: 'resend' };
    return { resend: false, reload: true, reason: 'stale', reloadKey: key, mark: 'reload' };
  }

  function markReload(reloads, key, mark) {
    var next = {};
    var name;
    var source = reloads && typeof reloads === 'object' ? reloads : {};
    for (name in source) {
      if (Object.prototype.hasOwnProperty.call(source, name)) next[name] = source[name];
    }
    if (key) next[key] = mark || 'reload';
    return next;
  }

  function duePreps(now, reloads) {
    var parts = tokyoParts(now);
    var current = minuteIndex(parts.hour + ':' + parts.minute);
    var day = tokyoDate(now);
    if (current == null) return [];
    return SLOTS.filter(function (slot) {
      var prep = minuteIndex(prepTime(slot.time));
      var start = minuteIndex(slot.time);
      if (prep == null || start == null) return false;
      return current >= prep && current <= start + SLOT_WINDOW_MINUTES;
    }).map(function (slot) {
      return slot.id;
    }).filter(function (slotId) {
      var reason = prepAction({ stamps: null, reloads: reloads }, slotId, now).reason;
      return reason !== 'already-fresh' && reason !== 'reload-used';
    }).filter(function (slotId, index, list) {
      return list.indexOf(slotId) === index && day;
    });
  }

  function enqueue(outbox, item) {
    var list = Array.isArray(outbox) ? outbox.slice() : [];
    if (!item || typeof item.key !== 'string' || !item.key) return list;
    var i;
    for (i = 0; i < list.length; i += 1) {
      if (list[i] && list[i].key === item.key) return list;
    }
    list.push({ key: item.key, payload: item.payload, queuedAt: item.queuedAt || '' });
    if (list.length > OUTBOX_LIMIT) list = list.slice(list.length - OUTBOX_LIMIT);
    return list;
  }

  function drop(outbox, key) {
    return (Array.isArray(outbox) ? outbox : []).filter(function (item) {
      return item && item.key !== key;
    });
  }

  function slotByAlarm(name) {
    var hit = null;
    SLOTS.forEach(function (slot) {
      if (PREP_PREFIX + slot.id === name) hit = slot;
    });
    return hit;
  }

  function loginUrl(url) {
    if (typeof url !== 'string') return false;
    return /\/#\/login(?:$|[/?#])/.test(url) || /\/ap\/signin/.test(url) || /openid\.amazon/.test(url);
  }

  return {
    SLOTS: SLOTS,
    PREP_LEAD_MINUTES: PREP_LEAD_MINUTES,
    FRESH_MS: FRESH_MS,
    OUTBOX_ALARM: OUTBOX_ALARM,
    PREP_PREFIX: PREP_PREFIX,
    prepTime: prepTime,
    nextStamp: nextStamp,
    alarmPlan: alarmPlan,
    captureFresh: captureFresh,
    prepAction: prepAction,
    markReload: markReload,
    duePreps: duePreps,
    enqueue: enqueue,
    drop: drop,
    slotByAlarm: slotByAlarm,
    loginUrl: loginUrl,
    tokyoDate: tokyoDate
  };
});
