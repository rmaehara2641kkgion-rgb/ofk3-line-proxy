/**
 * OFK3 エリア経験マスタ GAS
 * デプロイ: Webアプリ、実行: 自分、利用者: 全員
 *
 * セットアップ:
 * 1. Google Drive にフォルダを作成（例: OFK3_areaExperienceMaster）
 * 2. スクリプトプロパティ MASTER_FOLDER_ID にフォルダIDを設定
 * 3. Webアプリとしてデプロイし、URLを Render の AREA_EXPERIENCE_MASTER_GAS_URL に設定
 */

var MASTER_FILE_NAME = 'areaExperienceMaster.json';

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

function doGet(e) {
  try {
    var action = (e && e.parameter && e.parameter.action) ? e.parameter.action : '';
    if (action === 'get') {
      var file = getOrCreateMasterFile();
      var content = file.getBlob().getDataAsString('UTF-8');
      if (!content || !String(content).trim()) {
        return jsonResponse({ status: 'ok', data: null });
      }
      var parsed = JSON.parse(content);
      if (!parsed.records || !parsed.records.length) {
        return jsonResponse({ status: 'ok', data: null });
      }
      return jsonResponse({ status: 'ok', data: parsed });
    }
    if (action === 'stats') {
      var f = getOrCreateMasterFile();
      var txt = f.getBlob().getDataAsString('UTF-8');
      if (!txt || !String(txt).trim()) {
        return jsonResponse({ status: 'ok', stats: null });
      }
      var obj = JSON.parse(txt);
      return jsonResponse({ status: 'ok', stats: obj.stats || null, updatedAt: obj.updatedAt || '' });
    }
    return jsonResponse({ status: 'error', message: 'unknown action: ' + action });
  } catch (err) {
    return jsonResponse({ status: 'error', message: String(err.message || err) });
  }
}

function doPost(e) {
  try {
    var action = (e && e.parameter && e.parameter.action) ? e.parameter.action : '';
    if (action === 'save') {
      if (!e.postData || !e.postData.contents) {
        return jsonResponse({ status: 'error', message: 'empty body' });
      }
      var body = JSON.parse(e.postData.contents);
      if (!body || !Array.isArray(body.records)) {
        return jsonResponse({ status: 'error', message: 'records array required' });
      }
      var file = getOrCreateMasterFile();
      var payload = {
        updatedAt: body.updatedAt || Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd'),
        records: body.records,
        stats: body.stats || null,
      };
      file.setContent(JSON.stringify(payload));
      return jsonResponse({ status: 'ok', updatedAt: payload.updatedAt, recordCount: payload.records.length });
    }
    return jsonResponse({ status: 'error', message: 'unknown action: ' + action });
  } catch (err) {
    return jsonResponse({ status: 'error', message: String(err.message || err) });
  }
}
