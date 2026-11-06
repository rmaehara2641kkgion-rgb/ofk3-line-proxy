/**
 * 個別LINE送信モーダルの画像添付。
 * 添付が無い送信は既存の sendDmMessage のまま。画像URLは本文へ入れない。
 */
(function (global) {
  var attachment = null;

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function headers() {
    return typeof getProxyHeaders === 'function' ? getProxyHeaders() : { 'Content-Type': 'application/json' };
  }

  function reset() {
    attachment = null;
    var input = document.getElementById('dm-attach-file');
    var box = document.getElementById('dm-attach-confirm');
    var preview = document.getElementById('dm-attach-preview');
    if (input) input.value = '';
    if (box) box.checked = false;
    if (preview) preview.innerHTML = '';
  }

  function hasAttachment() {
    return !!(attachment && attachment.imageSetId);
  }

  async function post(path, body) {
    var response = await fetch(path, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
    var payload = null;
    try { payload = await response.json(); } catch (e) { payload = null; }
    if (!response.ok || !payload) {
      return { ok: false, sent: false, code: 'line_send_failed', label: 'LINE送信失敗' };
    }
    return payload;
  }

  function readFile(file) {
    return new Promise(function (resolve) {
      var reader = new FileReader();
      reader.onload = function () {
        var text = String(reader.result || '');
        var comma = text.indexOf(',');
        resolve(comma >= 0 ? text.slice(comma + 1) : '');
      };
      reader.onerror = function () { resolve(''); };
      reader.readAsDataURL(file);
    });
  }

  function renderPreview(result) {
    var el = document.getElementById('dm-attach-preview');
    if (!el) return;
    if (!result) {
      el.innerHTML = '';
      return;
    }
    var name = typeof dmTargetDriver !== 'undefined' ? dmTargetDriver : '';
    var company = result.company || (typeof driverDepartments !== 'undefined' && driverDepartments[name]) || '所属未登録';
    var pages = (result.previews || []).map(function (page) {
      return '<figure class="mt-2"><figcaption class="text-xs text-ink-lighter">' + page.page + 'ページ / ' + page.width + '×' + page.height + '</figcaption>'
        + '<img alt="添付プレビュー ' + page.page + '" src="' + esc(page.previewImageUrl) + '" style="max-width:220px;border:1px solid #ddd"></figure>';
    }).join('');
    var message = document.getElementById('dm-message') ? document.getElementById('dm-message').value : '';
    el.innerHTML = '<div class="border border-border rounded p-2 text-xs">'
      + '<div><b>DA氏名</b> ' + esc(result.subjectName || name) + '</div>'
      + '<div><b>所属</b> ' + esc(company) + '</div>'
      + '<div><b>LINE</b> ' + esc(result.linkLabel || result.label || '') + '</div>'
      + '<div><b>本文</b><pre class="whitespace-pre-wrap">' + esc(message) + '</pre></div>'
      + '<div><b>ページ数</b> ' + esc(result.pageCount || 0) + '</div>'
      + pages
      + '</div>';
  }

  async function onFile(input) {
    var file = input && input.files && input.files[0];
    var resultEl = document.getElementById('dm-send-result');
    if (!file) return;
    var name = typeof dmTargetDriver !== 'undefined' ? dmTargetDriver : '';
    if (!name) {
      if (resultEl) resultEl.textContent = '先にドライバーを選択してください';
      input.value = '';
      return;
    }
    var fileBase64 = await readFile(file);
    var result = await post('/dm-line/review', {
      subjectName: name,
      confirmSubject: name,
      text: document.getElementById('dm-message') ? document.getElementById('dm-message').value : '',
      lineId: (typeof lineMapping !== 'undefined' && lineMapping[name]) || '',
      filename: file.name,
      fileBase64: fileBase64
    });
    if (result.code !== 'ready') {
      attachment = null;
      renderPreview(result);
      if (resultEl) resultEl.textContent = result.label || result.code;
      return;
    }
    attachment = result;
    renderPreview(result);
    if (resultEl) resultEl.textContent = '添付を確認してください。画像の本番送信は保持確認まで停止しています。';
  }

  async function sendFromModal() {
    var resultEl = document.getElementById('dm-send-result');
    var box = document.getElementById('dm-attach-confirm');
    if (!box || !box.checked) {
      if (resultEl) resultEl.textContent = '送信内容を確認してください';
      return;
    }
    if (!attachment || !attachment.imageSetId) return;
    var name = typeof dmTargetDriver !== 'undefined' ? dmTargetDriver : '';
    var locations = [];
    if (typeof dmGeoCache !== 'undefined' && dmGeoCache.gohai) {
      locations.push({ title: '回収先', address: dmGeoCache.gohai.address, latitude: dmGeoCache.gohai.lat, longitude: dmGeoCache.gohai.lng });
    }
    if (typeof dmGeoCache !== 'undefined' && dmGeoCache.seihaisou) {
      locations.push({ title: '正配送先', address: dmGeoCache.seihaisou.address, latitude: dmGeoCache.seihaisou.lat, longitude: dmGeoCache.seihaisou.lng });
    }
    var result = await post('/dm-line/send', {
      subjectName: name,
      confirmSubject: name,
      confirmed: true,
      text: document.getElementById('dm-message') ? document.getElementById('dm-message').value : '',
      lineId: (typeof lineMapping !== 'undefined' && lineMapping[name]) || '',
      imageSetId: attachment.imageSetId,
      locations: locations
    });
    if (resultEl) {
      resultEl.textContent = result.sent && result.code === 'line_accepted'
        ? 'LINE API受理（閲覧は未確認）'
        : (result.label || result.code || '未送信');
    }
  }

  global.DmLineClient = {
    reset: reset,
    hasAttachment: hasAttachment,
    onFile: onFile,
    clear: reset,
    sendFromModal: sendFromModal
  };
})(window);
