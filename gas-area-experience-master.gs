/**
 * OFK3 エリア経験マスタ GAS
 * デプロイ: Webアプリ、実行: 自分、利用者: 全員
 *
 * セットアップ:
 * 1. Google Drive にフォルダを作成（例: OFK3_areaExperienceMaster）
 * 2. スクリプトプロパティ MASTER_FOLDER_ID にフォルダIDを設定
 * 3. Webアプリとしてデプロイし、URLを Render の AREA_EXPERIENCE_MASTER_GAS_URL に設定
 *
 * 保存形式（areaExperienceMaster.json）:
 *   updatedAt / records / stats   … 既存形式（旧クライアント互換。save で従来どおり更新）
 *   snapshot                       … 累積XLSXの初期スナップショット（rawRows・importHistory・
 *                                    snapshotThroughDate・sourceFile・missingPeriods・resolution 等）
 *   events.routeCaptures           … serviceDate|routeCode → 最新の取得状態（capturedAt が新しい方を採用）
 *   events.items                   … TransportID|normalizedArea|serviceDate → 経験イベント（集合）
 *   unresolved                     … 未解決ドライバー情報
 *   lastAggregatedDate / lastAggregatedAt
 *
 * events はスナップショット再登録でも削除しない。経験日数への算入は
 * クライアント側で serviceDate > snapshot.snapshotThroughDate のみに限定する。
 */

var MASTER_FILE_NAME = 'areaExperienceMaster.json';
var LOCK_WAIT_MS = 30000;

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function getMasterFolder() {
  var folderId = PropertiesService.getScriptProperties().getProperty('MASTER_FOLDER_ID');
  if (!folderId) {
    throw new Error('MASTER_FOLDER_ID not set in script properties');
  }
  return DriveApp.getFolderById(folderId);
}

function getOrCreateMasterFile() {
  var folder = getMasterFolder();
  var files = folder.getFilesByName(MASTER_FILE_NAME);
  if (files.hasNext()) {
    return files.next();
  }
  return folder.createFile(MASTER_FILE_NAME, JSON.stringify({ updatedAt: '', records: [], stats: null }), MimeType.PLAIN_TEXT);
}

function readMaster(file) {
  var content = file.getBlob().getDataAsString('UTF-8');
  if (!content || !String(content).trim()) return {};
  return JSON.parse(content) || {};
}

function hasMasterData(m) {
  return !!(
    (m.records && m.records.length) ||
    (m.snapshot && m.snapshot.rawRows && m.snapshot.rawRows.length) ||
    (m.events && ((m.events.routeCaptures && Object.keys(m.events.routeCaptures).length) || (m.events.items && Object.keys(m.events.items).length)))
  );
}

function withLock(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_WAIT_MS);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function todayJst() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
}

function isIsoDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
}

function doGet(e) {
  try {
    var action = (e && e.parameter && e.parameter.action) ? e.parameter.action : '';
    if (action === 'get') {
      var parsed = readMaster(getOrCreateMasterFile());
      if (!hasMasterData(parsed)) {
        return jsonResponse({ status: 'ok', data: null });
      }
      return jsonResponse({ status: 'ok', data: parsed });
    }
    if (action === 'stats') {
      var obj = readMaster(getOrCreateMasterFile());
      return jsonResponse({
        status: 'ok',
        stats: obj.stats || null,
        updatedAt: obj.updatedAt || '',
        snapshotThroughDate: obj.snapshot ? obj.snapshot.snapshotThroughDate || '' : '',
        lastAggregatedDate: obj.lastAggregatedDate || '',
      });
    }
    return jsonResponse({ status: 'error', message: 'unknown action: ' + action });
  } catch (err) {
    return jsonResponse({ status: 'error', message: String(err.message || err) });
  }
}

/** 旧形式 save: records/stats/updatedAt のみ更新し、snapshot/events/unresolved は保持する */
function handleSave(body) {
  if (!body || !Array.isArray(body.records)) {
    return { status: 'error', message: 'records array required' };
  }
  return withLock(function () {
    var file = getOrCreateMasterFile();
    var master = readMaster(file);
    master.updatedAt = body.updatedAt || todayJst();
    master.records = body.records;
    master.stats = body.stats || null;
    file.setContent(JSON.stringify(master));
    return { status: 'ok', updatedAt: master.updatedAt, recordCount: master.records.length };
  });
}

/** スナップショット登録: snapshot/records/stats/unresolved を置換。events は削除しない */
function handleSaveSnapshot(body) {
  var snap = body && body.snapshot;
  if (!snap || !Array.isArray(snap.rawRows) || !Array.isArray(snap.header)) {
    return { status: 'error', message: 'snapshot.rawRows / snapshot.header required' };
  }
  if (!isIsoDate(snap.snapshotThroughDate)) {
    return { status: 'error', message: 'snapshot.snapshotThroughDate (YYYY-MM-DD) required' };
  }
  if (!Array.isArray(body.records)) {
    return { status: 'error', message: 'records array required' };
  }
  return withLock(function () {
    var file = getOrCreateMasterFile();
    var master = readMaster(file);
    master.schemaVersion = 2;
    master.updatedAt = body.updatedAt || todayJst();
    master.records = body.records;
    master.stats = body.stats || null;
    master.snapshot = snap;
    master.unresolved = body.unresolved || null;
    if (!master.events) master.events = { routeCaptures: {}, items: {} };
    file.setContent(JSON.stringify(master));
    return {
      status: 'ok',
      updatedAt: master.updatedAt,
      recordCount: master.records.length,
      rawRowCount: snap.rawRows.length,
      snapshotThroughDate: snap.snapshotThroughDate,
      preservedRouteCaptures: Object.keys(master.events.routeCaptures || {}).length,
      preservedEventItems: Object.keys(master.events.items || {}).length,
    };
  });
}

/**
 * 経験イベント追記（冪等）。
 *   routeCaptures[]: {key, serviceDate, routeCode, transporterId, areas[], capturedAt, ...}
 *     key = serviceDate|routeCode。既存より capturedAt が古いものは無視、それ以外は置換。
 *   events[]: {key, transportId, normalizedArea, serviceDate, ...}
 *     key = transportId|normalizedArea|serviceDate。同一キーは上書きのみ（件数は増えない）。
 * 正規化（エリア抽出等）は Render 側 /area-experience-events で済ませてから送る。
 */
function handleAppendEvents(body) {
  var captures = (body && body.routeCaptures) || [];
  var items = (body && body.events) || [];
  if (!Array.isArray(captures) || !Array.isArray(items)) {
    return { status: 'error', message: 'routeCaptures / events must be arrays' };
  }
  return withLock(function () {
    var file = getOrCreateMasterFile();
    var master = readMaster(file);
    if (!master.events) master.events = { routeCaptures: {}, items: {} };
    if (!master.events.routeCaptures) master.events.routeCaptures = {};
    if (!master.events.items) master.events.items = {};
    var rc = master.events.routeCaptures;
    var it = master.events.items;
    var result = { capturesApplied: 0, capturesStale: 0, eventsAdded: 0, eventsUnchanged: 0, invalid: 0 };
    var maxDate = master.lastAggregatedDate || '';

    for (var i = 0; i < captures.length; i++) {
      var c = captures[i];
      if (!c || !isIsoDate(c.serviceDate) || !c.routeCode || c.key !== c.serviceDate + '|' + c.routeCode) {
        result.invalid++;
        continue;
      }
      var cur = rc[c.key];
      if (cur && cur.capturedAt && c.capturedAt && String(c.capturedAt) < String(cur.capturedAt)) {
        result.capturesStale++;
        continue;
      }
      rc[c.key] = c;
      result.capturesApplied++;
      if (c.serviceDate > maxDate) maxDate = c.serviceDate;
    }
    for (var j = 0; j < items.length; j++) {
      var ev = items[j];
      if (!ev || !ev.transportId || !ev.normalizedArea || !isIsoDate(ev.serviceDate) ||
          ev.key !== ev.transportId + '|' + ev.normalizedArea + '|' + ev.serviceDate) {
        result.invalid++;
        continue;
      }
      if (it[ev.key]) result.eventsUnchanged++;
      else result.eventsAdded++;
      it[ev.key] = ev;
      if (ev.serviceDate > maxDate) maxDate = ev.serviceDate;
    }
    master.lastAggregatedDate = maxDate;
    master.lastAggregatedAt = new Date().toISOString();
    file.setContent(JSON.stringify(master));
    result.status = 'ok';
    result.lastAggregatedDate = master.lastAggregatedDate;
    result.routeCaptureCount = Object.keys(rc).length;
    result.eventItemCount = Object.keys(it).length;
    return result;
  });
}

function doPost(e) {
  try {
    var action = (e && e.parameter && e.parameter.action) ? e.parameter.action : '';
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse({ status: 'error', message: 'empty body' });
    }
    var body = JSON.parse(e.postData.contents);
    if (action === 'save') return jsonResponse(handleSave(body));
    if (action === 'saveSnapshot') return jsonResponse(handleSaveSnapshot(body));
    if (action === 'appendEvents') return jsonResponse(handleAppendEvents(body));
    return jsonResponse({ status: 'error', message: 'unknown action: ' + action });
  } catch (err) {
    return jsonResponse({ status: 'error', message: String(err.message || err) });
  }
}
