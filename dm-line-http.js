/**
 * 個別LINE画像の配信と送信API。
 * 画像GETはLINEサーバが認証なしで取る。確認と送信は X-Proxy-Secret が必要。
 */
'use strict';

var express = require('express');
var DmLine = require('./dm-line-image.js');

function createRouter(service, opts) {
  opts = opts || {};
  var router = express.Router();

  function forbidden(req, res) {
    var secret = opts.proxySecret ? opts.proxySecret() : '';
    if (secret && req.get('x-proxy-secret') !== secret) {
      res.status(403).json({ status: 'error', message: 'Forbidden' });
      return true;
    }
    return false;
  }

  function origin(req) {
    if (opts.publicOriginFromRequest) return opts.publicOriginFromRequest(req);
    return DmLine.resolvePublicOrigin({
      host: req.get('x-forwarded-host') || req.get('host'),
      proto: req.get('x-forwarded-proto') || req.protocol
    });
  }

  router.post('/dm-line/review', async function (req, res) {
    if (forbidden(req, res)) return;
    try {
      res.json(await service.review(Object.assign({}, req.body || {}, { origin: origin(req) })));
    } catch (e) {
      res.status(500).json({ ok: false, sent: false, code: 'image_convert_failed', label: '画像変換失敗', viewed: false });
    }
  });

  router.post('/dm-line/send', async function (req, res) {
    if (forbidden(req, res)) return;
    try {
      res.json(await service.perform(Object.assign({}, req.body || {}, { origin: origin(req) })));
    } catch (e) {
      res.status(500).json({ ok: false, sent: false, code: 'line_send_failed', label: 'LINE送信失敗', viewed: false });
    }
  });

  router.get('/dm-line/retention', function (req, res) {
    if (forbidden(req, res)) return;
    res.json(Object.assign({ status: 'ok' }, service.retention()));
  });

  router.post('/dm-line/retention/revoke', function (req, res) {
    if (forbidden(req, res)) return;
    res.json(service.revoke((req.body || {}).imageSetId));
  });

  router.post('/dm-line/retention/confirm', function (req, res) {
    if (forbidden(req, res)) return;
    res.json(service.confirmRetention(req.body || {}));
  });

  router.post('/dm-line/production/unlock', function (req, res) {
    if (forbidden(req, res)) return;
    res.json(service.unlockProduction(req.body || {}));
  });

  function sendImage(req, res, kind) {
    var id = String(req.params.id || '');
    var page = String(req.params.page || '');
    var token = String(req.params.token || '');
    if (!/^[A-Za-z0-9_-]{16,}$/.test(id) || !/^[1-8]$/.test(page) || !/^[A-Za-z0-9_-]{40,}$/.test(token)) {
      return res.status(404).type('text/plain').send('not found');
    }
    var found = service.read(id, page, token, kind);
    if (!found) return res.status(404).type('text/plain').send('not found');
    res.set('Content-Type', found.mime);
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Disposition', 'inline; filename="page"');
    res.send(found.body);
  }

  router.get('/dm-line/file/:id/:page/:token', function (req, res) {
    sendImage(req, res, 'original');
  });
  router.get('/dm-line/preview/:id/:page/:token', function (req, res) {
    sendImage(req, res, 'preview');
  });

  return router;
}

function createDefaultService(hooks) {
  hooks = hooks || {};
  return DmLine.createService({
    liveSendEnabled: function () {
      var lineEnabled = hooks.lineEnabled ? hooks.lineEnabled() : false;
      return DmLine.liveSendAllowed(process.env.DM_IMAGE_LIVE_SEND, lineEnabled);
    },
    sendLine: hooks.sendLine,
    directory: hooks.directory,
    retentionTestLineId: process.env.DM_IMAGE_RETENTION_TEST_LINE_ID || '',
    pdfEnabled: process.env.DM_PDF_CONVERT === '1'
  });
}

module.exports = {
  createRouter: createRouter,
  createDefaultService: createDefaultService
};
