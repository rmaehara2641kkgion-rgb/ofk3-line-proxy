// ============================================================
// Google Apps Script: LINE Messaging API Proxy + Webhook
// 必ず200を返すように修正済み
// デプロイ方法:
//   1. GASエディタで既存コードを全部削除
//   2. このコードを貼り付け
//   3. setProperties() を実行（実行ボタン → 選択 → 実行）
//   4. デプロイ → 新しいデプロイ → Webアプリ
//      実行: 自分 / アクセスできるユーザー: 全員
//   5. 表示された /exec URLをLINE DevelopersのWebhook URLに設定
//   6. Webhookの利用をONにする
// ============================================================

function setProperties() {
  PropertiesService.getScriptProperties().setProperties({
    CHANNEL_ACCESS_TOKEN: 'ここに長期トークンを貼り付ける',
    ADMIN_LINE_ID: 'U48be7d67e979988a2298c2b9b8cb8035'
  });
  Logger.log('Properties set: ' + JSON.stringify(PropertiesService.getScriptProperties().getProperties()));
}

// LINE Webhook検証用: 常に200を返す
function doGet(e) {
  const output = ContentService.createTextOutput(JSON.stringify({ status: 'ok' }));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

// CORSプリフライト対応
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
    Logger.log('postData exists: ' + (e && e.postData ? 'yes' : 'no'));

    // Webhookイベント処理
    if (e && e.postData && e.postData.contents) {
      const raw = e.postData.contents;
      Logger.log('Raw payload: ' + raw);

      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch (parseErr) {
        Logger.log('JSON parse error: ' + parseErr);
        parsed = null;
      }

      if (parsed && parsed.events && Array.isArray(parsed.events)) {
        Logger.log('=== Webhook received ===');

        parsed.events.forEach(function(event) {
          Logger.log('Event type: ' + event.type);
          Logger.log('Event source: ' + JSON.stringify(event.source));

          if (event.source && event.source.userId) {
            Logger.log('=== USER ID FOUND: ' + event.source.userId + ' ===');

            // 友だち追加時に自動で挨拶メッセージを送る
            if (event.type === 'follow' && token) {
              sendWelcomeMessage(token, event.source.userId);
            }
          }
        });

        const output = ContentService.createTextOutput(JSON.stringify({ status: 'ok' }));
        output.setMimeType(ContentService.MimeType.JSON);
        return output;
      }
    }

    // 通常のLINE proxy処理
    if (!token) {
      const output = ContentService.createTextOutput(JSON.stringify({ status: 'error', message: 'CHANNEL_ACCESS_TOKEN not set' }));
      output.setMimeType(ContentService.MimeType.JSON);
      return output;
    }

    const rawContents = (e && e.postData && e.postData.contents) ? e.postData.contents : '{}';
    let payload = null;
    try {
      payload = JSON.parse(rawContents);
    } catch (parseErr) {
      const output = ContentService.createTextOutput(JSON.stringify({ status: 'error', message: 'Invalid JSON payload' }));
      output.setMimeType(ContentService.MimeType.JSON);
      return output;
    }

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
    Logger.log('LINE push payload: ' + linePayload);

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
