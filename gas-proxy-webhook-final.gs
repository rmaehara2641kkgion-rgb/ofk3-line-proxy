// ============================================================
// Google Apps Script: LINE Messaging API Proxy + Webhook
// LINE Webhook検証で必ず200を返す構成
// ============================================================

function setProperties() {
  PropertiesService.getScriptProperties().setProperties({
    CHANNEL_ACCESS_TOKEN: 'ここに長期トークンを貼り付ける',
    ADMIN_LINE_ID: 'U48be7d67e979988a2298c2b9b8cb8035'
  });
  Logger.log('Properties set: ' + JSON.stringify(PropertiesService.getScriptProperties().getProperties()));
}

function doGet(e) {
  const output = ContentService.createTextOutput(JSON.stringify({ status: 'ok' }));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

function doOptions(e) {
  const output = ContentService.createTextOutput(JSON.stringify({ status: 'ok' }));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

function doPost(e) {
  try {
    const props = PropertiesService.getScriptProperties();
    const token = props.getProperty('CHANNEL_ACCESS_TOKEN');
    const adminId = props.getProperty('ADMIN_LINE_ID');

    Logger.log('=== doPost called ===');
    Logger.log('postData exists: ' + !!((e && e.postData)));

    var rawContents = '{}';
    if (e && e.postData) {
      if (e.postData.contents) {
        rawContents = e.postData.contents;
      } else if (e.postData.getDataAsString) {
        rawContents = e.postData.getDataAsString();
      }
    }
    Logger.log('Raw contents: ' + rawContents);

    var parsed = null;
    try {
      parsed = JSON.parse(rawContents);
    } catch (err) {
      parsed = null;
    }

    // Webhookイベント処理
    if (parsed && parsed.events && Array.isArray(parsed.events)) {
      Logger.log('=== Webhook events received ===');
      parsed.events.forEach(function(event) {
        Logger.log('Event type: ' + event.type);
        Logger.log('Event source: ' + JSON.stringify(event.source));
        if (event.source && event.source.userId) {
          Logger.log('=== USER ID FOUND: ' + event.source.userId + ' ===');
          if (event.type === 'follow' && token) {
            sendWelcomeMessage(token, event.source.userId);
          }
        }
      });

      const output = ContentService.createTextOutput(JSON.stringify({ status: 'ok' }));
      output.setMimeType(ContentService.MimeType.JSON);
      return output;
    }

    // 通常proxy処理
    if (!token) {
      const output = ContentService.createTextOutput(JSON.stringify({ status: 'error', message: 'CHANNEL_ACCESS_TOKEN not set' }));
      output.setMimeType(ContentService.MimeType.JSON);
      return output;
    }

    var payload = parsed || {};
    const to = payload.to;
    const messages = payload.messages;

    if (!to || !messages || !Array.isArray(messages)) {
      const output = ContentService.createTextOutput(JSON.stringify({ status: 'error', message: 'Invalid payload. Required: to, messages[]' }));
      output.setMimeType(ContentService.MimeType.JSON);
      return output;
    }

    const target = to === '__admin__' ? adminId : to;
    if (!target) {
      const output = ContentService.createTextOutput(JSON.stringify({ status: 'error', message: 'Target not found' }));
      output.setMimeType(ContentService.MimeType.JSON);
      return output;
    }

    const linePayload = JSON.stringify({ to: target, messages: messages });
    const options = {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      payload: linePayload,
      muteHttpExceptions: true
    };

    Logger.log('LINE push target: ' + target);

    const response = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', options);
    const code = response.getResponseCode();
    const body = response.getContentText();

    Logger.log('LINE response code: ' + code);
    Logger.log('LINE response body: ' + body);

    const output = ContentService.createTextOutput(JSON.stringify(
      (code >= 200 && code < 300)
        ? { status: 'ok', lineStatus: code }
        : { status: 'error', lineStatus: code, lineBody: body }
    ));
    output.setMimeType(ContentService.MimeType.JSON);
    return output;
  } catch (err) {
    Logger.log('doPost error: ' + (err.message || String(err)));
    const output = ContentService.createTextOutput(JSON.stringify({ status: 'error', message: err.message || String(err) }));
    output.setMimeType(ContentService.MimeType.JSON);
    return output;
  }
}

function sendWelcomeMessage(token, userId) {
  try {
    const message = '友だち追加ありがとうございます。\n配送通知の設定は管理者画面から行ってください。';
    const options = {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      payload: JSON.stringify({
        to: userId,
        messages: [{ type: 'text', text: message }]
      }),
      muteHttpExceptions: true
    };
    UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', options);
  } catch (e) {
    Logger.log('Welcome message error: ' + e);
  }
}
