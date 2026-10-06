import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const Core = require(join(root, 'billing-reconcile-core.js'));
const indexSrc = readFileSync(join(root, 'index.html'), 'utf8');
const serverSrc = readFileSync(join(root, 'render-webhook-server.js'), 'utf8');

const NAGAURA_PDF = join(root, 'tests', 'fixtures', 'billing', '永浦.pdf');

function utf16hex(s) {
  let hex = 'FEFF';
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(4, '0');
  return hex.toUpperCase();
}

function makeTextPdf(pages) {
  const objs = {};
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  let next = 4;
  const kids = [];
  pages.forEach(function (lines) {
    const cmds = ['BT', '/F1 12 Tf', '72 720 Td'];
    lines.forEach(function (line, idx) {
      if (idx > 0) cmds.push('0 -20 Td');
      cmds.push('<' + utf16hex(line) + '> Tj');
    });
    cmds.push('ET');
    const stream = cmds.join('\n');
    const contentId = next++;
    objs[contentId] = '<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + '\nendstream';
    const pageId = next++;
    kids.push(pageId);
    objs[pageId] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ' + contentId + ' 0 R /Resources << /Font << /F1 3 0 R >> >> >>';
  });
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = '<< /Type /Pages /Count ' + kids.length + ' /Kids [' + kids.map(function (id) { return id + ' 0 R'; }).join(' ') + '] >>';
  const max = next - 1;
  const chunks = ['%PDF-1.4\n'];
  let pos = Buffer.byteLength(chunks[0]);
  const offsets = [0];
  for (let id = 1; id <= max; id++) {
    offsets[id] = pos;
    const piece = id + ' 0 obj\n' + objs[id] + '\nendobj\n';
    chunks.push(piece);
    pos += Buffer.byteLength(piece);
  }
  let xref = 'xref\n0 ' + (max + 1) + '\n0000000000 65535 f \n';
  for (let i = 1; i <= max; i++) xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  xref += 'trailer\n<< /Size ' + (max + 1) + ' /Root 1 0 R >>\nstartxref\n' + pos + '\n%%EOF\n';
  chunks.push(xref);
  return Buffer.from(chunks.join(''), 'latin1');
}

function headerRow() {
  return ['キー', 'TID', '宛名', '11B', '8B', 'B1', 'B2', 'biker', '嘉麻応援', 'C1', 'C3', 'システム', '日曜', 'チャーター', '走行', '控除', '税別', 'システム料', '税', '合計'];
}

function personRow(key, tid, name, days) {
  const row = [];
  row[0] = key;
  row[1] = tid;
  row[2] = name;
  if (days) {
    for (let i = 0; i < days.length; i++) row[3 + i] = days[i];
  }
  return row;
}

function names(rows) {
  return Core.parseBillingRows(rows).map(function (d) { return d.name; });
}

const targets = [
  { name: '永浦 康明', driverKey: 'N1' },
  { name: '松嶋 勇一', driverKey: 'M1' },
  { name: '木下 淳', driverKey: 'K1' },
  { name: '鴛海 剛', driverKey: 'O1' },
  { name: '安樂 陸', driverKey: 'A1' },
  { name: '金子 昌巧', driverKey: '' }
];

function assign(file, people, readings) {
  return Core.assignBillingPdfs([file], people || targets, { readings: readings || {} })[0];
}

mkdirSync(dirname(NAGAURA_PDF), { recursive: true });
const nagauraPdf = makeTextPdf([
  ['2026年 10月度支払確認書', '永浦 康明 様'],
  ['請求書', '永浦 康明', 'ナガウラヤスアキ']
]);
writeFileSync(NAGAURA_PDF, nagauraPdf);

// A. 最終行の対象者は落ちない
{
  const rows = [headerRow()];
  ['永浦 康明', '松嶋 勇一', '木下 淳', '鴛海 剛', '安樂 陸'].forEach(function (name, i) {
    rows.push(personRow('K' + i, 'A1TID' + String(i).padStart(8, '0'), name, [1]));
  });
  const parsed = Core.parseBillingRows(rows);
  assert.equal(parsed.length, 5);
  assert.equal(parsed[parsed.length - 1].name, '安樂 陸');
  console.log('  ok - A last row is recognized');
}

// B. A列空欄でも TID と氏名があれば対象
{
  const rows = [headerRow(), personRow('', 'A1EMPTYAKEY01', '鴛海 剛', [2])];
  const parsed = Core.parseBillingRows(rows);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].name, '鴛海 剛');
  assert.equal(parsed[0].driverKey, '');
  assert.equal(parsed[0].tid, 'A1EMPTYAKEY01');
  console.log('  ok - B empty column A with TID and name');
}

// C. 金子 昌巧（A空、B=TID、C=氏名、L=○）
{
  const rows = [];
  for (let i = 0; i < 22; i++) rows.push([]);
  rows[1] = headerRow();
  const listed = [
    [16, '永浦 康明'],
    [17, '松嶋 勇一'],
    [18, '木下 淳'],
    [19, '鴛海 剛'],
    [20, '安樂 陸']
  ];
  listed.forEach(function (pair, i) {
    rows[pair[0]] = personRow('K' + i, 'A1OTHER' + String(i).padStart(7, '0'), pair[1], [1]);
  });
  const kaneko = [];
  kaneko[0] = '';
  kaneko[1] = 'A1GKOXURY2BDIZ';
  kaneko[2] = '金子 昌巧';
  kaneko[3] = 7;
  kaneko[4] = 1;
  kaneko[11] = '○';
  rows[21] = kaneko;
  const parsed = Core.parseBillingRows(rows);
  const hit = parsed.filter(function (d) { return d.name === '金子 昌巧'; });
  assert.equal(hit.length, 1);
  assert.equal(hit[0].tid, 'A1GKOXURY2BDIZ');
  assert.equal(hit[0].driverKey, '');
  assert.equal(hit[0].workDays, 8);
  assert.deepEqual(hit[0].breakdown, ['11B: 7日', '8B: 1日']);
  assert.equal(hit[0].sysUsageFlag, '○');
  assert.equal(parsed[parsed.length - 1].name, '金子 昌巧');
  assert.ok(parsed.length >= 6);
  console.log('  ok - C kaneko row 22 empty A');
}

// D/E. 永浦.pdf
{
  const bytes = new Uint8Array(readFileSync(NAGAURA_PDF));
  const kind = Core.classifyPdfUpload({ name: '永浦.pdf', type: '' }, bytes);
  assert.equal(kind.ok, true, '永浦.pdf is a PDF');
  assert.equal(Core.classifyPdfUpload({ name: '永浦.pdf', type: 'application/pdf' }, bytes).ok, true);
  const text = Core.extractPdfText(bytes);
  assert.match(text, /2026年 10月度支払確認書/);
  assert.match(text, /永浦 康明/);
  assert.match(text, /請求書/);
  assert.match(text, /ナガウラヤスアキ/);
  const hit = assign({ filename: '永浦.pdf', text: text, error: '' });
  assert.equal(hit.code, 'matched');
  assert.equal(hit.targetName, '永浦 康明');
  assert.equal(hit.sendable, true);
  console.log('  ok - D/E nagaura.pdf reads and assigns');
}

// F. 空白差とカナ
{
  ['永浦 康明', '永浦　康明', '永浦康明', '永浦\n康明', '永浦   康明'].forEach(function (variant) {
    assert.equal(Core.normalizePersonName(variant), '永浦康明', variant);
    assert.equal(Core.textHasPersonName(variant + ' 様', '永浦 康明'), true, variant);
  });
  const kanaOnly = assign(
    { filename: 'reading.pdf', text: 'ナガウラヤスアキ', error: '' },
    targets,
    { '永浦 康明': ['ナガウラヤスアキ'] }
  );
  assert.equal(kanaOnly.targetName, '永浦 康明');
  assert.equal(kanaOnly.sendable, true);
  const fromMaster = Core.collectNameReadings(targets, {
    driverJapaneseNames: { '康明 永浦': 'ナガウラヤスアキ' }
  });
  assert.ok((fromMaster['永浦 康明'] || []).some(function (r) { return Core.normalizePersonName(r) === 'ナガウラヤスアキ'; }));
  const viaMaster = assign(
    { filename: 'kana.pdf', text: 'ナガウラヤスアキ', error: '' },
    targets,
    fromMaster
  );
  assert.equal(viaMaster.sendable, true);
  assert.equal(viaMaster.targetName, '永浦 康明');
  const kanjiWins = assign(
    { filename: 'both.pdf', text: '永浦 康明\nカネコマサタカ', error: '' },
    targets,
    { '金子 昌巧': ['カネコマサタカ'], '永浦 康明': ['ナガウラヤスアキ'] }
  );
  assert.equal(kanjiWins.targetName, '永浦 康明');
  assert.equal(kanjiWins.sendable, true);
  assert.equal(Core.textHasPersonName('木下淳一', '木下 淳'), false);
  assert.equal(assign({ filename: 'short.pdf', text: '永浦 様', error: '' }).sendable, false);
  console.log('  ok - F spaces, kana, kanji priority');
}

// G. 特定できない PDF は送らない
{
  const hit = assign({ filename: 'unknown.pdf', text: '請求書\n山田 太郎 様', error: '' });
  assert.equal(hit.code, 'unmatched');
  assert.equal(hit.label, '対象者を特定できません');
  assert.equal(hit.sendable, false);
  const empty = assign({ filename: 'blank.pdf', text: '', error: '' });
  assert.equal(empty.code, 'extract_failed');
  assert.equal(empty.label, '氏名抽出失敗');
  assert.equal(empty.sendable, false);
  console.log('  ok - G unknown pdf is not sendable');
}

// H. 複数候補は送らない
{
  const hit = assign({ filename: 'multi.pdf', text: '永浦 康明\n金子 昌巧', error: '' });
  assert.equal(hit.code, 'ambiguous');
  assert.equal(hit.label, '候補者が複数存在');
  assert.equal(hit.sendable, false);
  assert.equal(hit.targetName, '');
  const surname = assign({ filename: '【永浦DA】.pdf', text: '', error: '' });
  assert.equal(surname.sendable, false);
  console.log('  ok - H ambiguous pdf is not sendable');
}

// I. 複数PDFを個別に振り分け
{
  const kanekoPdf = makeTextPdf([['請求書', '金子 昌巧']]);
  const files = [
    { filename: '永浦.pdf', text: Core.extractPdfText(nagauraPdf), error: '' },
    { filename: '金子.pdf', text: Core.extractPdfText(kanekoPdf), error: '' },
    { filename: '不明.pdf', text: '関係のない文書', error: '' }
  ];
  const results = Core.assignBillingPdfs(files, targets, {});
  assert.equal(results[0].targetName, '永浦 康明');
  assert.equal(results[0].sendable, true);
  assert.equal(results[1].targetName, '金子 昌巧');
  assert.equal(results[1].sendable, true);
  assert.equal(results[2].sendable, false);
  assert.equal(results.filter(function (r) { return r.sendable; }).length, 2);
  console.log('  ok - I batch pdfs assign individually');
}

// J. 人数上限で切れない
{
  const rows = [headerRow()];
  for (let i = 0; i < 40; i++) {
    const key = i === 39 ? '' : ('K' + i);
    rows.push(personRow(key, 'A1LIMIT' + String(i).padStart(8, '0'), '対象者' + i, [1]));
  }
  rows.splice(10, 0, []);
  rows.splice(11, 0, ['', '', '', 9]);
  const parsed = Core.parseBillingRows(rows);
  assert.equal(parsed.length, 40);
  assert.equal(parsed[39].name, '対象者39');
  assert.equal(parsed[39].driverKey, '');
  assert.equal(parsed[39].tid, 'A1LIMIT' + '39'.padStart(8, '0'));
  console.log('  ok - J no fixed person cap');
}

// 既存の列位置と、空行で break しないこと
{
  const row = personRow('DRV1', 'A1GKOXURY2BDIZ', '永浦 康明', [2]);
  row[13] = '¥1,000';
  row[19] = 5000;
  const parsed = Core.parseBillingRows([headerRow(), [], row]);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].driverKey, 'DRV1');
  assert.equal(parsed[0].charter, 1000);
  assert.equal(parsed[0].total, 5000);
  assert.equal(parsed[0].workDays, 2);
  assert.equal(parsed[0].selected, true);
  const skipped = Core.parseBillingRows([headerRow(), personRow('ONLYKEY', '', '', [])]);
  assert.equal(skipped.length, 0);
  console.log('  ok - column alignment and blank rows');
}

// ファイル判定
{
  const pdfBytes = new Uint8Array(nagauraPdf);
  assert.equal(Core.classifyPdfUpload({ name: 'メモ.txt', type: 'text/plain' }, pdfBytes).reason === 'not_pdf' || Core.classifyPdfUpload({ name: 'メモ.txt', type: 'text/plain' }, new Uint8Array([1, 2, 3])).reason, 'not_pdf');
  assert.equal(Core.classifyPdfUpload({ name: '永浦.pdf', type: '' }, new Uint8Array([1, 2, 3, 4, 5])).reason, 'bad_magic');
  assert.equal(Core.classifyPdfUpload({ name: '請求.png', type: 'image/png' }, new Uint8Array([1, 2, 3])).reason, 'not_pdf');
  const bad = assign({ filename: '永浦.pdf', text: '', error: 'bad_magic' });
  assert.equal(bad.label, 'PDF読込失敗');
  assert.equal(bad.sendable, false);
  const notPdf = assign({ filename: 'photo.png', text: '永浦 康明', error: 'not_pdf' });
  assert.equal(notPdf.sendable, false);
  assert.equal(notPdf.label, 'PDFとして認識されません');
  console.log('  ok - pdf classify and error labels');
}

// index.html の配線。LINE送信APIそのものは触らない
{
  assert.match(indexSrc, /billing-reconcile-core\.js/);
  assert.match(indexSrc, /BillingReconcile\.parseBillingRows/);
  assert.match(indexSrc, /BillingReconcile\.assignBillingPdfs/);
  assert.match(indexSrc, /accept="application\/pdf,\.pdf"/);
  assert.match(indexSrc, /pdfjsLib\.getDocument/);
  assert.match(indexSrc, /cMapPacked:\s*true/);
  const parseStart = indexSrc.indexOf('function parseBillingData');
  const parseEnd = indexSrc.indexOf('function parseNum', parseStart);
  const parseFn = indexSrc.slice(parseStart, parseEnd);
  assert.match(parseFn, /BillingReconcile\.parseBillingRows/);
  assert.doesNotMatch(parseFn, /!row\[0\]/);
  const sendStart = indexSrc.indexOf('async function sendAllBillingLine');
  const sendEnd = indexSrc.indexOf('// ===== 配送MAP機能 =====');
  assert.ok(sendStart > 0 && sendEnd > sendStart);
  const sendFn = indexSrc.slice(sendStart, sendEnd);
  assert.match(sendFn, /fetch\(proxyUrl/);
  assert.match(sendFn, /headers:\s*getProxyHeaders\(\)/);
  assert.match(sendFn, /JSON\.stringify\(\{\s*to:\s*userId,\s*messages:\s*lineMessages\s*\}\)/);
  assert.doesNotMatch(sendFn, /assignBillingPdfs|PROXY_SECRET|parseBillingRows/);
  assert.match(serverSrc, /function\(req, res\) \{\s*\/\/ base64で受け取る方式/);
  assert.match(indexSrc, /ondrop="[^"]*handlePdfUpload\(event\.dataTransfer\.files\)/);
  assert.match(indexSrc, /onchange="handlePdfUpload\(this\)"/);
  console.log('  ok - index wiring keeps LINE send path');
}

// TID不一致は警告判定のみ。氏名もTIDも書き換えない
{
  assert.equal(Core.tidNameMismatch('金子 昌巧', ['勝幸 矢野']), true);
  assert.equal(Core.tidNameMismatch('永浦 康明', ['康明 永浦']), false);
  assert.equal(Core.tidNameMismatch('金子 昌巧', []), false);
  assert.equal(Core.tidNameMismatch('金子 昌巧', ['金子 昌巧']), false);
  const rows = [headerRow()];
  const kaneko = [];
  kaneko[1] = 'A1GKOXURY2BDIZ';
  kaneko[2] = '金子 昌巧';
  rows.push(kaneko);
  const parsed = Core.parseBillingRows(rows);
  assert.equal(parsed[0].name, '金子 昌巧');
  assert.equal(parsed[0].tid, 'A1GKOXURY2BDIZ');
  assert.equal(parsed[0].driverKey, '');
  const master = { '勝幸 矢野': 'A1GKOXURY2BDIZ' };
  assert.equal(master['A1GKOXURY2BDIZ'], undefined);
  assert.equal(master['勝幸 矢野'], 'A1GKOXURY2BDIZ');
  console.log('  ok - tid mismatch is warning-only');
}

// 1つのPDFは1人だけ。同一人物への複数PDFは結果が別々で、宛先は1人に留まる
{
  const files = [
    { filename: '永浦-1.pdf', text: '永浦 康明 様', error: '' },
    { filename: '永浦-2.pdf', text: '永浦　康明', error: '' }
  ];
  const results = Core.assignBillingPdfs(files, targets, {});
  assert.equal(results[0].sendable, true);
  assert.equal(results[1].sendable, true);
  assert.equal(results[0].targetName, '永浦 康明');
  assert.equal(results[1].targetName, '永浦 康明');
  const map = {};
  results.forEach(function (r) {
    if (!r.sendable) return;
    map[r.targetName] = r.filename;
  });
  assert.equal(Object.keys(map).length, 1);
  assert.equal(map['永浦 康明'], '永浦-2.pdf');
  console.log('  ok - one pdf stays on one person; later file wins the slot');
}

console.log('billing-reconcile tests passed');
