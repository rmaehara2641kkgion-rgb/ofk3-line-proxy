/**
 * 回収が正常終了した同じ実行結果から、勤務時間リスク用スナップショットを作る。
 * 一時ファイルを検証してから置き換える。失敗時は前回のファイルを残す。
 * 置き換えに成功したときだけ、既存のGAS公開へ進む。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.DutyRiskSnapshot = api;
})(this, function () {
  'use strict';

  var View = null;
  var Gas = null;
  var Republish = null;
  try { View = require('./inoichi-rolling-view.js'); } catch (e) { View = null; }
  try { Gas = require('./duty-risk-gas-client.js'); } catch (e2) { Gas = null; }
  try { Republish = require('./duty-risk-republish.js'); } catch (e3) { Republish = null; }

  function windowGap(window) {
    return window.judgment === 'undetermined' || window.complete === false || window.hasUndefinedHours;
  }

  function dispositionOf(driver) {
    var windows = driver && driver.windows ? driver.windows : [];
    var hasExceed = windows.some(function (window) { return window && window.judgment === 'exceed'; });
    var hasApproach = windows.some(function (window) { return window && window.judgment === 'approach'; });
    var hasWithin = windows.some(function (window) { return window && window.judgment === 'within'; });
    var hasKnownOver = windows.some(function (window) { return window && window.knownOver; });
    var hasGap = windows.length === 0 || driver.judgment === 'undetermined' || windows.some(windowGap);
    if (hasGap && (hasExceed || hasApproach || hasWithin || hasKnownOver)) {
      if (hasExceed) return 'partial-exceed';
      if (hasApproach) return 'partial-approach';
      return 'partial';
    }
    if (hasGap || (!hasExceed && !hasApproach && !hasWithin)) return 'undetermined';
    if (hasExceed) return 'exceed';
    if (hasApproach) return 'approach';
    // 同じTransport IDに他局の実績がある。OFK3の実績だけで正常とは言わない（要確認）。
    if (driver && driver.otherStation && driver.otherStation.dates && driver.otherStation.dates.length) return 'partial';
    return 'clear';
  }

  function readJson(fs, filePath) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      return null;
    }
  }

  function collectionOk(summary) {
    return !!(summary && summary.ok === true && summary.fileSuccess === 2 && summary.fileFailure === 0 && summary.historyCreated === 1 && summary.checkedAt);
  }

  function priorPredictions(history, summary) {
    var runs = history && Array.isArray(history.runs) ? history.runs : [];
    if (!runs.length || !summary) return [];
    if (summary.historyCreated && runs.length >= 2) return runs[runs.length - 2].predictions || [];
    if (summary.historyDuplicate || !summary.historyCreated) return runs[runs.length - 1].predictions || [];
    return [];
  }

  function buildSnapshot(captured, history) {
    var summary = captured && captured.summary ? captured.summary : {};
    var drivers = (captured && captured.drivers ? captured.drivers : []).map(function (driver) {
      var copy = {};
      Object.keys(driver || {}).forEach(function (key) { copy[key] = driver[key]; });
      copy.disposition = dispositionOf(copy);
      return copy;
    });
    var view = View.build({
      summary: summary,
      drivers: drivers,
      predictions: captured && captured.predictions ? captured.predictions : [],
      priorPredictions: priorPredictions(history, summary),
    });
    if (view) view.checkedAt = summary.checkedAt;
    return view;
  }

  function writeVerified(fs, pathMod, filePath, value, accept) {
    var dir = pathMod.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    var tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value));
    var parsed = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    if (!accept(parsed)) {
      try { fs.unlinkSync(tmp); } catch (e) {}
      return { ok: false, reason: 'verify-failed' };
    }
    try {
      fs.renameSync(tmp, filePath);
    } catch (e2) {
      try { fs.unlinkSync(tmp); } catch (e3) {}
      return { ok: false, reason: 'replace-failed' };
    }
    return { ok: true, snapshot: parsed };
  }

  function outboxFileOf(options) {
    if (options.outboxFile) return options.outboxFile;
    if (!options.snapshotFile || !options.path) return '';
    return options.path.join(options.path.dirname(options.snapshotFile), 'duty-risk-publish-queue.json');
  }

  function rememberPublish(options, snapshot, history, published) {
    try {
      if (!Republish || !options.fs || !options.path) return;
      var file = outboxFileOf(options);
      if (!file) return;
      Republish.remember(options.fs, options.path, file, snapshot, history, published || {});
    } catch (e) {}
  }

  function linesFor(collection, save, publish) {
    return [
      '回収結果 ' + JSON.stringify(collection),
      '保存結果 ' + JSON.stringify(save),
      '公開結果 ' + JSON.stringify(publish),
    ];
  }

  function finish(options) {
    options = options || {};
    var captured = options.captured || {};
    var summary = captured.summary || {};
    var fs = options.fs;
    var pathMod = options.path;
    var history = options.history != null ? options.history : readJson(fs, options.historyFile || captured.historyFile);
    var previous = fs && options.snapshotFile ? readJson(fs, options.snapshotFile) : null;
    var previousCheckedAt = previous && previous.checkedAt ? previous.checkedAt : null;
    var collection = {
      ok: summary.ok === true,
      checkedAt: summary.checkedAt || null,
      fileSuccess: summary.fileSuccess == null ? null : summary.fileSuccess,
      fileFailure: summary.fileFailure == null ? null : summary.fileFailure,
      historyCreated: summary.historyCreated == null ? 0 : summary.historyCreated,
      historyDuplicate: summary.historyDuplicate === true,
      dailyReason: summary.dailyReason || null,
      shiftReason: summary.shiftReason || null,
    };
    function done(save, publish) {
      var result = {
        collection: collection,
        save: save,
        publish: publish,
        lines: linesFor(collection, save, publish),
      };
      (result.lines || []).forEach(function (line) {
        if (typeof options.log === 'function') options.log(line);
      });
      return Promise.resolve(result);
    }
    if (summary.historyDuplicate === true) {
      return done(
        { replaced: false, kept: true, reason: 'duplicate', checkedAt: previousCheckedAt },
        { published: false, reason: 'duplicate', checkedAt: previousCheckedAt }
      );
    }
    if (!collectionOk(summary)) {
      return done(
        { replaced: false, kept: true, reason: 'collection-not-ok', checkedAt: previousCheckedAt },
        { published: false, reason: 'collection-not-ok', checkedAt: previousCheckedAt }
      );
    }
    var runs = history && Array.isArray(history.runs) ? history.runs : [];
    var matched = runs.filter(function (run) { return run && run.predictedAt === summary.checkedAt; });
    if (matched.length !== 1 || !View) {
      return done(
        { replaced: false, kept: true, reason: 'mismatch', checkedAt: previousCheckedAt },
        { published: false, reason: 'mismatch', checkedAt: previousCheckedAt }
      );
    }
    var view = null;
    try {
      view = buildSnapshot(captured, history);
    } catch (e) {
      view = null;
    }
    if (!view || view.checkedAt !== summary.checkedAt || view.usable !== true || !Array.isArray(view.alerts)) {
      return done(
        { replaced: false, kept: true, reason: 'build-failed', checkedAt: previousCheckedAt },
        { published: false, reason: 'build-failed', checkedAt: previousCheckedAt }
      );
    }
    var written = null;
    try {
      written = writeVerified(fs, pathMod, options.snapshotFile, view, function (parsed) {
      return parsed
        && parsed.checkedAt === summary.checkedAt
        && parsed.usable === true
        && Array.isArray(parsed.alerts)
        && parsed.alerts.length === view.alerts.length;
      });
    } catch (writeErr) {
      written = { ok: false, reason: 'replace-failed' };
    }
    if (!written.ok) {
      var still = readJson(fs, options.snapshotFile);
      return done(
        { replaced: false, kept: true, reason: written.reason, checkedAt: still && still.checkedAt ? still.checkedAt : previousCheckedAt },
        { published: false, reason: 'save-failed', checkedAt: previousCheckedAt }
      );
    }
    var gas = options.gas || Gas;
    if (!options.client || !gas) {
      var skipped = { published: false, reason: 'not-configured', checkedAt: written.snapshot.checkedAt };
      rememberPublish(options, written.snapshot, history, skipped);
      return done(
        { replaced: true, kept: false, reason: 'saved', checkedAt: written.snapshot.checkedAt },
        skipped
      );
    }
    return gas.afterHarvest({
      summary: summary,
      snapshot: written.snapshot,
      history: history,
      client: options.client,
      timeoutMs: options.timeoutMs,
    }).then(function (published) {
      rememberPublish(options, written.snapshot, history, published);
      return done(
        { replaced: true, kept: false, reason: 'saved', checkedAt: written.snapshot.checkedAt },
        {
          published: published && published.published === true,
          reason: published && published.published === true ? 'published' : ((published && published.reason) || 'incomplete'),
          checkedAt: written.snapshot.checkedAt,
        }
      );
    });
  }

  return {
    dispositionOf: dispositionOf,
    buildSnapshot: buildSnapshot,
    writeVerified: writeVerified,
    finish: finish,
  };
});
