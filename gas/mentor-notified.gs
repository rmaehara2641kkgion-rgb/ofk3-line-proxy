/**
 * メンター通知済みログ GAS — 独立版
 * 全アクションをdoGet（GETリクエスト）で処理
 * POST不使用（axiosリダイレクト問題を回避）
 * デプロイ: Webアプリ、実行: 自分、利用者: 全員
 */

var SPREADSHEET_ID = '1x8yu09Ub-LpuGnGIRqzE7zNZOBenaJMr1fL6k__D5V0';

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) ? e.parameter.action : '';

  if (action === 'batchCheck') {
    return handleBatchCheck(e);
  }
  if (action === 'mark') {
    return handleMark(e);
  }
  if (action === 'status') {
    var sheet = getNotifiedSheet();
    var lastRow = sheet.getLastRow();
    return jsonResponse({ status: 'ok', rows: Math.max(0, lastRow - 1) });
  }
  if (action === 'getActive') {
    return handleGetActive();
  }
  if (action === 'saveActive') {
    return handleSaveActive(e);
  }
  return jsonResponse({ status: 'error', message: 'unknown action' });
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getNotifiedSheet() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName('notifiedLog');
  if (!sheet) {
    sheet = ss.insertSheet('notifiedLog');
    sheet.appendRow(['date', 'driverId', 'notifiedAt']);
  }
  return sheet;
}

// 一括チェック: ?action=batchCheck&date=2026-08-02&ids=内山 健一,豊島 健太郎
function handleBatchCheck(e) {
  var date = e.parameter.date || '';
  var idsParam = e.parameter.ids || '';
  if (!date || !idsParam) {
    return jsonResponse({ notifiedIds: [] });
  }
  var driverIds = idsParam.split(',');
  var sheet = getNotifiedSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    return jsonResponse({ notifiedIds: [] });
  }
  var data = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  var notifiedSet = {};
  for (var i = 0; i < data.length; i++) {
    var rowDate = data[i][0];
    if (rowDate instanceof Date) {
      rowDate = Utilities.formatDate(rowDate, 'Asia/Tokyo', 'yyyy-MM-dd');
    }
    if (String(rowDate) === date) {
      notifiedSet[String(data[i][1])] = true;
    }
  }
  var result = [];
  for (var j = 0; j < driverIds.length; j++) {
    if (notifiedSet[driverIds[j]]) {
      result.push(driverIds[j]);
    }
  }
  return jsonResponse({ notifiedIds: result });
}

// 記録: ?action=mark&date=2026-08-02&ids=内山 健一,豊島 健太郎
function handleMark(e) {
  var date = e.parameter.date || '';
  var idsParam = e.parameter.ids || '';
  if (!date || !idsParam) {
    return jsonResponse({ status: 'ok', count: 0 });
  }
  var driverIds = idsParam.split(',');
  var sheet = getNotifiedSheet();
  var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
  var rows = [];
  for (var i = 0; i < driverIds.length; i++) {
    if (driverIds[i]) {
      rows.push([date, driverIds[i], now]);
    }
  }
  if (rows.length > 0) {
    var startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 1, rows.length, 3).setValues(rows);
  }
  return jsonResponse({ status: 'ok', count: rows.length });
}

// ── activeDrivers シート ──

function getActiveSheet() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName('activeDrivers');
  if (!sheet) {
    sheet = ss.insertSheet('activeDrivers');
    sheet.appendRow(['savedAt', 'data']);
  }
  return sheet;
}

// 前回保存したActiveリストを返す
function handleGetActive() {
  var sheet = getActiveSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    return jsonResponse({ drivers: [] });
  }
  var data = sheet.getRange(2, 2).getValue();
  try {
    var parsed = JSON.parse(data);
    return jsonResponse({ drivers: parsed });
  } catch (ex) {
    return jsonResponse({ drivers: [] });
  }
}

// 今回のActiveリストを保存（1行のみ上書き）
function handleSaveActive(e) {
  var dataParam = (e && e.parameter && e.parameter.data) ? e.parameter.data : '';
  if (!dataParam) {
    return jsonResponse({ status: 'error', message: 'no data' });
  }
  var sheet = getActiveSheet();
  var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    sheet.appendRow([now, dataParam]);
  } else {
    sheet.getRange(2, 1).setValue(now);
    sheet.getRange(2, 2).setValue(dataParam);
  }
  return jsonResponse({ status: 'ok', savedAt: now });
}

// 古いログの掃除（毎日トリガーで実行推奨）
function cleanNotifiedLog() {
  var sheet = getNotifiedSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;
  var today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  var data = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
  var keep = [];
  for (var i = 0; i < data.length; i++) {
    var rowDate = data[i][0];
    if (rowDate instanceof Date) {
      rowDate = Utilities.formatDate(rowDate, 'Asia/Tokyo', 'yyyy-MM-dd');
    }
    if (String(rowDate) === today) {
      keep.push(data[i]);
    }
  }
  sheet.getRange(2, 1, lastRow - 1, 3).clear();
  if (keep.length > 0) {
    sheet.getRange(2, 1, keep.length, 3).setValues(keep);
  }
}
