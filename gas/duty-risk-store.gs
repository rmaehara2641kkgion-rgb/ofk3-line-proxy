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
var DUTY_RISK_REVISION = 'diag-20261023-1';

function dutyRiskCode_(value) {
  var text = value == null ? '' : String(value);
  if (!text) return '';
  if (/token|secret|bearer|password|authorization/i.test(text)) return '';
  return /^[a-z][a-z0-9-]{0,40}$/.test(text) ? text : '';
}

function dutyRiskEnter_(stage) {
  Logger.log('duty-risk revision=' + DUTY_RISK_REVISION + ' stage=' + (dutyRiskCode_(stage) || 'unknown') + ' mark=enter');
}

function dutyRiskFaultReason_(err) {
  var detail = err && err.message ? String(err.message) : '';
  var safeDetail = dutyRiskCode_(detail);
  if (safeDetail) return safeDetail;
  var name = err && err.name ? String(err.name) : '';
  if (name === 'TypeError') return 'type-error';
  if (name === 'ReferenceError') return 'reference-error';
  if (name === 'SyntaxError') return 'syntax-error';
  return 'exception';
}

function dutyRiskFinish_(fields) {
  fields = fields || {};
  var reason = dutyRiskCode_(fields.reason) || 'incomplete';
  var stage = dutyRiskCode_(fields.stage) || 'unknown';
  Logger.log('duty-risk revision=' + DUTY_RISK_REVISION + ' stage=' + stage + ' reason=' + reason + ' mark=result');
  var payload = { ok: fields.ok === true, reason: reason, stage: stage, revision: DUTY_RISK_REVISION };
  if (fields.published === true || fields.published === false) payload.published = fields.published === true;
  if (fields.duplicate === true) payload.duplicate = true;
  if (fields.lastSuccessAt) payload.lastSuccessAt = fields.lastSuccessAt;
  if (fields.checkedAt) payload.checkedAt = fields.checkedAt;
  if (fields.generation) payload.generation = fields.generation;
  return dutyRiskJson_(payload);
}

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
  if (e && e.parameter && e.parameter.action === 'revision') {
    Logger.log('duty-risk revision=' + DUTY_RISK_REVISION + ' stage=revision reason=ok mark=result');
    return dutyRiskJson_({ ok: true, revision: DUTY_RISK_REVISION, stage: 'revision', readsDrive: false });
  }
  var stage = 'auth';
  try {
    dutyRiskEnter_('auth');
    var auth = dutyRiskAuthorize_(e);
    if (!auth.ok) return dutyRiskFinish_({ ok: false, reason: auth.reason, stage: 'auth', lastSuccessAt: null });
    stage = 'action';
    dutyRiskEnter_('action');
    if (!e || !e.parameter || e.parameter.action !== 'current') {
      return dutyRiskFinish_({ ok: false, reason: 'unknown-action', stage: 'action', lastSuccessAt: null });
    }
    stage = 'folder';
    dutyRiskEnter_('folder');
    var folder = dutyRiskFolder_();
    if (!folder) return dutyRiskFinish_({ ok: false, reason: 'not-configured', stage: 'folder', lastSuccessAt: null });
    stage = 'pointer';
    dutyRiskEnter_('pointer');
    var pointer = dutyRiskPointer_(folder);
    if (!pointer || !pointer.generation || !pointer.checkedAt) {
      return dutyRiskFinish_({ ok: false, reason: 'not-published', stage: 'pointer', lastSuccessAt: null });
    }
    stage = 'read';
    dutyRiskEnter_('read');
    var snapshot = dutyRiskReadJson_(dutyRiskFind_(folder, pointer.generation + '-snapshot.json'));
    var historyRun = dutyRiskReadJson_(dutyRiskFind_(folder, pointer.generation + '-history-run.json'));
    if (!snapshot || !historyRun || snapshot.checkedAt !== pointer.checkedAt || historyRun.predictedAt !== pointer.checkedAt) {
      return dutyRiskFinish_({ ok: false, reason: 'read-failed', stage: 'read', lastSuccessAt: pointer.checkedAt });
    }
    Logger.log('duty-risk revision=' + DUTY_RISK_REVISION + ' stage=read reason=ok mark=result');
    return dutyRiskJson_({
      ok: true,
      checkedAt: pointer.checkedAt,
      generation: pointer.generation,
      snapshot: snapshot,
      historyRun: historyRun,
      stage: 'read',
      revision: DUTY_RISK_REVISION,
    });
  } catch (err) {
    return dutyRiskFinish_({ ok: false, reason: dutyRiskFaultReason_(err), stage: stage, lastSuccessAt: null });
  }
}

function doPost(e) {
  var stage = 'auth';
  var lastSuccessAt = null;
  var lock = null;
  var held = false;
  try {
    dutyRiskEnter_('auth');
    var auth = dutyRiskAuthorize_(e);
    if (!auth.ok) return dutyRiskFinish_({ ok: false, published: false, reason: auth.reason, stage: 'auth', lastSuccessAt: null });
    stage = 'body';
    dutyRiskEnter_('body');
    var body = dutyRiskBody_(e);
    if (!body || body.action !== 'publish') {
      return dutyRiskFinish_({ ok: false, published: false, reason: 'unknown-action', stage: 'body', lastSuccessAt: null });
    }
    stage = 'folder';
    dutyRiskEnter_('folder');
    var folder = dutyRiskFolder_();
    if (!folder) return dutyRiskFinish_({ ok: false, published: false, reason: 'not-configured', stage: 'folder', lastSuccessAt: null });
    stage = 'select';
    dutyRiskEnter_('select');
    var previous = dutyRiskPointer_(folder);
    lastSuccessAt = previous && previous.checkedAt ? previous.checkedAt : null;
    var pair = dutyRiskSelect_(body.snapshot, body.historyRun);
    if (!pair.ok) return dutyRiskFinish_({ ok: false, published: false, reason: pair.reason, stage: 'select', lastSuccessAt: lastSuccessAt });
    stage = 'lock';
    dutyRiskEnter_('lock');
    lock = LockService.getScriptLock();
    if (!lock.tryLock(15000)) return dutyRiskFinish_({ ok: false, published: false, reason: 'busy', stage: 'lock', lastSuccessAt: lastSuccessAt });
    held = true;
    stage = 'compare';
    dutyRiskEnter_('compare');
    var current = dutyRiskPointer_(folder);
    var currentCheckedAt = current && current.checkedAt ? current.checkedAt : null;
    lastSuccessAt = currentCheckedAt || lastSuccessAt;
    var relation = dutyRiskCompare_(currentCheckedAt, pair.snapshot.checkedAt);
    if (relation === 'same') {
      return dutyRiskFinish_({
        ok: true,
        published: false,
        duplicate: true,
        reason: 'already-published',
        stage: 'compare',
        generation: current.generation || null,
        checkedAt: currentCheckedAt,
      });
    }
    if (relation === 'older') return dutyRiskFinish_({ ok: false, published: false, reason: 'stale', stage: 'compare', lastSuccessAt: lastSuccessAt });
    if (relation === 'incomparable') return dutyRiskFinish_({ ok: false, published: false, reason: 'mismatch', stage: 'compare', lastSuccessAt: lastSuccessAt });
    var generation = 'gen-' + Utilities.getUuid();
    stage = 'write-snapshot';
    dutyRiskEnter_('write-snapshot');
    var snapshotFile = dutyRiskWriteJson_(folder, generation + '-snapshot.json', pair.snapshot);
    stage = 'write-history';
    dutyRiskEnter_('write-history');
    var historyFile = dutyRiskWriteJson_(folder, generation + '-history-run.json', pair.historyRun);
    stage = 'verify-snapshot';
    dutyRiskEnter_('verify-snapshot');
    var savedSnapshot = dutyRiskReadJson_(snapshotFile);
    if (!savedSnapshot || savedSnapshot.checkedAt !== pair.snapshot.checkedAt) throw new Error('verify-snapshot');
    stage = 'verify-run';
    dutyRiskEnter_('verify-run');
    var savedRun = dutyRiskReadJson_(historyFile);
    if (!savedRun || savedRun.predictedAt !== pair.snapshot.checkedAt) throw new Error('verify-run');
    if (!savedRun.predictions || savedRun.predictions.length !== pair.historyRun.predictions.length) throw new Error('verify-run');
    stage = 'pointer';
    dutyRiskEnter_('pointer');
    dutyRiskWriteJson_(folder, DUTY_RISK_POINTER_NAME, {
      generation: generation,
      checkedAt: pair.snapshot.checkedAt,
    });
    return dutyRiskFinish_({
      ok: true,
      published: true,
      reason: 'published',
      stage: 'pointer',
      generation: generation,
      checkedAt: pair.snapshot.checkedAt,
    });
  } catch (err) {
    return dutyRiskFinish_({
      ok: false,
      published: false,
      reason: dutyRiskFaultReason_(err),
      stage: stage,
      lastSuccessAt: lastSuccessAt,
    });
  } finally {
    if (held && lock) lock.releaseLock();
  }
}
