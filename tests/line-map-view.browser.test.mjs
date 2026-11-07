// ブラウザ検証 (任意実行): LEAFLET_DIST=<leaflet/dist のパス> と playwright がある環境でのみ動く。無ければSKIP。
// 注意: ヘッドレスChromium(Linux)での確認であり、実機スマホ・LINE内ブラウザの確認ではない。
import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert';
import express from 'express';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const dist = process.env.LEAFLET_DIST;
let chromium; try { ({ chromium } = require('playwright')); } catch { /* skip */ }
if (!dist || !chromium || !fs.existsSync(path.join(dist, 'leaflet.js'))) { console.log('line-map-view browser test SKIPPED (LEAFLET_DIST / playwright 未設定)'); process.exit(0); }
const Core = require('../line-map-reply-core.js'), Store = require('../line-map-store.js'), Routes = require('../line-map-routes.js');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const UA = 'U' + 'a'.repeat(32);
const store = Store.createAssignmentStore({}); store.sync({ date: today, rows: [{ routeCode: 'DCX-1', driverId: 'A001' }], links: [{ driverId: 'A001', lineUserId: UA }] }, today);
const tokenStore = Core.createMapTokenStore();
// 巡回番号 1,2,3,4 のうち 2 の座標が欠損 → 番号を詰めず 1,3,4 を表示。時間指定情報は一切なし。
const stops = [1, 2, 3, 4].map(q => ({ routeCode: 'DCX-1', sequenceNumber: q, latitude: q === 2 ? null : 33.5 + q / 200, longitude: 130.4 + q / 200, packageCount: q }));
const app = express(); app.use(express.json());
app.use(Routes.createLineMapRouter({ express, env: { PROXY_SECRET: 'ps', LINE_CHANNEL_SECRET: 'cs', PUBLIC_ORIGIN: '' }, assignmentStore: store, tokenStore, getRouteStops: () => stops, reply: async () => {}, todayJst: () => today }));
const srv = await new Promise(r => { const x = app.listen(0, () => r(x)); }); const base = 'http://127.0.0.1:' + srv.address().port;
const tok = tokenStore.issue({ lineUserId: UA, date: today, cycle: 'C1', routeCode: 'DCX-1' });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const browser = await chromium.launch();
async function open(hash, ctxOpts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true, locale: 'ja-JP', ...ctxOpts });
  const page = await ctx.newPage(); const violations = []; page.on('console', m => { if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text()); });
  await page.route('https://unpkg.com/leaflet@1.9.4/dist/**', r => { const f = r.request().url().split('/').pop().split('?')[0]; const p = path.join(dist, f);
    fs.existsSync(p) ? r.fulfill({ path: p, headers: { 'access-control-allow-origin': '*' } }) : r.fulfill({ status: 200, body: png, contentType: 'image/png' }); });
  await page.route('https://*.tile.openstreetmap.org/**', r => r.fulfill({ status: 200, body: png, contentType: 'image/png' }));
  await page.goto(base + '/line-map/view' + hash); return { page, ctx, violations };
}
try {
  const LINE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Line/14.0.0';
  { const { page, ctx, violations } = await open('#' + tok, { userAgent: LINE_UA });
    await page.waitForSelector('.pin'); const nums = await page.$$eval('.pin', els => els.map(e => e.textContent));
    assert.deepStrictEqual(nums, ['1', '3', '4'], '座標欠損(2番)でも番号を詰めない'); n++;
    ok(/C1 DCX-1/.test(await page.textContent('#bar')) && /位置不明 1件/.test(await page.textContent('#bar')), '日本語の案内表示');
    ok(!page.url().includes(tok), 'URLのトークンは履歴から消去される');
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), '横スクロールなし(スマホ幅)');
    const c0 = await page.evaluate(() => { const m = document.querySelector('.leaflet-container'); return m.getBoundingClientRect().height; }); ok(c0 > 600, '地図が画面に広がる');
    await page.click('.pin >> nth=0', { force: true }); await page.waitForSelector('.leaflet-popup'); ok(/巡回 1番/.test(await page.textContent('.leaflet-popup')), 'ポップアップに巡回番号');
    await page.mouse.click(5, 5);
    // ズーム
    const z0 = await page.$$eval('.leaflet-tile-loaded', t => t.length); await page.click('.leaflet-control-zoom-in'); await page.waitForTimeout(500);
    const z1 = await page.evaluate(() => document.querySelector('.leaflet-map-pane').style.transform); ok(z1 !== undefined, 'ズーム操作可');
    // ドラッグ
    const before = await page.evaluate(() => document.querySelector('.leaflet-map-pane').style.transform); const box = await page.locator('#map').boundingBox();
    await page.mouse.move(box.x + 200, box.y + 400); await page.mouse.down(); await page.mouse.move(box.x + 80, box.y + 300, { steps: 8 }); await page.mouse.up();
    const after = await page.evaluate(() => document.querySelector('.leaflet-map-pane').style.transform); ok(before !== after, 'ドラッグで移動可');
    ok(violations.length === 0, 'CSP違反なし: ' + violations.join('|')); await ctx.close(); }
  { const { page, ctx } = await open('#' + 'z'.repeat(32)); await page.waitForSelector('#bar.err'); ok(/無効か期限切れ/.test(await page.textContent('#bar')) && /LINEで「マップ」/.test(await page.textContent('#bar')), '期限切れ/無効の案内'); await ctx.close(); }
  { const { page, ctx } = await open(''); await page.waitForSelector('#bar.err'); ok(/無効/.test(await page.textContent('#bar')), 'トークン無しの案内'); await ctx.close(); }
} finally { await browser.close(); srv.close(); }
console.log('line-map-view browser tests passed (' + n + ' assertions) [headless Chromium only]');
