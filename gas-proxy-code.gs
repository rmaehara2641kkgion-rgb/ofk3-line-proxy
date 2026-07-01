// ============================================================
// Google Apps Script: LINE Messaging API CORS Proxy
// デプロイ方法: GASエディタ → 新規プロジェクト → このコードを貼り付け
//             → 拡張サービスでPropertiesServiceが有効になっていることを確認
//             → setProperties() を一度実行して TOKEN / ADMIN_ID を設定
//             → デプロイ → Webアプリとして公開（実行: 自分 / アクセス: 全員）
// ============================================================

// --- 初期設定用（ローカルHTMLやGAS実行ログから一度だけ実行）---
function setProperties() {
  // 必ず実際の値に置き換えてからGASで実行してください
  PropertiesService.getScriptProperties().setProperties({
    CHANNEL_ACCESS_TOKEN: 'YOUR_CHANNEL_ACCESS_TOKEN_HERE',
    ADMIN_LINE_ID: 'raizo0428gion'
  });
  Logger.log('Properties set: ' + JSON.stringify(PropertiesService.getScriptProperties().getProperties()));
}

function doGet(e) {
  var action = e.parameter && e.parameter.action;
  var userId = e.parameter && e.parameter.userId;

  if (action === 'getProfile' && userId) {
    return getLineProfile(userId);
  }

  return jsonResponse({ status: 'ok', message: 'LINE proxy is running' });
}

function doOptions(e) {
  return jsonResponse({ status: 'ok' });
}

function doPost(e) {
  try {
    const props = PropertiesService.getScriptProperties();
    const token = props.getProperty('CHANNEL_ACCESS_TOKEN');
    const adminId = props.getProperty('ADMIN_LINE_ID');

    if (!token) {
      return jsonResponse({ status: 'error', message: 'CHANNEL_ACCESS_TOKEN not set' }, 500);
    }

    const payload = JSON.parse(e.postData.contents || '{}');
    const to = payload.to;
    const messages = payload.messages;

    if (!to || !messages || !Array.isArray(messages)) {
      return jsonResponse({ status: 'error', message: 'Invalid payload. Required: to, messages[]' }, 400);
    }

    // 管理者IDをGAS側で上書き（オプション：セキュリティ強化）
    const target = to === '__admin__' ? adminId : to;
    if (!target) {
      return jsonResponse({ status: 'error', message: 'Target not found' }, 400);
    }

    const linePayload = JSON.stringify({ to: target, messages: messages });
    const options = {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      payload: linePayload,
      muteHttpExceptions: true
    };

    Logger.log('LINE push target: ' + target);
    Logger.log('LINE push payload: ' + linePayload);

    const response = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', options);
    const code = response.getResponseCode();
    const body = response.getContentText();

    Logger.log('LINE response code: ' + code);
    Logger.log('LINE response body: ' + body);

    if (code >= 200 && code < 300) {
      return jsonResponse({ status: 'ok', lineStatus: code });
    } else {
      return jsonResponse({ status: 'error', lineStatus: code, lineBody: body }, 502);
    }
  } catch (err) {
    return jsonResponse({ status: 'error', message: err.message || String(err) }, 500);
  }
}

function getLineProfile(userId) {
  if (!userId || userId.indexOf('U') !== 0) {
    return jsonResponse({ status: 'error', message: 'Invalid userId' }, 400);
  }

  var cache = CacheService.getScriptCache();
  var cacheKey = 'line_profile_' + userId;
  var cached = cache.get(cacheKey);

  if (cached) {
    return jsonResponse(JSON.parse(cached));
  }

  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('CHANNEL_ACCESS_TOKEN');

  if (!token) {
    return jsonResponse({ status: 'error', message: 'CHANNEL_ACCESS_TOKEN not set' }, 500);
  }

  var url = 'https://api.line.me/v2/bot/profile/' + encodeURIComponent(userId);
  var options = {
    method: 'GET',
    headers: {
      'Authorization': 'Bearer ' + token
    },
    muteHttpExceptions: true
  };

  try {
    var response = UrlFetchApp.fetch(url, options);
    var code = response.getResponseCode();
    var body = response.getContentText();

    if (code < 200 || code >= 300) {
      return jsonResponse({ status: 'error', lineStatus: code, lineBody: body }, 502);
    }

    var data = JSON.parse(body);
    var profile = {
      userId: data.userId || userId,
      displayName: data.displayName || '',
      pictureUrl: data.pictureUrl || '',
      statusMessage: data.statusMessage || ''
    };

    cache.put(cacheKey, JSON.stringify(profile), 21600); // 6 hours
    return jsonResponse(profile);
  } catch (err) {
    return jsonResponse({ status: 'error', message: err.message || String(err) }, 500);
  }
}

function jsonResponse(obj, statusCode) {
  statusCode = statusCode || 200;
  var output = ContentService.createTextOutput(JSON.stringify(obj));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

// ============================================================
// 注意：GASのWebアプリはデフォルトでCORSを許可しています。
// デプロイ時は「アクセスできるユーザー: 全員」に設定してください。
// ============================================================
