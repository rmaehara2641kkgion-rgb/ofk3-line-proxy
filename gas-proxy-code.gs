/**
 * 住所マスター GAS — 超安定版（キャッシュなし、シート直接読み取り）
 * デプロイ: Webアプリ、実行: 自分、利用者: 全員
 */

var SPREADSHEET_ID = '1TwLfMoab1fCd-zMxgYONDUUobxR0AokqAs87Vd39th0';
var SHEET_NAME = 'addrMaster';

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) ? e.parameter.action : '';
  if (action === 'lookup') {
    var address = e.parameter.address;
    var coord = lookupAddress(address);
    if (coord) {
      return jsonResponse({ status: 'ok', lat: coord.lat, lng: coord.lng });
    }
    return jsonResponse({ status: 'notfound' });
  }
  if (action === 'list') {
    return jsonResponse({ status: 'ok', data: loadAllAddresses() });
  }
  if (action === 'pending') {
    return jsonResponse({ status: 'ok', data: loadPendingAddresses() });
  }
  if (action === 'stats') {
    var sheet = getSheet();
    var lastRow = sheet.getLastRow();
    if (lastRow <= 1) {
      return jsonResponse({ status: 'ok', total: 0, geocoded: 0, pending: 0 });
    }
    var values = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
    var total = 0;
    var geocoded = 0;
    for (var i = 0; i < values.length; i++) {
      if (!String(values[i][0] || '').trim()) continue;
      total++;
      if (values[i][1] !== '' && values[i][2] !== '') geocoded++;
    }
    return jsonResponse({ status: 'ok', total: total, geocoded: geocoded, pending: total - geocoded });
  }
  if (action === 'dedup') {
    var result = deduplicateAddresses();
    return jsonResponse({ status: 'ok', removed: result.removed, kept: result.kept });
  }
  if (action === 'geocode') {
    var address = e.parameter.address;
    if (!address) return jsonResponse({ status: 'error', message: 'address required' });
    var existing = lookupAddress(address);
    if (existing) return jsonResponse({ status: 'ok', lat: existing.lat, lng: existing.lng });
    var apiKey = PropertiesService.getScriptProperties().getProperty('GOOGLE_MAPS_API_KEY');
    if (!apiKey) return jsonResponse({ status: 'error', message: 'GOOGLE_MAPS_API_KEY not set' });
    var geoUrl = 'https://maps.googleapis.com/maps/api/geocode/json?address=' + encodeURIComponent(address) + '&key=' + apiKey + '&language=ja&region=jp';
    var res = UrlFetchApp.fetch(geoUrl, { muteHttpExceptions: true });
    var geo = JSON.parse(res.getContentText());
    if (geo.status === 'OK' && geo.results && geo.results.length > 0) {
      var loc = geo.results[0].geometry.location;
      saveAddress(address, loc.lat, loc.lng);
      return jsonResponse({ status: 'ok', lat: loc.lat, lng: loc.lng });
    }
    return jsonResponse({ status: 'error', message: 'geocode failed: ' + geo.status });
  }
  return jsonResponse({ status: 'error', message: 'unknown action' });
}

function doPost(e) {
  var action = (e && e.parameter && e.parameter.action) ? e.parameter.action : '';
  if (action === 'save') {
    var body = JSON.parse(e.postData.contents);
    saveAddress(body.address, body.lat, body.lng);
    return jsonResponse({ status: 'ok' });
  }
  if (action === 'batchSave') {
    var body = JSON.parse(e.postData.contents);
    var count = batchSaveAddresses(body);
    return jsonResponse({ status: 'ok', count: count });
  }
  if (action === 'replaceAll') {
    var body = JSON.parse(e.postData.contents);
    var count = replaceAllAddresses(body);
    return jsonResponse({ status: 'ok', count: count });
  }
  if (action === 'batchUpdateCoords') {
    var body = JSON.parse(e.postData.contents);
    var count = batchUpdateCoords(body);
    return jsonResponse({ status: 'ok', count: count });
  }
  return jsonResponse({ status: 'error', message: 'unknown action' });
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getSheet() {
  Logger.log('SHEET_NAME=' + SHEET_NAME);
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(['住所', '緯度', '経度', '登録日']);
  }
  return sheet;
}

function buildIndex() {
  var sheet = getSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return {};
  var values = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
  var idx = {};
  for (var i = 0; i < values.length; i++) {
    var addr = String(values[i][0] || '').trim();
    if (!addr) continue;
    idx[normalizeAddress(addr)] = {
      row: i + 2,
      hasCoord: values[i][1] !== '' && values[i][2] !== ''
    };
  }
  return idx;
}

function lookupAddress(address) {
  var idx = buildIndex();
  var key = normalizeAddress(address);
  if (!idx[key]) return null;
  var row = idx[key].row;
  if (!idx[key].hasCoord) return null;
  var sheet = getSheet();
  var vals = sheet.getRange(row, 2, 1, 2).getValues()[0];
  return { lat: Number(vals[0]), lng: Number(vals[1]) };
}

function saveAddress(address, lat, lng) {
  if (!address) return;
  var sheet = getSheet();
  var idx = buildIndex();
  var key = normalizeAddress(address);
  if (idx[key] && idx[key].row > 1) {
    sheet.getRange(idx[key].row, 2, 1, 2).setValues([[lat, lng]]);
  } else {
    sheet.appendRow([address, lat, lng, nowJst()]);
  }
}

function batchSaveAddresses(entries) {
  if (!entries || Object.keys(entries).length === 0) return 0;
  var sheet = getSheet();
  var idx = buildIndex();
  var appends = [];
  var now = nowJst();

  for (var addr in entries) {
    var e = entries[addr];
    if (!addr || e === undefined) continue;
    var key = normalizeAddress(addr);
    var lat = (e && typeof e.lat === 'number') ? e.lat : ((e && e.lat) || '');
    var lng = (e && typeof e.lng === 'number') ? e.lng : ((e && e.lng) || '');

    if (idx[key] && idx[key].row > 1) {
      if (lat !== '' && lng !== '') {
        sheet.getRange(idx[key].row, 2, 1, 2).setValues([[lat, lng]]);
      }
    } else {
      appends.push([addr, lat, lng, now]);
    }
  }

  if (appends.length > 0) {
    var startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 1, appends.length, 4).setValues(appends);
  }

  return appends.length;
}

function replaceAllAddresses(entries) {
  if (!entries || Object.keys(entries).length === 0) return 0;
  var sheet = getSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, 4).clear();
  }
  var unique = {};
  for (var addr in entries) {
    var e = entries[addr];
    if (!addr || e === undefined) continue;
    var key = normalizeAddress(addr);
    var lat = (e && typeof e.lat === 'number') ? e.lat : ((e && e.lat) || '');
    var lng = (e && typeof e.lng === 'number') ? e.lng : ((e && e.lng) || '');
    var curHasCoord = lat !== '' && lng !== '';
    if (!unique[key] || curHasCoord) {
      unique[key] = { addr: addr, lat: lat, lng: lng };
    }
  }
  var rows = [];
  var now = nowJst();
  for (var key in unique) {
    rows.push([unique[key].addr, unique[key].lat, unique[key].lng, now]);
  }
  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, 4).setValues(rows);
  }
  return rows.length;
}

function batchUpdateCoords(entries) {
  if (!entries || Object.keys(entries).length === 0) return 0;
  var sheet = getSheet();
  var idx = buildIndex();
  var updated = 0;
  for (var addr in entries) {
    var e = entries[addr];
    if (!e || typeof e.lat !== 'number' || typeof e.lng !== 'number') continue;
    var key = normalizeAddress(addr);
    if (idx[key] && idx[key].row > 1) {
      sheet.getRange(idx[key].row, 2, 1, 2).setValues([[e.lat, e.lng]]);
      updated++;
    }
  }
  return updated;
}

function loadAllAddresses() {
  var sheet = getSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return {};
  var values = sheet.getRange(2, 1, lastRow - 1, 4).getValues();
  var result = {};
  for (var i = 0; i < values.length; i++) {
    var addr = String(values[i][0] || '').trim();
    if (!addr) continue;
    var hasCoord = values[i][1] !== '' && values[i][2] !== '';
    result[addr] = {
      lat: hasCoord ? Number(values[i][1]) : null,
      lng: hasCoord ? Number(values[i][2]) : null,
      registeredAt: values[i][3] || ''
    };
  }
  return result;
}

function loadPendingAddresses() {
  var sheet = getSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return {};
  var values = sheet.getRange(2, 1, lastRow - 1, 4).getValues();
  var result = {};
  for (var i = 0; i < values.length; i++) {
    var addr = String(values[i][0] || '').trim();
    if (!addr) continue;
    if (values[i][1] === '' || values[i][2] === '') {
      result[addr] = { lat: null, lng: null, registeredAt: values[i][3] || '' };
    }
  }
  return result;
}

function normalizeAddress(addr) {
  if (!addr) return '';
  return String(addr)
    .replace(/[０-９]/g, function(ch) { return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0); })
    .replace(/[Ａ-Ｚａ-ｚ]/g, function(ch) { return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0); })
    .replace(/[－‐―—−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function nowJst() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
}

function cleanAll() {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var keys = Object.keys(all);
  for (var i = 0; i < keys.length; i++) {
    if (keys[i] !== 'GOOGLE_MAPS_API_KEY') {
      props.deleteProperty(keys[i]);
    }
  }
  CacheService.getScriptCache().remove('addrIdx');
  CacheService.getScriptCache().remove('addrMasterIndex');
  Logger.log('削除完了: ' + keys.length + '件');
}

function deduplicateAddresses() {
  var sheet = getSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return { removed: 0, kept: 0 };
  var values = sheet.getRange(2, 1, lastRow - 1, 4).getValues();
  var seen = {};
  var rowsToDelete = [];

  for (var i = 0; i < values.length; i++) {
    var addr = normalizeAddress(String(values[i][0] || '').trim());
    if (!addr) {
      rowsToDelete.push(i + 2);
      continue;
    }
    if (seen[addr] !== undefined) {
      var prevIdx = seen[addr];
      var prevHasCoord = values[prevIdx][1] !== '' && values[prevIdx][2] !== '';
      var curHasCoord = values[i][1] !== '' && values[i][2] !== '';
      if (!prevHasCoord && curHasCoord) {
        rowsToDelete.push(prevIdx + 2);
        seen[addr] = i;
      } else {
        rowsToDelete.push(i + 2);
      }
    } else {
      seen[addr] = i;
    }
  }

  rowsToDelete.sort(function(a, b) { return b - a; });
  for (var i = 0; i < rowsToDelete.length; i++) {
    sheet.deleteRow(rowsToDelete[i]);
  }

  return { removed: rowsToDelete.length, kept: Object.keys(seen).length };
}
