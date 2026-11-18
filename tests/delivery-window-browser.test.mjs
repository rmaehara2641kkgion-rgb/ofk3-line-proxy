// Browser integration test for the delivery-window mode inside the real index.html (synthetic data only).
// - serves the repo over localhost, blocks every external request (CDN scripts are stubbed; xlsx comes from node_modules)
// - replaces speechSynthesis with a recording fake (headless Chromium has no voices)
// - no network, no real data, no real audio. Skips (exit 0) when Playwright is not installed.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, createReadStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let chromium;
try { chromium = require('playwright').chromium; } catch (e) {
  try { chromium = require(join(process.env.NODE_PATH || '', 'playwright')).chromium; } catch (e2) { chromium = null; }
}
if (!chromium) { console.log('delivery-window-browser tests: SKIPPED (playwright not installed)'); process.exit(0); }
const XLSX = require('xlsx');

let passed = 0;
function assert(cond, msg) { if (!cond) throw new Error('FAIL: ' + msg); }
function eq(a, b, msg) {
  const x = JSON.stringify(a); const y = JSON.stringify(b);
  if (x !== y) throw new Error('FAIL: ' + msg + '\n  actual:   ' + x + '\n  expected: ' + y);
}
const tests = [];
function t(name, fn) { tests.push([name, fn]); }

// ---------- synthetic files ----------
const REF = '2026-11-17', D = REF + ' ';
const id = (n) => 'DA' + String(n).padStart(10, '0');
const HEAD = 'Tracking ID,Last Updated Time,Scheduled Delivery Start Time,Scheduled Delivery End Time,Promised Delivery Date';
const srLine = (n, s, e, p) => [id(n), '2026-11-17 09:30:00', s || '', e || '', p === undefined ? REF : p].join(',');
const SR_A = '﻿' + HEAD + '\r\n' + [
  srLine(1, D + '08:00:00', D + '12:00:00'), srLine(2, D + '14:00:00', D + '16:00:00'), srLine(3, D + '08:00:00', D + '22:00:00'),
  srLine(4, '', ''), srLine(5, '2026-11-18 08:00:00', '2026-11-18 12:00:00', REF), srLine(8, D + '08:00:00', D + '22:00:00')
].join('\r\n') + '\r\n';
const SR_B = '﻿' + HEAD + '\r\n' + srLine(1, D + '16:00:00', D + '18:00:00') + '\r\n';
function elimiBuf(c1, c2) {
  const rows = [[null, null, null, null, null, null], [null, 'RTS報告', null, null, null, null], [null, null, null, null, null, null],
    [null, '日付', 46343, null, null, null], [null, 'Node', 'OFK3', null, null, null], [null, null, null, null, null, null],
    [null, 'Cycle1', null, null, 'Cycle2', null], [null, 'AM指定・14-16指定・BC', null, null, '16-18時指定', null],
    [null, '番号', 'トラッキングID', null, '番号', 'トラッキングID']];
  const n = Math.max(c1.length, c2.length);
  for (let i = 0; i < n; i++) rows.push([null, i + 1, c1[i] === undefined ? null : id(c1[i]), null, i + 1, c2[i] === undefined ? null : id(c2[i])]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'エリミネーション報告');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
const ELIMI_A = elimiBuf([1, 2, 3, 4, 5], [8]);
const ELIMI_B = elimiBuf([1], []);
const MALE = { name: 'Microsoft Ichiro - Japanese (Japan)', lang: 'ja-JP', localService: true };
const FEMALE = { name: 'Google 日本語', lang: 'ja-JP', localService: true };

// ---------- static server + browser ----------
const server = createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]); const f = join(root, u === '/' ? 'index.html' : u);
  if (!f.startsWith(root) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8' });
  createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const xlsxJs = readFileSync(join(root, 'node_modules', 'xlsx', 'dist', 'xlsx.full.min.js'));
const consoleLines = [];

async function openPage(cfg) {
  const c = Object.assign({ voices: [MALE, FEMALE], synth: true, mode: 'ok', manifest: false, voiceOn: null }, cfg || {});
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => { if (!/tailwind/.test(e.message)) errors.push(e.message); });
  page.on('console', (m) => consoleLines.push(m.text()));
  await page.route('**/*', (r) => {
    const u = r.request().url();
    if (u.startsWith('http://127.0.0.1:' + port)) return r.continue();
    if (/xlsx/.test(u)) return r.fulfill({ status: 200, contentType: 'text/javascript', body: xlsxJs });
    return r.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
  });
  await page.addInitScript((cfg2) => {
    window.tailwind = { config: {} };
    window.__spoken = []; window.__cancels = 0; window.__mode = cfg2.mode;
    if (cfg2.voiceOn !== null) { try { localStorage.setItem('ofk3.dw.voiceOn', cfg2.voiceOn); } catch (e) { /* ignore */ } }
    if (!cfg2.synth) { Object.defineProperty(window, 'speechSynthesis', { value: undefined, configurable: true }); window.SpeechSynthesisUtterance = undefined; return; }
    var cur = null;
    window.SpeechSynthesisUtterance = function (t) { this.text = t; };
    var synth = {
      getVoices: function () { return cfg2.voices; }, addEventListener: function () {},
      speak: function (u) {
        if (window.__mode === 'throw') throw new Error('speak failed');
        window.__spoken.push({ text: u.text, voice: u.voice ? u.voice.name : null });
        cur = u;
        setTimeout(function () { if (cur === u && u.onstart) u.onstart(); }, 5);
        if (window.__mode === 'error') setTimeout(function () { if (cur === u && u.onerror) u.onerror({ error: 'synthesis-failed' }); }, 15);
      },
      cancel: function () { var u = cur; cur = null; window.__cancels += 1; if (u && u.onerror) u.onerror({ error: 'canceled' }); },
      __interrupt: function () { var u = cur; cur = null; if (u && u.onerror) u.onerror({ error: 'interrupted' }); }
    };
    Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  }, c);
  await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__dwInstalled);
  if (c.manifest) await page.evaluate(() => { daNumberMap['DA0000000001'] = 'DCX12'; daNumberMap['DA0000000002'] = 'DMX45'; });
  await page.evaluate(() => switchTab('scan'));
  return { page, ctx, errors };
}
const spoken = (page) => page.evaluate(() => window.__spoken.map((s) => s.text));
async function setMode(page, on) { await page.evaluate((v) => { const c = document.getElementById('dw-mode-toggle'); c.checked = v; c.dispatchEvent(new Event('change')); }, on); }
async function loadBoth(page, sr, elimi) {
  await page.setInputFiles('#dw-elimi-file', { name: 'elimi.xlsx', mimeType: 'application/octet-stream', buffer: elimi || ELIMI_A });
  await page.setInputFiles('#dw-sr-file', { name: 'sr.csv', mimeType: 'text/csv', buffer: Buffer.from(sr || SR_A, 'utf8') });
  await page.waitForFunction(() => /使用可能/.test(document.getElementById('dw-state').textContent));
}
async function scan(page, value, key) {
  await page.fill('#scan-input', value);
  await page.press('#scan-input', key || 'Enter');
  await page.waitForTimeout(40);
}
const text = (page, sel) => page.textContent(sel);

// ================= regression: mode OFF = existing behaviour =================
t('mode starts OFF; nothing visible but the toggle; existing panel state unchanged (no manifest)', async () => {
  const { page, ctx, errors } = await openPage();
  eq(await page.isChecked('#dw-mode-toggle'), false, 'toggle off');
  eq(await page.isVisible('#dw-body'), false, 'body hidden');
  eq(await page.evaluate(() => document.getElementById('scan-ready').classList.contains('hidden')), true, 'scan-ready hidden without manifest');
  eq(await page.evaluate(() => document.getElementById('scan-dropzone').classList.contains('hidden')), false, 'dropzone shown');
  eq(errors, [], 'no page errors'); await ctx.close();
});
t('regression (mode OFF, manifest loaded): normal DA search works exactly as before, incl. the existing female-voice route read-out', async () => {
  const { page, ctx, errors } = await openPage({ manifest: true, voices: [FEMALE, MALE] });
  await page.evaluate(() => updateScanStatus());
  eq(await page.evaluate(() => document.getElementById('scan-ready').classList.contains('hidden')), false, 'scan-ready visible with manifest');
  await scan(page, id(1));
  eq(await text(page, '#scan-route-display'), 'CX12', 'route number shown');
  eq(await spoken(page), ['CX12番'], 'existing voice text');
  eq(await page.evaluate(() => window.__spoken[0].voice), FEMALE.name, 'existing female voice preference untouched');
  await scan(page, id(99));
  eq(await page.isVisible('#scan-not-found'), true, 'not found card');
  eq((await spoken(page)).slice(-1), ['該当なし'], 'not found speech');
  eq(await page.inputValue('#scan-input'), '', 'input cleared by the original function');
  eq(await page.evaluate(() => document.getElementById('dw-card').getAttribute('data-kind')), 'idle', 'time card untouched');
  eq(errors, [], 'no errors'); await ctx.close();
});
t('regression: the original lookupDA / handlers / voice code in index.html are byte-for-byte present', () => {
  const html = readFileSync(join(root, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
  for (const needle of ['function lookupDA() {', "onkeydown=\"if(event.key==='Enter'){lookupDA(); event.preventDefault();}\"", 'onpaste="setTimeout(function(){ lookupDA(); }, 50)"',
    'function speakRouteNumber(text) {', 'utter.pitch = 1.3;', 'var scanVoiceEnabled = true;', "var utter = new SpeechSynthesisUtterance('該当なし');", 'function updateScanStatus() {']) {
    assert(html.indexOf(needle) >= 0, 'missing: ' + needle);
  }
  assert(readFileSync(join(root, 'index.html'), 'utf8').indexOf('\r\n') > 0, 'CRLF line endings preserved');
});

// ================= readiness (mode ON) =================
t('mode ON without any file: scan input is shown but disabled, both required files are listed, nothing is scanned or spoken', async () => {
  const { page, ctx } = await openPage();
  await setMode(page, true);
  eq(await page.evaluate(() => document.getElementById('scan-ready').classList.contains('hidden')), false, 'input area visible without manifest');
  eq(await page.isDisabled('#scan-input'), true, 'disabled');
  const st = await text(page, '#dw-state');
  assert(st.indexOf('データ未読込') >= 0 && st.indexOf('エリミ報告書') >= 0 && st.indexOf('SearchResults') >= 0, 'lists both files: ' + st);
  await page.evaluate(() => window.lookupDA());
  eq(await spoken(page), [], 'nothing spoken'); eq(await page.evaluate(() => window.__dwInstalled.controller.getHistory().length), 0, 'nothing scanned');
  await ctx.close();
});
t('only one of the two files: still blocked, and the screen names the missing one', async () => {
  const { page, ctx } = await openPage();
  await setMode(page, true);
  await page.setInputFiles('#dw-elimi-file', { name: 'e.xlsx', mimeType: 'application/octet-stream', buffer: ELIMI_A });
  await page.waitForFunction(() => /読込済: エリミ/.test(document.getElementById('dw-elimi-btn').textContent));
  const st = await text(page, '#dw-state');
  assert(st.indexOf('SearchResults') >= 0 && st.indexOf('エリミ報告書') < 0, 'only SR missing: ' + st);
  eq(await page.isDisabled('#scan-input'), true, 'still disabled'); await ctx.close();
});
t('both files valid: ready, input enabled, last-update info shown', async () => {
  const { page, ctx } = await openPage();
  await setMode(page, true); await loadBoth(page);
  eq(await page.isDisabled('#scan-input'), false, 'enabled');
  const upd = await text(page, '#dw-updated');
  assert(upd.indexOf('SearchResults最終更新: 2026-11-17 09:30:00') >= 0 && upd.indexOf('データ読込:') >= 0 && upd.indexOf('基準日: 2026-11-17') >= 0, 'update info: ' + upd);
  await ctx.close();
});
t('bad files are rejected with a visible error and scanning stays unavailable (wrong CSV; workbook without the sheet)', async () => {
  const { page, ctx } = await openPage();
  await setMode(page, true);
  await page.setInputFiles('#dw-elimi-file', { name: 'e.xlsx', mimeType: 'application/octet-stream', buffer: ELIMI_A });
  await page.setInputFiles('#dw-sr-file', { name: 'sr.csv', mimeType: 'text/csv', buffer: Buffer.from('Tracking ID,Foo\nx,y\n') });
  await page.waitForFunction(() => /エラー/.test(document.getElementById('dw-errors').textContent));
  assert((await text(page, '#dw-errors')).indexOf('sr_missing_columns') >= 0, 'names the problem');
  eq(await page.isDisabled('#scan-input'), true, 'blocked');
  await page.setInputFiles('#dw-sr-file', { name: 'sr.csv', mimeType: 'text/csv', buffer: Buffer.from(SR_A, 'utf8') });
  await page.waitForFunction(() => /使用可能/.test(document.getElementById('dw-state').textContent));
  eq(await page.isDisabled('#scan-input'), false, 'recovers with a good file');
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['x']]), 'Other');
  await page.setInputFiles('#dw-elimi-file', { name: 'e.xlsx', mimeType: 'application/octet-stream', buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) });
  await page.waitForFunction(() => /elimi_sheet_missing/.test(document.getElementById('dw-errors').textContent));
  eq(await page.isDisabled('#scan-input'), true, 'old data is not silently kept'); await ctx.close();
});

// ================= scanning =================
t('three outcomes on screen and in speech; male voice used; existing route-number voice never fires in time mode', async () => {
  const { page, ctx, errors } = await openPage({ manifest: true, voices: [FEMALE, MALE] });
  await setMode(page, true); await loadBoth(page);
  await scan(page, id(1));
  eq([await text(page, '#dw-card-label'), await text(page, '#dw-card-range'), await page.getAttribute('#dw-card', 'data-kind')], ['8時から12時', '08:00〜12:00', 'window'], 'window card');
  await scan(page, id(3));
  eq([await text(page, '#dw-card-label'), await page.getAttribute('#dw-card', 'data-kind')], ['時間指定なし', 'no_window'], 'no window card');
  await scan(page, id(4));
  eq([await text(page, '#dw-card-label'), await page.getAttribute('#dw-card', 'data-kind')], ['確認できません', 'unknown'], 'unknown card');
  assert((await text(page, '#dw-card-reason')).indexOf('時間欄が空欄') >= 0, 'reason shown');
  eq(await spoken(page), ['8時から12時！', '時間指定なし！', '確認できません！'], 'speech');
  eq(await page.evaluate(() => window.__spoken.map((s) => s.voice)), [MALE.name, MALE.name, MALE.name], 'male voice');
  eq(await page.evaluate(() => document.getElementById('scan-route-display').textContent), '', 'normal DA result card not touched');
  assert((await text(page, '#dw-voice-note')).indexOf('男性声') >= 0, 'voice note');
  eq(errors, [], 'no errors'); await ctx.close();
});
t('safety conditions on screen: date mismatch, heading conflict (Cycle2 + 8-22), not found, not in SR/elimi all show 確認できません', async () => {
  const { page, ctx } = await openPage();
  await setMode(page, true); await loadBoth(page);
  const want = [[5, '約束日と時間帯の日付が不一致'], [8, 'エリミ区分と時間帯が不一致'], [99, '照合できません']];
  for (const [n, reason] of want) {
    await scan(page, id(n));
    eq(await text(page, '#dw-card-label'), '確認できません', 'label ' + n);
    assert((await text(page, '#dw-card-reason')).indexOf(reason) >= 0, 'reason ' + n + ': ' + await text(page, '#dw-card-reason'));
  }
  eq((await spoken(page)).every((s) => s === '確認できません！'), true, 'all unknown speech'); await ctx.close();
});
t('input is cleared after each scan; history holds kind + last 4 characters only; the page never shows a full Tracking ID', async () => {
  const { page, ctx } = await openPage();
  await setMode(page, true); await loadBoth(page);
  await scan(page, id(1)); await scan(page, id(2)); await scan(page, id(99));
  eq(await page.inputValue('#scan-input'), '', 'cleared');
  const rows = await page.$$eval('#dw-history > div', (d) => d.map((x) => x.textContent));
  eq(rows.length, 3, 'three rows');
  const shown = await page.evaluate(() => document.getElementById('dw-root').innerText + document.getElementById('scan-ready').innerText);
  assert(!/[A-Z]{2}\d{10}/.test(shown), 'no full id on screen');
  assert(rows[0].indexOf('…0099') >= 0, 'tail shown: ' + rows[0]);
  const stored = await page.evaluate(() => JSON.stringify(Object.assign({}, localStorage)) + JSON.stringify(Object.assign({}, sessionStorage)));
  assert(!/[A-Z]{2}\d{10}/.test(stored) && stored.indexOf('8時') < 0, 'nothing delivery-related stored');
  await ctx.close();
});
t('consecutive scans: latest result wins on screen and in speech; older speech is cancelled; same item can be rescanned', async () => {
  const { page, ctx } = await openPage();
  await setMode(page, true); await loadBoth(page);
  await scan(page, id(1)); await scan(page, id(2)); await scan(page, id(3)); await scan(page, id(3));
  eq(await text(page, '#dw-card-label'), '時間指定なし', 'card = last scan');
  eq(await spoken(page), ['8時から12時！', '14時から16時！', '時間指定なし！', '時間指定なし！'], 'every scan spoken, in order');
  assert(await page.evaluate(() => window.__cancels) >= 3, 'previous speech cancelled each time');
  await ctx.close();
});
t('scanner input paths: Enter, paste and idle-timer; a half-typed value is NOT scanned', async () => {
  const { page, ctx } = await openPage();
  await setMode(page, true); await loadBoth(page);
  await page.fill('#scan-input', id(1).slice(0, 8)); await page.dispatchEvent('#scan-input', 'input'); await page.waitForTimeout(450);
  eq([await spoken(page), await page.inputValue('#scan-input')], [[], id(1).slice(0, 8)], 'partial typing ignored and kept');
  await page.fill('#scan-input', id(2)); await page.dispatchEvent('#scan-input', 'input'); await page.waitForTimeout(450); // no Enter: idle path, complete ID
  eq(await spoken(page), ['14時から16時！'], 'idle path with a complete ID');
  await page.evaluate((v) => { const i = document.getElementById('scan-input'); i.value = v; i.dispatchEvent(new Event('paste', { bubbles: true })); }, id(3));
  await page.waitForTimeout(200);
  eq((await spoken(page)).slice(-1), ['時間指定なし！'], 'paste path');
  await scan(page, id(1), 'Enter');
  eq((await spoken(page)).slice(-1), ['8時から12時！'], 'enter path');
  await page.fill('#scan-input', 'ab'); await page.press('#scan-input', 'Enter'); await page.waitForTimeout(40);
  eq((await spoken(page)).slice(-1), ['確認できません！'], 'explicit Enter with a wrong value is reported, not ignored');
  await ctx.close();
});
t('file update: loading a new SearchResults replaces the answers; unrelated old IDs stop matching', async () => {
  const { page, ctx } = await openPage();
  await setMode(page, true); await loadBoth(page);
  await scan(page, id(1)); eq(await text(page, '#dw-card-label'), '8時から12時', 'old');
  await page.setInputFiles('#dw-sr-file', { name: 'sr2.csv', mimeType: 'text/csv', buffer: Buffer.from(SR_B, 'utf8') });
  await page.waitForFunction(() => /使用可能/.test(document.getElementById('dw-state').textContent));
  await page.setInputFiles('#dw-elimi-file', { name: 'e2.xlsx', mimeType: 'application/octet-stream', buffer: ELIMI_B });
  await page.waitForFunction(() => /使用可能/.test(document.getElementById('dw-state').textContent));
  await scan(page, id(1));
  eq(await text(page, '#dw-card-label'), '16時から18時', 'new answer (Cycle1 mixed heading)');
  await scan(page, id(2)); eq(await text(page, '#dw-card-label'), '確認できません', 'old-only id gone'); await ctx.close();
});

// ================= voice =================
t('voice OFF: result still shown, nothing spoken, choice remembered after reload (mode itself resets to OFF)', async () => {
  const { page, ctx } = await openPage();
  await setMode(page, true); await loadBoth(page);
  await page.uncheck('#dw-voice-toggle');
  await scan(page, id(1));
  eq([await text(page, '#dw-card-label'), await spoken(page)], ['8時から12時', []], 'visible, silent');
  assert((await text(page, '#dw-card-speech')).indexOf('音声OFF') >= 0, 'says voice off');
  await page.reload(); await page.waitForFunction(() => !!window.__dwInstalled);
  eq([await page.isChecked('#dw-mode-toggle'), await page.isChecked('#dw-voice-toggle')], [false, false], 'mode OFF, voice stays OFF');
  await ctx.close();
});
t('speech failures never hide the result (speak throws / error event / interrupted by the next scan)', async () => {
  for (const mode of ['throw', 'error']) {
    const { page, ctx } = await openPage({ mode });
    await setMode(page, true); await loadBoth(page);
    await scan(page, id(2)); await page.waitForTimeout(80);
    eq(await text(page, '#dw-card-label'), '14時から16時', 'result visible in mode ' + mode);
    assert((await text(page, '#dw-card-speech')).indexOf('音声') >= 0 && /エラー|中断/.test(await text(page, '#dw-card-speech')), 'failure shown: ' + await text(page, '#dw-card-speech'));
    await ctx.close();
  }
  const { page, ctx } = await openPage();
  await setMode(page, true); await loadBoth(page);
  await scan(page, id(1)); await scan(page, id(2));
  await page.waitForTimeout(60);
  eq(await text(page, '#dw-card-label'), '14時から16時', 'interrupted older speech does not touch the newest card');
  assert((await text(page, '#dw-card-speech')).indexOf('音声エラー') < 0 && (await text(page, '#dw-card-speech')).indexOf('中断') < 0, 'cancel of the old one is not shown as failure');
  await ctx.close();
});
t('male voice not available is stated on screen (female only / no ja voice / no speech support)', async () => {
  let r = await openPage({ voices: [FEMALE] }); await setMode(r.page, true);
  assert((await text(r.page, '#dw-voice-note')).indexOf('男性声が見つかりません') >= 0, 'female only'); await r.ctx.close();
  r = await openPage({ voices: [{ name: 'Alex', lang: 'en-US', localService: true }] }); await setMode(r.page, true);
  assert((await text(r.page, '#dw-voice-note')).indexOf('日本語の音声がありません') >= 0, 'no ja'); await r.ctx.close();
  r = await openPage({ synth: false }); await setMode(r.page, true); await loadBoth(r.page);
  assert((await text(r.page, '#dw-voice-note')).indexOf('非対応') >= 0, 'unsupported');
  await scan(r.page, id(1)); eq(await text(r.page, '#dw-card-label'), '8時から12時', 'result still shown without speech'); await r.ctx.close();
});

// ================= added checks (Phase 5 verification) =================
t('reloading a file: scanning is impossible while the new file is being read, the old data is never used, and it comes back afterwards', async () => {
  const { page, ctx } = await openPage();
  await setMode(page, true); await loadBoth(page);
  await scan(page, id(1)); eq(await text(page, '#dw-card-label'), '8時から12時', 'works before');
  const before = (await spoken(page)).length;
  await page.evaluate(() => { const o = FileReader.prototype.readAsText; FileReader.prototype.readAsText = function (f, e) { const self = this; setTimeout(function () { o.call(self, f, e); }, 500); }; });
  await page.setInputFiles('#dw-sr-file', { name: 'sr2.csv', mimeType: 'text/csv', buffer: Buffer.from(SR_B, 'utf8') });
  await page.waitForFunction(() => /読み込み中/.test(document.getElementById('dw-state').textContent));
  eq(await page.isDisabled('#scan-input'), true, 'input disabled while loading');
  const r = await page.evaluate((v) => { const i = document.getElementById('scan-input'); i.disabled = false; i.value = v; window.lookupDA(); i.disabled = true; return window.__dwInstalled.controller.handleScan(v).reason; }, id(1));
  eq(r, 'table_not_loaded', 'old table is gone during the reload');
  const dur = (await spoken(page)).slice(before);
  eq(dur, ['確認できません！'], 'only the direct engine call spoke; lookupDA with data not ready did nothing');
  await page.waitForFunction(() => /使用可能/.test(document.getElementById('dw-state').textContent));
  await scan(page, id(1)); eq(await text(page, '#dw-card-label'), '16時から18時', 'new data after the reload');
  await ctx.close();
});
t('updateScanStatus duplicate definition: no side effects on the tenko caller, wrapper is transparent in both modes', async () => {
  const { page, ctx, errors } = await openPage({ manifest: true });
  const info = await page.evaluate(() => ({ src: String(window.__dwInstalled && window.updateScanStatus).length > 0, nameOk: typeof window.updateScanStatus === 'function' }));
  assert(info.src && info.nameOk, 'wrapper installed');
  // the page defines updateScanStatus twice (tenko + scan); the scan version (last one) is active. Calls with tenko arguments must not throw.
  const probe = () => page.evaluate(() => {
    const t = document.getElementById('scan-status-title'), d = document.getElementById('scan-status-detail'), b = document.getElementById('scan-driver-badge');
    const snap = () => [t && t.textContent, d && d.textContent, b && b.textContent, document.getElementById('scan-ready').className, document.getElementById('scan-dropzone').className];
    const before = snap(); let threw = false;
    try { updateScanStatus('qr'); updateScanStatus('ocr', 'x'); updateScanStatus('complete'); updateScanStatus(); } catch (e) { threw = true; }
    return { threw, before, after: snap() };
  });
  let r = await probe();
  eq(r.threw, false, 'mode OFF: no throw'); eq(r.after, r.before, 'mode OFF: nothing in the tenko or scan areas changes');
  await setMode(page, true); await loadBoth(page);
  r = await probe();
  eq(r.threw, false, 'mode ON: no throw');
  eq(r.after[0], r.before[0], 'tenko status title untouched in mode ON');
  eq(await page.isDisabled('#scan-input'), false, 'input stays usable after such calls');
  await setMode(page, false);
  r = await probe(); eq(r.threw, false, 'after OFF: no throw');
  eq(errors, [], 'no page errors'); await ctx.close();
});
t('switching tabs while mode is ON: coming back to the scan tab keeps the input reachable (updateScanStatus re-hides scan-ready, wrapper restores it)', async () => {
  const { page, ctx } = await openPage();
  await setMode(page, true); await loadBoth(page);
  await page.evaluate(() => { switchTab('dashboard'); switchTab('scan'); });
  eq(await page.evaluate(() => document.getElementById('scan-ready').classList.contains('hidden')), false, 'visible again');
  eq(await page.isDisabled('#scan-input'), false, 'enabled'); await scan(page, id(2));
  eq(await text(page, '#dw-card-label'), '14時から16時', 'works'); await ctx.close();
});
t('cloud voices: with only cloud ja voices nothing is spoken, the result is on screen, and the screen says why', async () => {
  const CLOUD = { name: 'Google 日本語', lang: 'ja-JP', localService: false };
  const { page, ctx } = await openPage({ voices: [CLOUD, { name: 'Cloud Ichiro', lang: 'ja-JP', localService: false }] });
  await setMode(page, true); await loadBoth(page);
  assert((await text(page, '#dw-voice-note')).indexOf('ローカルの日本語音声がありません') >= 0, 'note: ' + await text(page, '#dw-voice-note'));
  await scan(page, id(1));
  eq([await text(page, '#dw-card-label'), await spoken(page)], ['8時から12時', []], 'visible, silent');
  assert((await text(page, '#dw-card-speech')).indexOf('ローカルの日本語音声がない') >= 0, 'speech line: ' + await text(page, '#dw-card-speech'));
  eq(await page.$$eval('#dw-voice-select option', (o) => o.length), 0, 'cloud voices not offered');
  await ctx.close();
});
t('cloud voices: with local + cloud voices only the local one is used', async () => {
  const { page, ctx } = await openPage({ voices: [{ name: 'Cloud Ichiro', lang: 'ja-JP', localService: false }, MALE] });
  await setMode(page, true); await loadBoth(page); await scan(page, id(3));
  eq(await page.evaluate(() => window.__spoken.map((s) => s.voice)), [MALE.name], 'local voice only'); await ctx.close();
});
t('audio stopped from outside: the result stays, the voice line says 中断, a following scan speaks normally; screen = last scan', async () => {
  const { page, ctx } = await openPage();
  await setMode(page, true); await loadBoth(page);
  await scan(page, id(1)); await page.waitForTimeout(30);
  await page.evaluate(() => window.speechSynthesis.__interrupt());
  eq(await text(page, '#dw-card-label'), '8時から12時', 'result kept');
  assert((await text(page, '#dw-card-speech')).indexOf('中断') >= 0, 'line: ' + await text(page, '#dw-card-speech'));
  await scan(page, id(2)); await page.waitForTimeout(30);
  eq([await text(page, '#dw-card-label'), (await spoken(page)).slice(-1)[0]], ['14時から16時', '14時から16時！'], 'next scan consistent');
  assert((await text(page, '#dw-card-speech')).indexOf('中断') < 0, 'stale interruption text is gone');
  await ctx.close();
});
t('rapid sequence: after any run of quick scans the card and the last spoken text belong to the same (last) scan', async () => {
  const { page, ctx } = await openPage();
  await setMode(page, true); await loadBoth(page);
  const ids = [1, 2, 3, 4, 5, 8, 99, 1, 3, 2];
  for (const n of ids) { await page.fill('#scan-input', id(n)); await page.press('#scan-input', 'Enter'); }
  await page.waitForTimeout(60);
  const label = await text(page, '#dw-card-label'), last = (await spoken(page)).slice(-1)[0];
  eq([label, last], ['14時から16時', '14時から16時！'], 'last scan on screen and in audio');
  eq((await spoken(page)).length, ids.length, 'every scan was spoken once, in order');
  await ctx.close();
});
t('scanner check page: shows the SHAPE only (digits masked), prefix/suffix characters and the terminator; never the real number', async () => {
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  await page.goto('http://127.0.0.1:' + port + '/delivery-window-scanner-check.html');
  await page.click('#field');
  await page.keyboard.type(id(1)); await page.keyboard.press('Enter');
  await page.keyboard.type('*' + id(2) + '*'); await page.keyboard.press('Tab');
  await page.waitForTimeout(50);
  const shown = await page.evaluate(() => document.body.innerText);
  assert(!/[A-Z]{2}(?!9{10})\d{10}/.test(shown), 'no real number on the page (the masked shape DA9999999999 is expected)');
  assert(shown.indexOf('DA9999999999') >= 0 && shown.indexOf('*DA9999999999*') >= 0, 'shapes shown: ' + shown.slice(0, 200));
  assert(shown.indexOf('Enter') >= 0 && shown.indexOf('Tab') >= 0, 'terminators shown');
  await ctx.close();
});
t('voice check page: local-only is on by default and cloud voices are reported but not used', async () => {
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  await page.addInitScript(() => {
    const voices = [{ name: 'Google 日本語', lang: 'ja-JP', localService: false }, { name: 'Microsoft Ichiro', lang: 'ja-JP', localService: true }];
    window.SpeechSynthesisUtterance = function (t) { this.text = t; }; window.__spoken = [];
    Object.defineProperty(window, 'speechSynthesis', { value: { getVoices: () => voices, addEventListener() {}, speak(u) { window.__spoken.push(u.voice && u.voice.name); }, cancel() {} }, configurable: true });
  });
  await page.goto('http://127.0.0.1:' + port + '/delivery-window-voice-check.html');
  eq(await page.isChecked('#localOnly'), true, 'default on');
  assert((await text(page, '#voices')).indexOf('通信の可能性あり 1件') >= 0, 'cloud counted: ' + await text(page, '#voices'));
  await page.click('button[data-t="8時から12時！"]');
  eq(await page.evaluate(() => window.__spoken), ['Microsoft Ichiro'], 'local voice used'); await ctx.close();
});

// ================= switching back =================
t('mode OFF again restores the original panel (input enabled, scan-ready/dropzone as before) and cancels speech', async () => {
  const { page, ctx } = await openPage({ manifest: false });
  await setMode(page, true); await loadBoth(page); await scan(page, id(1));
  await setMode(page, false);
  eq(await page.isDisabled('#scan-input'), false, 'enabled');
  eq(await page.evaluate(() => document.getElementById('scan-ready').classList.contains('hidden')), true, 'scan-ready hidden again (no manifest)');
  eq(await page.evaluate(() => document.getElementById('scan-dropzone').classList.contains('hidden')), false, 'dropzone back');
  assert(await page.evaluate(() => window.__cancels) >= 1, 'speech cancelled');
  await ctx.close();
});
t('mode ON/OFF with manifest loaded: normal search works again after turning the mode OFF', async () => {
  const { page, ctx } = await openPage({ manifest: true });
  await page.evaluate(() => updateScanStatus());
  await setMode(page, true); await loadBoth(page); await scan(page, id(1));
  eq((await spoken(page)).slice(-1), ['8時から12時！'], 'time mode');
  await setMode(page, false);
  await scan(page, id(2));
  eq([await text(page, '#scan-route-display'), (await spoken(page)).slice(-1)], ['MX45', ['MX45番']], 'normal search + original voice after OFF');
  await ctx.close();
});

// ================= hygiene =================
t('no console output contains a Tracking ID; loaded modules have no backticks (IE-mode rule)', () => {
  assert(consoleLines.every((l) => !/[A-Z]{2}\d{10}/.test(l)), 'console lines with ids');
  for (const f of ['delivery-window-session.js', 'delivery-window-ui.js']) {
    const src = readFileSync(join(root, f), 'utf8');
    assert(src.indexOf('`') < 0 && !/=>/.test(src) && !/console\./.test(src), f + ' hygiene');
    assert(!/fetch\(|XMLHttpRequest|sendBeacon|WebSocket/.test(src), f + ' makes no network calls');
  }
});

console.log('delivery-window-browser tests');
for (const [name, fn] of tests) {
  try { await fn(); passed += 1; console.log('  ok - ' + name); } catch (e) {
    console.error('  NOT OK - ' + name + '\n' + e.message); await browser.close(); server.close(); process.exit(1);
  }
}
await browser.close(); server.close();
console.log('\n' + passed + ' tests passed');
