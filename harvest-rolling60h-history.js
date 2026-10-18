/**
 * ローリング60hの予測履歴。
 * ローカルJSONだけに対象者IDと日別時間を残す。戻り値は件数だけ。
 * 同じファイル内容・同じ計算条件の再実行では履歴を追加しない。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.HarvestRolling60hHistory = api;
})(this, function () {
  'use strict';

  var crypto = require('crypto');
  var RULE_VERSION = 'rolling60h-predict-3';

  function sha256(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
  }

  function hashFile(fs, filePath) {
    try {
      return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    } catch (e) {
      return '';
    }
  }

  function logicIdentity(table) {
    var keys = Object.keys(table || {}).sort();
    var lines = [
      RULE_VERSION,
      'limit=60',
      'exceed=greater-than',
      'approach=equal',
      'past=daily-estimate',
      'same-day=daily-not-added',
      'future=roster-plan',
      'outside-daily=archived-estimate-or-unverified',
      'missing-hours=not-zero',
      'rest-symbol=explicit-zero',
      'blank-in-mixed-column=unconfirmed',
      'blank-in-all-blank-column=outside-period-candidate',
      'unconfirmed-window=undetermined-keep-known-over',
      'daily-valid-over-shift-blank=daily',
    ];
    keys.forEach(function (key) { lines.push(key + '=' + table[key]); });
    return sha256(lines.join('\n'));
  }

  function fingerprintOf(logicId, referenceDate, dailyHash, shiftHash) {
    return sha256([logicId || '', referenceDate || '', dailyHash || '', shiftHash || ''].join('\n'));
  }

  function emptyVerdict() {
    return {
      resolvedBySchedule: 0,
      resolvedByDaily: 0,
      resolvedByBoth: 0,
      resolvedCauseUnknown: 0,
      stillAlert: 0,
      verifyUndetermined: 0,
      resolvedWithFuture: 0,
      blankFilledWindows: 0,
      blankFilledPersons: 0,
      blankFilledToAlertWindows: 0,
      normalToExceedWindows: 0,
      normalToExceedBySchedule: 0,
      normalToExceedByDaily: 0,
    };
  }

  function isAlert(level) {
    return level === 'exceed' || level === 'approach';
  }

  function isDaily(origin) {
    return origin === 'daily-estimate' || origin === 'archived-daily';
  }

  function differ(left, right) {
    if (typeof left !== 'number' || typeof right !== 'number') return true;
    return Math.abs(left - right) > 1e-6;
  }

  function blocked(prediction) {
    if (!prediction || prediction.level === 'undetermined' || !prediction.days || prediction.days.length !== 7) return true;
    return prediction.days.some(function (day) {
      return !day || day.origin === 'missing' || day.origin === 'undefined' || day.origin === 'roster-unconfirmed';
    });
  }

  function assess(priorList, currentList) {
    var counts = emptyVerdict();
    var currentByKey = {};
    (currentList || []).forEach(function (item) {
      if (!item) return;
      currentByKey[item.subjectId + '\t' + item.start + '\t' + item.end] = item;
    });
    (priorList || []).forEach(function (prior) {
      if (!prior || !isAlert(prior.level)) return;
      var current = currentByKey[prior.subjectId + '\t' + prior.start + '\t' + prior.end];
      if (!current || blocked(prior) || blocked(current)) {
        counts.verifyUndetermined++;
        return;
      }
      if (isAlert(current.level)) {
        counts.stillAlert++;
        return;
      }
      if (current.level !== 'within') {
        counts.verifyUndetermined++;
        return;
      }
      var storedDays = {};
      prior.days.forEach(function (day) { storedDays[day.date] = day; });
      var dailyChanged = false;
      var scheduleChanged = false;
      var lostDaily = false;
      current.days.forEach(function (day) {
        var stored = storedDays[day.date];
        if (!stored) return;
        var storedDaily = isDaily(stored.origin);
        var currentDaily = isDaily(day.origin);
        var storedPlan = stored.origin === 'roster-plan';
        var currentPlan = day.origin === 'roster-plan';
        if (storedDaily && !currentDaily) lostDaily = true;
        if (currentDaily && (storedPlan || (storedDaily && differ(stored.hours, day.hours)))) dailyChanged = true;
        if (currentPlan && storedPlan && differ(stored.hours, day.hours)) scheduleChanged = true;
      });
      if (lostDaily) {
        counts.verifyUndetermined++;
        return;
      }
      if (current.future) counts.resolvedWithFuture++;
      if (dailyChanged && scheduleChanged) counts.resolvedByBoth++;
      else if (dailyChanged) counts.resolvedByDaily++;
      else if (scheduleChanged) counts.resolvedBySchedule++;
      else counts.resolvedCauseUnknown++;
    });
    return counts;
  }

  /**
   * 前回と今回で同じ7日窓を比べ、空白(未確定)→勤務記号への変化を予定変更として数える。
   * 前回が未確定・正常でも追跡し、正常から超過・接近へ変わった窓は原因別に分ける。
   * 同じ計算バージョン同士だけを渡すこと（旧版は空白を0hとして保存しており区別できない）。
   */
  function trackScheduleChanges(priorList, currentList) {
    var counts = {
      blankFilledWindows: 0,
      blankFilledPersons: 0,
      blankFilledToAlertWindows: 0,
      normalToExceedWindows: 0,
      normalToExceedBySchedule: 0,
      normalToExceedByDaily: 0,
    };
    var priorByKey = {};
    (priorList || []).forEach(function (item) {
      if (!item) return;
      priorByKey[item.subjectId + '\t' + item.start + '\t' + item.end] = item;
    });
    var persons = {};
    (currentList || []).forEach(function (current) {
      if (!current || !current.days) return;
      var prior = priorByKey[current.subjectId + '\t' + current.start + '\t' + current.end];
      if (!prior || !prior.days) return;
      var storedDays = {};
      prior.days.forEach(function (day) { if (day) storedDays[day.date] = day; });
      var blankFilled = false;
      var scheduleChanged = false;
      var dailyChanged = false;
      current.days.forEach(function (day) {
        var stored = day && storedDays[day.date];
        if (!stored) return;
        if (stored.origin === 'roster-unconfirmed' && day.origin === 'roster-plan') blankFilled = true;
        if (stored.origin === 'roster-plan' && day.origin === 'roster-plan' && differ(stored.hours, day.hours)) scheduleChanged = true;
        if (isDaily(day.origin) && (stored.origin === 'roster-plan' || stored.origin === 'roster-unconfirmed' || (isDaily(stored.origin) && differ(stored.hours, day.hours)))) dailyChanged = true;
      });
      if (blankFilled) {
        counts.blankFilledWindows++;
        persons[current.subjectId] = true;
        if (isAlert(current.level)) counts.blankFilledToAlertWindows++;
      }
      if (prior.level === 'within' && current.level === 'exceed') {
        counts.normalToExceedWindows++;
        if (blankFilled || scheduleChanged) counts.normalToExceedBySchedule++;
        if (dailyChanged) counts.normalToExceedByDaily++;
      }
    });
    counts.blankFilledPersons = Object.keys(persons).length;
    return counts;
  }

  function readJson(fs, filePath) {
    try {
      if (!filePath || !fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      return null;
    }
  }

  function validStore(value) {
    return !!(value && value.version === 1 && Array.isArray(value.runs) && value.dailyArchive && typeof value.dailyArchive === 'object');
  }

  function load(fs, filePath) {
    var main = readJson(fs, filePath);
    if (validStore(main)) return main;
    var backup = readJson(fs, filePath + '.bak');
    if (validStore(backup)) return backup;
    var mainExists = false;
    var backupExists = false;
    try { mainExists = !!(filePath && fs.existsSync(filePath)); } catch (e) { mainExists = false; }
    try { backupExists = !!(filePath && fs.existsSync(filePath + '.bak')); } catch (e2) { backupExists = false; }
    if (mainExists || backupExists) return { corrupt: true, version: 1, runs: [], dailyArchive: {} };
    return { version: 1, runs: [], dailyArchive: {} };
  }

  function saveAtomic(fs, pathMod, dest, value) {
    var dir = pathMod.dirname(dest);
    fs.mkdirSync(dir, { recursive: true });
    var tmp = dest + '.tmp';
    var bak = dest + '.bak';
    var fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, JSON.stringify(value));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    var had = false;
    try { had = fs.existsSync(dest); } catch (e) { had = false; }
    if (had) {
      try { if (fs.existsSync(bak)) fs.unlinkSync(bak); } catch (e2) {}
      fs.renameSync(dest, bak);
    }
    try {
      fs.renameSync(tmp, dest);
    } catch (e3) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e4) {}
      if (had && !fs.existsSync(dest) && fs.existsSync(bak)) fs.renameSync(bak, dest);
      throw e3;
    }
    try { if (fs.existsSync(bak)) fs.unlinkSync(bak); } catch (e5) {}
  }

  function mergeArchive(archive, observations, dailyHash, snapshotDate) {
    var next = {};
    Object.keys(archive || {}).forEach(function (key) { next[key] = archive[key]; });
    (observations || []).forEach(function (obs) {
      if (!obs || !obs.subjectId || !obs.date || typeof obs.hours !== 'number') return;
      var key = obs.subjectId + '\t' + obs.date;
      var prev = next[key];
      if (!prev) {
        next[key] = { hours: obs.hours, dailyHash: dailyHash || '', snapshotDate: snapshotDate || '', conflict: false };
        return;
      }
      if (prev.conflict) return;
      if (typeof prev.hours === 'number' && Math.abs(prev.hours - obs.hours) > 1e-6) {
        next[key] = { hours: null, dailyHash: dailyHash || '', snapshotDate: snapshotDate || '', conflict: true };
        return;
      }
      next[key] = {
        hours: prev.hours,
        dailyHash: dailyHash || prev.dailyHash || '',
        snapshotDate: snapshotDate || prev.snapshotDate || '',
        conflict: false,
      };
    });
    return next;
  }

  function commit(options) {
    options = options || {};
    var fs = options.fs;
    var pathMod = options.path;
    var filePath = options.file;
    var base = emptyVerdict();
    base.historySaved = false;
    base.historyRuns = 0;
    base.historyCreated = 0;
    base.historyDuplicate = false;
    if (!fs || !pathMod || !filePath) return base;
    var store = load(fs, filePath);
    if (store.corrupt) return base;
    var logicId = options.logicId || '';
    var fingerprint = fingerprintOf(logicId, options.referenceDate, options.dailyHash, options.shiftHash);
    var duplicate = (store.runs || []).some(function (run) { return run && run.fingerprint === fingerprint; });
    if (duplicate) {
      base.historySaved = true;
      base.historyRuns = store.runs.length;
      base.historyDuplicate = true;
      return base;
    }
    // 計算バージョンが違う旧履歴は削除せず残すが、比較には使わない（旧版は空白を0hで保存している）。
    var version = options.logicVersion || RULE_VERSION;
    var sameVersion = (store.runs || []).filter(function (run) { return run && run.logicVersion === version; });
    var prior = sameVersion.length ? (sameVersion[sameVersion.length - 1].predictions || []) : [];
    var verdict = assess(prior, options.predictions || []);
    var tracked = trackScheduleChanges(prior, options.predictions || []);
    Object.keys(tracked).forEach(function (key) { verdict[key] = tracked[key]; });
    var next = {
      version: 1,
      runs: (store.runs || []).concat([{
        fingerprint: fingerprint,
        logicId: logicId,
        logicVersion: options.logicVersion || RULE_VERSION,
        referenceDate: options.referenceDate || '',
        predictedAt: options.predictedAt || new Date().toISOString(),
        sources: {
          dailyFile: options.dailyFile || '',
          shiftFile: options.shiftFile || '',
          dailyHash: options.dailyHash || '',
          shiftHash: options.shiftHash || '',
          snapshotDate: options.snapshotDate || '',
          workingDayMin: options.workingDayMin || '',
          workingDayMax: options.workingDayMax || '',
        },
        predictions: options.predictions || [],
      }]),
      dailyArchive: mergeArchive(store.dailyArchive, options.observations, options.dailyHash, options.snapshotDate),
    };
    try {
      saveAtomic(fs, pathMod, filePath, next);
    } catch (e) {
      verdict.historySaved = false;
      verdict.historyRuns = store.runs.length;
      verdict.historyCreated = 0;
      verdict.historyDuplicate = false;
      return verdict;
    }
    verdict.historySaved = true;
    verdict.historyRuns = next.runs.length;
    verdict.historyCreated = 1;
    verdict.historyDuplicate = false;
    return verdict;
  }

  return {
    RULE_VERSION: RULE_VERSION,
    hashFile: hashFile,
    logicIdentity: logicIdentity,
    fingerprintOf: fingerprintOf,
    assess: assess,
    trackScheduleChanges: trackScheduleChanges,
    load: load,
    saveAtomic: saveAtomic,
    commit: commit,
  };
});
