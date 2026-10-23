/**
 * 勤務時間リスクの公開ファイル。
 * 既存のExcelやDAマスタは開かない。専用フォルダへ新しいファイルを書き、
 * 照合が終わったあとだけ current ポインタを差し替える。
 *
 * Script Properties:
 *   DUTY_RISK_GAS_TOKEN  必須。空なら503。不一致は401。
 *   DUTY_RISK_FOLDER_ID  必須。このフォルダ以外には書かない。
 *
 * Webアプリは「自分として実行」。ファイルは共有しない。
 */
var DUTY_RISK_POINTER_NAME = 'duty-risk-current.json';

function dutyRiskJson_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function dutyRiskExpectedToken_() {
  return PropertiesService.getScriptProperties().getProperty('DUTY_RISK_GAS_TOKEN') || '';
}

function dutyRiskPresentedToken_(e) {
  e = e || {};
  if (e.parameter && e.parameter.token) return String(e.parameter.token);
  var body = {};
  try {
    if (e.postData && e.postData.contents) body = JSON.parse(e.postData.contents);
  } catch (err) {
    body = {};
  }
  if (body && body.token) return String(body.token);
  return '';
}

function dutyRiskAuthorize_(e) {
  var expected = dutyRiskExpectedToken_();
  if (!expected) return { ok: false, status: 503, reason: 'not-configured' };
  var presented = dutyRiskPresentedToken_(e);
  if (!presented || presented !== expected) return { ok: false, status: 401, reason: 'unauthorized' };
  return { ok: true, status: 200 };
}

function dutyRiskFolder_() {
  var id = PropertiesService.getScriptProperties().getProperty('DUTY_RISK_FOLDER_ID') || '';
  if (!id) return null;
  return DriveApp.getFolderById(id);
}

function dutyRiskFind_(folder, name) {
  var found = folder.getFilesByName(name);
  return found.hasNext() ? found.next() : null;
}

function dutyRiskReadJson_(file) {
  return JSON.parse(file.getBlob().getDataAsString('UTF-8'));
}

function dutyRiskWriteJson_(folder, name, value) {
  var text = JSON.stringify(value);
  var existing = dutyRiskFind_(folder, name);
  if (existing) {
    existing.setContent(text);
    return existing;
  }
  return folder.createFile(name, text, MimeType.JSON);
}

function dutyRiskPointer_(folder) {
  var file = dutyRiskFind_(folder, DUTY_RISK_POINTER_NAME);
  if (!file) return null;
  try { return dutyRiskReadJson_(file); } catch (e) { return null; }
}

function dutyRiskBody_(e) {
  try {
    if (e && e.postData && e.postData.contents) return JSON.parse(e.postData.contents);
  } catch (err) {}
  return {};
}

function dutyRiskCompare_(currentCheckedAt, incomingCheckedAt) {
  if (!currentCheckedAt) return 'absent';
  if (currentCheckedAt === incomingCheckedAt) return 'same';
  var currentTime = Date.parse(currentCheckedAt);
  var incomingTime = Date.parse(incomingCheckedAt);
  if (!isFinite(currentTime) || !isFinite(incomingTime) || currentTime === incomingTime) return 'incomparable';
  return currentTime > incomingTime ? 'older' : 'newer';
}

function dutyRiskSelect_(snapshot, historyRun) {
  if (!snapshot || snapshot.usable !== true) return { ok: false, reason: 'snapshot-not-usable' };
  if (snapshot.fetchStatus !== 'success' && snapshot.fetchStatus !== 'partial') {
    return { ok: false, reason: 'snapshot-not-success' };
  }
  if (!snapshot.checkedAt || !historyRun || historyRun.predictedAt !== snapshot.checkedAt) {
    return { ok: false, reason: 'mismatch' };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(historyRun.referenceDate || '') || !Array.isArray(historyRun.predictions)) {
    return { ok: false, reason: 'mismatch' };
  }
  return { ok: true, snapshot: snapshot, historyRun: historyRun };
}

function doGet(e) {
  var auth = dutyRiskAuthorize_(e);
  if (!auth.ok) return dutyRiskJson_({ ok: false, reason: auth.reason, lastSuccessAt: null });
  if (!e || !e.parameter || e.parameter.action !== 'current') {
    return dutyRiskJson_({ ok: false, reason: 'unknown-action', lastSuccessAt: null });
  }
  var folder = dutyRiskFolder_();
  if (!folder) return dutyRiskJson_({ ok: false, reason: 'not-configured', lastSuccessAt: null });
  var pointer = dutyRiskPointer_(folder);
  if (!pointer || !pointer.generation || !pointer.checkedAt) {
    return dutyRiskJson_({ ok: false, reason: 'not-published', lastSuccessAt: null });
  }
  try {
    var snapshot = dutyRiskReadJson_(dutyRiskFind_(folder, pointer.generation + '-snapshot.json'));
    var historyRun = dutyRiskReadJson_(dutyRiskFind_(folder, pointer.generation + '-history-run.json'));
    if (!snapshot || !historyRun || snapshot.checkedAt !== pointer.checkedAt || historyRun.predictedAt !== pointer.checkedAt) {
      return dutyRiskJson_({ ok: false, reason: 'read-failed', lastSuccessAt: pointer.checkedAt });
    }
    return dutyRiskJson_({
      ok: true,
      checkedAt: pointer.checkedAt,
      generation: pointer.generation,
      snapshot: snapshot,
      historyRun: historyRun,
    });
  } catch (err) {
    return dutyRiskJson_({ ok: false, reason: 'read-failed', lastSuccessAt: pointer.checkedAt });
  }
}

function doPost(e) {
  var auth = dutyRiskAuthorize_(e);
  if (!auth.ok) return dutyRiskJson_({ ok: false, reason: auth.reason, lastSuccessAt: null });
  var body = dutyRiskBody_(e);
  if (!body || body.action !== 'publish') {
    return dutyRiskJson_({ ok: false, reason: 'unknown-action', lastSuccessAt: null });
  }
  var folder = dutyRiskFolder_();
  if (!folder) return dutyRiskJson_({ ok: false, reason: 'not-configured', lastSuccessAt: null });
  var previous = dutyRiskPointer_(folder);
  var lastSuccessAt = previous && previous.checkedAt ? previous.checkedAt : null;
  var pair = dutyRiskSelect_(body.snapshot, body.historyRun);
  if (!pair.ok) return dutyRiskJson_({ ok: false, published: false, reason: pair.reason, lastSuccessAt: lastSuccessAt });
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    return dutyRiskJson_({ ok: false, published: false, reason: 'busy', lastSuccessAt: lastSuccessAt });
  }
  try {
    var current = dutyRiskPointer_(folder);
    var currentCheckedAt = current && current.checkedAt ? current.checkedAt : null;
    lastSuccessAt = currentCheckedAt || lastSuccessAt;
    var relation = dutyRiskCompare_(currentCheckedAt, pair.snapshot.checkedAt);
    if (relation === 'same') {
      return dutyRiskJson_({
        ok: true,
        published: false,
        duplicate: true,
        reason: 'already-published',
        generation: current.generation || null,
        checkedAt: currentCheckedAt,
      });
    }
    if (relation === 'older') {
      return dutyRiskJson_({ ok: false, published: false, reason: 'stale', lastSuccessAt: lastSuccessAt });
    }
    if (relation === 'incomparable') {
      return dutyRiskJson_({ ok: false, published: false, reason: 'mismatch', lastSuccessAt: lastSuccessAt });
    }
    var generation = 'gen-' + Utilities.getUuid();
    var snapshotFile = dutyRiskWriteJson_(folder, generation + '-snapshot.json', pair.snapshot);
    var historyFile = dutyRiskWriteJson_(folder, generation + '-history-run.json', pair.historyRun);
    var savedSnapshot = dutyRiskReadJson_(snapshotFile);
    var savedRun = dutyRiskReadJson_(historyFile);
    if (!savedSnapshot || savedSnapshot.checkedAt !== pair.snapshot.checkedAt) throw new Error('verify-snapshot');
    if (!savedRun || savedRun.predictedAt !== pair.snapshot.checkedAt) throw new Error('verify-run');
    if (!savedRun.predictions || savedRun.predictions.length !== pair.historyRun.predictions.length) throw new Error('verify-run');
    dutyRiskWriteJson_(folder, DUTY_RISK_POINTER_NAME, {
      generation: generation,
      checkedAt: pair.snapshot.checkedAt,
    });
    return dutyRiskJson_({ ok: true, published: true, generation: generation, checkedAt: pair.snapshot.checkedAt });
  } catch (err) {
    var detail = err && err.message ? String(err.message) : '';
    var reason = 'incomplete';
    if (detail === 'verify-snapshot' || detail === 'verify-run') reason = detail;
    return dutyRiskJson_({ ok: false, published: false, reason: reason, lastSuccessAt: lastSuccessAt });
  } finally {
    lock.releaseLock();
  }
}
