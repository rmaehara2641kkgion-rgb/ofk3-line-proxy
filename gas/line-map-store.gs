/**
 * LINE MAP 割当ストア (承認待ち・未デプロイ)。duty-risk-store.gs と同じ方針。
 * 保存するのは「日付・サイクル・ルート・DA安定ID(transportId)・LINE userId」のみ。
 * 配送先住所・座標・荷物情報・MAP閲覧トークン・秘密値は保存しない (許可リスト方式で、想定外のキーは拒否)。
 *
 * Script Properties (すべて必須):
 *   LINE_MAP_GAS_TOKEN  空なら not-configured、不一致は unauthorized。
 *   LINE_MAP_FOLDER_ID  保存先フォルダ。このフォルダ以外には読み書きしない。
 *                       フォルダの共有設定が「非公開(PRIVATE)」でなければ書き込みを拒否する。
 *
 * デプロイ設定: 実行ユーザー=自分 / アクセス=全員(匿名可。トークンで保護する必要があるため)。
 *   ※ URLを知っていてもトークンが無ければ何も返さない。トークンはPOSTボディでのみ受け取る(URLには載せない)。
 *
 * 排他と世代: save は expectedSeq が現在の seq と一致するときだけ成功 (LockService)。
 * 不一致は conflict を返し、呼び出し側が再読込・マージして再試行する。保存成功の応答には seq と checksum を返す。
 */
var LINE_MAP_FILE = 'line-map-assignments.json';
var LINE_MAP_MAX_BYTES = 1500000;
var LINE_MAP_MAX_DATES = 5;
var LINE_MAP_MAX_ROWS = 2000;

function lineMapJson_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
function lineMapProp_(k) { return PropertiesService.getScriptProperties().getProperty(k) || ''; }
function lineMapSafeEq_(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  var d = 0;
  for (var i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function lineMapOnlyKeys_(o, keys) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  for (var k in o) if (keys.indexOf(k) < 0) return false;
  return true;
}
// 想定外のキー・型・件数は拒否 (住所などが紛れ込んでも保存しない)
function lineMapValidateData_(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  var dates = Object.keys(data);
  if (dates.length > LINE_MAP_MAX_DATES) return false;
  for (var i = 0; i < dates.length; i++) {
    var e = data[dates[i]];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dates[i]) || !lineMapOnlyKeys_(e, ['rows', 'links', 'syncedAt'])) return false;
    if (!Array.isArray(e.rows) || !Array.isArray(e.links) || e.rows.length > LINE_MAP_MAX_ROWS || e.links.length > LINE_MAP_MAX_ROWS) return false;
    for (var r = 0; r < e.rows.length; r++) {
      var row = e.rows[r];
      if (!lineMapOnlyKeys_(row, ['date', 'cycle', 'routeCode', 'driverId']) || row.date !== dates[i]) return false;
      if (typeof row.routeCode !== 'string' || typeof row.driverId !== 'string' || row.routeCode.length > 32 || row.driverId.length > 64) return false;
    }
    for (var l = 0; l < e.links.length; l++) {
      var lk = e.links[l];
      if (!lineMapOnlyKeys_(lk, ['driverId', 'lineUserId']) || !/^U[0-9a-f]{32}$/i.test(String(lk.lineUserId))) return false;
    }
  }
  return true;
}

function doPost(e) {
  var expected = lineMapProp_('LINE_MAP_GAS_TOKEN');
  var folderId = lineMapProp_('LINE_MAP_FOLDER_ID');
  if (!expected || !folderId) return lineMapJson_({ status: 'error', reason: 'not-configured' });
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) { return lineMapJson_({ status: 'error', reason: 'bad-request' }); }
  if (!body.token || !lineMapSafeEq_(body.token, expected)) return lineMapJson_({ status: 'error', reason: 'unauthorized' });

  var folder = DriveApp.getFolderById(folderId);
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return lineMapJson_({ status: 'error', reason: 'busy' });
  try {
    var it = folder.getFilesByName(LINE_MAP_FILE);
    var file = it.hasNext() ? it.next() : null;
    var current = file ? JSON.parse(file.getBlob().getDataAsString('UTF-8')) : null;
    if (body.action === 'load') return lineMapJson_({ status: 'ok', envelope: current });
    if (body.action === 'save') {
      // 保存先が共有されている場合は書き込まない (個人情報の意図しない公開を防ぐ)
      if (folder.getSharingAccess() !== DriveApp.Access.PRIVATE) return lineMapJson_({ status: 'error', reason: 'folder-not-private' });
      var env = body.envelope;
      if (!env || env.v !== 1 || typeof env.seq !== 'number' || typeof env.checksum !== 'string' || !lineMapValidateData_(env.data)) return lineMapJson_({ status: 'error', reason: 'bad-request' });
      var currentSeq = current ? current.seq : 0;
      if (body.expectedSeq !== currentSeq || env.seq !== currentSeq + 1) return lineMapJson_({ status: 'error', reason: 'conflict', seq: currentSeq });
      var text = JSON.stringify(env);
      if (text.length > LINE_MAP_MAX_BYTES) return lineMapJson_({ status: 'error', reason: 'too-large' });
      if (file) file.setContent(text); else folder.createFile(LINE_MAP_FILE, text, MimeType.JSON);
      return lineMapJson_({ status: 'ok', seq: env.seq, checksum: env.checksum });
    }
    return lineMapJson_({ status: 'error', reason: 'unknown-action' });
  } finally { lock.releaseLock(); }
}
