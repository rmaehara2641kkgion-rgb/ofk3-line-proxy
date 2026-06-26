// ============================================================
// Google Apps Script: LINE Messaging API Proxy + Webhook
// デプロイ方法: GASエディタ → 新規プロジェクト → このコードを貼り付け
//             → setProperties() を一度実行
//             → デプロイ → Webアプリとして公開（実行: 自分 / アクセス: 全員）
//             → LINE Developers の Webhook URL にGAS URLを設定
// ============================================================

function setProperties() {
  PropertiesService.getScriptProperties().setProperties({
    CHANNEL_ACCESS_TOKEN: 'ここに長期トークンを貼り付ける',
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

    // まずWebhookイベントとしてパースを試みる
    if (e.postData && e.postData.contents) {
      let parsed;
      try {
        parsed = JSON.parse(e.postData.contents);
      } catch (parseErr) {
        parsed = null;
      }

      if (parsed && parsed.events && Array.isArray(parsed.events)) {
        Logger.log('=== Webhook received ===');
        Logger.log('Payload: ' + e.postData.contents);

        parsed.events.forEach(event => {
          Logger.log('Event type: ' + event.type);
          Logger.log('Event source: ' + JSON.stringify(event.source));

          if (event.source && event.source.userId) {
            Logger.log('=== USER ID FOUND: ' + event.source.userId + ' ===');

            // 友だち追加時に自動で挨拶メッセージを送る（任意）
            if (event.type === 'follow' && token) {
              sendWelcomeMessage(token, event.source.userId);
            }
          }
        });

        return jsonResponse({ status: 'ok' });
      }
    }

    // 通常のLINE proxy処理
    if (!token) {
      return jsonResponse({ status: 'error', message: 'CHANNEL_ACCESS_TOKEN not set' }, 500);
    }

    let payload;
    try {
      payload = JSON.parse(e.postData.contents || '{}');
    } catch (parseErr) {
      return jsonResponse({ status: 'error', message: 'Invalid JSON payload' }, 400);
    }

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

function sendWelcomeMessage(token, userId) {
  try {
    const message = '友だち追加ありがとうございます。\n配送通知の設定は管理者画面から行ってください。';
    const options = {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
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

function jsonResponse(obj, statusCode) {
  const output = ContentService.createTextOutput(JSON.stringify(obj));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

// ============================================================
// 注意：GASのWebアプリはデフォルトでCORSを許可しています。
// デプロイ時は「アクセスできるユーザー: 全員」に設定してください。
// ============================================================
