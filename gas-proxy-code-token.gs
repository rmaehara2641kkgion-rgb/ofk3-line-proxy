// ============================================================
// Google Apps Script: LINE Messaging API CORS Proxy
// デプロイ方法: GASエディタ → 新規プロジェクト → このコードを貼り付け
//             → setProperties() を一度実行
//             → デプロイ → Webアプリとして公開（実行: 自分 / アクセス: 全員）
// ============================================================

function setProperties() {
  PropertiesService.getScriptProperties().setProperties({
    CHANNEL_ACCESS_TOKEN: '2010481323',
    ADMIN_LINE_ID: 'raizo0428gion'
  });
  Logger.log('Properties set: ' + JSON.stringify(PropertiesService.getScriptProperties().getProperties()));
}

function doGet(e) {
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

function jsonResponse(obj, statusCode) {
  const output = ContentService.createTextOutput(JSON.stringify(obj));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

// ============================================================
// 注意：GASのWebアプリはデフォルトでCORSを許可しています。
// デプロイ時は「アクセスできるユーザー: 全員」に設定してください。
// ============================================================
