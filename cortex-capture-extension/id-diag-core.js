/**
 * Scheduling と Mentor の ID 診断。
 * 比較用 ID は createSession のメモリにだけ置く。
 * read() と copyPayload() は集計と形式だけを返す。
 * ブラウザの保存領域には書かない。外部送信もしない。
 * 文字列の一致は本人確定ではない。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.OFK3IdDiag = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var STALE_MS = 15 * 60 * 1000;
  var IDENTITY_NOTE = '文字列の一致は本人対応の証明ではない';
  var PAIRS = [
    ['driverPersonId', 'realStaffNumber'],
    ['driverPersonId', 'driverId'],
    ['daPersonId', 'realStaffNumber'],
    ['daPersonId', 'driverId']
  ];

  function cleanId(value) {
    if (typeof value === 'number' && isFinite(value)) value = String(value);
    if (typeof value !== 'string') return '';
    var text = value.trim();
    if (!text || text.length > 80) return '';
    if (/bearer|cookie|password|token|@/i.test(text)) return '';
    return text;
  }

  function finiteNumber(value) {
    var n = typeof value === 'number' ? value : (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim()) ? Number(value.trim()) : NaN);
    return isFinite(n) ? n : null;
  }

  function finiteInt(value) {
    var n = finiteNumber(value);
    if (n == null || Math.floor(n) !== n) return null;
    return n;
  }

  function cleanStatus(value) {
    if (typeof value !== 'string') return '';
    var text = value.trim();
    if (!/^[A-Z][A-Z0-9_]{0,31}$/.test(text)) return '';
    return text;
  }

  function safeIssue(value) {
    var text = typeof value === 'string' ? value : '';
    if (text === 'JSON_PARSE_FAILED' || text === 'NO_DATA_ARRAY' || text === 'HTTP' || text === 'CLONE_FAILED' || text === 'TEXT_FAILED' || text === 'OTHER_HOST') return text;
    return 'FAILED';
  }

  function safeTime(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return '';
    var ms = Date.parse(value);
    return isFinite(ms) ? value : '';
  }

  function cleanHost(value) {
    var text = typeof value === 'string' ? value.toLowerCase() : '';
    if (!/^[a-z0-9.-]{1,80}$/.test(text)) return '';
    return text;
  }

  function idKind(value) {
    if (!value) return 'empty';
    if (/^\d+$/.test(value)) return 'digits';
    if (/^[A-Za-z]+$/.test(value)) return 'letters';
    if (/^[A-Za-z][A-Za-z0-9]+$/.test(value)) return 'letter-then-alnum';
    return 'other';
  }

  function kindLabel(kind) {
    if (kind === 'digits') return '数字のみ';
    if (kind === 'letters') return '英字のみ';
    if (kind === 'letter-then-alnum') return '英字で始まる英数字';
    if (kind === 'other') return 'その他';
    return '空';
  }

  function summarizeIds(values) {
    var list = Array.isArray(values) ? values : [];
    var kinds = { empty: 0, digits: 0, letters: 0, 'letter-then-alnum': 0, other: 0 };
    var lengths = {};
    var counts = Object.create(null);
    var present = 0;
    list.forEach(function (value) {
      var id = value || '';
      if (!id) {
        kinds.empty += 1;
        return;
      }
      present += 1;
      var kind = idKind(id);
      kinds[kind] += 1;
      var len = String(id.length);
      lengths[len] = (lengths[len] || 0) + 1;
      counts[id] = (counts[id] || 0) + 1;
    });
    var duplicateValues = 0;
    var extraRows = 0;
    Object.keys(counts).forEach(function (id) {
      if (counts[id] > 1) {
        duplicateValues += 1;
        extraRows += counts[id] - 1;
      }
    });
    var dominant = 'empty';
    var best = -1;
    ['digits', 'letter-then-alnum', 'letters', 'other'].forEach(function (kind) {
      if (kinds[kind] > best) {
        best = kinds[kind];
        dominant = kinds[kind] > 0 ? kind : dominant;
      }
    });
    if (present === 0) dominant = 'empty';
    return {
      rows: list.length,
      present: present,
      missing: kinds.empty,
      dominantKind: dominant,
      dominantLabel: kindLabel(dominant),
      kinds: {
        digits: kinds.digits,
        letters: kinds.letters,
        letterThenAlnum: kinds['letter-then-alnum'],
        other: kinds.other
      },
      lengths: lengths,
      duplicateValues: duplicateValues,
      extraRows: extraRows
    };
  }

  function formatsAlign(left, right) {
    if (!left || !right) return false;
    if (!left.present || !right.present) return false;
    return left.dominantKind === right.dominantKind && left.dominantKind !== 'other' && left.dominantKind !== 'empty';
  }

  function compareIds(leftList, rightList) {
    var left = Array.isArray(leftList) ? leftList : [];
    var right = Array.isArray(rightList) ? rightList : [];
    var leftCounts = Object.create(null);
    var rightCounts = Object.create(null);
    left.forEach(function (id) { if (id) leftCounts[id] = (leftCounts[id] || 0) + 1; });
    right.forEach(function (id) { if (id) rightCounts[id] = (rightCounts[id] || 0) + 1; });
    var exactValueCount = 0;
    Object.keys(leftCounts).forEach(function (id) {
      if (rightCounts[id]) exactValueCount += 1;
    });
    var uniquePeople = 0;
    var ambiguous = 0;
    var unmatched = 0;
    var missing = 0;
    left.forEach(function (id) {
      if (!id) {
        missing += 1;
        return;
      }
      if (!rightCounts[id]) {
        unmatched += 1;
        return;
      }
      if (leftCounts[id] === 1 && rightCounts[id] === 1) uniquePeople += 1;
      else ambiguous += 1;
    });
    return {
      comparable: true,
      identityProven: false,
      exactValueCount: exactValueCount,
      uniquePeople: uniquePeople,
      ambiguous: ambiguous,
      unmatched: unmatched,
      missing: missing,
      leftRows: left.length,
      rightRows: right.length
    };
  }

  function epochToMs(value) {
    var n = finiteNumber(value);
    if (n == null || n <= 0) return null;
    if (n >= 1e12) return n;
    if (n >= 1e9) return n * 1000;
    return null;
  }

  function tokyoParts(ms) {
    var fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Tokyo',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
    var parts = fmt.formatToParts(new Date(ms));
    function pick(type) {
      var found = null;
      parts.forEach(function (part) {
        if (part.type === type) found = part.value;
      });
      return found || '';
    }
    var hour = pick('hour');
    if (hour === '24') hour = '00';
    var minute = Number(pick('minute'));
    var hourNum = Number(hour);
    if (!isFinite(hourNum) || !isFinite(minute)) return null;
    return {
      date: pick('year') + '-' + pick('month') + '-' + pick('day'),
      minutes: hourNum * 60 + minute
    };
  }

  function hourKey(minutes) {
    if (minutes == null || minutes < 0 || minutes > 1439) return '';
    var hour = Math.floor(minutes / 60);
    return (hour < 10 ? '0' : '') + String(hour);
  }

  function clockCheck(res, dateKey) {
    var minutes = res.startTimeInMinutes;
    var ms = epochToMs(res.startTimeInEpoch);
    var minutesOk = minutes != null && minutes >= 0 && minutes <= 1439;
    if (ms == null) return { minute: 'unknown', date: 'unknown' };
    var parts = tokyoParts(ms);
    if (!parts) return { minute: 'unknown', date: 'unknown' };
    return {
      minute: !minutesOk ? 'unknown' : (parts.minutes === minutes ? 'match' : 'mismatch'),
      date: parts.date === dateKey ? 'match' : 'mismatch'
    };
  }

  function bump(map, key) {
    if (!key) return;
    map[key] = (map[key] || 0) + 1;
  }

  function personDaRelation(person) {
    var driver = person.driverPersonId || '';
    var seen = Object.create(null);
    var daValues = [];
    person.reservations.forEach(function (res) {
      if (!res.daPersonId || seen[res.daPersonId]) return;
      seen[res.daPersonId] = true;
      daValues.push(res.daPersonId);
    });
    if (!person.reservations.length) return { className: 'no-reservation', daPersonId: '' };
    if (!driver || !daValues.length) return { className: 'missing', daPersonId: daValues.length === 1 ? daValues[0] : '' };
    if (daValues.length > 1) return { className: 'conflict', daPersonId: '' };
    if (daValues[0] === driver) return { className: 'same', daPersonId: daValues[0] };
    return { className: 'different', daPersonId: daValues[0] };
  }

  function statsForDate(people, date) {
    var withRes = 0;
    var without = 0;
    var multi = 0;
    var assigned = 0;
    var reservationCount = 0;
    var statusCounts = {};
    var startHourCounts = {};
    var clock = { minuteMatch: 0, minuteMismatch: 0, minuteUnknown: 0, dateMatch: 0, dateMismatch: 0, dateUnknown: 0 };
    people.forEach(function (person) {
      var items = [];
      person.reservations.forEach(function (res) {
        if (res.date === date) items.push(res);
      });
      if (!items.length) {
        without += 1;
        return;
      }
      withRes += 1;
      if (items.length > 1) multi += 1;
      items.forEach(function (res) {
        reservationCount += 1;
        var status = res.status || '(empty)';
        bump(statusCounts, status);
        if (res.status === 'ASSIGNED') assigned += 1;
        bump(startHourCounts, hourKey(res.startTimeInMinutes));
        var check = clockCheck(res, date);
        if (check.minute === 'match') clock.minuteMatch += 1;
        else if (check.minute === 'mismatch') clock.minuteMismatch += 1;
        else clock.minuteUnknown += 1;
        if (check.date === 'match') clock.dateMatch += 1;
        else if (check.date === 'mismatch') clock.dateMismatch += 1;
        else clock.dateUnknown += 1;
      });
    });
    var otherStatusCounts = {};
    Object.keys(statusCounts).forEach(function (status) {
      if (status !== 'ASSIGNED') otherStatusCounts[status] = statusCounts[status];
    });
    return {
      peopleWithReservation: withRes,
      peopleWithoutReservation: without,
      reservationCount: reservationCount,
      assignedReservations: assigned,
      otherStatusCounts: otherStatusCounts,
      multiBlockPeople: multi,
      startHourCounts: startHourCounts,
      clock: clock
    };
  }

  function dateKeysOf(people) {
    var seen = Object.create(null);
    people.forEach(function (person) {
      person.reservations.forEach(function (res) {
        if (res.date) seen[res.date] = true;
      });
    });
    return Object.keys(seen).sort();
  }

  function tokyoDate(now) {
    var parts = tokyoParts(now.getTime());
    return parts ? parts.date : '';
  }

  function chooseFocus(keys, selectedDate, now) {
    if (selectedDate && keys.indexOf(selectedDate) >= 0) return selectedDate;
    var today = tokyoDate(now);
    if (today && keys.indexOf(today) >= 0) return today;
    return keys.length ? keys[0] : '';
  }

  function isRosterPath(pathname) {
    return /\/rosters\/?$/.test(String(pathname || ''));
  }

  function requestUrl(url) {
    try {
      return new URL(String(url || ''), 'https://logistics.amazon.co.jp');
    } catch (e) {
      return null;
    }
  }

  function isRosterRequest(url, method) {
    if (String(method || 'GET').toUpperCase() !== 'GET') return false;
    var parsed = requestUrl(url);
    if (!parsed) return false;
    if (parsed.hostname !== 'logistics.amazon.co.jp') return false;
    return isRosterPath(parsed.pathname);
  }

  function foreignRosterHost(url, method) {
    if (String(method || 'GET').toUpperCase() !== 'GET') return '';
    var parsed = requestUrl(url);
    if (!parsed || !isRosterPath(parsed.pathname)) return '';
    if (parsed.hostname === 'logistics.amazon.co.jp') return '';
    return cleanHost(parsed.hostname);
  }

  function fromDateOf(url) {
    var parsed = requestUrl(url);
    if (!parsed) return '';
    var value = parsed.searchParams.get('fromDate') || '';
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '';
  }

  function parseJson(text) {
    var raw = String(text == null ? '' : text);
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    raw = raw.replace(/^\)\]\}',?\n/, '');
    try {
      return { ok: true, body: JSON.parse(raw) };
    } catch (e) {
      return { ok: false, issue: 'JSON_PARSE_FAILED' };
    }
  }

  var ROSTER_NAME_FIELDS = ['associateName', 'schedulingName', 'firstName', 'lastName', 'displayName', 'driverFirstName', 'driverLastName', 'driverName'];

  function isRosterNameKey(key) {
    if (typeof key !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,40}$/.test(key)) return false;
    if (/email|phone|token|password|cookie|authorization|secret|personid/i.test(key)) return false;
    if (ROSTER_NAME_FIELDS.indexOf(key) >= 0) return true;
    return /name$/i.test(key);
  }

  function rosterNamePresent(value) {
    if (typeof value === 'string') return value.trim() !== '';
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === 'object') return Object.keys(value).length > 0;
    return false;
  }

  function tallyRosterNameFields(rows) {
    var list = Array.isArray(rows) ? rows : [];
    var extras = Object.create(null);
    list.forEach(function (row) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return;
      Object.keys(row).forEach(function (key) {
        if (!isRosterNameKey(key) || ROSTER_NAME_FIELDS.indexOf(key) >= 0) return;
        extras[key] = true;
      });
    });
    var fields = ROSTER_NAME_FIELDS.concat(Object.keys(extras).sort());
    return fields.slice(0, 20).map(function (field) {
      var present = 0;
      list.forEach(function (row) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) return;
        if (!Object.prototype.hasOwnProperty.call(row, field)) return;
        if (rosterNamePresent(row[field])) present += 1;
      });
      return { field: field, present: present, missing: list.length - present };
    });
  }

  function publicNameFields(list) {
    if (!Array.isArray(list)) return null;
    var byField = Object.create(null);
    list.forEach(function (item) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return;
      var field = item.field;
      if (!isRosterNameKey(field) || byField[field]) return;
      var present = finiteInt(item.present);
      var missing = finiteInt(item.missing);
      if (present == null || present < 0 || missing == null || missing < 0) return;
      byField[field] = { field: field, present: present, missing: missing };
    });
    var ordered = [];
    ROSTER_NAME_FIELDS.forEach(function (field) {
      if (!byField[field]) return;
      ordered.push(byField[field]);
      delete byField[field];
    });
    Object.keys(byField).sort().forEach(function (field) {
      if (ordered.length >= 20) return;
      ordered.push(byField[field]);
    });
    return ordered;
  }

  function extractRoster(body, url, capturedAt) {
    var data = body && Array.isArray(body.data) ? body.data : null;
    if (!data) return { ok: false, issue: 'NO_DATA_ARRAY', capturedAt: safeTime(capturedAt) || new Date().toISOString() };
    var people = [];
    data.forEach(function (row) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        people.push({ driverPersonId: '', reservations: [] });
        return;
      }
      var map = row.reservationsMap;
      var reservations = [];
      if (map && typeof map === 'object' && !Array.isArray(map)) {
        Object.keys(map).forEach(function (date) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Array.isArray(map[date])) return;
          map[date].forEach(function (res) {
            if (!res || typeof res !== 'object' || Array.isArray(res)) return;
            reservations.push({
              date: date,
              daPersonId: cleanId(res.daPersonId),
              startTimeInMinutes: finiteInt(res.startTimeInMinutes),
              startTimeInEpoch: finiteNumber(res.startTimeInEpoch),
              status: cleanStatus(res.status)
            });
          });
        });
      }
      people.push({
        driverPersonId: cleanId(row.driverPersonId),
        driverFirstName: cleanPersonName(row.driverFirstName),
        driverLastName: cleanPersonName(row.driverLastName),
        driverName: cleanPersonName(row.driverName),
        reservations: reservations
      });
    });
    return {
      ok: true,
      capturedAt: safeTime(capturedAt) || new Date().toISOString(),
      fromDate: fromDateOf(url),
      people: people,
      nameFields: tallyRosterNameFields(data)
    };
  }

  var EPOCH_MIN_MS = Date.UTC(2000, 0, 1);
  var EPOCH_MAX_MS = Date.UTC(2100, 0, 1);

  function finiteCount(value) {
    return typeof value === 'number' && isFinite(value) && value >= 0 && Math.floor(value) === value && value < 10000000 ? value : 0;
  }

  function pad2(value) {
    return (value < 10 ? '0' : '') + value;
  }

  function calendarDate(text) {
    if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return '';
    var year = Number(text.slice(0, 4));
    var month = Number(text.slice(5, 7));
    var day = Number(text.slice(8, 10));
    if (month < 1 || month > 12 || day < 1 || day > 31) return '';
    var utc = new Date(Date.UTC(year, month - 1, day));
    if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) return '';
    return text;
  }

  function jstDayStart(date) {
    var text = calendarDate(date);
    if (!text) return null;
    return Date.UTC(Number(text.slice(0, 4)), Number(text.slice(5, 7)) - 1, Number(text.slice(8, 10)), -9, 0, 0);
  }

  function addCalendarDays(date, days) {
    var text = calendarDate(date);
    if (!text) return '';
    var utc = new Date(Date.UTC(Number(text.slice(0, 4)), Number(text.slice(5, 7)) - 1, Number(text.slice(8, 10)) + days));
    return utc.getUTCFullYear() + '-' + pad2(utc.getUTCMonth() + 1) + '-' + pad2(utc.getUTCDate());
  }

  function jstDateOf(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '';
    var parts = tokyoParts(ms);
    return parts && calendarDate(parts.date) ? parts.date : '';
  }

  function blankTypeCounts() {
    return { number: 0, numericString: 0, timeString: 0, isoDatetime: 0, nullish: 0, other: 0 };
  }

  function blankEndTypeCounts() {
    var counts = blankTypeCounts();
    counts.na = 0;
    return counts;
  }

  function blankEpochCounts() {
    return { epochMs: 0, epochSec: 0, unparseable: 0 };
  }

  function blankEndDates() {
    return { sameDay: 0, previousDay: 0, otherDay: 0, undated: 0, targetUnverified: 0 };
  }

  function blankStatusSide() {
    return { active: 0, missing: 0, other: [] };
  }

  function unavailableHistory() {
    return {
      available: false,
      rangeStatus: 'range-unverified',
      targetDate: '',
      rangeStartDate: '',
      rangeEndDate: '',
      includesTarget: null,
      coversFullTargetDay: null,
      localDateParse: 'missing',
      startTimeParse: 'missing',
      endTimeParse: 'missing',
      fpIdPresent: false,
      returnCompleteness: 'unverified',
      startTypes: blankTypeCounts(),
      startEpoch: blankEpochCounts(),
      endTypes: blankEndTypeCounts(),
      endEpoch: blankEpochCounts(),
      endDates: blankEndDates(),
      vrmStatus: { active: 0, missing: 0, other: [], endNA: blankStatusSide(), notEndNA: blankStatusSide() },
      sessions: {
        multiRowIdentifiers: 0,
        mixedActiveCandidates: 0,
        parseableEndCandidates: 0,
        identityConflictCandidates: 0
      }
    };
  }

  function publicStatus(value) {
    if (value == null) return '';
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return '(opaque)';
    var label = String(value).trim();
    if (!label) return '';
    if (label.length > 32 || /^\d{6,}$/.test(label)) return '(opaque)';
    if (!/^[A-Za-z0-9][A-Za-z0-9 _./:-]{0,31}$/.test(label)) return '(opaque)';
    return label;
  }

  function copyStatusList(list) {
    var out = [];
    if (!Array.isArray(list)) return out;
    list.forEach(function (item) {
      var status = publicStatus(item && item.status);
      if (!status || status === 'Active') return;
      out.push({ status: status, count: finiteCount(item && item.count) });
    });
    return out;
  }

  function copyStatusSide(side) {
    return {
      active: finiteCount(side && side.active),
      missing: finiteCount(side && side.missing),
      other: copyStatusList(side && side.other)
    };
  }

  function acceptHistory(value) {
    if (!value || value.available !== true) return unavailableHistory();
    var start = value.startTypes || {};
    var end = value.endTypes || {};
    var dates = value.endDates || {};
    var sessions = value.sessions || {};
    var status = value.vrmStatus || {};
    return {
      available: true,
      rangeStatus: value.rangeStatus === 'verified' ? 'verified' : 'range-unverified',
      targetDate: calendarDate(value.targetDate),
      rangeStartDate: calendarDate(value.rangeStartDate),
      rangeEndDate: calendarDate(value.rangeEndDate),
      includesTarget: value.includesTarget === true ? true : (value.includesTarget === false ? false : null),
      coversFullTargetDay: value.coversFullTargetDay === true ? true : (value.coversFullTargetDay === false ? false : null),
      localDateParse: value.localDateParse === 'ok' || value.localDateParse === 'failed' ? value.localDateParse : 'missing',
      startTimeParse: value.startTimeParse === 'ok' || value.startTimeParse === 'failed' ? value.startTimeParse : 'missing',
      endTimeParse: value.endTimeParse === 'ok' || value.endTimeParse === 'failed' ? value.endTimeParse : 'missing',
      fpIdPresent: value.fpIdPresent === true,
      returnCompleteness: 'unverified',
      startTypes: {
        number: finiteCount(start.number),
        numericString: finiteCount(start.numericString),
        timeString: finiteCount(start.timeString),
        isoDatetime: finiteCount(start.isoDatetime),
        nullish: finiteCount(start.nullish),
        other: finiteCount(start.other)
      },
      startEpoch: {
        epochMs: finiteCount(value.startEpoch && value.startEpoch.epochMs),
        epochSec: finiteCount(value.startEpoch && value.startEpoch.epochSec),
        unparseable: finiteCount(value.startEpoch && value.startEpoch.unparseable)
      },
      endTypes: {
        na: finiteCount(end.na),
        number: finiteCount(end.number),
        numericString: finiteCount(end.numericString),
        timeString: finiteCount(end.timeString),
        isoDatetime: finiteCount(end.isoDatetime),
        nullish: finiteCount(end.nullish),
        other: finiteCount(end.other)
      },
      endEpoch: {
        epochMs: finiteCount(value.endEpoch && value.endEpoch.epochMs),
        epochSec: finiteCount(value.endEpoch && value.endEpoch.epochSec),
        unparseable: finiteCount(value.endEpoch && value.endEpoch.unparseable)
      },
      endDates: {
        sameDay: finiteCount(dates.sameDay),
        previousDay: finiteCount(dates.previousDay),
        otherDay: finiteCount(dates.otherDay),
        undated: finiteCount(dates.undated),
        targetUnverified: finiteCount(dates.targetUnverified)
      },
      vrmStatus: {
        active: finiteCount(status.active),
        missing: finiteCount(status.missing),
        other: copyStatusList(status.other),
        endNA: copyStatusSide(status.endNA),
        notEndNA: copyStatusSide(status.notEndNA)
      },
      sessions: {
        multiRowIdentifiers: finiteCount(sessions.multiRowIdentifiers),
        mixedActiveCandidates: finiteCount(sessions.mixedActiveCandidates),
        parseableEndCandidates: finiteCount(sessions.parseableEndCandidates),
        identityConflictCandidates: finiteCount(sessions.identityConflictCandidates)
      }
    };
  }

  function valueShape(value, allowNA) {
    if (value == null) return 'nullish';
    if (typeof value === 'number') return isFinite(value) ? 'number' : 'other';
    if (typeof value !== 'string') return 'other';
    var text = value.trim();
    if (!text) return 'other';
    if (allowNA && text === 'N/A') return 'na';
    if (/^-?\d+(\.\d+)?$/.test(text)) return 'numericString';
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(text)) {
      var bits = text.split(':');
      var hour = Number(bits[0]);
      var minute = Number(bits[1]);
      var second = bits.length === 3 ? Number(bits[2]) : 0;
      if (hour > 23 || minute > 59 || second > 59) return 'other';
      return 'timeString';
    }
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})?$/.test(text)) return 'isoDatetime';
    return 'other';
  }

  function epochInstant(value) {
    var n = null;
    if (typeof value === 'number' && isFinite(value)) n = value;
    else if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) n = Number(value.trim());
    else return null;
    if (!isFinite(n)) return { ms: null, unit: '' };
    if (n >= 1e12 && n < 1e14) {
      if (n >= EPOCH_MIN_MS && n < EPOCH_MAX_MS) return { ms: n, unit: 'ms' };
      return { ms: null, unit: '' };
    }
    if (n >= 1e9 && n < 1e12) {
      var ms = n * 1000;
      if (ms >= EPOCH_MIN_MS && ms < EPOCH_MAX_MS) return { ms: ms, unit: 'sec' };
      return { ms: null, unit: '' };
    }
    return { ms: null, unit: '' };
  }

  function isoInstant(value) {
    var text = typeof value === 'string' ? value.trim() : '';
    var match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})?$/.exec(text);
    if (!match || !calendarDate(match[1] + '-' + match[2] + '-' + match[3])) return null;
    var hour = Number(match[4]);
    var minute = Number(match[5]);
    var second = Number(match[6]);
    if (hour > 23 || minute > 59 || second > 59) return null;
    var fraction = match[7] ? match[7].slice(1) : '';
    while (fraction.length < 3) fraction += '0';
    var millis = fraction ? Number(fraction.slice(0, 3)) : 0;
    var zone = match[8] || '';
    var year = Number(match[1]);
    var month = Number(match[2]);
    var day = Number(match[3]);
    var instant;
    if (!zone) instant = Date.UTC(year, month - 1, day, hour - 9, minute, second, millis);
    else if (zone === 'Z') instant = Date.UTC(year, month - 1, day, hour, minute, second, millis);
    else {
      var sign = zone.charAt(0) === '-' ? -1 : 1;
      var zoneHour = Number(zone.slice(1, 3));
      var zoneMinute = Number(zone.slice(4, 6));
      if (zoneHour > 23 || zoneMinute > 59) return null;
      instant = Date.UTC(year, month - 1, day, hour, minute, second, millis) - sign * ((zoneHour * 60) + zoneMinute) * 60000;
    }
    if (!isFinite(instant) || instant < EPOCH_MIN_MS || instant >= EPOCH_MAX_MS) return null;
    return instant;
  }

  function timedInstant(value, shape) {
    if (shape === 'number' || shape === 'numericString') {
      var epoch = epochInstant(value);
      if (!epoch) return null;
      if (epoch.ms == null) return { ms: null, unit: '' };
      return epoch;
    }
    if (shape === 'isoDatetime') {
      var ms = isoInstant(value);
      return ms == null ? { ms: null, unit: '' } : { ms: ms, unit: 'iso' };
    }
    return null;
  }

  function bumpStatus(list, status) {
    var found = false;
    list.forEach(function (item) {
      if (item.status === status) {
        item.count += 1;
        found = true;
      }
    });
    if (!found) list.push({ status: status, count: 1 });
  }

  function sortStatus(list) {
    list.sort(function (a, b) {
      if (b.count !== a.count) return b.count - a.count;
      return a.status < b.status ? -1 : (a.status > b.status ? 1 : 0);
    });
  }

  function readShiftQuery(url) {
    var out = { localDate: null, startRaw: null, endRaw: null, fpIdPresent: false };
    if (typeof url !== 'string' || !url) return out;
    var parsed;
    try { parsed = new URL(url, 'https://vrm-mentor.edriving.com'); } catch (e) { return out; }
    if (parsed.searchParams.has('localDate')) out.localDate = parsed.searchParams.get('localDate');
    if (parsed.searchParams.has('startTime')) out.startRaw = parsed.searchParams.get('startTime');
    if (parsed.searchParams.has('endTime')) out.endRaw = parsed.searchParams.get('endTime');
    out.fpIdPresent = parsed.searchParams.has('fpId') && String(parsed.searchParams.get('fpId') || '').trim() !== '';
    return out;
  }

  function queryInstant(raw) {
    if (raw == null) return { parse: 'missing', ms: null };
    if (String(raw).trim() === '') return { parse: 'missing', ms: null };
    var epoch = epochInstant(raw);
    if (!epoch || epoch.ms == null) return { parse: 'failed', ms: null };
    return { parse: 'ok', ms: epoch.ms };
  }

  function noteEpoch(bucket, timed) {
    if (!timed) return;
    if (timed.unit === 'ms') bucket.epochMs += 1;
    else if (timed.unit === 'sec') bucket.epochSec += 1;
    else bucket.unparseable += 1;
  }

  function summarizeMentorHistory(data, requestUrl) {
    var history = unavailableHistory();
    history.available = true;
    var query = readShiftQuery(requestUrl);
    var target = query.localDate == null ? '' : calendarDate(String(query.localDate).trim());
    history.localDateParse = query.localDate == null || String(query.localDate).trim() === '' ? 'missing' : (target ? 'ok' : 'failed');
    history.targetDate = target;
    var start = queryInstant(query.startRaw);
    var end = queryInstant(query.endRaw);
    history.startTimeParse = start.parse;
    history.endTimeParse = end.parse;
    history.fpIdPresent = query.fpIdPresent === true;
    history.rangeStartDate = start.ms == null ? '' : jstDateOf(start.ms);
    history.rangeEndDate = end.ms == null ? '' : jstDateOf(end.ms);
    var ordered = start.parse === 'ok' && end.parse === 'ok' && start.ms <= end.ms;
    var dayStart = target ? jstDayStart(target) : null;
    var dayEnd = dayStart == null ? null : dayStart + 86400000;
    if (history.localDateParse === 'ok' && ordered && dayStart != null) {
      history.rangeStatus = 'verified';
      history.includesTarget = start.ms < dayEnd && end.ms > dayStart;
      history.coversFullTargetDay = start.ms <= dayStart && end.ms >= dayEnd - 1;
    }
    var previous = target ? addCalendarDays(target, -1) : '';
    var groups = Object.create(null);
    (data || []).forEach(function (row) {
      var record = row && typeof row === 'object' && !Array.isArray(row) ? row : null;
      var startValue = record ? record.shiftStartTime : null;
      var startShape = valueShape(startValue, false);
      history.startTypes[startShape] += 1;
      if (startShape === 'number' || startShape === 'numericString') noteEpoch(history.startEpoch, timedInstant(startValue, startShape));
      var endValue = record ? record.shiftEndTime : null;
      var endShape = valueShape(endValue, true);
      history.endTypes[endShape] += 1;
      var endTimed = timedInstant(endValue, endShape);
      if (endShape === 'number' || endShape === 'numericString') noteEpoch(history.endEpoch, endTimed);
      var endMs = endTimed && endTimed.ms != null ? endTimed.ms : null;
      if (endMs == null) history.endDates.undated += 1;
      else if (!target) history.endDates.targetUnverified += 1;
      else {
        var endDate = jstDateOf(endMs);
        if (!endDate) history.endDates.undated += 1;
        else if (endDate === target) history.endDates.sameDay += 1;
        else if (endDate === previous) history.endDates.previousDay += 1;
        else history.endDates.otherDay += 1;
      }
      var openEnd = !!(record && record.shiftEndTime === 'N/A');
      var side = openEnd ? history.vrmStatus.endNA : history.vrmStatus.notEndNA;
      var active = !!(record && record.vrmStatus === 'Active');
      var label = publicStatus(record ? record.vrmStatus : null);
      if (active) {
        history.vrmStatus.active += 1;
        side.active += 1;
      } else if (!label) {
        history.vrmStatus.missing += 1;
        side.missing += 1;
      } else {
        bumpStatus(history.vrmStatus.other, label);
        bumpStatus(side.other, label);
      }
      var staff = normalizeIdToken(record && record.realStaffNumber);
      if (!staff) return;
      if (!groups[staff]) groups[staff] = { rows: 0, active: 0, inactive: 0, parseableEnd: 0, driverIds: Object.create(null), names: Object.create(null) };
      var group = groups[staff];
      group.rows += 1;
      if (active && openEnd) group.active += 1;
      else group.inactive += 1;
      if (endMs != null) group.parseableEnd += 1;
      var driver = normalizeIdToken(record && record.driverId);
      if (driver) group.driverIds[driver] = true;
      var name = mentorNameKey(record && record.firstName, record && record.lastName);
      if (name) group.names[name] = true;
    });
    Object.keys(groups).forEach(function (staff) {
      var group = groups[staff];
      if (group.rows > 1) history.sessions.multiRowIdentifiers += 1;
      if (group.active > 0 && group.inactive > 0) history.sessions.mixedActiveCandidates += 1;
      if (group.parseableEnd > 0) history.sessions.parseableEndCandidates += 1;
      if (Object.keys(group.driverIds).length > 1 || Object.keys(group.names).length > 1) history.sessions.identityConflictCandidates += 1;
    });
    sortStatus(history.vrmStatus.other);
    sortStatus(history.vrmStatus.endNA.other);
    sortStatus(history.vrmStatus.notEndNA.other);
    return acceptHistory(history);
  }

  function shiftEndDate(value) {
    if (value === 'N/A') return '';
    var shape = valueShape(value, true);
    var timed = timedInstant(value, shape);
    if (!timed || timed.ms == null) return '';
    return jstDateOf(timed.ms);
  }

  function mentorDigest(body, capturedAt, requestUrl) {
    var data = body && Array.isArray(body.data) ? body.data : null;
    var captured = safeTime(capturedAt) || new Date().toISOString();
    if (!data) return { ok: false, issue: 'NO_DATA_ARRAY', capturedAt: captured, history: unavailableHistory() };
    var rows = [];
    data.forEach(function (row) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        rows.push({ driverId: '', realStaffNumber: '', active: false });
        return;
      }
      rows.push({
        driverId: cleanId(row.driverId),
        realStaffNumber: cleanId(row.realStaffNumber),
        firstName: cleanPersonName(row.firstName),
        lastName: cleanPersonName(row.lastName),
        active: row.shiftEndTime === 'N/A' && row.vrmStatus === 'Active',
        endDate: shiftEndDate(row.shiftEndTime)
      });
    });
    return {
      ok: true,
      capturedAt: captured,
      rows: rows,
      history: summarizeMentorHistory(data, requestUrl)
    };
  }

  function sideView(side, role) {
    if (!side) return { state: 'missing', role: role };
    if (side.ok === false) {
      return {
        state: 'failed',
        role: role,
        issue: safeIssue(side.issue),
        capturedAt: safeTime(side.capturedAt),
        meta: publicMeta(side.meta)
      };
    }
    return { state: 'ready', role: role };
  }

  function publicMeta(meta) {
    meta = meta || {};
    var hosts = [];
    if (Array.isArray(meta.otherHosts)) {
      meta.otherHosts.forEach(function (host) {
        var clean = cleanHost(host);
        if (clean && hosts.indexOf(clean) < 0 && hosts.length < 3) hosts.push(clean);
      });
    }
    return {
      matched: Number(meta.matched) > 0 ? Number(meta.matched) : 0,
      otherHostRosterCount: Number(meta.otherHostRosterCount) > 0 ? Number(meta.otherHostRosterCount) : 0,
      otherHosts: hosts
    };
  }

  function personDaSummary(people) {
    var summary = { same: 0, different: 0, missing: 0, conflict: 0, noReservation: 0 };
    people.forEach(function (person) {
      var relation = personDaRelation(person);
      if (relation.className === 'same') summary.same += 1;
      else if (relation.className === 'different') summary.different += 1;
      else if (relation.className === 'missing') summary.missing += 1;
      else if (relation.className === 'conflict') summary.conflict += 1;
      else summary.noReservation += 1;
    });
    return summary;
  }

  function daIdsForMatch(people) {
    var ids = [];
    var skippedConflict = 0;
    people.forEach(function (person) {
      var relation = personDaRelation(person);
      if (relation.className === 'conflict') {
        skippedConflict += 1;
        return;
      }
      if (relation.className === 'no-reservation') return;
      ids.push(relation.daPersonId || '');
    });
    return { ids: ids, skippedConflict: skippedConflict };
  }

  function isStale(side, now) {
    if (!side || side.ok === false) return false;
    var text = safeTime(side.capturedAt);
    if (!text) return true;
    return now.getTime() - Date.parse(text) > STALE_MS;
  }

  function tokyoStartMs(date, minutes) {
    if (minutes == null || minutes < 0 || minutes > 1439) return null;
    var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
    if (!match) return null;
    var midnight = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), -9, 0, 0);
    return midnight + minutes * 60000;
  }

  function startBucket(date, minutes, now) {
    var start = tokyoStartMs(date, minutes);
    if (start == null || !(now instanceof Date)) return 'unknown';
    var elapsed = now.getTime() - start;
    if (elapsed < 0) return 'before';
    if (elapsed < 5 * 60000) return 'within5';
    return 'after5';
  }

  function personTimeClass(buckets) {
    var hasAfter = false;
    var hasUnknown = false;
    var hasWithin = false;
    (buckets || []).forEach(function (bucket) {
      if (bucket === 'after5') hasAfter = true;
      else if (bucket === 'unknown') hasUnknown = true;
      else if (bucket === 'within5') hasWithin = true;
    });
    if (hasAfter) return 'after5';
    if (hasUnknown) return 'unknown';
    if (hasWithin) return 'within5';
    return 'before';
  }

  function idCounts(values) {
    var counts = Object.create(null);
    (values || []).forEach(function (id) {
      if (id) counts[id] = (counts[id] || 0) + 1;
    });
    return counts;
  }

  function normalizeIdToken(value) {
    if (value == null) return '';
    var text = String(value).replace(/[Ａ-Ｚａ-ｚ０-９]/g, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
    });
    text = text.replace(/[\s\-‐‑‒–—―−－]/g, '');
    if (!text || text.length > 80) return '';
    if (/bearer|cookie|password|token|@/i.test(text)) return '';
    return text;
  }

  function buildMasterIndex(entries) {
    var groups = Object.create(null);
    var registered = 0;
    (entries || []).forEach(function (entry) {
      var id = normalizeIdToken(entry && entry.transportId);
      var name = entry && typeof entry.name === 'string' ? entry.name : '';
      if (!id || !name) return;
      if (!groups[id]) groups[id] = { names: Object.create(null), department: '' };
      if (!groups[id].names[name]) {
        groups[id].names[name] = true;
        registered += 1;
        if (!groups[id].label) groups[id].label = name;
      }
      var japanese = entry && typeof entry.japaneseName === 'string' ? entry.japaneseName.trim() : '';
      if (japanese && !groups[id].japanese) groups[id].japanese = japanese;
      var department = entry && typeof entry.department === 'string' ? entry.department.trim() : '';
      if (department && !groups[id].department) groups[id].department = department;
    });
    var rows = [];
    var duplicateIds = 0;
    Object.keys(groups).forEach(function (id) {
      var nameCount = Object.keys(groups[id].names).length;
      if (nameCount > 1) duplicateIds += 1;
      rows.push({
        id: id,
        nameCount: nameCount,
        department: nameCount === 1 ? groups[id].department : '',
        label: nameCount === 1 ? groups[id].label || '' : '',
        japanese: nameCount === 1 ? groups[id].japanese || '' : ''
      });
    });
    return { registered: registered, duplicateIds: duplicateIds, rows: rows };
  }

  function masterView(master) {
    if (!master) return { state: 'missing', identityProven: false, namesShown: false };
    if (master.phase === 'loading') return { state: 'loading', identityProven: false, namesShown: false };
    if (master.ok === false || master.phase === 'failed') return { state: 'failed', identityProven: false, namesShown: false };
    return {
      state: 'ready',
      registered: master.registered || 0,
      duplicateIds: master.duplicateIds || 0,
      identityProven: false,
      namesShown: false
    };
  }

  function blankCauses() {
    return {
      total: 0,
      missing: 0,
      format: 0,
      normalization: 0,
      duplicate: 0,
      notInMaster: 0,
      noDepartment: 0,
      ofk6: 0,
      unknown: 0
    };
  }

  function masterShape(rows) {
    var shape = { count: 0, kinds: Object.create(null), lengths: Object.create(null) };
    (rows || []).forEach(function (row) {
      if (!row || !row.id) return;
      shape.count += 1;
      shape.kinds[idKind(row.id)] = true;
      shape.lengths[row.id.length] = true;
    });
    return shape;
  }

  function classifyAbsent(id, shape) {
    if (!id) return 'missing';
    if (shape.count && (!shape.kinds[idKind(id)] || !shape.lengths[id.length])) return 'format';
    return 'notInMaster';
  }

  function classifyUnnamed(id, row, shape) {
    if (!id) return 'missing';
    if (row && row.nameCount > 1) return 'duplicate';
    if (!row) return classifyAbsent(id, shape);
    if (!row.department) return 'noDepartment';
    if (row.department === 'OFK6') return 'ofk6';
    return 'unknown';
  }

  function addCause(causes, cause) {
    causes.total += 1;
    if (Object.prototype.hasOwnProperty.call(causes, cause)) causes[cause] += 1;
    else causes.unknown += 1;
  }

  function summarizeMasterJoin(people, date, now, master, activeIds, activeReady, rawActiveIds) {
    var out = {
      comparable: false,
      reason: '',
      identityProven: false,
      namesShown: false,
      after5NameCandidate: null,
      group1: null,
      group2: null,
      overlap: null,
      normalizedMatch: null
    };
    if (!master || master.phase === 'loading') {
      out.reason = 'master-loading';
      return out;
    }
    if (master.ok === false || master.phase === 'failed') {
      out.reason = 'master-failed';
      return out;
    }
    if (!master.rows) {
      out.reason = 'master-missing';
      return out;
    }
    var byTid = Object.create(null);
    master.rows.forEach(function (row) {
      if (row && row.id) byTid[row.id] = row;
    });
    var shape = masterShape(master.rows);
    var cohort = [];
    (people || []).forEach(function (person) {
      var assigned = (person.reservations || []).filter(function (res) {
        return res && res.date === date && res.status === 'ASSIGNED';
      });
      if (!assigned.length) return;
      cohort.push({
        raw: person && person.driverPersonId ? person.driverPersonId : '',
        id: normalizeIdToken(person && person.driverPersonId),
        buckets: assigned.map(function (res) {
          return startBucket(date, res.startTimeInMinutes, now);
        })
      });
    });
    var leftCounts = idCounts(cohort.map(function (member) { return member.id; }));
    var rawLeftCounts = idCounts(cohort.map(function (member) { return member.raw; }));
    var activeCounts = idCounts(activeIds || []);
    var rawActiveCounts = idCounts(rawActiveIds || activeIds || []);
    var unique = 0;
    var absent = 0;
    var unmatchable = 0;
    var withDepartment = 0;
    var withoutDepartment = 0;
    var ofk6 = 0;
    var after5NameCandidate = 0;
    var normalizedMatch = 0;
    var group1 = blankCauses();
    var group2 = blankCauses();
    var overlap = 0;
    cohort.forEach(function (member) {
      var row = member.id ? byTid[member.id] : null;
      var blocked = !member.id || leftCounts[member.id] !== 1 || (row && row.nameCount !== 1);
      var inGroup1 = false;
      if (blocked) {
        unmatchable += 1;
      } else if (!row) {
        absent += 1;
        inGroup1 = true;
        addCause(group1, classifyAbsent(member.id, shape));
      } else {
        unique += 1;
        if (member.raw && member.raw !== member.id) normalizedMatch += 1;
        if (row.department) withDepartment += 1;
        else withoutDepartment += 1;
        if (row.department === 'OFK6') ofk6 += 1;
      }
      var nameReady = !!(row && row.nameCount === 1 && row.department && row.department !== 'OFK6' && member.id && leftCounts[member.id] === 1);
      var inAfter5Gap = !!(
        activeReady &&
        member.raw &&
        !rawActiveCounts[member.raw] &&
        rawLeftCounts[member.raw] === 1 &&
        personTimeClass(member.buckets) === 'after5'
      );
      if (inAfter5Gap && nameReady) after5NameCandidate += 1;
      if (inAfter5Gap && !nameReady) {
        addCause(group2, classifyUnnamed(member.id, row, shape));
        if (inGroup1) overlap += 1;
      }
    });
    out.comparable = true;
    out.unique = unique;
    out.absent = absent;
    out.unmatchable = unmatchable;
    out.withDepartment = withDepartment;
    out.withoutDepartment = withoutDepartment;
    out.ofk6 = ofk6;
    out.after5NameCandidate = activeReady ? after5NameCandidate : null;
    out.group1 = group1;
    out.group2 = activeReady ? group2 : null;
    out.overlap = activeReady ? overlap : null;
    out.normalizedMatch = normalizedMatch;
    return out;
  }

  function summarizeAssignedActive(people, date, now, activeIds, allStaffIds, reason) {
    var cohort = [];
    var members = [];
    var multi = 0;
    var before = 0;
    var within5 = 0;
    var after5 = 0;
    var unknown = 0;
    var blocks = 0;
    (people || []).forEach(function (person) {
      var items = [];
      (person.reservations || []).forEach(function (res) {
        if (res && res.date === date && res.status === 'ASSIGNED') items.push(res);
      });
      if (!items.length) return;
      if (items.length > 1) multi += 1;
      var buckets = [];
      cohort.push(person.driverPersonId || '');
      items.forEach(function (res) {
        blocks += 1;
        var bucket = startBucket(date, res.startTimeInMinutes, now);
        buckets.push(bucket);
        if (bucket === 'before') before += 1;
        else if (bucket === 'within5') within5 += 1;
        else if (bucket === 'after5') after5 += 1;
        else unknown += 1;
      });
      members.push({ id: person.driverPersonId || '', buckets: buckets });
    });
    var out = {
      assignedPeople: cohort.length,
      assignedBlocks: blocks,
      multiBlockPeople: multi,
      before: before,
      within5: within5,
      after5: after5,
      unknown: unknown,
      comparable: !reason,
      reason: reason || '',
      identityProven: false,
      absenceIsUnstarted: false
    };
    if (reason) return out;
    var compared = compareIds(cohort, activeIds || []);
    var activeCounts = idCounts(activeIds);
    var historyCounts = idCounts(allStaffIds);
    var leftCounts = idCounts(cohort);
    var beforeOnly = 0;
    var within5Only = 0;
    var hasAfter5 = 0;
    var unknownTime = 0;
    var confirmUnavailable = 0;
    var after5InHistory = 0;
    var after5NotInHistory = 0;
    members.forEach(function (member) {
      if (!member.id || activeCounts[member.id]) return;
      if (leftCounts[member.id] !== 1) {
        confirmUnavailable += 1;
        return;
      }
      var kind = personTimeClass(member.buckets);
      if (kind === 'after5') {
        hasAfter5 += 1;
        if (historyCounts[member.id]) after5InHistory += 1;
        else after5NotInHistory += 1;
      } else if (kind === 'unknown') unknownTime += 1;
      else if (kind === 'within5') within5Only += 1;
      else beforeOnly += 1;
    });
    out.uniqueStringMatch = compared.uniquePeople;
    out.notInActive = compared.unmatched;
    out.unmatchable = compared.missing + compared.ambiguous;
    out.mismatchBeforeOnly = beforeOnly;
    out.mismatchWithin5Only = within5Only;
    out.mismatchHasAfter5 = hasAfter5;
    out.mismatchUnknownTime = unknownTime;
    out.mismatchConfirmUnavailable = confirmUnavailable;
    out.after5InAllRows = after5InHistory;
    out.after5AbsentFromAllRows = after5NotInHistory;
    return out;
  }

  function attachAssignedActive(result, scheduling, mentor, now, crossStatus, stale) {
    var schedule = result.scheduling && result.scheduling.schedule;
    if (!schedule || !schedule.byDate || !scheduling || scheduling.ok === false) return;
    var reason = '';
    var activeIds = null;
    var allStaffIds = null;
    if (crossStatus !== 'ready') reason = crossStatus;
    else if (stale) reason = 'stale';
    else {
      activeIds = [];
      allStaffIds = [];
      (mentor.rows || []).forEach(function (row) {
        allStaffIds.push(row && row.realStaffNumber || '');
        if (row && row.active) activeIds.push(row.realStaffNumber || '');
      });
    }
    (schedule.dateKeys || []).forEach(function (date) {
      if (schedule.byDate[date]) {
        schedule.byDate[date].assignedActive = summarizeAssignedActive(scheduling.people, date, now, activeIds, allStaffIds, reason);
      }
    });
  }

  function attachMasterJoin(result, scheduling, mentor, master, now, schedulingStale) {
    result.master = masterView(master);
    var schedule = result.scheduling && result.scheduling.schedule;
    if (!schedule || !schedule.byDate || !scheduling || scheduling.ok === false) return;
    var activeIds = null;
    var rawActiveIds = null;
    var activeReady = false;
    if (!schedulingStale && mentor && mentor.ok !== false && !isStale(mentor, now)) {
      activeReady = true;
      activeIds = [];
      rawActiveIds = [];
      (mentor.rows || []).forEach(function (row) {
        if (!row || !row.active) return;
        rawActiveIds.push(row.realStaffNumber || '');
        activeIds.push(normalizeIdToken(row.realStaffNumber));
      });
    }
    (schedule.dateKeys || []).forEach(function (date) {
      if (!schedule.byDate[date]) return;
      if (schedulingStale) {
        schedule.byDate[date].masterJoin = {
          comparable: false,
          reason: 'stale',
          identityProven: false,
          namesShown: false,
          after5NameCandidate: null
        };
        return;
      }
      schedule.byDate[date].masterJoin = summarizeMasterJoin(
        scheduling.people,
        date,
        now,
        master,
        activeIds,
        activeReady,
        rawActiveIds
      );
    });
  }

  function buildDiagnostic(scheduling, mentor, master, now, selectedDate) {
    now = now instanceof Date ? now : new Date();
    var schedulingState = sideView(scheduling, 'scheduling');
    var mentorState = sideView(mentor, 'mentor');
    var crossStatus = 'ready';
    if (!scheduling && !mentor) crossStatus = 'both-missing';
    else if (!scheduling) crossStatus = 'scheduling-missing';
    else if (!mentor) crossStatus = 'mentor-missing';
    else if (scheduling.ok === false || mentor.ok === false) crossStatus = 'failed';
    var schedulingStale = !!(scheduling && scheduling.ok !== false && isStale(scheduling, now));
    var mentorStale = !!(mentor && mentor.ok !== false && isStale(mentor, now));
    var stale = schedulingStale || mentorStale;
    var result = {
      product: 'ID照合診断（調査用）',
      sendsData: false,
      identityProven: false,
      identityNote: IDENTITY_NOTE,
      absenceSafe: false,
      stale: stale,
      staleAfterMinutes: STALE_MS / 60000,
      crossStatus: crossStatus,
      scheduling: schedulingState,
      mentor: mentorState,
      pairs: null,
      stringCoverageComplete: false,
      coverageNote: '全shifts行への文字列カバーであり、Activeにいないことは未起動ではない'
    };
    if (scheduling && scheduling.ok !== false) {
      var driverIds = scheduling.people.map(function (person) { return person.driverPersonId || ''; });
      var keys = dateKeysOf(scheduling.people);
      var focus = chooseFocus(keys, selectedDate, now);
      var byDate = {};
      keys.forEach(function (date) { byDate[date] = statsForDate(scheduling.people, date); });
      result.scheduling = {
        state: 'ready',
        role: 'scheduling',
        capturedAt: safeTime(scheduling.capturedAt),
        fromDate: scheduling.fromDate || '',
        peopleCount: scheduling.people.length,
        driverPersonId: summarizeIds(driverIds),
        daPersonId: summarizeIds(daIdsForMatch(scheduling.people).ids),
        personDa: personDaSummary(scheduling.people),
        nameFields: scheduling.nameFields || null,
        meta: publicMeta(scheduling.meta),
        schedule: { dateKeys: keys, focus: focus, byDate: byDate }
      };
    } else if (scheduling && scheduling.meta) {
      result.scheduling.meta = publicMeta(scheduling.meta);
    }
    if (mentor && mentor.ok !== false) {
      var allDriver = [];
      var allStaff = [];
      var activeDriver = [];
      var activeStaff = [];
      var activeRows = 0;
      mentor.rows.forEach(function (row) {
        allDriver.push(row.driverId || '');
        allStaff.push(row.realStaffNumber || '');
        if (row.active) {
          activeRows += 1;
          activeDriver.push(row.driverId || '');
          activeStaff.push(row.realStaffNumber || '');
        }
      });
      result.mentor = {
        state: 'ready',
        role: 'mentor',
        capturedAt: safeTime(mentor.capturedAt),
        totalRows: mentor.rows.length,
        activeRows: activeRows,
        driverId: summarizeIds(allDriver),
        realStaffNumber: summarizeIds(allStaff),
        activeDriverId: summarizeIds(activeDriver),
        activeRealStaffNumber: summarizeIds(activeStaff),
        history: acceptHistory(mentor.history)
      };
    }
    if (crossStatus !== 'ready') {
      attachAssignedActive(result, scheduling, mentor, now, crossStatus, stale);
      attachMasterJoin(result, scheduling, mentor, master, now, schedulingStale);
      attachMentorPeople(result, scheduling, mentor);
      return seal(result);
    }
    var daMatch = daIdsForMatch(scheduling.people);
    var staff = mentor.rows.map(function (row) { return row.realStaffNumber || ''; });
    var drivers = mentor.rows.map(function (row) { return row.driverId || ''; });
    var left = {
      driverPersonId: scheduling.people.map(function (person) { return person.driverPersonId || ''; }),
      daPersonId: daMatch.ids
    };
    var right = { realStaffNumber: staff, driverId: drivers };
    var formats = {
      driverPersonId: result.scheduling.driverPersonId,
      daPersonId: result.scheduling.daPersonId,
      realStaffNumber: result.mentor.realStaffNumber,
      driverId: result.mentor.driverId
    };
    result.pairs = PAIRS.map(function (pair) {
      var compared = compareIds(left[pair[0]], right[pair[1]]);
      var aligned = formatsAlign(formats[pair[0]], formats[pair[1]]);
      compared.left = pair[0];
      compared.right = pair[1];
      compared.formatAligned = aligned;
      compared.skippedConflict = pair[0] === 'daPersonId' ? daMatch.skippedConflict : 0;
      compared.note = IDENTITY_NOTE;
      return compared;
    });
    var cover = result.pairs[0];
    result.stringCoverageComplete = !!(
      !stale &&
      cover.formatAligned &&
      cover.missing === 0 &&
      cover.unmatched === 0 &&
      cover.ambiguous === 0 &&
      cover.leftRows > 0 &&
      cover.uniquePeople === cover.leftRows
    );
    attachAssignedActive(result, scheduling, mentor, now, crossStatus, stale);
    attachMasterJoin(result, scheduling, mentor, master, now, schedulingStale);
    attachMentorPeople(result, scheduling, mentor);
    return seal(result);
  }

  function seal(value) {
    return JSON.parse(JSON.stringify(value, function (key, item) {
      if (key && (key === 'people' || key === 'rows' || key === 'reservations' || key === 'entries' || key === 'providerReservationId' || key === 'authorization' || key === 'cookie' || key === 'name' || key === 'japaneseName' || key === 'japanese' || key === 'label' || key === 'masterName' || key === 'schedulingName' || key === 'mentorName' || key === 'transportId' || key === 'firstName' || key === 'lastName' || key === 'driverFirstName' || key === 'driverLastName' || key === 'driverName' || key === 'email' || key === 'phone' || key === 'token' || key === 'sample' || key === 'repFirst' || key === 'repLast' || key === 'display' || key === 'driverToken' || key === 'nameToken' || key === 'endDate' || key === 'shiftEndTime' || key === 'shiftStartTime')) return undefined;
      if (typeof item === 'string' && /bearer|cookie|password|@/i.test(item)) return undefined;
      return item;
    }));
  }

  function displayMasterName(row) {
    var key = row && row.label ? row.label : '';
    var japanese = row && row.japanese ? row.japanese : '';
    if (japanese && key && japanese !== key) return japanese + '（' + key + '）';
    return japanese || key || '取得不可';
  }

  function cleanPersonName(value) {
    if (typeof value !== 'string') return '';
    var text = value.replace(/^\s+|\s+$/g, '');
    if (!text || text.length > 80) return '';
    if (/bearer|cookie|password|token|@/i.test(text)) return '';
    return text;
  }

  function personNameKey(value) {
    var text = cleanPersonName(value);
    if (!text) return '';
    text = text.replace(/[Ａ-Ｚａ-ｚ０-９]/g, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
    });
    return text.replace(/[\s　]+/g, '').toLowerCase();
  }

  function rosterNamePartsAgree(full, first, last) {
    var whole = personNameKey(full);
    if (!whole) return false;
    var given = personNameKey(first);
    var family = personNameKey(last);
    if (given && whole.indexOf(given) < 0) return false;
    if (family && whole.indexOf(family) < 0) return false;
    return true;
  }

  function schedulingNameLabels(people) {
    var list = Array.isArray(people) ? people : [];
    var idRows = Object.create(null);
    var nameIds = Object.create(null);
    list.forEach(function (person) {
      var id = normalizeIdToken(person && person.driverPersonId);
      if (!id) return;
      if (!idRows[id]) idRows[id] = [];
      idRows[id].push(person);
    });
    Object.keys(idRows).forEach(function (id) {
      var seen = Object.create(null);
      idRows[id].forEach(function (person) {
        var key = personNameKey(person && person.driverName);
        if (key) seen[key] = true;
      });
      Object.keys(seen).forEach(function (key) {
        if (!nameIds[key]) nameIds[key] = Object.create(null);
        nameIds[key][id] = true;
      });
    });
    return list.map(function (person) {
      var full = cleanPersonName(person && person.driverName);
      var first = cleanPersonName(person && person.driverFirstName);
      var last = cleanPersonName(person && person.driverLastName);
      if (!full && !first && !last) return '取得不可';
      if (!full) return '要確認';
      var id = normalizeIdToken(person && person.driverPersonId);
      if (!id) return '取得不可';
      var group = idRows[id] || [];
      var distinct = Object.create(null);
      group.forEach(function (item) {
        var key = personNameKey(item && item.driverName);
        if (key) distinct[key] = true;
      });
      if (group.length !== 1 || Object.keys(distinct).length !== 1) return '要確認';
      if (!rosterNamePartsAgree(full, first, last)) return '要確認';
      var owners = nameIds[personNameKey(full)] ? Object.keys(nameIds[personNameKey(full)]) : [];
      if (owners.length !== 1) return '要確認';
      return full;
    });
  }

  function uniqueAssignedMatches(people, rows, date) {
    var byTid = Object.create(null);
    (rows || []).forEach(function (row) {
      if (row && row.id) byTid[row.id] = row;
    });
    var labels = schedulingNameLabels(people);
    var cohort = [];
    (people || []).forEach(function (person, index) {
      var assigned = (person.reservations || []).some(function (res) {
        return res && res.date === date && res.status === 'ASSIGNED';
      });
      if (!assigned) return;
      cohort.push({
        id: normalizeIdToken(person && person.driverPersonId),
        schedulingName: labels[index] || '取得不可'
      });
    });
    var leftCounts = idCounts(cohort.map(function (member) { return member.id; }));
    var matches = [];
    cohort.forEach(function (member) {
      var row = member.id ? byTid[member.id] : null;
      if (!member.id || leftCounts[member.id] !== 1 || !row || row.nameCount !== 1) return;
      matches.push({
        id: member.id,
        schedulingName: member.schedulingName,
        masterName: displayMasterName(row),
        department: row.department || ''
      });
    });
    matches.sort(function (a, b) {
      return String(a.masterName).localeCompare(String(b.masterName), 'ja');
    });
    return matches;
  }

  function createSession(nowFn) {
    var scheduling = null;
    var mentor = null;
    var master = null;
    var confirmations = Object.create(null);
    var identityLinks = [];
    var identityGeneration = 1;
    function currentNow() {
      var now = nowFn ? nowFn() : new Date();
      return now instanceof Date ? now : new Date();
    }
    function read(selectedDate) {
      return buildDiagnostic(scheduling, mentor, master, currentNow(), selectedDate);
    }
    function rememberMeta(digest) {
      if (!digest || !digest.meta) return null;
      return publicMeta(digest.meta);
    }
    return {
      ingestScheduling: function (digest) {
        if (!digest || digest.ok === false) {
          scheduling = {
            ok: false,
            issue: safeIssue(digest && digest.issue),
            capturedAt: safeTime(digest && digest.capturedAt),
            meta: rememberMeta(digest)
          };
        } else {
          var extracted = digest.people ? digest : null;
          if (!extracted) {
            scheduling = { ok: false, issue: 'FAILED', capturedAt: safeTime(digest.capturedAt), meta: rememberMeta(digest) };
          } else {
            scheduling = {
              ok: true,
              capturedAt: safeTime(digest.capturedAt),
              fromDate: typeof digest.fromDate === 'string' ? digest.fromDate : '',
              people: digest.people.map(function (person) {
                return {
                  driverPersonId: cleanId(person && person.driverPersonId),
                  driverFirstName: cleanPersonName(person && person.driverFirstName),
                  driverLastName: cleanPersonName(person && person.driverLastName),
                  driverName: cleanPersonName(person && person.driverName),
                  reservations: Array.isArray(person && person.reservations) ? person.reservations.map(function (res) {
                    return {
                      date: /^\d{4}-\d{2}-\d{2}$/.test(res && res.date) ? res.date : '',
                      daPersonId: cleanId(res && res.daPersonId),
                      startTimeInMinutes: finiteInt(res && res.startTimeInMinutes),
                      startTimeInEpoch: finiteNumber(res && res.startTimeInEpoch),
                      status: cleanStatus(res && res.status)
                    };
                  }).filter(function (res) { return res.date; }) : []
                };
              }),
              nameFields: publicNameFields(digest.nameFields),
              meta: rememberMeta(digest)
            };
          }
        }
        return read();
      },
      ingestMentor: function (digest) {
        if (!digest || digest.ok === false) {
          mentor = { ok: false, issue: safeIssue(digest && digest.issue), capturedAt: safeTime(digest && digest.capturedAt) };
        } else if (!Array.isArray(digest.rows)) {
          mentor = { ok: false, issue: 'FAILED', capturedAt: safeTime(digest.capturedAt) };
        } else {
          mentor = {
            ok: true,
            capturedAt: safeTime(digest.capturedAt),
            history: acceptHistory(digest.history),
            rows: digest.rows.map(function (row) {
              return {
                driverId: cleanId(row && row.driverId),
                realStaffNumber: cleanId(row && row.realStaffNumber),
                firstName: cleanPersonName(row && row.firstName),
                lastName: cleanPersonName(row && row.lastName),
                active: !!(row && row.active),
                endDate: calendarDate(row && row.endDate)
              };
            })
          };
        }
        return read();
      },
      ingestMaster: function (digest) {
        if (!digest || digest.phase === 'loading') {
          master = { phase: 'loading' };
          confirmations = Object.create(null);
          return read();
        }
        if (digest.ok === false || digest.phase === 'failed' || !Array.isArray(digest.entries)) {
          master = { ok: false, phase: 'failed' };
          confirmations = Object.create(null);
          return read();
        }
        var built = buildMasterIndex(digest.entries);
        var loadedAt = typeof digest.loadedAt === 'number' && isFinite(digest.loadedAt) ? digest.loadedAt : 0;
        if (!master || master.loadedAt !== loadedAt) confirmations = Object.create(null);
        master = {
          ok: true,
          phase: 'ready',
          loadedAt: loadedAt,
          registered: built.registered,
          duplicateIds: built.duplicateIds,
          rows: built.rows
        };
        return read();
      },
      resetConfirmations: function () {
        confirmations = Object.create(null);
      },
      confirmationView: function (selectedDate, includeRows) {
        var view = buildConfirmation(scheduling, mentor, master, confirmations, currentNow(), selectedDate);
        if (!includeRows) view.rows = [];
        return view;
      },
      rollCallView: function (selectedDate, includeRows) {
        return buildRollCall(scheduling, mentor, master, confirmations, currentNow(), selectedDate, includeRows === true);
      },
      suspectView: function (selectedDate, includeRows) {
        var view = buildSuspectList(scheduling, mentor, master, currentNow(), selectedDate, includeRows === true, identityLinks, null);
        view.identityGeneration = identityGeneration;
        view.identityProven = false;
        return view;
      },
      exportIdentityLinks: function () {
        return normalizeIdentityLinks(identityLinks).map(function (item) {
          return {
            schedulingId: item.schedulingId,
            mentorStaffId: item.mentorStaffId,
            mentorDriverId: item.mentorDriverId,
            officialName: item.officialName,
            mentorName: item.mentorName,
            state: item.state,
            savedAt: item.savedAt
          };
        });
      },
      loadIdentityLinks: function (list) {
        identityLinks = normalizeIdentityLinks(list);
        identityGeneration += 1;
        return identityGeneration;
      },
      setIdentityLink: function (selectedDate, rowIndex, candidateIndex, action, generation) {
        var now = currentNow();
        function fresh(includeRows) {
          var view = buildSuspectList(scheduling, mentor, master, now, selectedDate, includeRows === true, identityLinks, null);
          view.identityGeneration = identityGeneration;
          view.identityProven = false;
          return view;
        }
        if (generation !== identityGeneration) return { ok: false, message: '表示が古い', suspect: fresh(false) };
        if (action !== 'linked' && action !== 'excluded' && action !== 'held') return { ok: false, message: '操作できません', suspect: fresh(false) };
        var sink = { rows: [] };
        var preview = buildSuspectList(scheduling, mentor, master, now, selectedDate, false, identityLinks, sink);
        if (!preview.enabled || preview.reason) return { ok: false, message: 'データ未取得または期限切れのため登録できません', suspect: fresh(false) };
        var row = sink.rows[rowIndex];
        var candidate = row && row.nameCandidates ? row.nameCandidates[candidateIndex] : null;
        if (!row || !row.schedulingId || !candidate) return { ok: false, message: '対象が見つかりません', suspect: fresh(true) };
        if (!candidate.canSave || !candidate.staffId || !candidate.driverId) return { ok: false, message: candidate.saveBlock || '識別子がないため保存できない', suspect: fresh(true) };
        var rest = identityLinks.filter(function (item) {
          return !(item.schedulingId === row.schedulingId && item.mentorStaffId === candidate.staffId && item.mentorDriverId === candidate.driverId);
        });
        if (action === 'linked') {
          var clash = identityLinkConflict(rest, row.schedulingId, candidate.staffId, candidate.driverId);
          if (clash) return { ok: false, message: clash, suspect: fresh(true) };
        }
        rest.push({
          schedulingId: row.schedulingId,
          mentorStaffId: candidate.staffId,
          mentorDriverId: candidate.driverId,
          officialName: row.schedulingName && row.schedulingName !== '要確認' && row.schedulingName !== '取得不可' ? row.schedulingName : '',
          mentorName: candidate.mentorName || '',
          state: action,
          savedAt: now.toISOString()
        });
        identityLinks = rest;
        identityGeneration += 1;
        return { ok: true, message: action === 'linked' ? '対応を登録しました' : (action === 'excluded' ? '別人として除外しました' : '保留にしました'), suspect: fresh(true) };
      },
      clearIdentityLink: function (selectedDate, rowIndex, generation) {
        var now = currentNow();
        function fresh(includeRows) {
          var view = buildSuspectList(scheduling, mentor, master, now, selectedDate, includeRows === true, identityLinks, null);
          view.identityGeneration = identityGeneration;
          view.identityProven = false;
          return view;
        }
        if (generation !== identityGeneration) return { ok: false, message: '表示が古い', suspect: fresh(false) };
        var sink = { rows: [] };
        var preview = buildSuspectList(scheduling, mentor, master, now, selectedDate, false, identityLinks, sink);
        if (!preview.enabled || preview.reason) return { ok: false, message: 'データ未取得または期限切れのため解除できません', suspect: fresh(false) };
        var row = sink.rows[rowIndex];
        if (!row || !row.schedulingId) return { ok: false, message: '対象が見つかりません', suspect: fresh(true) };
        identityLinks = identityLinks.filter(function (item) { return item.schedulingId !== row.schedulingId; });
        identityGeneration += 1;
        return { ok: true, message: '登録を解除しました', suspect: fresh(true) };
      },
      setConfirmation: function (selectedDate, index, status, generation) {
        var now = currentNow();
        var gate = confirmationGate(scheduling, mentor, master, now, selectedDate);
        var matches = gate.enabled ? uniqueAssignedMatches(scheduling.people, master.rows, gate.date) : [];
        if (!gate.enabled || generation !== master.loadedAt || !matches[index]) {
          return buildConfirmation(scheduling, mentor, master, confirmations, now, selectedDate);
        }
        if (status !== 'confirmed' && status !== 'rejected' && status !== 'pending') {
          return buildConfirmation(scheduling, mentor, master, confirmations, now, selectedDate);
        }
        if (status === 'pending') delete confirmations[matches[index].id];
        else confirmations[matches[index].id] = status;
        return buildConfirmation(scheduling, mentor, master, confirmations, now, selectedDate);
      },
      read: read
    };
  }

  function confirmationGate(scheduling, mentor, master, now, selectedDate) {
    var date = '';
    if (scheduling && scheduling.ok !== false && scheduling.people) {
      var keys = dateKeysOf(scheduling.people);
      date = chooseFocus(keys, selectedDate, now);
    }
    var join = null;
    if (date && scheduling && scheduling.ok !== false && master && master.rows) {
      var activeReady = !!(mentor && mentor.ok !== false && !isStale(mentor, now) && !isStale(scheduling, now));
      join = summarizeMasterJoin(scheduling.people, date, now, master, [], activeReady, []);
    }
    var gate = {
      enabled: false,
      reason: '取得不足',
      date: date,
      unregistered: join && join.comparable ? join.absent : null,
      noDepartment: join && join.comparable ? join.withoutDepartment : null
    };
    if (!scheduling || scheduling.ok === false || !mentor || mentor.ok === false || !master || master.ok === false || master.phase !== 'ready') {
      gate.reason = (!scheduling || !mentor || !master) ? '取得不足' : '取得失敗';
      if (master && master.phase === 'loading') gate.reason = '読み込み待ち';
      return gate;
    }
    if (isStale(scheduling, now) || isStale(mentor, now) || !master.loadedAt || now.getTime() - master.loadedAt > STALE_MS) {
      gate.reason = '取得が古い';
      return gate;
    }
    if ((master.duplicateIds || 0) > 0 || (join && join.unmatchable > 0)) {
      gate.reason = '対応が曖昧';
      return gate;
    }
    gate.enabled = true;
    gate.reason = '';
    return gate;
  }

  function foldPersonToken(value) {
    var text = cleanPersonName(value);
    if (!text) return '';
    text = text.replace(/[Ａ-Ｚａ-ｚ０-９]/g, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
    });
    return text.replace(/[\s　]+/g, '').toLowerCase();
  }

  function mentorNameKey(first, last) {
    var given = foldPersonToken(first);
    var family = foldPersonToken(last);
    if (!given || !family) return '';
    return [given, family].sort().join('\0');
  }

  function compareMentorName(schedulingName, first, last) {
    var full = foldPersonToken(schedulingName);
    var given = foldPersonToken(first);
    var family = foldPersonToken(last);
    if (!full || !given || !family) return '判定不能';
    if (full === family + given || full === given + family) return '氏名一致候補';
    return '氏名不一致';
  }

  function mentorGroups(rows) {
    var grouped = Object.create(null);
    (rows || []).forEach(function (row) {
      var id = normalizeIdToken(row && row.realStaffNumber);
      if (!id) return;
      if (!grouped[id]) grouped[id] = [];
      grouped[id].push(row);
    });
    var out = Object.create(null);
    Object.keys(grouped).forEach(function (id) {
      var list = grouped[id];
      var driverIds = Object.create(null);
      var nameKeys = Object.create(null);
      var missing = false;
      var display = '';
      var repFirst = '';
      var repLast = '';
      list.forEach(function (row) {
        var driver = normalizeIdToken(row && row.driverId);
        if (driver) driverIds[driver] = true;
        var key = mentorNameKey(row && row.firstName, row && row.lastName);
        if (!key) {
          missing = true;
          return;
        }
        nameKeys[key] = true;
        if (!display) {
          repFirst = cleanPersonName(row.firstName);
          repLast = cleanPersonName(row.lastName);
          display = [repLast, repFirst].filter(Boolean).join(' ');
        }
      });
      var nameCount = Object.keys(nameKeys).length;
      var driverCount = Object.keys(driverIds).length;
      var session = '判定不能';
      if (missing || nameCount === 0) {
        session = '判定不能';
        nameCount = 0;
        display = '';
        repFirst = '';
        repLast = '';
      } else if (driverCount !== 1 || nameCount !== 1) session = '要確認';
      else if (list.length > 1) session = '同一人物候補・過去セッション重複';
      else session = '同一人物候補';
      var oneName = nameCount === 1;
      var driverKeys = Object.keys(driverIds);
      var nameKeyList = Object.keys(nameKeys);
      out[id] = {
        session: session,
        nameCount: oneName ? 1 : nameCount,
        display: oneName ? display : '',
        repFirst: oneName ? repFirst : '',
        repLast: oneName ? repLast : '',
        driverToken: driverCount === 1 && !missing ? driverKeys[0] : '',
        nameToken: oneName && !missing ? nameKeyList[0] : '',
        driverCount: driverCount
      };
    });
    return out;
  }

  function activeAgrees(rows, id, group) {
    if (!id || !group || group.nameCount !== 1 || !group.driverToken || !group.nameToken) return false;
    if (group.session !== '同一人物候補' && group.session !== '同一人物候補・過去セッション重複') return false;
    var found = false;
    (rows || []).forEach(function (row) {
      if (!row || row.active !== true) return;
      if (normalizeIdToken(row.realStaffNumber) !== id) return;
      if (normalizeIdToken(row.driverId) !== group.driverToken) return;
      if (mentorNameKey(row.firstName, row.lastName) !== group.nameToken) return;
      found = true;
    });
    return found;
  }

  function mentorVerdict(id, groups, schedulingName) {
    var group = id && groups ? groups[id] : null;
    if (!group) return { session: '判定不能', nameCompare: '判定不能', mentorName: '' };
    var nameCompare = group.nameCount === 1 ? compareMentorName(schedulingName, group.repFirst, group.repLast) : '判定不能';
    return {
      session: group.session,
      nameCompare: nameCompare,
      mentorName: group.nameCount === 1 ? group.display : ''
    };
  }

  function clockFromMinutes(minutes) {
    if (minutes == null || minutes < 0 || minutes > 1439) return '';
    var hour = Math.floor(minutes / 60);
    var minute = minutes % 60;
    return (hour < 10 ? '0' : '') + hour + ':' + (minute < 10 ? '0' : '') + minute;
  }

  function elapsedText(ms) {
    if (ms == null || !isFinite(ms)) return '経過不明';
    var ahead = ms < 0;
    var abs = Math.abs(ms);
    var minutes = Math.floor(abs / 60000);
    var seconds = Math.floor((abs % 60000) / 1000);
    var body = String(minutes) + '分' + (seconds ? String(seconds) + '秒' : '');
    return ahead ? '開始まで ' + body : '経過 ' + body;
  }

  function capturedStamp(value) {
    if (typeof value === 'number' && isFinite(value)) {
      try { return new Date(value).toISOString(); } catch (e) { return ''; }
    }
    return safeTime(value);
  }

  function rollCallGate(scheduling, mentor, master, now, selectedDate) {
    var date = '';
    if (scheduling && scheduling.ok !== false && scheduling.people) {
      date = chooseFocus(dateKeysOf(scheduling.people), selectedDate, now);
    }
    var gate = { enabled: false, reason: '取得不足', detail: '未取得', date: date };
    if (!scheduling || scheduling.ok === false) {
      gate.detail = scheduling ? '取得失敗' : '未取得';
      return gate;
    }
    if (!mentor || mentor.ok === false) {
      gate.detail = mentor ? '取得失敗' : '未取得';
      return gate;
    }
    if (!master || master.ok === false || master.phase !== 'ready') {
      gate.detail = master && master.phase === 'loading' ? '読み込み待ち' : (master && master.phase === 'failed' ? '取得失敗' : '未取得');
      return gate;
    }
    if (isStale(scheduling, now) || isStale(mentor, now) || !master.loadedAt || now.getTime() - master.loadedAt > STALE_MS) {
      gate.detail = '取得が古い';
      return gate;
    }
    if (!date) {
      gate.detail = '対象日なし';
      return gate;
    }
    gate.enabled = true;
    gate.reason = '';
    gate.detail = '';
    return gate;
  }

  function emptyRollCounts() {
    return {
      total: 0,
      before: 0,
      within5: 0,
      activeCandidate: 0,
      activeUnseen: 0,
      after5Unmatched: 0,
      unknownTime: 0,
      identityIssues: 0
    };
  }

  function emptySameDay() {
    return {
      ended: 0,
      absent: 0,
      unmatched: 0,
      rangeUnverified: 0,
      unavailable: 0
    };
  }

  function assignedSlotCount(people, date) {
    var count = 0;
    var seen = Object.create(null);
    (people || []).forEach(function (person) {
      var blocks = ((person && person.reservations) || []).filter(function (res) {
        return res && res.date === date && res.status === 'ASSIGNED';
      });
      if (!blocks.length) return;
      var id = normalizeIdToken(person && person.driverPersonId);
      if (id) {
        if (seen[id]) return;
        seen[id] = true;
      }
      count += 1;
    });
    return count;
  }

  function sameDayRangeReady(history, date) {
    return !!(
      history &&
      history.available === true &&
      history.rangeStatus === 'verified' &&
      history.includesTarget === true &&
      calendarDate(history.targetDate) === date
    );
  }

  function endDatesByStaff(rows) {
    var out = Object.create(null);
    (rows || []).forEach(function (row) {
      var id = normalizeIdToken(row && row.realStaffNumber);
      var date = calendarDate(row && row.endDate);
      if (!id || !date) return;
      if (!out[id]) out[id] = Object.create(null);
      out[id][date] = true;
    });
    return out;
  }

  function sameDayReference(rangeReady, identity, staffId, endDates, date) {
    if (!rangeReady) return '取得範囲未検証';
    if (identity !== 'ID・氏名一致候補') return '履歴照合不能';
    var dates = staffId && endDates ? endDates[staffId] : null;
    if (dates && dates[date]) return '当日終了時刻あり（同一人物候補）';
    return '当日終了履歴未検出';
  }

  function countSameDay(bag, label) {
    if (label === '当日終了時刻あり（同一人物候補）') bag.ended += 1;
    else if (label === '当日終了履歴未検出') bag.absent += 1;
    else if (label === '履歴照合不能') bag.unmatched += 1;
    else if (label === '取得範囲未検証') bag.rangeUnverified += 1;
    else bag.unavailable += 1;
  }

  function rollIdentity(uniquePerson, masterRow, masterOk, verdict) {
    if (!uniquePerson) return { identity: 'Mentor照合不能', note: 'IDの対応を確認' };
    if (!masterRow) return { identity: 'OFK3マスタ未登録', note: 'マスタ未登録' };
    if (!masterOk) return { identity: 'Mentor照合不能', note: 'マスタ氏名を確認' };
    if (verdict.nameCompare === '氏名不一致') return { identity: '氏名不一致', note: '氏名不一致' };
    if (verdict.session === '要確認') return { identity: 'Mentor照合不能', note: 'MentorのIDが複数' };
    if ((verdict.session !== '同一人物候補' && verdict.session !== '同一人物候補・過去セッション重複') || verdict.nameCompare !== '氏名一致候補') {
      return { identity: 'Mentor照合不能', note: '照合不能' };
    }
    return { identity: 'ID・氏名一致候補', note: '' };
  }

  function rollTimeStatus(date, earliest, unknownTime, now) {
    if (unknownTime || earliest == null) return '時刻不明';
    var bucket = startBucket(date, earliest, now);
    if (bucket === 'before') return '開始前';
    if (bucket === 'within5') return '開始後5分未満';
    if (bucket === 'after5') return '開始後5分以上';
    return '時刻不明';
  }

  function rollListStatus(timeStatus, identity, active) {
    if (timeStatus === '開始前') return '開始前';
    if (timeStatus === '開始後5分未満') return '開始後5分未満';
    if (timeStatus === '時刻不明') return '時刻不明';
    if (identity !== 'ID・氏名一致候補') return '開始後5分以上・照合不能';
    if (active) return '開始後5分以上・Active確認候補';
    return '開始後5分以上・Active未確認';
  }

  function emptyRollUi() {
    return {
      activeUnseenEnded: 0,
      activeUnseenOther: 0,
      activeUnseenRangeHold: 0,
      causes: {
        'OFK3マスタ未登録': 0,
        'Mentor照合不能': 0,
        '氏名不一致': 0,
        'ID重複・競合': 0,
        '取得データ不足': 0,
        '原因未確定': 0
      }
    };
  }

  function unmatchedCauseLabel(status, identity, hasId, personCount, group) {
    if (status !== '開始後5分以上・照合不能') return '';
    if (identity === 'OFK3マスタ未登録') return 'OFK3マスタ未登録';
    if (identity === '氏名不一致') return '氏名不一致';
    if (!hasId) return '取得データ不足';
    if (personCount > 1) return 'ID重複・競合';
    if (group && group.driverCount > 1) return 'ID重複・競合';
    if (identity === 'Mentor照合不能') return 'Mentor照合不能';
    return '原因未確定';
  }

  function endedHistoryMark(status, sameDayHistory) {
    return status === '開始後5分以上・Active未確認' && sameDayHistory === '当日終了時刻あり（同一人物候補）';
  }

  function countRollUi(ui, status, sameDayHistory, cause) {
    if (status === '開始後5分以上・Active未確認') {
      if (sameDayHistory === '当日終了時刻あり（同一人物候補）') ui.activeUnseenEnded += 1;
      else ui.activeUnseenOther += 1;
      if (sameDayHistory === '取得範囲未検証' || sameDayHistory === 'データ未取得・期限切れ') ui.activeUnseenRangeHold += 1;
    }
    if (status !== '開始後5分以上・照合不能') return;
    if (ui.causes[cause] == null) ui.causes['原因未確定'] += 1;
    else ui.causes[cause] += 1;
  }

  function countRoll(counts, status, identity) {
    counts.total += 1;
    if (status === '開始前') counts.before += 1;
    else if (status === '開始後5分未満') counts.within5 += 1;
    else if (status === '開始後5分以上・Active確認候補') counts.activeCandidate += 1;
    else if (status === '開始後5分以上・Active未確認') counts.activeUnseen += 1;
    else if (status === '開始後5分以上・照合不能') counts.after5Unmatched += 1;
    else counts.unknownTime += 1;
    if (identity !== 'ID・氏名一致候補') counts.identityIssues += 1;
  }

  function buildRollCall(scheduling, mentor, master, confirmations, now, selectedDate, includeRows) {
    var gate = rollCallGate(scheduling, mentor, master, now, selectedDate);
    var view = {
      enabled: gate.enabled,
      reason: gate.reason,
      detail: gate.detail,
      date: gate.date,
      captured: {
        scheduling: capturedStamp(scheduling && scheduling.capturedAt),
        mentor: capturedStamp(mentor && mentor.capturedAt),
        master: capturedStamp(master && master.loadedAt)
      },
      counts: emptyRollCounts(),
      sameDay: emptySameDay(),
      ui: emptyRollUi(),
      identityProven: false,
      namesShown: includeRows === true && gate.enabled,
      rows: []
    };
    if (!gate.enabled) {
      view.sameDay.unavailable = gate.date ? assignedSlotCount(scheduling && scheduling.people, gate.date) : 0;
      view.namesShown = false;
      return view;
    }
    var people = scheduling.people || [];
    var labels = schedulingNameLabels(people);
    var groups = mentorGroups(mentor.rows);
    var endDates = endDatesByStaff(mentor.rows);
    var rangeReady = sameDayRangeReady(mentor.history, gate.date);
    var byTid = Object.create(null);
    (master.rows || []).forEach(function (row) {
      if (row && row.id) byTid[row.id] = row;
    });
    var slots = [];
    var byId = Object.create(null);
    people.forEach(function (person, index) {
      var blocks = ((person && person.reservations) || []).filter(function (res) {
        return res && res.date === gate.date && res.status === 'ASSIGNED';
      });
      if (!blocks.length) return;
      var id = normalizeIdToken(person && person.driverPersonId);
      var slot = null;
      if (id && byId[id]) slot = byId[id];
      else {
        slot = { id: id, people: 0, blocks: [], label: labels[index] || '取得不可' };
        slots.push(slot);
        if (id) byId[id] = slot;
      }
      if (slot.people > 0) slot.label = '要確認';
      slot.people += 1;
      blocks.forEach(function (block) { slot.blocks.push(block); });
    });
    var rank = {
      '開始後5分以上・Active未確認': 0,
      '開始後5分以上・照合不能': 1,
      '時刻不明': 2,
      '開始後5分以上・Active確認候補': 3,
      '開始後5分未満': 4,
      '開始前': 5
    };
    var rows = [];
    slots.forEach(function (slot) {
      var uniquePerson = !!(slot.id && slot.people === 1);
      var schedulingName = uniquePerson ? (slot.label || '取得不可') : '要確認';
      var masterRow = uniquePerson ? byTid[slot.id] : null;
      var masterOk = !!(masterRow && masterRow.nameCount === 1);
      var masterName = 'マスタ未登録';
      var department = 'マスタ未登録';
      if (!uniquePerson) {
        masterName = '要確認';
        department = '要確認';
      } else if (masterOk) {
        masterName = displayMasterName(masterRow);
        department = masterRow.department || '所属なし';
      } else if (masterRow) {
        masterName = '要確認';
        department = '要確認';
      }
      var unknownTime = slot.blocks.some(function (block) {
        return block.startTimeInMinutes == null;
      });
      var earliest = null;
      slot.blocks.forEach(function (block) {
        if (block.startTimeInMinutes == null) return;
        if (earliest == null || block.startTimeInMinutes < earliest) earliest = block.startTimeInMinutes;
      });
      var comparableName = schedulingName !== '要確認' && schedulingName !== '取得不可' ? schedulingName : '';
      var verdict = mentorVerdict(uniquePerson ? slot.id : '', groups, comparableName);
      var identityView = rollIdentity(uniquePerson, masterRow, masterOk, verdict);
      var timeStatus = rollTimeStatus(gate.date, earliest, unknownTime, now);
      var active = identityView.identity === 'ID・氏名一致候補' && activeAgrees(mentor.rows, slot.id, groups[slot.id]);
      var status = rollListStatus(timeStatus, identityView.identity, active);
      var sameDayHistory = sameDayReference(rangeReady, identityView.identity, uniquePerson ? slot.id : '', endDates, gate.date);
      var cause = unmatchedCauseLabel(status, identityView.identity, !!slot.id, slot.people, slot.id ? groups[slot.id] : null);
      var historyMark = endedHistoryMark(status, sameDayHistory);
      var stored = uniquePerson && slot.id ? confirmations[slot.id] : '';
      var confirmation = stored === 'confirmed' ? '確認済み' : (stored === 'rejected' ? '不一致（運用対象外）' : '未確認');
      var startLabel = unknownTime || earliest == null
        ? '時刻不明'
        : clockFromMinutes(earliest) + (slot.blocks.length > 1 ? '（最初の開始予定・' + slot.blocks.length + '件）' : '（開始予定）');
      var startMs = !unknownTime && earliest != null ? tokyoStartMs(gate.date, earliest) : null;
      countRoll(view.counts, status, identityView.identity);
      countSameDay(view.sameDay, sameDayHistory);
      countRollUi(view.ui, status, sameDayHistory, cause);
      rows.push({
        status: status,
        sameDayHistory: sameDayHistory,
        endedHistoryMark: historyMark,
        unmatchedCause: cause,
        timeStatus: timeStatus,
        identity: identityView.identity,
        schedulingName: schedulingName,
        masterName: masterName,
        department: department,
        startLabel: startLabel,
        elapsed: startMs == null ? '経過不明' : elapsedText(now.getTime() - startMs),
        mentorText: verdict.session + ' / ' + verdict.nameCompare,
        mentorName: verdict.mentorName || '',
        confirmation: confirmation,
        note: identityView.note,
        startSort: earliest == null ? 99999 : earliest,
        rank: rank[status] == null ? 9 : rank[status]
      });
    });
    rows.sort(function (a, b) {
      if (a.rank !== b.rank) return a.rank - b.rank;
      if (a.startSort !== b.startSort) return a.startSort - b.startSort;
      return String(a.masterName).localeCompare(String(b.masterName), 'ja');
    });
    view.rows = includeRows ? rows.map(function (row) {
      return {
        status: row.status,
        sameDayHistory: row.sameDayHistory,
        endedHistoryMark: row.endedHistoryMark === true,
        unmatchedCause: row.unmatchedCause || '',
        timeStatus: row.timeStatus,
        identity: row.identity,
        schedulingName: row.schedulingName,
        masterName: row.masterName,
        department: row.department,
        startLabel: row.startLabel,
        elapsed: row.elapsed,
        mentorText: row.mentorText,
        mentorName: row.mentorName,
        confirmation: row.confirmation,
        note: row.note
      };
    }) : [];
    if (!includeRows) view.namesShown = false;
    return view;
  }

  function jstClock(ms) {
    try {
      var fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Tokyo',
        hourCycle: 'h23',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
      var parts = fmt.formatToParts(new Date(ms));
      function pick(type) {
        var found = '';
        parts.forEach(function (part) {
          if (part.type === type) found = part.value;
        });
        return found;
      }
      var hour = pick('hour');
      if (hour === '24') hour = '00';
      var minute = pick('minute');
      var second = pick('second');
      if (!hour || !minute || !second) return '';
      return hour + ':' + minute + ':' + second;
    } catch (e) {
      return '';
    }
  }

  function suspectStartMs(date, block) {
    var fromEpoch = epochToMs(block && block.startTimeInEpoch);
    if (fromEpoch != null) return fromEpoch;
    if (!block || block.startTimeInMinutes == null) return null;
    return tokyoStartMs(date, block.startTimeInMinutes);
  }

  function suspectFullRange(history, date) {
    return sameDayRangeReady(history, date) && !!(history && history.coversFullTargetDay === true);
  }

  function suspectHoldCause(gate) {
    if (gate && gate.detail === '取得が古い') return '15分超過';
    return 'データ未取得';
  }

  function suspectSourceGate(scheduling, mentor, now, selectedDate) {
    var date = '';
    if (scheduling && scheduling.ok !== false && scheduling.people) {
      date = chooseFocus(dateKeysOf(scheduling.people), selectedDate, now);
    }
    var gate = { enabled: false, reason: '取得不足', detail: '未取得', date: date };
    if (!scheduling || scheduling.ok === false) {
      gate.detail = scheduling ? '取得失敗' : '未取得';
      return gate;
    }
    if (!mentor || mentor.ok === false) {
      gate.detail = mentor ? '取得失敗' : '未取得';
      return gate;
    }
    if (isStale(scheduling, now) || isStale(mentor, now)) {
      gate.detail = '取得が古い';
      return gate;
    }
    if (!date) {
      gate.detail = '対象日なし';
      return gate;
    }
    gate.enabled = true;
    gate.reason = '';
    gate.detail = '';
    return gate;
  }

  function sourceCaptureState(side, now) {
    if (!side) return 'missing';
    if (side.ok === false) return 'failed';
    if (isStale(side, now)) return 'stale';
    return 'ready';
  }

  function masterDepartmentReady(master, now) {
    return !!(
      master &&
      master.ok !== false &&
      master.phase === 'ready' &&
      master.rows &&
      master.loadedAt &&
      now &&
      now.getTime() - master.loadedAt <= STALE_MS
    );
  }

  function suspectBasis(hasId, personCount, uniquePerson, group, verdict) {
    if (!hasId) return '取得データ不足';
    if (!uniquePerson || personCount > 1) return personCount > 1 ? 'ID重複・競合' : '取得データ不足';
    if (!group) return '';
    if (verdict && verdict.nameCompare === '氏名不一致') return '氏名不一致';
    if (group.driverCount > 1) return 'ID重複・競合';
    if (!verdict || verdict.session === '要確認' || verdict.session === '判定不能' || verdict.nameCompare !== '氏名一致候補') return 'Mentor照合不能';
    if (verdict.session !== '同一人物候補' && verdict.session !== '同一人物候補・過去セッション重複') return 'Mentor照合不能';
    return '';
  }

  function emptySuspectCounts() {
    return { total: 0, active: 0, ended: 0, suspect: 0, undetermined: 0 };
  }

  function countSuspect(counts, causes, status, cause) {
    counts.total += 1;
    if (status === '現在Active確認候補') counts.active += 1;
    else if (status === '当日終了履歴あり（参考）') counts.ended += 1;
    else if (status === 'Mentor未起動疑い（要確認）') counts.suspect += 1;
    else {
      counts.undetermined += 1;
      if (!causes[cause]) causes[cause] = 0;
      causes[cause] += 1;
    }
  }

  function hiraToKata(text) {
    return String(text || '').replace(/[\u3041-\u3096]/g, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) + 0x60);
    });
  }

  function foldLooseName(value) {
    var text = cleanPersonName(value);
    if (!text) return '';
    try { text = text.normalize('NFKC'); } catch (e) {}
    return text.toLowerCase().replace(/[\s\u3000]+/g, '');
  }

  function nameScript(text) {
    var kana = /[\u3041-\u3096\u30a1-\u30fa]/.test(text);
    var kanji = /[\u4e00-\u9fff]/.test(text);
    if (kanji && kana) return 'mixed';
    if (kanji) return 'kanji';
    if (kana) return 'kana';
    return 'other';
  }

  function nameTokens(value) {
    var text = cleanPersonName(value);
    if (!text) return [];
    try { text = text.normalize('NFKC'); } catch (e) {}
    text = text.toLowerCase();
    return text.split(/[\s\u3000]+/).filter(Boolean).map(function (part) {
      return { key: hiraToKata(part), script: nameScript(part) };
    });
  }

  function nameSurfaceReason(official, mentorName) {
    var left = cleanPersonName(official);
    var right = cleanPersonName(mentorName);
    if (!left || !right) return '';
    if (left === right) return '表記が一致';
    if (left.replace(/[\s\u3000]+/g, '') === right.replace(/[\s\u3000]+/g, '')) return '空白の違い';
    var looseLeft = foldLooseName(left);
    var looseRight = foldLooseName(right);
    var kanaLeft = hiraToKata(looseLeft);
    var kanaRight = hiraToKata(looseRight);
    if (looseLeft === looseRight) return '全角半角または大文字小文字の違い';
    if (kanaLeft === kanaRight) return 'ひらがなとカタカナの違い';
    return '表記を揃えると一致。同一人物とは確定しない';
  }

  function classifyNamePair(official, mentorName) {
    var empty = { relation: 'different', reason: '', score: 0, identity: false };
    var left = nameTokens(official);
    var right = nameTokens(mentorName);
    if (!left.length || !right.length) return empty;
    function compact(tokens) {
      return tokens.map(function (token) { return token.key; }).join('');
    }
    function forward(tokens) {
      return tokens.map(function (token) { return token.key; }).join('\0');
    }
    var compactLeft = compact(left);
    var compactRight = compact(right);
    var forwardLeft = forward(left);
    var forwardRight = forward(right);
    var reverseRight = forward(right.slice().reverse());
    if (compactLeft === compactRight && forwardLeft === forwardRight) {
      return { relation: 'normalized', reason: nameSurfaceReason(official, mentorName), score: 100, identity: false };
    }
    if (left.length === 2 && right.length === 2 && forwardLeft === reverseRight) {
      return { relation: 'normalized', reason: '姓名の順序が異なる', score: 80, identity: false };
    }
    if (compactLeft === compactRight) {
      return { relation: 'normalized', reason: nameSurfaceReason(official, mentorName), score: 90, identity: false };
    }
    function aligned(a, b) {
      if (a.length !== b.length || !a.length) return null;
      var exact = 0;
      var readingGap = 0;
      var other = 0;
      for (var i = 0; i < a.length; i += 1) {
        if (a[i].key === b[i].key) exact += 1;
        else if ((a[i].script === 'kanji' && b[i].script === 'kana') || (a[i].script === 'kana' && b[i].script === 'kanji')) readingGap += 1;
        else other += 1;
      }
      return { exact: exact, readingGap: readingGap, other: other };
    }
    var sameOrder = aligned(left, right);
    var reversed = left.length === 2 && right.length === 2 ? aligned(left, [right[1], right[0]]) : null;
    if (sameOrder && sameOrder.other === 0 && sameOrder.readingGap > 0 && sameOrder.exact > 0) {
      return { relation: 'similar', reason: '漢字と仮名の違い。読みとしては確定しない', score: 40, identity: false };
    }
    if (reversed && reversed.other === 0 && reversed.readingGap > 0 && reversed.exact > 0) {
      return { relation: 'similar', reason: '漢字と仮名の違い。読みとしては確定しない', score: 35, identity: false };
    }
    var seen = Object.create(null);
    left.forEach(function (token) { seen[token.key] = true; });
    var shared = false;
    right.forEach(function (token) { if (seen[token.key]) shared = true; });
    if (shared) return { relation: 'similar', reason: '表記の一部が一致。同一人物とは確定しない', score: 30, identity: false };
    return empty;
  }

  function adminStateLabel(state) {
    if (state === 'linked') return '管理者確認済み';
    if (state === 'excluded') return '別人として除外';
    if (state === 'held') return '保留';
    return '未確認';
  }

  function mentorIdentities(rows, date) {
    var grouped = Object.create(null);
    (rows || []).forEach(function (row) {
      var staff = normalizeIdToken(row && row.realStaffNumber);
      if (!staff) return;
      if (!grouped[staff]) grouped[staff] = [];
      grouped[staff].push(row);
    });
    return Object.keys(grouped).map(function (staff) {
      var list = grouped[staff];
      var drivers = Object.create(null);
      var names = Object.create(null);
      var display = '';
      var currentActive = false;
      var endedToday = false;
      list.forEach(function (row) {
        var driver = normalizeIdToken(row && row.driverId);
        if (driver) drivers[driver] = true;
        var name = [cleanPersonName(row && row.lastName), cleanPersonName(row && row.firstName)].filter(Boolean).join(' ');
        if (name) names[name] = true;
        if (!display && name) display = name;
        if (row && row.active === true) currentActive = true;
        if (row && row.endDate && date && row.endDate === date) endedToday = true;
      });
      var driverKeys = Object.keys(drivers);
      var nameKeys = Object.keys(names);
      var conflict = driverKeys.length !== 1 || nameKeys.length !== 1;
      var mentorState = '観測あり';
      if (conflict) mentorState = '識別子が競合';
      else if (currentActive) mentorState = '現在Active';
      else if (endedToday) mentorState = '当日終了履歴あり（参考）';
      return {
        staffId: staff,
        driverId: driverKeys.length === 1 ? driverKeys[0] : '',
        display: conflict ? '' : display,
        conflict: conflict,
        currentActive: currentActive && !conflict,
        mentorState: mentorState,
        canSave: !conflict && !!display
      };
    });
  }

  function findIdentityLink(links, schedulingId, staffId, driverId) {
    var found = null;
    (links || []).forEach(function (item) {
      if (!item) return;
      if (item.schedulingId === schedulingId && item.mentorStaffId === staffId && item.mentorDriverId === driverId) found = item;
    });
    return found;
  }

  function collectNameCandidates(officialName, schedulingId, identities, links) {
    if (!officialName || officialName === '要確認' || officialName === '取得不可') return [];
    var found = [];
    (identities || []).forEach(function (ident) {
      if (!ident || ident.conflict || !ident.display) return;
      var judged = classifyNamePair(officialName, ident.display);
      if (judged.relation !== 'normalized' && judged.relation !== 'similar') return;
      var saved = findIdentityLink(links, schedulingId, ident.staffId, ident.driverId);
      found.push({
        mentorName: ident.display,
        reason: judged.reason,
        score: judged.score,
        relation: judged.relation,
        mentorState: ident.mentorState,
        adminState: saved ? adminStateLabel(saved.state) : '未確認',
        canSave: ident.canSave === true && !!schedulingId,
        saveBlock: ident.canSave && schedulingId ? '' : '識別子がないため保存できない',
        staffId: ident.staffId,
        driverId: ident.driverId,
        identity: false
      });
    });
    var normalizedCount = found.filter(function (item) { return item.relation === 'normalized'; }).length;
    if (normalizedCount > 1) {
      found.forEach(function (item) {
        if (item.relation === 'normalized') item.reason = '同姓同名または同一表記の候補が複数。管理者確認が必要。' + item.reason;
      });
    }
    found.sort(function (a, b) {
      if (a.score !== b.score) return b.score - a.score;
      return String(a.mentorName).localeCompare(String(b.mentorName), 'ja');
    });
    return found.slice(0, 8);
  }

  function linkNoteFor(schedulingId, links, identities) {
    var mine = (links || []).filter(function (item) { return item && item.schedulingId === schedulingId; });
    var linked = mine.filter(function (item) { return item.state === 'linked'; });
    if (linked.length > 1) return '対応が重複しています';
    if (linked.length === 1) {
      var item = linked[0];
      var alive = (identities || []).some(function (ident) {
        return ident.staffId === item.mentorStaffId && ident.driverId === item.mentorDriverId;
      });
      if (!alive) return '識別子の変更を検出';
    }
    return '';
  }

  function promoteLinkedActive(slot, status, cause, links, identities) {
    if (!slot || !slot.id || slot.people !== 1) return null;
    if (cause === 'ID重複・競合' || cause === '取得データ不足' || cause === '取得範囲未検証' || cause === '取得範囲が対象日全体を覆わない' || cause === '15分超過' || cause === 'データ未取得') return null;
    if (status !== 'Mentor未起動疑い（要確認）' && cause !== '氏名不一致' && cause !== 'Mentor照合不能') return null;
    var linked = (links || []).filter(function (item) { return item && item.state === 'linked' && item.schedulingId === slot.id; });
    if (linked.length !== 1) return null;
    var item = linked[0];
    if (!item.mentorStaffId || !item.mentorDriverId) return null;
    var hits = (identities || []).filter(function (ident) {
      return ident.staffId === item.mentorStaffId && ident.driverId === item.mentorDriverId && ident.currentActive === true && ident.canSave === true && ident.conflict !== true;
    });
    if (hits.length !== 1) return null;
    return { basis: 'Active確認候補｜管理者確認済みID対応', mentorName: hits[0].display || '' };
  }

  function normalizeIdentityLinks(list) {
    if (!Array.isArray(list)) return [];
    var out = [];
    list.forEach(function (item) {
      if (!item) return;
      var state = item.state === 'linked' || item.state === 'excluded' || item.state === 'held' ? item.state : '';
      var schedulingId = normalizeIdToken(item.schedulingId);
      var mentorStaffId = normalizeIdToken(item.mentorStaffId);
      var mentorDriverId = normalizeIdToken(item.mentorDriverId);
      if (!state || !schedulingId || !mentorStaffId || !mentorDriverId) return;
      out.push({
        schedulingId: schedulingId,
        mentorStaffId: mentorStaffId,
        mentorDriverId: mentorDriverId,
        officialName: cleanPersonName(item.officialName),
        mentorName: cleanPersonName(item.mentorName),
        state: state,
        savedAt: typeof item.savedAt === 'string' ? item.savedAt : ''
      });
    });
    return out;
  }

  function identityLinkConflict(links, schedulingId, mentorStaffId, mentorDriverId) {
    var schedulingClash = (links || []).some(function (item) {
      return item.state === 'linked' && item.schedulingId === schedulingId && (item.mentorStaffId !== mentorStaffId || item.mentorDriverId !== mentorDriverId);
    });
    if (schedulingClash) return '1人のSchedulingに複数のMentorが対応しています';
    var mentorClash = (links || []).some(function (item) {
      return item.state === 'linked' && item.mentorStaffId === mentorStaffId && item.mentorDriverId === mentorDriverId && item.schedulingId !== schedulingId;
    });
    if (mentorClash) return '1人のMentorに複数のSchedulingが対応しています';
    return '';
  }

  function buildSuspectList(scheduling, mentor, master, now, selectedDate, includeRows, links, sink) {
    links = Array.isArray(links) ? links : [];
    var gate = suspectSourceGate(scheduling, mentor, now, selectedDate);
    var view = {
      enabled: !!(gate.date && scheduling && scheduling.ok !== false),
      reason: gate.enabled ? '' : (gate.detail === '取得が古い' ? '15分超過' : 'データ未取得'),
      date: gate.date,
      counts: emptySuspectCounts(),
      causes: {},
      namesShown: includeRows === true && gate.enabled,
      rows: [],
      identityProven: false,
      sources: {
        scheduling: sourceCaptureState(scheduling, now),
        mentor: sourceCaptureState(mentor, now)
      }
    };
    if (!view.enabled) {
      if (sink) sink.rows = [];
      return view;
    }
    var people = scheduling.people || [];
    var labels = schedulingNameLabels(people);
    var mentorRows = mentor && mentor.rows ? mentor.rows : [];
    var history = mentor && mentor.history ? mentor.history : null;
    var groups = mentorGroups(mentorRows);
    var endDates = endDatesByStaff(mentorRows);
    var endReady = sameDayRangeReady(history, gate.date);
    var fullRange = suspectFullRange(history, gate.date);
    var byTid = Object.create(null);
    (master && master.rows ? master.rows : []).forEach(function (row) {
      if (row && row.id) byTid[row.id] = row;
    });
    var slots = [];
    var byId = Object.create(null);
    people.forEach(function (person, index) {
      var blocks = ((person && person.reservations) || []).filter(function (res) {
        return res && res.date === gate.date && res.status === 'ASSIGNED';
      });
      if (!blocks.length) return;
      var id = normalizeIdToken(person && person.driverPersonId);
      var slot = null;
      if (id && byId[id]) slot = byId[id];
      else {
        slot = { id: id, people: 0, blocks: [], label: labels[index] || '取得不可' };
        slots.push(slot);
        if (id) byId[id] = slot;
      }
      if (slot.people > 0) slot.label = '要確認';
      slot.people += 1;
      blocks.forEach(function (block) { slot.blocks.push(block); });
    });
    var rank = {
      'Mentor未起動疑い（要確認）': 0,
      '判定不能（原因付き）': 1,
      '当日終了履歴あり（参考）': 2,
      '現在Active確認候補': 3
    };
    var rows = [];
    slots.forEach(function (slot) {
      var started = [];
      slot.blocks.forEach(function (block) {
        var ms = suspectStartMs(gate.date, block);
        if (ms == null) return;
        if (now.getTime() > ms) started.push(ms);
      });
      if (!started.length) return;
      var earliest = started[0];
      started.forEach(function (ms) { if (ms < earliest) earliest = ms; });
      var uniquePerson = !!(slot.id && slot.people === 1);
      var schedulingName = uniquePerson ? (slot.label || '取得不可') : '要確認';
      var masterRow = uniquePerson ? byTid[slot.id] : null;
      var masterOk = !!(masterRow && masterRow.nameCount === 1);
      var department = '表示保留';
      if (!uniquePerson) department = '要確認';
      else if (masterDepartmentReady(master, now)) {
        if (!masterRow) department = 'マスタ未登録';
        else if (masterOk) department = masterRow.department || '所属なし';
        else department = '要確認';
      }
      var comparableName = schedulingName !== '要確認' && schedulingName !== '取得不可' ? schedulingName : '';
      var group = slot.id ? groups[slot.id] : null;
      var verdict = mentorVerdict(uniquePerson ? slot.id : '', groups, comparableName);
      var blockCause = suspectBasis(!!slot.id, slot.people, uniquePerson, group, verdict);
      var active = gate.enabled && blockCause === '' && activeAgrees(mentorRows, slot.id, group);
      var hasEnd = gate.enabled && blockCause === '' && endReady && !!(endDates[slot.id] && endDates[slot.id][gate.date]);
      var status = '判定不能（原因付き）';
      var cause = '';
      if (!gate.enabled) cause = suspectHoldCause(gate);
      else if (active) status = '現在Active確認候補';
      else if (blockCause) cause = blockCause;
      else if (hasEnd) status = '当日終了履歴あり（参考）';
      else if (!endReady) cause = '取得範囲未検証';
      else if (!fullRange) cause = '取得範囲が対象日全体を覆わない';
      else status = 'Mentor未起動疑い（要確認）';
      var identities = mentorIdentities(mentorRows, gate.date);
      var candidates = [];
      if ((status === 'Mentor未起動疑い（要確認）' || status === '判定不能（原因付き）') && cause !== 'ID重複・競合' && cause !== '取得データ不足' && cause !== '15分超過' && cause !== 'データ未取得') {
        candidates = collectNameCandidates(schedulingName, slot.id, identities, links);
      }
      var linkNote = linkNoteFor(slot.id, links, identities);
      var basis = '';
      var promoted = promoteLinkedActive(slot, status, cause, links, identities);
      if (promoted) {
        status = '現在Active確認候補';
        cause = '';
        basis = promoted.basis;
      }
      countSuspect(view.counts, view.causes, status, cause);
      rows.push({
        status: status,
        cause: cause,
        schedulingName: schedulingName,
        department: department,
        startLabel: jstClock(earliest) + (started.length > 1 ? '（開始済みのうち最初・' + started.length + '件）' : '（開始予定）'),
        elapsed: elapsedText(now.getTime() - earliest),
        mentorText: group ? (verdict.session + ' / ' + verdict.nameCompare) : '該当行なし',
        startSort: earliest,
        rank: rank[status] == null ? 9 : rank[status],
        schedulingId: slot.id || '',
        nameCandidates: candidates,
        matchBasis: basis,
        linkNote: linkNote
      });
    });
    rows.sort(function (a, b) {
      if (a.rank !== b.rank) return a.rank - b.rank;
      if (a.startSort !== b.startSort) return a.startSort - b.startSort;
      return String(a.schedulingName).localeCompare(String(b.schedulingName), 'ja');
    });
    if (sink) sink.rows = gate.enabled ? rows : [];
    view.identityProven = false;
    view.rows = includeRows && gate.enabled ? rows.map(function (row, index) {
      return {
        status: row.status,
        cause: row.cause,
        schedulingName: row.schedulingName,
        department: row.department,
        startLabel: row.startLabel,
        elapsed: row.elapsed,
        mentorText: row.mentorText,
        rowIndex: index,
        matchBasis: row.matchBasis || '',
        linkNote: row.linkNote || '',
        nameCandidates: (row.nameCandidates || []).map(function (item, candidateIndex) {
          return {
            mentorName: item.mentorName,
            reason: item.reason,
            mentorState: item.mentorState,
            adminState: item.adminState,
            canSave: item.canSave === true,
            saveBlock: item.saveBlock || '',
            relation: item.relation,
            identity: false,
            candidateIndex: candidateIndex
          };
        })
      };
    }) : [];
    if (!includeRows || !gate.enabled) view.namesShown = false;
    return view;
  }

  function schedulingNameById(people) {
    var out = Object.create(null);
    (people || []).forEach(function (person) {
      var id = normalizeIdToken(person && person.driverPersonId);
      if (!id || Object.prototype.hasOwnProperty.call(out, id)) return;
      out[id] = cleanPersonName(person && person.driverName);
    });
    return out;
  }

  function emptyMentorPeople() {
    return {
      comparable: false,
      history: 0,
      single: 0,
      review: 0,
      unknown: 0,
      nameMatch: 0,
      nameMismatch: 0,
      nameUnknown: 0
    };
  }

  function summarizeMentorPeople(people, rows, date) {
    var out = emptyMentorPeople();
    if (!Array.isArray(rows)) return out;
    out.comparable = true;
    var groups = mentorGroups(rows);
    var names = schedulingNameById(people);
    (people || []).forEach(function (person) {
      var assigned = (person.reservations || []).some(function (res) {
        return res && res.date === date && res.status === 'ASSIGNED';
      });
      if (!assigned) return;
      var id = normalizeIdToken(person && person.driverPersonId);
      var verdict = mentorVerdict(id, groups, names[id] || '');
      if (verdict.session === '同一人物候補・過去セッション重複') out.history += 1;
      else if (verdict.session === '同一人物候補') out.single += 1;
      else if (verdict.session === '要確認') out.review += 1;
      else out.unknown += 1;
      if (verdict.nameCompare === '氏名一致候補') out.nameMatch += 1;
      else if (verdict.nameCompare === '氏名不一致') out.nameMismatch += 1;
      else out.nameUnknown += 1;
    });
    return out;
  }

  function attachMentorPeople(result, scheduling, mentor) {
    var schedule = result.scheduling && result.scheduling.schedule;
    if (!schedule || !schedule.byDate || !scheduling || scheduling.ok === false) return;
    var rows = mentor && mentor.ok !== false ? mentor.rows : null;
    (schedule.dateKeys || []).forEach(function (date) {
      if (!schedule.byDate[date]) return;
      schedule.byDate[date].mentorPeople = summarizeMentorPeople(scheduling.people, rows, date);
    });
  }

  function buildConfirmation(scheduling, mentor, master, confirmations, now, selectedDate) {
    var gate = confirmationGate(scheduling, mentor, master, now, selectedDate);
    var view = {
      enabled: gate.enabled,
      reason: gate.reason,
      unregistered: gate.unregistered,
      noDepartment: gate.noDepartment,
      confirmed: 0,
      rejected: 0,
      pending: 0,
      generation: master && master.loadedAt || 0,
      identityProven: false,
      rows: []
    };
    if (!gate.enabled) {
      if (gate.reason !== '対応が曖昧') {
        view.unregistered = null;
        view.noDepartment = null;
      }
      return view;
    }
    var matches = uniqueAssignedMatches(scheduling.people, master.rows, gate.date);
    var groups = mentorGroups(mentor && mentor.rows);
    var rawNames = schedulingNameById(scheduling.people);
    matches.forEach(function (person, index) {
      var status = confirmations[person.id] || 'pending';
      if (status === 'confirmed') view.confirmed += 1;
      else if (status === 'rejected') view.rejected += 1;
      else view.pending += 1;
      var mentorView = mentorVerdict(person.id, groups, rawNames[person.id] || '');
      var row = {
        index: index,
        schedulingName: person.schedulingName || '取得不可',
        masterName: person.masterName,
        department: person.department || '未登録',
        mentorSession: mentorView.session,
        mentorNameCompare: mentorView.nameCompare,
        status: status === 'confirmed' || status === 'rejected' ? status : 'pending'
      };
      if (mentorView.mentorName) row.mentorName = mentorView.mentorName;
      view.rows.push(row);
    });
    return view;
  }

  function formatLine(title, summary) {
    if (!summary) return title + ': なし';
    var lengths = Object.keys(summary.lengths).sort().map(function (len) {
      return len + '文字×' + summary.lengths[len];
    }).join(', ') || '-';
    return title + ': ' + summary.dominantLabel + ' / ' + lengths + ' / あり' + summary.present + ' 欠損' + summary.missing + ' / 重複値' + summary.duplicateValues + ' 余分行' + summary.extraRows;
  }

  function historyFlag(value) {
    if (value === true) return 'はい';
    if (value === false) return 'いいえ';
    return '不明';
  }

  function historyParse(value) {
    if (value === 'ok') return '成功';
    if (value === 'failed') return '失敗';
    return 'なし';
  }

  function historyTypes(title, counts, includeNA) {
    var text = title + ': number ' + counts.number +
      ' / numeric-string ' + counts.numericString +
      ' / time-string ' + counts.timeString +
      ' / iso ' + counts.isoDatetime +
      ' / null ' + counts.nullish +
      ' / other ' + counts.other;
    if (includeNA) text += ' / N/A ' + (counts.na || 0);
    return text;
  }

  function historyEpoch(title, counts) {
    return title + ': ミリ秒 ' + counts.epochMs + ' / 秒 ' + counts.epochSec + ' / unparseable ' + counts.unparseable;
  }

  function historyStatus(title, side) {
    var others = (side.other || []).map(function (item) { return item.status + '=' + item.count; }).join(', ');
    return title + ': Active ' + side.active + ' / 欠損 ' + side.missing + ' / その他 ' + (others || '-');
  }

  function historyLines(history) {
    var lines = [
      'Mentor終了履歴（診断のみ。点呼要確認の分類には使わない）',
      '正常終了の判定: しない',
      '点呼完了の判定: しない',
      '個人別の当日稼働履歴: 確定しない',
      '未起動判定: しない',
      'API返却の完全性: 断定しない'
    ];
    if (!history || history.available !== true) {
      lines.push('取得範囲: range-unverified');
      lines.push('終了履歴の集計: 未観測');
      return lines;
    }
    lines.push('取得範囲: ' + history.rangeStatus);
    lines.push('対象日: ' + (history.targetDate || '-'));
    lines.push('取得範囲の開始日（JST）: ' + (history.rangeStartDate || '-'));
    lines.push('取得範囲の終了日（JST）: ' + (history.rangeEndDate || '-'));
    lines.push('取得範囲が対象日を含む: ' + historyFlag(history.includesTarget));
    lines.push('取得範囲が対象日の全時間帯を覆う: ' + historyFlag(history.coversFullTargetDay));
    lines.push('localDateの解析: ' + historyParse(history.localDateParse));
    lines.push('startTimeの解析: ' + historyParse(history.startTimeParse));
    lines.push('endTimeの解析: ' + historyParse(history.endTimeParse));
    lines.push('fpId: ' + (history.fpIdPresent ? 'あり' : 'なし'));
    lines.push(historyTypes('shiftStartTime', history.startTypes, false));
    lines.push(historyEpoch('shiftStartTimeエポック', history.startEpoch));
    lines.push(historyTypes('shiftEndTime', history.endTypes, true));
    lines.push(historyEpoch('shiftEndTimeエポック', history.endEpoch));
    lines.push('vrmStatus ' + historyStatus('全体', history.vrmStatus));
    lines.push('shiftEndTimeがN/A ' + historyStatus('との組合せ', history.vrmStatus.endNA));
    lines.push('shiftEndTimeがN/A以外 ' + historyStatus('との組合せ', history.vrmStatus.notEndNA));
    lines.push('終了時刻のJST日付: 対象日と同日 ' + history.endDates.sameDay +
      ' / 前日 ' + history.endDates.previousDay +
      ' / その他の日 ' + history.endDates.otherDay +
      ' / 日付判定不能 ' + history.endDates.undated +
      ' / 対象日未確定 ' + history.endDates.targetUnverified);
    lines.push('複数行を持つ識別子: ' + history.sessions.multiRowIdentifiers);
    lines.push('Active行と非Active行が混在する候補: ' + history.sessions.mixedActiveCandidates);
    lines.push('解析可能な終了時刻を持つ候補: ' + history.sessions.parseableEndCandidates);
    lines.push('IDまたは氏名が競合する候補: ' + history.sessions.identityConflictCandidates);
    lines.push('IDの一致は本人確認ではない');
    return lines;
  }

  function panelLines(diag, focusDate) {
    diag = diag || {};
    var lines = [
      'ID照合診断（調査用）',
      '外部送信: しない',
      '本人対応の証明: できない',
      IDENTITY_NOTE,
      '未起動判定: しない',
      '取得の新しさ: ' + (diag.stale ? '古い（' + (diag.staleAfterMinutes || 15) + '分超）' : '範囲内'),
      '照合状態: ' + (diag.crossStatus || 'both-missing')
    ];
    lines.push(sideLine('Scheduling', diag.scheduling));
    lines.push(sideLine('Mentor', diag.mentor));
    var otherHosts = diag.scheduling && diag.scheduling.meta && diag.scheduling.meta.otherHosts;
    if (otherHosts && otherHosts.length) lines.push('別ホストのrosters: ' + otherHosts.join(', '));
    if (diag.scheduling && diag.scheduling.state === 'ready') {
      lines.push('Scheduling人数: ' + diag.scheduling.peopleCount);
      lines.push('対象期間の開始日: ' + (diag.scheduling.fromDate || '-'));
      lines.push('最終取得 Scheduling: ' + (diag.scheduling.capturedAt || '-'));
      lines.push(formatLine('driverPersonId形式', diag.scheduling.driverPersonId));
      lines.push(formatLine('daPersonId形式', diag.scheduling.daPersonId));
      var da = diag.scheduling.personDa || {};
      lines.push('driverPersonIdとdaPersonId: 一致' + (da.same || 0) + '人 / 不一致' + (da.different || 0) + '人 / 欠損' + (da.missing || 0) + '人 / 予約内で複数' + (da.conflict || 0) + '人 / 予約なし' + (da.noReservation || 0) + '人');
      lines.push.apply(lines, nameFieldLines(diag.scheduling.nameFields));
    }
    if (diag.mentor && diag.mentor.state === 'ready') {
      lines.push('Mentor行数: ' + diag.mentor.totalRows + ' / Active行数: ' + diag.mentor.activeRows);
      lines.push('最終取得 Mentor: ' + (diag.mentor.capturedAt || '-'));
      lines.push(formatLine('realStaffNumber形式', diag.mentor.realStaffNumber));
      lines.push(formatLine('driverId形式', diag.mentor.driverId));
      lines.push(formatLine('Active realStaffNumber形式', diag.mentor.activeRealStaffNumber));
      lines.push(formatLine('Active driverId形式', diag.mentor.activeDriverId));
      lines.push.apply(lines, historyLines(diag.mentor.history));
    } else {
      lines.push.apply(lines, historyLines(null));
    }
    if (!diag.pairs) {
      lines.push('サイト間の文字列一致: 診断不能（片方未取得、失敗、または未観測）');
    } else {
      lines.push('サイト間の文字列一致（本人確定ではない）:');
      diag.pairs.forEach(function (pair) {
        lines.push(
          pair.left + ' × ' + pair.right +
          ': 一致値' + pair.exactValueCount +
          ' / 一意' + pair.uniquePeople +
          '人 / 曖昧' + pair.ambiguous +
          '人 / 照合不能' + pair.unmatched +
          '人 / 欠損' + pair.missing +
          ' / 形式' + (pair.formatAligned ? '同じ種類' : '異なる種類') +
          (pair.skippedConflict ? ' / 予約内複数で比較除外' + pair.skippedConflict + '人' : '')
        );
      });
    }
    lines.push.apply(lines, masterHeaderLines(diag.master));
    lines.push('Mentor全行への文字列カバー: ' + (diag.stringCoverageComplete ? '揃っている' : '証明できない'));
    lines.push(diag.coverageNote || '');
    var schedule = diag.scheduling && diag.scheduling.schedule;
    var focus = focusDate || (schedule && schedule.focus) || '';
    if (schedule && schedule.byDate) {
      lines.push('予定の対象日: ' + (focus || '-'));
      lines.push('選べる日: ' + ((schedule.dateKeys || []).join(', ') || '-'));
      var day = focus && schedule.byDate[focus];
      if (!day) {
        lines.push('この日の予約集計: なし');
      } else {
        lines.push('予約あり人数: ' + day.peopleWithReservation);
        lines.push('予約なし人数: ' + day.peopleWithoutReservation);
        lines.push('予約件数: ' + day.reservationCount);
        lines.push('ASSIGNED予約件数: ' + day.assignedReservations);
        var others = Object.keys(day.otherStatusCounts || {});
        lines.push('ASSIGNED以外: ' + (others.length ? others.map(function (status) {
          return status + '=' + day.otherStatusCounts[status];
        }).join(', ') : 'なし'));
        lines.push('複数ブロック人数: ' + day.multiBlockPeople);
        var hours = Object.keys(day.startHourCounts || {}).sort();
        lines.push('開始予定の時台（件数）: ' + (hours.length ? hours.map(function (hour) {
          return hour + '時=' + day.startHourCounts[hour];
        }).join(', ') : '-'));
        var clock = day.clock || {};
        lines.push('startTimeInMinutesとepoch（東京）: 一致' + (clock.minuteMatch || 0) + ' / 不一致' + (clock.minuteMismatch || 0) + ' / 不明' + (clock.minuteUnknown || 0));
        lines.push('予約日とepochの東京日付: 一致' + (clock.dateMatch || 0) + ' / 不一致' + (clock.dateMismatch || 0) + ' / 不明' + (clock.dateUnknown || 0));
        lines.push.apply(lines, assignedActiveLines(day.assignedActive));
        lines.push.apply(lines, masterJoinLines(day.masterJoin));
        lines.push.apply(lines, mentorPeopleLines(day.mentorPeople));
      }
    }
    return lines;
  }

  function mentorPeopleLines(block) {
    if (!block || !block.comparable) return ['Mentor人物照合: 取得不足'];
    return [
      'Mentor人物照合: 同一人物候補・過去セッション重複 ' + block.history + ' / 同一人物候補 ' + block.single + ' / 要確認 ' + block.review + ' / 判定不能 ' + block.unknown,
      'Scheduling氏名とMentor氏名: 氏名一致候補 ' + block.nameMatch + ' / 氏名不一致 ' + block.nameMismatch + ' / 判定不能 ' + block.nameUnknown,
      'Mentor氏名の一致は本人確定ではない',
      '未起動判定: しない'
    ];
  }

  function masterHeaderLines(master) {
    if (!master || master.state === 'missing') return ['OFK3マスタ: 未取得'];
    if (master.state === 'loading') return ['OFK3マスタ: 読み込み待ち', '空のマスタは確定結果にしない'];
    if (master.state === 'failed') return ['OFK3マスタ: 取得失敗'];
    return [
      'OFK3マスタ: 取得済み',
      'マスタ登録人数: ' + master.registered,
      'Transport ID重複件数: ' + master.duplicateIds,
      '氏名の表示: しない'
    ];
  }

  function masterJoinLines(join) {
    if (!join || !join.comparable) {
      var reason = join && join.reason;
      if (reason === 'stale') return ['マスタとSchedulingの照合: 取得が古い'];
      if (reason === 'master-loading') return ['マスタとSchedulingの照合: 読み込み待ち'];
      if (reason === 'master-failed') return ['マスタとSchedulingの照合: 取得失敗'];
      return ['マスタとSchedulingの照合: 未取得'];
    }
    var lines = [
      'Schedulingとの一意一致人数: ' + join.unique + '（本人確定ではない）',
      '不一致人数: ' + join.absent,
      '照合不能人数: ' + join.unmatchable,
      '所属登録あり: ' + join.withDepartment,
      '所属登録なし: ' + join.withoutDepartment,
      'OFK6所属人数: ' + join.ofk6,
      '開始後5分以上の確認対象で氏名に一意対応できる人数: ' + (join.after5NameCandidate == null ? '取得不足' : String(join.after5NameCandidate)) + '（氏名は表示しない）',
      '正規化して一致した人数: ' + (join.normalizedMatch == null ? '取得不足' : String(join.normalizedMatch)) + '（不一致の原因ではない）',
      'ID一致は本人確定ではない',
      '退職者の判定: しない'
    ];
    lines.push.apply(lines, causeLines('マスタ不一致の内訳', join.group1));
    lines.push.apply(lines, causeLines('氏名に対応できない確認対象の内訳', join.group2));
    lines.push('2グループに同時に入る人数: ' + (join.overlap == null ? '取得不足' : String(join.overlap)) + '（合計人数ではない）');
    return lines;
  }

  function causeLines(title, causes) {
    if (!causes) return [title + ': 取得不足'];
    return [
      title + ': ' + causes.total + '人',
      'ID欠損: ' + causes.missing,
      '形式差異: ' + causes.format,
      '正規化差異: ' + causes.normalization,
      '重複: ' + causes.duplicate,
      'マスタ未登録: ' + causes.notInMaster,
      '所属未登録: ' + causes.noDepartment,
      'OFK6所属: ' + causes.ofk6,
      '原因未確定: ' + causes.unknown
    ];
  }

  function assignedReasonLabel(reason) {
    if (reason === 'stale') return '取得が古い';
    if (reason === 'mentor-missing' || reason === 'scheduling-missing' || reason === 'both-missing') return '片方未取得';
    if (reason === 'failed') return '取得失敗';
    return '取得不足';
  }

  function assignedActiveLines(block) {
    if (!block) return ['ASSIGNED予約者とActive: なし'];
    var lines = [
      'ASSIGNED予約がある人数: ' + block.assignedPeople,
      'ASSIGNED予約件数: ' + block.assignedBlocks,
      '複数ブロックの人数: ' + block.multiBlockPeople,
      '開始前の予約件数: ' + block.before,
      '開始後5分未満の予約件数: ' + block.within5,
      '開始後5分以上の予約件数: ' + block.after5,
      '開始時刻不明の予約件数: ' + block.unknown
    ];
    if (!block.comparable) {
      lines.push('Activeとの人数照合: ' + assignedReasonLabel(block.reason));
      lines.push('未起動判定: しない');
      return lines;
    }
    lines.push('Activeと一意に文字列一致した人数: ' + block.uniqueStringMatch + '（本人確定ではない）');
    lines.push('Activeに文字列一致しない人数: ' + block.notInActive + '（未起動ではない）');
    lines.push('照合不能人数: ' + block.unmatchable);
    lines.push('不一致のうち全予約が開始前: ' + block.mismatchBeforeOnly + '人');
    lines.push('不一致のうち開始後5分未満のみ: ' + block.mismatchWithin5Only + '人');
    lines.push('不一致のうち開始後5分以上が1件以上: ' + block.mismatchHasAfter5 + '人');
    lines.push('不一致のうち開始時刻不明: ' + block.mismatchUnknownTime + '人');
    lines.push('不一致のうち確認不可: ' + block.mismatchConfirmUnavailable + '人');
    lines.push('開始後5分以上の不一致者で、Mentor全行に文字列がある人数: ' + block.after5InAllRows + '（本人確定ではない）');
    lines.push('開始後5分以上の不一致者で、Mentor全行に文字列がない人数: ' + block.after5AbsentFromAllRows + '（未起動ではない）');
    lines.push('未起動判定: しない');
    return lines;
  }

  function nameFieldLines(fields) {
    if (!Array.isArray(fields)) return ['rostersの氏名フィールド: 未観測'];
    var lines = ['rostersの氏名フィールド（driverPersonIdと同じレコード。値は出さない）:'];
    fields.forEach(function (item) {
      if (!item || !isRosterNameKey(item.field)) return;
      lines.push(item.field + ': あり' + item.present + ' / 欠損' + item.missing);
    });
    return lines;
  }

  function sideLine(label, side) {
    if (!side || side.state === 'missing') return label + ': 未取得';
    if (side.state === 'failed') return label + ': 診断不能 (' + (side.issue || 'FAILED') + ')';
    return label + ': 取得済み';
  }

  function copyPayload(diag, focusDate) {
    var sealed = seal(diag || {});
    sealed.focusDate = typeof focusDate === 'string' ? focusDate : ((sealed.scheduling && sealed.scheduling.schedule && sealed.scheduling.schedule.focus) || '');
    sealed.panel = panelLines(sealed, sealed.focusDate);
    return JSON.stringify(sealed, null, 2);
  }

  return {
    STALE_MS: STALE_MS,
    IDENTITY_NOTE: IDENTITY_NOTE,
    isRosterRequest: isRosterRequest,
    foreignRosterHost: foreignRosterHost,
    parseJson: parseJson,
    extractRoster: extractRoster,
    mentorDigest: mentorDigest,
    summarizeIds: summarizeIds,
    compareIds: compareIds,
    normalizeIdToken: normalizeIdToken,
    classifyAbsent: classifyAbsent,
    classifyUnnamed: classifyUnnamed,
    masterShape: masterShape,
    tokyoParts: tokyoParts,
    createSession: createSession,
    classifyNamePair: classifyNamePair,
    panelLines: panelLines,
    copyPayload: copyPayload,
    seal: seal
  };
});
