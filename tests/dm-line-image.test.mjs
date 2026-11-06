import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import express from 'express';
import PDFDocument from 'pdfkit';
import { spawnSync } from 'node:child_process';
import http from 'node:http';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const Dm = require(join(root, 'dm-line-image.js'));
const Http = require(join(root, 'dm-line-http.js'));
const Guard = require(join(root, 'api-guard.js'));
const { createCanvas } = require('@napi-rs/canvas');

const LINE_ID = 'U' + 'a'.repeat(32);
const OTHER_ID = 'U' + 'b'.repeat(32);
const indexSrc = readFileSync(join(root, 'index.html'), 'utf8');
const serverSrc = readFileSync(join(root, 'render-webhook-server.js'), 'utf8');
const imageSrc = readFileSync(join(root, 'dm-line-image.js'), 'utf8');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function jpeg() {
  const canvas = createCanvas(40, 40);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 40, 40);
  ctx.fillStyle = '#111111';
  ctx.fillRect(8, 8, 20, 20);
  return canvas.toBuffer('image/jpeg');
}

function png() {
  const canvas = createCanvas(30, 30);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#00aa00';
  ctx.fillRect(0, 0, 30, 30);
  return canvas.toBuffer('image/png');
}

function pdf(pages) {
  const doc = new PDFDocument({ size: 'A4' });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolve) => doc.on('end', resolve));
  for (let i = 0; i < pages; i++) {
    if (i) doc.addPage();
    doc.fontSize(18).text('page ' + (i + 1));
  }
  doc.end();
  return done.then(() => Buffer.concat(chunks));
}

function service(extra) {
  const calls = [];
  const api = Dm.createService(Object.assign({
    retentionConfirmed: true,
    productionUnlocked: true,
    directory: async () => [{ key: '山田 太郎', japaneseName: '山田 太郎', company: '福岡', lineId: LINE_ID }],
    liveSendEnabled: () => true,
    sendLine: async (to, messages) => {
      calls.push({ to, messages });
      return { status: 200, data: {} };
    }
  }, extra || {}));
  return { api, calls };
}

function input(extra) {
  return Object.assign({
    subjectName: '山田 太郎',
    confirmSubject: '山田 太郎',
    confirmed: true,
    origin: 'https://ofk3-line-proxy-1.onrender.com'
  }, extra);
}

assert.equal(Dm.liveSendAllowed('1', true), true);
assert.equal(Dm.liveSendAllowed('1', false), false);
assert.equal(Dm.liveSendAllowed('true', true), false);
assert.equal(Dm.sniff(Buffer.from([0xFF, 0xD8, 0xFF, 0x00, 0, 0, 0, 0])), 'image/jpeg');
assert.equal(Guard.groupOf('POST', '/dm-line/send'), 'line-send');
assert.equal(Guard.groupOf('POST', '/dm-line/production/unlock'), 'line-send');
assert.equal(Guard.groupOf('GET', '/dm-line/file/abc/1/' + 'a'.repeat(43)), null);
assert.equal(Guard.groupOf('POST', '/proxy'), 'line-send');
assert.match(serverSrc, /DM_IMAGE_LIVE_SEND/);
assert.match(serverSrc, /DM_PDF_CONVERT/);
assert.match(serverSrc, /app\.post\('\/proxy'/);
assert.doesNotMatch(serverSrc, /billing-image/);
assert.doesNotMatch(serverSrc, /@napi-rs\/canvas|pdfjs-dist/);
assert.doesNotMatch(imageSrc, /@napi-rs\/canvas|pdfjs-dist/);
assert.equal(pkg.dependencies['@napi-rs/canvas'], undefined);
assert.equal(pkg.dependencies['pdfjs-dist'], undefined);
assert.equal(pkg.optionalDependencies['@napi-rs/canvas'], '0.1.80');
assert.equal(pkg.optionalDependencies['pdfjs-dist'], '3.11.174');

const sendStart = indexSrc.indexOf('async function sendDmMessage');
const sendFn = indexSrc.slice(sendStart, indexSrc.indexOf('function toggleBulkLinePanel', sendStart));
assert.match(sendFn, /DmLineClient\.hasAttachment\(\)/);
assert.match(sendFn, /fetch\(proxyUrl/);
assert.doesNotMatch(sendFn, /originalContentUrl/);

const textOnly = service();
const textSent = await textOnly.api.perform(input({ text: '本日の連絡です' }));
assert.equal(textSent.code, 'line_accepted');
assert.equal(textSent.sent, true);
assert.equal(textOnly.calls.length, 1);
assert.equal(textOnly.calls[0].to, LINE_ID);
assert.equal(textOnly.calls[0].messages.length, 1);
assert.equal(textOnly.calls[0].messages[0].type, 'text');
assert.doesNotMatch(textOnly.calls[0].messages[0].text, /https?:\/\//);

const jpg = jpeg();
const imageService = service();
const jpgReview = await imageService.api.review(input({ bytes: jpg, filename: 'note.jpg' }));
assert.equal(jpgReview.code, 'ready');
assert.equal(jpgReview.pageCount, 1);
assert.equal(jpgReview.company, '福岡');
assert.equal(jpgReview.sent, false);
assert.equal(jpgReview.previews[0].width, 40);
assert.equal(jpgReview.previews[0].height, 40);
assert.equal(jpgReview.previews[0].originalBytes, jpg.length);
assert.equal(jpgReview.previews[0].previewBytes, jpg.length);
assert.equal(JSON.stringify(jpgReview).includes('/dm-line/file/'), false);
const jpgSent = await imageService.api.perform(input({ text: '', imageSetId: jpgReview.imageSetId }));
assert.equal(jpgSent.code, 'line_accepted');
assert.equal(jpgSent.viewed, false);
assert.equal(imageService.calls[0].messages[0].type, 'image');
assert.match(imageService.calls[0].messages[0].originalContentUrl, /^https:\/\//);
assert.ok(!imageService.calls[0].messages.some((message) => message.type === 'text'));

const both = service();
const pngBytes = png();
const bothReview = await both.api.review(input({ bytes: pngBytes, filename: 'note.png' }));
assert.equal(bothReview.pageCount, 1);
assert.equal(bothReview.previews[0].mime, 'image/png');
assert.equal(bothReview.previews[0].width, 30);
assert.equal(bothReview.previews[0].height, 30);
const bothSent = await both.api.perform(input({ text: '画像を見てください', imageSetId: bothReview.imageSetId }));
assert.equal(bothSent.code, 'line_accepted');
assert.equal(both.calls[0].messages[0].type, 'text');
assert.equal(both.calls[0].messages[0].text, '画像を見てください');
assert.equal(both.calls[0].messages[1].type, 'image');
assert.doesNotMatch(both.calls[0].messages[0].text, /dm-line/);

assert.equal(Object.keys(require.cache).some((key) => key.includes('pdfjs-dist') || key.includes('dm-line-pdf.js')), false);
const stagedPdf = await service().api.review(input({ bytes: Buffer.from('%PDF-1.7\n%stage\n') }));
assert.equal(stagedPdf.code, 'pdf_unavailable');
assert.match(stagedPdf.label, /JPEGまたはPNG/);
const missingLib = service({
  pdfEnabled: true,
  renderPdf: async () => {
    const error = new Error('missing');
    error.code = 'pdf_unavailable';
    throw error;
  }
});
const missingPdf = await missingLib.api.review(input({ bytes: Buffer.from('%PDF-1.7\n%stage\n') }));
assert.equal(missingPdf.code, 'pdf_unavailable');
const stillJpg = await missingLib.api.review(input({ bytes: jpg }));
assert.equal(stillJpg.code, 'ready');

const overPreview = Buffer.alloc(Dm.PREVIEW_MAX + 1, 0x11);
overPreview[0] = 0xFF;
overPreview[1] = 0xD8;
overPreview[2] = 0xFF;
const overPreviewResult = await service().api.review(input({ bytes: overPreview }));
assert.equal(overPreviewResult.code, 'size_exceeded');
assert.match(overPreviewResult.label, /1MB/);

const fakeJpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0x00, 1, 2, 3, 4, 5, 6, 7, 8]);
assert.equal((await service().api.review(input({ bytes: fakeJpeg }))).code, 'invalid_file');

const plainHttp = service();
const plainReview = await plainHttp.api.review(input({ bytes: jpg, origin: 'http://ofk3-line-proxy-1.onrender.com' }));
assert.equal(plainReview.code, 'ready');
const plainSend = await plainHttp.api.perform(input({ imageSetId: plainReview.imageSetId, origin: 'http://ofk3-line-proxy-1.onrender.com' }));
assert.equal(plainSend.code, 'insecure_delivery');
assert.equal(plainHttp.calls.length, 0);

let clock = Date.parse('2026-11-06T01:00:00Z');
const expiring = service({ now: () => new Date(clock), ttlMs: 1000 });
const expReview = await expiring.api.review(input({ bytes: jpg }));
const expToken = new URL(expReview.previews[0].previewImageUrl).pathname.split('/').pop();
assert.ok(expiring.api.read(expReview.imageSetId, 1, expToken, 'preview'));
clock += 1001;
assert.equal(expiring.api.read(expReview.imageSetId, 1, expToken, 'preview'), null);
const late = await expiring.api.perform(input({ imageSetId: expReview.imageSetId }));
assert.equal(late.code, 'image_fetch_failed');
assert.equal(expiring.calls.length, 0);

const stopped = service({ liveSendEnabled: () => false });
const stoppedReview = await stopped.api.review(input({ bytes: jpg }));
const stoppedSend = await stopped.api.perform(input({ imageSetId: stoppedReview.imageSetId }));
assert.equal(stoppedSend.code, 'live_send_disabled');
assert.equal(stopped.calls.length, 0);

const testId = 'U' + 'c'.repeat(32);
const trial = service({
  retentionConfirmed: false,
  productionUnlocked: false,
  retentionTestLineId: testId,
  directory: async () => [{ key: '山田 太郎', japaneseName: '山田 太郎', company: '福岡', lineId: testId }]
});
const trialReview = await trial.api.review(input({ bytes: jpg }));
const trialSend = await trial.api.perform(input({ imageSetId: trialReview.imageSetId }));
assert.equal(trialSend.code, 'line_accepted');
assert.equal(trial.calls[0].to, testId);
assert.equal(trial.api.retention().confirmed, false);
assert.equal(trial.api.confirmRetention({ imageSetId: trialReview.imageSetId, visualCheck: true }).code, 'retention_unconfirmed');
assert.equal(trial.api.revoke(trialReview.imageSetId).code, 'revoked');
assert.equal(trial.api.read(trialReview.imageSetId, 1, 'token-token-token-token-token-token-token', 'original'), null);
assert.equal(trial.api.confirmRetention({ imageSetId: trialReview.imageSetId, visualCheck: true }).code, 'retention_confirmed');
assert.equal(trial.api.retention().confirmed, true);
assert.equal(trial.api.retention().productionUnlocked, false);
assert.equal(trial.api.retention().imageSendEnabled, false);

const gate = service({
  retentionConfirmed: false,
  productionUnlocked: false,
  retentionTestLineId: testId,
  directory: async () => [
    { key: '試験アカウント', japaneseName: '試験アカウント', company: '試験', lineId: testId },
    { key: '本番 花子', japaneseName: '本番 花子', company: '福岡', lineId: LINE_ID }
  ]
});
const prodReview = await gate.api.review(input({ bytes: jpg, subjectName: '本番 花子', confirmSubject: '本番 花子', lineId: testId }));
assert.equal(prodReview.code, 'mismatch');
assert.equal(gate.calls.length, 0);
const prodSilent = await gate.api.review(input({ bytes: jpg, subjectName: '本番 花子', confirmSubject: '本番 花子' }));
assert.equal(prodSilent.code, 'ready');
const prodSend = await gate.api.perform(input({ subjectName: '本番 花子', confirmSubject: '本番 花子', imageSetId: prodSilent.imageSetId }));
assert.equal(prodSend.code, 'retention_unconfirmed');
assert.equal(gate.calls.length, 0);
const testReview = await gate.api.review(input({ bytes: jpg, subjectName: '試験アカウント', confirmSubject: '試験アカウント' }));
const testSent = await gate.api.perform(input({ subjectName: '試験アカウント', confirmSubject: '試験アカウント', imageSetId: testReview.imageSetId }));
assert.equal(testSent.code, 'line_accepted');
assert.equal(gate.calls[0].to, testId);
assert.equal(gate.api.unlockProduction({ unlockProduction: true }).code, 'retention_unconfirmed');
gate.api.revoke(testReview.imageSetId);
assert.equal(gate.api.confirmRetention({ imageSetId: testReview.imageSetId, visualCheck: true }).code, 'retention_confirmed');
const stillLocked = await gate.api.perform(input({ subjectName: '本番 花子', confirmSubject: '本番 花子', imageSetId: prodSilent.imageSetId }));
assert.equal(stillLocked.code, 'production_locked');
assert.equal(gate.calls.length, 1);
assert.equal(gate.api.unlockProduction({}).code, 'production_locked');
assert.equal(gate.api.unlockProduction({ unlockProduction: true }).code, 'production_unlocked');
const unlocked = await gate.api.perform(input({ subjectName: '本番 花子', confirmSubject: '本番 花子', imageSetId: prodSilent.imageSetId }));
assert.equal(unlocked.code, 'line_accepted');
assert.equal(gate.calls[1].to, LINE_ID);

const onePdf = await pdf(1);
const pdfService = service({ pdfEnabled: true });
const oneReview = await pdfService.api.review(input({ bytes: onePdf, filename: 'one.pdf' }));
assert.equal(oneReview.code, 'ready');
assert.equal(oneReview.pageCount, 1);
const oneSent = await pdfService.api.perform(input({ text: '1ページ', imageSetId: oneReview.imageSetId }));
assert.equal(oneSent.code, 'line_accepted');
assert.equal(pdfService.calls[0].messages.filter((message) => message.type === 'image').length, 1);
assert.equal(Object.keys(require.cache).some((key) => key.includes('pdfjs-dist') || key.includes('dm-line-pdf.js')), false);

const twoPdf = await pdf(2);
let mode = 'fail-second';
const partialCalls = [];
const partial = Dm.createService({
  retentionConfirmed: true,
  productionUnlocked: true,
  pdfEnabled: true,
  maxPerPush: 2,
  directory: async () => [{ key: '山田 太郎', japaneseName: '山田 太郎', company: '福岡', lineId: LINE_ID }],
  liveSendEnabled: () => true,
  sendLine: async (to, messages) => {
    partialCalls.push({ to, messages });
    if (mode === 'fail-second' && partialCalls.length === 2) {
      const error = new Error('line down');
      error.response = { status: 502, data: {} };
      throw error;
    }
    return { status: 200, data: {} };
  }
});
const twoReview = await partial.review(input({ bytes: twoPdf, filename: 'two.pdf' }));
assert.equal(twoReview.pageCount, 2);
const failed = await partial.perform(input({ text: '複数ページ', imageSetId: twoReview.imageSetId }));
assert.equal(failed.code, 'line_send_failed');
assert.equal(failed.sent, false);
assert.equal(partialCalls.length, 2);
const held = await partial.perform(input({ text: '複数ページ', imageSetId: twoReview.imageSetId }));
assert.equal(held.code, 'partial_hold');
assert.equal(partialCalls.length, 2);
mode = 'on';
const retried = await partial.perform(input({
  text: '複数ページ',
  imageSetId: twoReview.imageSetId,
  resend: true,
  confirmResend: true
}));
assert.equal(retried.code, 'line_accepted');
const retriedImages = partialCalls.slice(2).flatMap((call) => call.messages.filter((message) => message.type === 'image'));
assert.equal(retriedImages.length, 1);
assert.equal(new URL(retriedImages[0].originalContentUrl).pathname.split('/')[4], '2');

const unknownCalls = [];
const unknown = Dm.createService({
  retentionConfirmed: true,
  productionUnlocked: true,
  pdfEnabled: true,
  maxPerPush: 1,
  directory: async () => [{ key: '山田 太郎', japaneseName: '山田 太郎', company: '福岡', lineId: LINE_ID }],
  liveSendEnabled: () => true,
  sendLine: async (to, messages) => {
    unknownCalls.push(messages);
    if (unknownCalls.length === 2) {
      const error = new Error('timeout');
      error.code = 'ECONNABORTED';
      throw error;
    }
    return { status: 200, data: {} };
  }
});
const unknownReview = await unknown.review(input({ bytes: twoPdf, filename: 'two.pdf' }));
const unknownResult = await unknown.perform(input({ imageSetId: unknownReview.imageSetId }));
assert.equal(unknownResult.code, 'delivery_unknown');
assert.equal(unknownResult.viewed, false);
assert.deepEqual(unknownResult.acceptedPages, [1]);
assert.deepEqual(unknownResult.uncertainPages, [2]);
assert.equal(new URL(unknownCalls[0][0].originalContentUrl).pathname.split('/')[4], '1');
const heldUnknown = await unknown.perform(input({ imageSetId: unknownReview.imageSetId, resend: true, confirmResend: true }));
assert.equal(heldUnknown.code, 'delivery_unknown');
assert.equal(unknownCalls.length, 2);
const confirmedUnknown = await unknown.perform(input({
  imageSetId: unknownReview.imageSetId,
  resend: true,
  confirmResend: true,
  confirmUnknown: true
}));
assert.equal(confirmedUnknown.code, 'line_accepted');
assert.equal(unknownCalls.length, 3);
assert.equal(new URL(unknownCalls[2][0].originalContentUrl).pathname.split('/')[4], '2');

const mismatch = service();
const mismatchReview = await mismatch.api.review(input({ bytes: jpg, lineId: OTHER_ID }));
assert.equal(mismatchReview.code, 'mismatch');
assert.equal(mismatch.calls.length, 0);

const unlinked = service({
  directory: async () => [{ key: '山田 太郎', japaneseName: '山田 太郎', company: '福岡', lineId: '' }]
});
const unlinkedResult = await unlinked.api.review(input({ bytes: jpg }));
assert.equal(unlinkedResult.code, 'unlinked');

const invalid = service();
const invalidResult = await invalid.api.review(input({ bytes: Buffer.from('this is not an image or pdf') }));
assert.equal(invalidResult.code, 'invalid_file');

const tooBig = service();
const big = Buffer.alloc(6 * 1024 * 1024 + 1, 0xFF);
big[0] = 0xFF;
big[1] = 0xD8;
big[2] = 0xFF;
const bigResult = await tooBig.api.review(input({ bytes: big }));
assert.equal(bigResult.code, 'size_exceeded');
assert.equal(tooBig.calls.length, 0);

const apiError = service({
  sendLine: async () => {
    const error = new Error('bad request');
    error.response = { status: 400, data: { message: 'fail' } };
    throw error;
  }
});
const apiReview = await apiError.api.review(input({ bytes: jpg }));
const apiFailed = await apiError.api.perform(input({ imageSetId: apiReview.imageSetId }));
assert.equal(apiFailed.code, 'line_send_failed');
assert.equal(apiFailed.sent, false);

const skipped = service({
  sendLine: async () => ({ status: 200, data: { lineSkipped: true } })
});
const skippedReview = await skipped.api.review(input({ bytes: jpg }));
const skippedSend = await skipped.api.perform(input({ imageSetId: skippedReview.imageSetId }));
assert.equal(skippedSend.code, 'line_skipped');
assert.equal(skippedSend.sent, false);

const closed = service({ retentionConfirmed: false, liveSendEnabled: () => true });
const closedReview = await closed.api.review(input({ bytes: jpg }));
assert.equal(closedReview.code, 'ready');
const closedSend = await closed.api.perform(input({ imageSetId: closedReview.imageSetId }));
assert.equal(closedSend.code, 'retention_unconfirmed');
assert.equal(closed.calls.length, 0);

const missing = service();
const missingSend = await missing.api.perform(input({ imageSetId: 'missing-image-set-id' }));
assert.equal(missingSend.code, 'image_fetch_failed');
assert.equal(missing.calls.length, 0);

const app = express();
app.use(express.json({ limit: '10mb' }));
const served = service();
app.use(Http.createRouter(served.api, { proxySecret: () => 'test-secret' }));
const httpServer = await new Promise((resolve) => {
  const handle = app.listen(0, '127.0.0.1', () => resolve(handle));
});
const port = httpServer.address().port;
const servedReview = await served.api.review(input({ bytes: jpg }));
const previewPath = new URL(servedReview.previews[0].previewImageUrl).pathname;
const preview = await fetch('http://127.0.0.1:' + port + previewPath);
const previewBytes = Buffer.from(await preview.arrayBuffer());
assert.equal(preview.status, 200);
assert.equal(preview.headers.get('content-type'), 'image/jpeg');
assert.equal(preview.headers.get('cache-control'), 'private, no-store');
assert.equal(preview.headers.get('x-content-type-options'), 'nosniff');
assert.deepEqual(previewBytes, jpg);
const filePath = previewPath.replace('/preview/', '/file/');
const original = await fetch('http://127.0.0.1:' + port + filePath);
assert.equal(original.status, 200);
assert.equal(original.headers.get('content-type'), 'image/jpeg');
assert.deepEqual(Buffer.from(await original.arrayBuffer()), jpg);
const pngReview = await served.api.review(input({ bytes: pngBytes }));
const pngPath = new URL(pngReview.previews[0].previewImageUrl).pathname;
const pngResponse = await fetch('http://127.0.0.1:' + port + pngPath);
assert.equal(pngResponse.status, 200);
assert.equal(pngResponse.headers.get('content-type'), 'image/png');
assert.deepEqual(Buffer.from(await pngResponse.arrayBuffer()), pngBytes);
const expired = await fetch('http://127.0.0.1:' + port + previewPath.replace(/\/[^/]+$/, '/wrong-token-wrong-token-wrong-token-wrong'));
assert.equal(expired.status, 404);
const hidden = await fetch('http://127.0.0.1:' + port + '/dm-line/retention');
assert.equal(hidden.status, 403);
httpServer.close();

const TestServer = require(join(root, 'scripts', 'dm-line-test-server.js'));
assert.match(TestServer.refusalReason({ RENDER: 'true', DM_IMAGE_RETENTION_TEST_LINE_ID: testId }), /Render/);
assert.match(TestServer.refusalReason({ NODE_ENV: 'production', DM_IMAGE_RETENTION_TEST_LINE_ID: testId }), /production/);
assert.equal(TestServer.refusalReason({ DM_PDF_CONVERT: '1', DM_IMAGE_RETENTION_TEST_LINE_ID: testId }), '');
assert.match(TestServer.refusalReason({}), /LINE ID/);
assert.equal(Dm.singleTestDirectory(testId).length, 1);
assert.equal(Dm.singleTestDirectory(testId)[0].lineId, testId);
assert.throws(() => Dm.singleTestDirectory('U' + 'a'.repeat(31)), /test line id/);
const started = await TestServer.listen({ DM_IMAGE_RETENTION_TEST_LINE_ID: testId }, 0);
const testBase = 'http://127.0.0.1:' + started.port;
const adminHeaders = { 'Content-Type': 'application/json', 'X-Test-Admin-Token': started.adminToken };
const noToken = await fetch(testBase + '/dm-line/test-status');
assert.equal(noToken.status, 403);
const testStatus = await fetch(testBase + '/dm-line/test-status', { headers: adminHeaders }).then((response) => response.json());
assert.equal(testStatus.directoryCount, 1);
assert.equal(testStatus.pdfEnabled, true);
assert.equal(testStatus.sendCalls, 0);
assert.equal(testStatus.productionUnlocked, false);
assert.equal(testStatus.sendEnabled, false);
assert.equal(testStatus.sameProcess, true);
const originSet = await fetch(testBase + '/dm-line/test-origin', {
  method: 'POST',
  headers: adminHeaders,
  body: JSON.stringify({ origin: 'https://abcd.trycloudflare.com/ignored' })
});
assert.equal(originSet.status, 400);
const prodOrigin = await fetch(testBase + '/dm-line/test-origin', {
  method: 'POST',
  headers: adminHeaders,
  body: JSON.stringify({ origin: 'https://ofk3-line-proxy-1.onrender.com' })
});
assert.equal(prodOrigin.status, 400);
const originOk = await fetch(testBase + '/dm-line/test-origin', {
  method: 'POST',
  headers: adminHeaders,
  body: JSON.stringify({ origin: 'https://abcd.trycloudflare.com' })
}).then((response) => response.json());
assert.equal(originOk.publicOrigin, 'https://abcd.trycloudflare.com');
assert.equal(originOk.pid, testStatus.pid);
assert.equal(originOk.nonce, testStatus.nonce);
const earlySend = await fetch(testBase + '/dm-line/send', {
  method: 'POST',
  headers: adminHeaders,
  body: JSON.stringify({ subjectName: '試験アカウント', confirmSubject: '試験アカウント', confirmed: true, text: 'まだ' })
}).then((response) => response.json());
assert.equal(earlySend.code, 'live_send_disabled');
const hostedReview = await fetch(testBase + '/dm-line/review', {
  method: 'POST',
  headers: adminHeaders,
  body: JSON.stringify({
    subjectName: '試験アカウント',
    confirmSubject: '試験アカウント',
    origin: 'http://evil.example',
    fileBase64: jpg.toString('base64')
  })
}).then((response) => response.json());
assert.equal(hostedReview.code, 'ready');
assert.match(hostedReview.previews[0].previewImageUrl, /^https:\/\/abcd\.trycloudflare\.com\/dm-line\/preview\//);
const hostedPath = new URL(hostedReview.previews[0].previewImageUrl).pathname;
function requestHost(path, host) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: started.port, path, method: 'GET', headers: { Host: host } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}
const sameProcessImage = await requestHost(hostedPath, 'abcd.trycloudflare.com');
assert.equal(sameProcessImage.status, 200);
assert.deepEqual(sameProcessImage.body, jpg);
const badToken = await requestHost(hostedPath.replace(/\/[^/]+$/, '/' + 'w'.repeat(43)), 'abcd.trycloudflare.com');
assert.equal(badToken.status, 404);
const publicStatus = await requestHost('/dm-line/test-status', 'abcd.trycloudflare.com');
assert.equal(publicStatus.status, 403);
const spoofed = await new Promise((resolve, reject) => {
  const req = http.request({
    hostname: '127.0.0.1',
    port: started.port,
    path: '/dm-line/send',
    method: 'POST',
    headers: {
      Host: '127.0.0.1',
      'CF-Connecting-IP': '203.0.113.8',
      'X-Test-Admin-Token': started.adminToken,
      'Content-Type': 'application/json',
      'Content-Length': 2
    }
  }, (res) => {
    res.resume();
    res.on('end', () => resolve(res.statusCode));
  });
  req.on('error', reject);
  req.end('{}');
});
assert.equal(spoofed, 403);
const wrongHost = await requestHost('/dm-line/test-status', 'evil.example');
assert.equal(wrongHost.status, 403);
const unlock = await fetch(testBase + '/dm-line/production/unlock', {
  method: 'POST',
  headers: adminHeaders,
  body: JSON.stringify({ unlockProduction: true })
});
assert.equal(unlock.status, 403);
assert.equal((await unlock.json()).code, 'production_locked');
const afterUnlock = await fetch(testBase + '/dm-line/test-status', { headers: adminHeaders }).then((response) => response.json());
assert.equal(afterUnlock.productionUnlocked, false);
assert.equal(afterUnlock.nonce, testStatus.nonce);
const cleared = await fetch(testBase + '/dm-line/test-origin', {
  method: 'POST',
  headers: adminHeaders,
  body: JSON.stringify({ origin: '' })
}).then((response) => response.json());
assert.equal(cleared.publicOrigin, '');
const afterClear = await requestHost(hostedPath, 'abcd.trycloudflare.com');
assert.equal(afterClear.status, 404);
const otherPerson = await fetch(testBase + '/dm-line/review', {
  method: 'POST',
  headers: adminHeaders,
  body: JSON.stringify({ subjectName: '本番 花子', confirmSubject: '本番 花子', fileBase64: jpg.toString('base64') })
}).then((response) => response.json());
assert.equal(otherPerson.code, 'unlinked');
const pdfOnTest = await fetch(testBase + '/dm-line/review', {
  method: 'POST',
  headers: adminHeaders,
  body: JSON.stringify({ subjectName: '試験アカウント', confirmSubject: '試験アカウント', fileBase64: Buffer.from('%PDF-1.7\n%test\n').toString('base64') })
}).then((response) => response.json());
assert.equal(pdfOnTest.code === 'image_convert_failed' || pdfOnTest.code === 'invalid_file', true);
const overMb = Buffer.alloc(Dm.PREVIEW_MAX + 1, 0x11);
overMb[0] = 0xFF;
overMb[1] = 0xD8;
overMb[2] = 0xFF;
const overOnTest = await fetch(testBase + '/dm-line/review', {
  method: 'POST',
  headers: adminHeaders,
  body: JSON.stringify({ subjectName: '試験アカウント', confirmSubject: '試験アカウント', fileBase64: overMb.toString('base64') })
}).then((response) => response.json());
assert.equal(overOnTest.code, 'size_exceeded');
started.server.close();

const PdfHost = require(join(root, 'dm-line-pdf-host.js'));
const { spawn } = require('node:child_process');
const savedToken = process.env.DM_TEST_TOKEN_SAMPLE;
process.env.DM_TEST_TOKEN_SAMPLE = 'hidden';
const copied = PdfHost.safeEnv();
delete process.env.DM_TEST_TOKEN_SAMPLE;
if (savedToken !== undefined) process.env.DM_TEST_TOKEN_SAMPLE = savedToken;
assert.equal(copied.DM_TEST_TOKEN_SAMPLE, undefined);
assert.equal(copied.NODE_OPTIONS, undefined);

function nodeChild(script) {
  return spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
}

const timeoutPids = [];
const timeoutHostTracked = PdfHost.createPdfHost({
  timeoutMs: 250,
  spawn: () => {
    const child = nodeChild('setInterval(function(){}, 10000)');
    timeoutPids.push(child.pid);
    return child;
  }
});
await assert.rejects(timeoutHostTracked.render(Buffer.from('%PDF-1.7\n'), {}), (error) => error.reason === 'timeout' && error.code === 'image_convert_failed');
await new Promise((resolve) => setTimeout(resolve, 200));
assert.equal(timeoutPids.length, 1);
assert.throws(() => process.kill(timeoutPids[0], 0));

const crashHost = PdfHost.createPdfHost({
  timeoutMs: 3000,
  spawn: () => nodeChild('setTimeout(function(){ process.exit(9); }, 20)')
});
await assert.rejects(crashHost.render(Buffer.from('%PDF-1.7\n'), {}), (error) => error.code === 'image_convert_failed' && error.reason !== 'timeout');

const sizeHost = PdfHost.createPdfHost({
  timeoutMs: 3000,
  spawn: () => nodeChild('setTimeout(function(){ process.stdout.write(JSON.stringify({ok:false,code:"size_exceeded",peakRss:5})); }, 20)')
});
await assert.rejects(sizeHost.render(Buffer.from('%PDF-1.7\n'), {}), (error) => error.code === 'size_exceeded');

const busyPids = [];
const busyHost = PdfHost.createPdfHost({
  concurrency: 1,
  timeoutMs: 2000,
  spawn: () => {
    const child = nodeChild('setInterval(function(){}, 10000)');
    busyPids.push(child);
    return child;
  }
});
const busyFirst = busyHost.render(Buffer.from('%PDF-1.7\n'), {});
await new Promise((resolve) => setTimeout(resolve, 50));
await assert.rejects(busyHost.render(Buffer.from('%PDF-1.7\n'), {}), (error) => error.code === 'pdf_busy');
busyPids.forEach((child) => child.kill());
await assert.rejects(busyFirst);

const timeoutLabel = service({
  pdfEnabled: true,
  renderPdf: async () => {
    const error = new Error('timeout');
    error.code = 'image_convert_failed';
    error.reason = 'timeout';
    throw error;
  }
});
const timeoutReview = await timeoutLabel.api.review(input({ bytes: Buffer.from('%PDF-1.7\n%label\n') }));
assert.equal(timeoutReview.code, 'image_convert_failed');
assert.match(timeoutReview.label, /時間内/);
const busyLabel = service({
  pdfEnabled: true,
  renderPdf: async () => {
    const error = new Error('busy');
    error.code = 'pdf_busy';
    throw error;
  }
});
const busyReview = await busyLabel.api.review(input({ bytes: Buffer.from('%PDF-1.7\n%label\n') }));
assert.equal(busyReview.code, 'pdf_busy');
assert.match(busyReview.label, /別のPDF変換/);

const rss = spawnSync(process.execPath, ['--expose-gc', join(root, 'tests', 'dm-line-pdf-rss.cjs')], {
  cwd: root,
  encoding: 'utf8',
  timeout: 120000
});
assert.equal(rss.status, 0, rss.stderr);
const rssReport = JSON.parse(rss.stdout);
assert.equal(rssReport.runs, 10);
assert.equal(rssReport.pages, 2);
assert.ok(rssReport.parentGrowth < 64 * 1024 * 1024);
assert.ok(rssReport.childPeakMin > rssReport.parentGrowth);
assert.equal(rssReport.quality.pageCount, 2);
assert.equal(rssReport.quality.pages[0].width, 1310);
assert.equal(rssReport.quality.pages[1].width, 1310);
assert.ok(rssReport.quality.pages.every((page) => page.originalBytes <= 1024 * 1024 && page.previewBytes <= 1024 * 1024));
assert.ok(rssReport.quality.pages.every((page) => page.originalBytes > 25000 && page.previewBytes < page.originalBytes));
assert.equal(rssReport.quality.differentPages, true);

const iso = spawnSync(process.execPath, [join(root, 'tests', 'dm-line-jpeg-isolate.cjs')], {
  cwd: root,
  encoding: 'utf8',
  env: Object.assign({}, process.env, {
    DM_PROBE_JPEG: jpg.toString('base64'),
    DM_PDF_CONVERT: '',
    DM_IMAGE_LIVE_SEND: '',
    DM_IMAGE_RETENTION_TEST_LINE_ID: ''
  })
});
assert.equal(iso.status, 0, (iso.stdout || '') + (iso.stderr || ''));
assert.match(iso.stdout, /jpeg isolated/);

console.log('dm line image ok');
