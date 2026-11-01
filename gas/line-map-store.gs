/**
 * LINE MAP 割当ストア (承認待ち・未デプロイ)。duty-risk-store.gs と同じ方針。
 * 保存するのは「日付・サイクル・ルート・DA安定ID・LINE ID」のみ。配送先住所・座標は保存しない。
 *
 * Script Properties:
 *   LINE_MAP_GAS_TOKEN  必須。空なら503、不一致は401。
 *   LINE_MAP_FOLDER_ID  必須。非公開フォルダ(共有しない)。このフォルダ以外には書かない。
 * Webアプリは「自分として実行」、アクセスは「全員」(トークンで保護)。
 */
var LINE_MAP_FILE = 'line-map-assignments.json';

function lineMapJson_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
function lineMapProp_(k) { return PropertiesService.getScriptProperties().getProperty(k) || ''; }

function doPost(e) {
  var expected = lineMapProp_('LINE_MAP_GAS_TOKEN');
  if (!expected) return lineMapJson_({ status: 'error', reason: 'not-configured' });
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) { return lineMapJson_({ status: 'error', reason: 'bad-request' }); }
  if (!body.token || String(body.token) !== expected) return lineMapJson_({ status: 'error', reason: 'unauthorized' });
  var folderId = lineMapProp_('LINE_MAP_FOLDER_ID');
  if (!folderId) return lineMapJson_({ status: 'error', reason: 'not-configured' });
  var folder = DriveApp.getFolderById(folderId);
  var it = folder.getFilesByName(LINE_MAP_FILE);
  var file = it.hasNext() ? it.next() : null;
  if (body.action === 'load') {
    return lineMapJson_({ status: 'ok', data: file ? JSON.parse(file.getBlob().getDataAsString('UTF-8')) : {} });
  }
  if (body.action === 'save') {
    if (!body.data || typeof body.data !== 'object') return lineMapJson_({ status: 'error', reason: 'bad-request' });
    var text = JSON.stringify(body.data);
    if (text.length > 2000000) return lineMapJson_({ status: 'error', reason: 'too-large' });
    if (file) file.setContent(text); else folder.createFile(LINE_MAP_FILE, text, MimeType.JSON);
    return lineMapJson_({ status: 'ok' });
  }
  return lineMapJson_({ status: 'error', reason: 'unknown-action' });
}
