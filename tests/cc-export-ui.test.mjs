// Contact Compliance 画面の Excel 出力導線テスト（CC Logic Ver.1 と従来「べき架電／実架電」の分離）。
// index.html から実際の関数を抜き出して vm で実行する（DOM は最小限のモック）。
// CC 判定ロジック自体は contact-compliance-core.test.mjs が担当。
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const coreSource = readFileSync(join(root, 'contact-compliance-core.js'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error('FAIL: ' + message);
}

// 文字列リテラル・コメントを読み飛ばしながら { } を数えて関数全体を取り出す
function extractFunction(src, name) {
  var start = src.indexOf('    function ' + name + '(');
  assert(start >= 0, 'index.html に function ' + name + ' がある');
  var i = src.indexOf('{', start);
  var depth = 0;
  for (; i < src.length; i++) {
    var ch = src[i];
    if (ch === '"' || ch === "'") {
      for (i++; i < src.length && src[i] !== ch; i++) if (src[i] === '\\') i++;
    } else if (ch === '/' && src[i + 1] === '/') {
      i = src.indexOf('\n', i);
    } else if (ch === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i) + 1;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unterminated function ' + name);
}

function extractVarObject(src, name) {
  var start = src.indexOf('var ' + name + ' = {');
  assert(start >= 0, 'index.html に var ' + name + ' がある');
  var end = src.indexOf('};', start);
  return src.slice(start, end + 2);
}

const FUNCTIONS = [
  'normalizeReportHeader', 'isTransporterHeader', 'mapAnalysisHeaderColumns', 'findAnalysisHeaderRow',
  'buildTidToNameLookup', 'updateCcExportUi', 'clearCcV1', 'showCcV1Error', 'ccV1RateHtml',
  'renderCcV1FromRows', 'renderCcV1', 'renderCcV1DriverTable', 'ccV1RateBarHtml', 'ccV1NcBarHtml', 'ccV1ReasonTableHtml',
  'ccV1RateCellHtml', 'ccV1TabClass', 'ccMasterSyncLabel', 'renderMasterSyncWarning', 'finishMasterSync', 'syncMasterBeforeAnalysis',
  'ccMasterAffiliationFor', 'handleCcFile', 'handleFtdsFile', 'normalizeIdToken', 'normalizeCcTid', 'ccV1MasterSignature', 'buildCcMasterLookup',
  'summarizeCcAffiliationStatus', 'refreshCcV1Affiliation', 'ccV1SelectTab', 'ccV1SelectDa', 'renderCcV1Affiliation', 'exportCcV1Result', 'processCcData',
  'translateReason', 'isCcCallRequired', 'isCcCallMade', 'calcCcCallRate', 'buildCcAoa',
  'styleQualityExportSheet', 'styleCcSheet', 'buildQualityAffiliationWorkbook',
  'groupQualityRecordsByAffiliation', 'toSafeExcelSheetName', 'exportCcResult'
];

function newElement(id) {
  var cls = { hidden: true };
  return {
    id: id, textContent: '', innerHTML: '', value: '', disabled: true,
    classList: {
      add: function (c) { cls[c] = true; },
      remove: function (c) { delete cls[c]; },
      contains: function (c) { return !!cls[c]; },
      toggle: function (c, on) { if (on) cls[c] = true; else delete cls[c]; }
    }
  };
}

function buildSandbox(master) {
  var elements = {};
  var alerts = [];
  var writes = [];
  var XLSXProxy = {
    utils: XLSX.utils,
    read: XLSX.read,
    write: XLSX.write,
    writeFile: function (wb, name) { writes.push({ wb: wb, name: name }); }
  };
  var sandbox = {
    console: console,
    XLSX: XLSXProxy,
    alert: function (m) { alerts.push(String(m)); },
    document: {
      getElementById: function (id) {
        if (!elements[id]) elements[id] = newElement(id);
        return elements[id];
      }
    },
    transportIDs: master || {},
    ccResultData: [],
    exportedQualityCounts: {},
    ccV1Result: null,
    ccV1MissingColumns: null,
    ccV1Tab: '__all__',
    ccV1TabList: [],
    ccV1DaSel: null,
    ccV1DaView: [],
    getTodayJst: function () { return '2026-10-07'; },
    escapeHtml: function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
    latFormatDate: function (s) { return String(s || '').replace(/-/g, '/'); },
    driverDepartments: {},
    resolveQualityAffiliationByKeys: function () { return ''; }, // 従来指標Excel側（CC Ver.1 の所属判定では使わない）
    resolveDriverKey: function (n) { return n; },
    ccV1SourceRows: null,
    ccMasterSync: { state: 'none', at: 0, reason: '' },
    ccMasterSyncWaiters: null,
    CC_MASTER_SYNC_TIMEOUT_MS: 400,
    setTimeout: setTimeout,
    handleCcFileImpl: function (f) { sandbox.__impl = (sandbox.__impl || []).concat(['cc:' + f + ':' + sandbox.ccMasterSync.state]); },
    handleFtdsFileImpl: function (f) { sandbox.__impl = (sandbox.__impl || []).concat(['ftds:' + f + ':' + sandbox.ccMasterSync.state]); },
    ccV1MasterSig: '',
    ccV1AffStats: null,
    renderCcResultsUI: function () { sandbox.__legacyRendered = true; } // 従来指標の描画（DOM）だけ省略
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(coreSource, sandbox);
  var depStart = html.indexOf('    var DEPARTMENTS = [');
  var code = html.slice(depStart, html.indexOf('];', depStart) + 2) + '\n'
    + extractVarObject(html, 'REASON_JA') + '\n'
    + extractVarObject(html, 'CC_V1_RATE_LEVEL_COLORS') + '\n';
  for (var i = 0; i < FUNCTIONS.length; i++) code += extractFunction(html, FUNCTIONS[i]) + '\n';
  vm.runInContext(code, sandbox);
  return { sandbox: sandbox, elements: elements, alerts: alerts, writes: writes };
}

function wk40Rows() {
  var csv = readFileSync(join(root, 'tests/fixtures/contact-compliance/wk40-ofk3-contact-compliance-sanitized.csv'), 'utf8');
  var wb = XLSX.read(csv, { type: 'string', raw: true });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: true });
}

function dropColumns(rows, names) {
  var idx = [];
  rows[0].forEach(function (h, i) { if (names.indexOf(h) < 0) idx.push(i); });
  return rows.map(function (r) { return idx.map(function (i) { return r[i]; }); });
}

function roundTrip(wb) {
  return XLSX.read(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });
}

function summaryOf(wb) {
  var rows = XLSX.utils.sheet_to_json(wb.Sheets['CCサマリー'], { header: 1, raw: true });
  var out = {};
  rows.forEach(function (r, i) {
    var cell = wb.Sheets['CCサマリー'][XLSX.utils.encode_cell({ r: i, c: 1 })];
    out[r[0]] = { v: r[1], w: cell ? cell.w : undefined };
  });
  return out;
}

// ---- 画面の導線（静的確認） ----
function testButtonsAreSeparated() {
  var header = html.slice(html.indexOf('id="panel-ftds"'), html.indexOf('<!-- Drop zones -->'));
  assert(/id="cc-v1-export-btn"[^>]*>📊 CC Ver\.1 Excel出力</.test(header), 'ヘッダーに「📊 CC Ver.1 Excel出力」');
  assert(/onclick="exportCcV1Result\(\)" id="cc-v1-export-btn" disabled/.test(header), 'CC Ver.1 ボタンは exportCcV1Result・初期は無効');
  assert(/onclick="exportCcResult\(\)" id="cc-export-btn" disabled[^>]*>📞 従来架電実績 Excel出力</.test(header), '旧ボタンは「📞 従来架電実績 Excel出力」');
  assert(header.indexOf('cc-v1-export-btn') < header.indexOf('cc-export-btn'), 'CC Ver.1 ボタンが主（先に配置）');
  assert(html.indexOf('>CC エクスポート<') < 0, '旧ラベル「CC エクスポート」は残っていない');
  assert((html.match(/id="cc-v1-export-btn"/g) || []).length === 1, 'CC Ver.1 ボタンは1つだけ');
  assert(html.indexOf("'ContactCompliance分析_' + getTodayJst() + '.xlsx'") < 0, '旧Excelを ContactCompliance分析_ の名前で出さない');
  var exportV1 = extractFunction(html, 'exportCcV1Result');
  assert(exportV1.indexOf('ccResultData') < 0 && exportV1.indexOf('buildCcAoa') < 0 && exportV1.indexOf('exportedQualityCounts') < 0,
    'CC Ver.1 出力は従来指標データを参照しない');
  assert(exportV1.indexOf('ContactComplianceCore.buildCcExportWorkbook') >= 0, 'CC Ver.1 出力は core の集計結果から作る');
}

// ---- Test 1/2/3/5: Wk40 raw → 画面とCC Ver.1 Excelが一致・5シート・NC 122行・ファイル名 ----
function testWk40ScreenAndV1Excel() {
  var t = buildSandbox({ 'テスト 太郎': 'A8JSA661WQ3ZH' });
  var status = t.sandbox.processCcData(wk40Rows());
  assert(status.legacyOk === true && status.v1.ok === true, 'Wk40 取込: 従来指標・CC Ver.1 とも成功');
  var screen = {
    rate: t.elements['cc-v1-rate'].innerHTML,
    total: String(t.elements['cc-v1-total'].textContent),
    compliant: String(t.elements['cc-v1-compliant'].textContent),
    nonCompliant: String(t.elements['cc-v1-noncompliant'].textContent)
  };
  assert(screen.rate === '78.78%' && screen.total === '575' && screen.compliant === '453' && screen.nonCompliant === '122',
    '画面 575/453/122/78.78%: ' + JSON.stringify(screen));
  assert(t.elements['cc-v1-export-btn'].disabled === false, 'raw data 取込後は CC Ver.1 ボタンが有効');
  assert(t.elements['cc-v1-export-status'].textContent.indexOf('出力可能') >= 0, '状態表示: 出力可能');

  t.sandbox.exportCcV1Result();
  assert(t.writes.length === 1, 'CC Ver.1 Excel を1ファイル出力');
  var v1Name = t.writes[0].name;
  assert(v1Name === 'CC_Ver1分析_2026-10-07.xlsx', 'CC Ver.1 ファイル名: ' + v1Name);
  var wb = roundTrip(t.writes[0].wb);
  assert(wb.SheetNames.join() === '全体,所属未判定,CCサマリー,所属別サマリー,所属別DA分析,理由別,DA別,日別,Non-Compliant明細', 'Test 2: 全体・所属別シート＋7分析シート ' + wb.SheetNames);
  var sum = summaryOf(wb);
  var excel = { rate: sum['CC率'].w, total: String(sum['CC対象件数'].v), compliant: String(sum['Compliant件数'].v), nonCompliant: String(sum['Non-Compliant件数'].v) };
  assert(JSON.stringify(excel) === JSON.stringify(screen), 'Test 1: 画面とExcelが一致 screen=' + JSON.stringify(screen) + ' excel=' + JSON.stringify(excel));
  assert(sum['Logic Version'].v === 'CC Logic Ver.1', 'Logic Version');
  var nc = XLSX.utils.sheet_to_json(wb.Sheets['Non-Compliant明細'], { header: 1, raw: true });
  assert(nc.length - 1 === 122, 'Test 3: Non-Compliant明細 122行, got ' + (nc.length - 1));
  console.log('  screen ' + JSON.stringify(screen) + ' / excel ' + JSON.stringify(excel) + ' / NC rows ' + (nc.length - 1));

  // Test 4/5: 同じ取込状態で旧Excelを出すと従来指標、ファイル名も別
  t.sandbox.exportCcResult();
  assert(t.writes.length === 2, '旧Excel も出力できる');
  var oldName = t.writes[1].name;
  assert(oldName === '従来架電実績分析_2026-10-07.xlsx', '旧Excel ファイル名: ' + oldName);
  assert(oldName !== v1Name, 'Test 5: 新旧のファイル名が異なる');
  var oldWb = roundTrip(t.writes[1].wb);
  assert(oldWb.SheetNames[0] === '全体データ', '旧Excel は従来どおり「全体データ」シートから');
  var oldHeader = XLSX.utils.sheet_to_json(oldWb.Sheets['全体データ'], { header: 1, raw: true })[0];
  assert(oldHeader.join() === 'ドライバー名,TransportID,べき架電,実架電,架電率(%),通話時間(秒),日付,配送理由内訳',
    'Test 4: 旧Excel は従来指標の列: ' + oldHeader);
  assert(oldWb.SheetNames.indexOf('CCサマリー') < 0, '旧Excel に CC Ver.1 シートは混ざらない');
}

// ---- Test 6: raw data 未読込なら CC Ver.1 Excel を出せない（従来指標データがあっても） ----
function testV1ExportBlockedWithoutRawData() {
  var t = buildSandbox();
  t.sandbox.ccResultData = [{ date: '2026-09-27', driverName: 'A', transporterId: 'T1', tracking: '', reason: 'CUSTOMER_UNAVAILABLE', method: '', contactType: 'Calls to Customer', duration: 10 }];
  t.sandbox.exportedQualityCounts = { A: { ccRequired: 3, ccActual: 2 } };
  t.sandbox.clearCcV1();
  assert(t.elements['cc-v1-export-btn'].disabled === true, '未読込ではボタン無効');
  assert(t.elements['cc-v1-export-status'].textContent.indexOf('Amazon Contact Compliance raw dataを読み込んでください') >= 0, '未読込の理由を表示');
  t.sandbox.exportCcV1Result();
  assert(t.writes.length === 0, 'Test 6: CC Ver.1 Excel を出力しない');
  assert(t.alerts.length === 1 && t.alerts[0].indexOf('raw dataを読み込んでください') >= 0, '理由をalert: ' + t.alerts[0]);
}

// ---- Test 7: 必須列不足時に従来指標へフォールバックしない ----
function testNoFallbackWhenColumnsMissing() {
  var t = buildSandbox();
  var status = t.sandbox.processCcData(dropColumns(wk40Rows(), ['Text Event', 'Destination Address ID']));
  assert(status.legacyOk === true && status.v1.ok === false, '従来指標は利用可能・CC Ver.1 は算出不可');
  assert(status.v1.missing.join() === 'Destination Address ID,Text Event', '不足列: ' + status.v1.missing);
  assert(t.sandbox.ccResultData.length > 0, '従来指標のデータは読み込まれている');
  assert(t.elements['cc-v1-export-btn'].disabled === true, 'CC Ver.1 ボタンは無効のまま');
  var st = t.elements['cc-v1-export-status'].textContent;
  assert(st.indexOf('必須列不足のため算出不可') >= 0 && st.indexOf('Text Event') >= 0, '状態表示: CC Ver.1 算出不可と不足列: ' + st);
  t.sandbox.exportCcV1Result();
  assert(t.writes.length === 0, 'Test 7: 従来指標の Excel を代わりに出さない');
  assert(t.alerts.length === 1 && t.alerts[0].indexOf('必須列不足') >= 0 && t.alerts[0].indexOf('Destination Address ID') >= 0, 'alert に不足列: ' + t.alerts[0]);

  // その後 raw data を読み込めば CC Ver.1 が使えるようになる
  t.sandbox.processCcData(wk40Rows());
  assert(t.elements['cc-v1-export-btn'].disabled === false && t.sandbox.ccV1MissingColumns === null, '正しいファイルで復帰');
}

// ---- 従来指標Excelの再取込（協力会社ダッシュボード一括読込）が新ファイル名でも CC 取込へ回る ----
function testBulkImportRoutesLegacyName() {
  var fn = extractFunction(html, 'handleTeamQualityBulkFiles');
  var end = fn.indexOf(') handleCcFile(file);');
  var begin = fn.lastIndexOf('else if (', end);
  assert(end > 0 && begin > 0, 'xlsx の CC ルーティング行がある');
  var test = new Function('fname', 'return ' + fn.slice(begin + 'else if ('.length, end) + ';');
  assert(test('従来架電実績分析_2026-10-07.xlsx'), '新しい旧指標ファイル名も CC 取込へ');
  assert(test('contactcompliance分析_2026-10-07.xlsx') && test('cc_ver1分析_2026-10-07.xlsx'), '既存の名前も従来どおり');
  assert(!test('ftds分析_2026-10-07.xlsx'), 'FTDS は対象外');
}

// ---- 所属別タブ（W36方式）: 全体｜所属…｜所属競合｜所属未判定 ----
function testAffiliationTabs() {
  var rows = wk40Rows();
  var tids = Array.from(new Set(rows.slice(1).map(function (r) { return r[5]; }))).filter(Boolean);
  var master = {}; var depts = {};
  tids.forEach(function (tid, i) {
    master['DA' + i] = tid;
    if (i % 3 !== 0) depts['DA' + i] = i % 3 === 1 ? 'JHS' : 'AE物流'; // 3人に1人は所属マスタ無し
  });
  var t = buildSandbox(master);
  t.sandbox.driverDepartments = depts;
  var res = t.sandbox.renderCcV1FromRows(wk40Rows());
  assert(res.ok, '算出成功');
  var r = t.sandbox.ccV1Result;
  assert(r.summary.total === 575 && r.summary.compliant === 453 && r.summary.nonCompliant === 122, 'Wk40の全体値は不変');
  var tabsHtml = function () { return t.elements['cc-v1-aff-tabs'].innerHTML; };
  var body = function () { return t.elements['cc-v1-aff-body'].innerHTML; };
  var tabLabels = t.sandbox.ccV1TabList.map(function (x) { return x.label; });
  assert(tabLabels.join() === '全体,JHS,AE物流,所属未判定', 'タブはマスタの所属から動的生成（マスタ順→所属未判定）: ' + tabLabels);
  assert(t.sandbox.ccV1Tab === '__all__' && /全体/.test(tabsHtml()), '最初は全体タブ');

  // 全体タブ: 全DAを最初から表示・所属列あり・10項目
  var head = body().slice(0, body().indexOf('</thead>'));
  ['DA名', 'Transporter ID', '所属', '対象', 'Compliant', 'Non-Compliant', 'CC率', '不在', '配達先アクセス不可', '住所不明', '安全な置き場所なし'].forEach(function (h) {
    assert(head.indexOf('>' + h) >= 0, '全体タブの列: ' + h);
  });
  var allRows = (body().match(/onclick="ccV1SelectDa\(/g) || []).length;
  assert(allRows === r.byDriver.length, '全体タブに全DA(' + r.byDriver.length + '名)を表示: ' + allRows);
  assert(/（NC \d+）/.test(body()), '理由別にNC件数を併記');
  assert(body().indexOf('所属未判定') >= 0, '全体タブの所属列に所属未判定');

  // 各所属タブ: そのDA全員・所属列なし・上部に所属合計
  t.sandbox.ccV1SelectTab(1);
  var tab = t.sandbox.ccV1TabList[1];
  assert(tab.label === 'JHS' && t.sandbox.ccV1Tab === 'JHS', 'JHSタブ選択');
  var g = r.byAffiliation.filter(function (a) { return a.affiliation === 'JHS'; })[0];
  assert((body().match(/onclick="ccV1SelectDa\(/g) || []).length === g.drivers.length, '所属に該当するDA全員を最初から表示');
  var head2 = body().slice(0, body().indexOf('</thead>'));
  assert(head2.indexOf('>所属<') < 0, '所属タブには所属列なし');
  assert(body().indexOf('JHS CC率') >= 0, 'タブ上部に所属合計(CC率)');
  var top = body().slice(0, body().indexOf('<table'));
  [g.total, g.compliant, g.nonCompliant].forEach(function (n) { assert(top.indexOf('>' + n + '<') >= 0, 'タブ上部に所属合計 ' + n); });
  assert(top.indexOf(t.sandbox.ContactComplianceCore.formatCcRate(g.rate)) >= 0, 'タブ上部のCC率');
  // 合計行(理由別含む)
  var totalRow = body().slice(body().lastIndexOf('<tr class="bg-surface font-bold">'));
  assert(totalRow.indexOf('>' + g.total + '<') >= 0 && totalRow.indexOf('>' + g.nonCompliant + '<') >= 0, '合計行は所属合計と一致');

  // 所属未判定タブ
  var ui = t.sandbox.ccV1TabList.map(function (x) { return x.label; }).indexOf('所属未判定');
  t.sandbox.ccV1SelectTab(ui);
  assert(t.sandbox.ccV1TabList[ui].kind === 'unknown' && body().indexOf('ドライバーマスタに未登録') >= 0, '所属未判定タブ');
  assert(/bg-red-600/.test(tabsHtml()), '所属未判定タブは強調色');

  // DA詳細（階層クリックは詳細表示として残す）
  t.sandbox.ccV1SelectTab(0);
  t.sandbox.ccV1SelectDa(0);
  var detail = t.elements['cc-v1-da-detail'].innerHTML;
  var da = t.sandbox.ccV1DaView[0];
  assert(/の詳細/.test(detail) && detail.indexOf('非適合明細（' + da.nonCompliant + '件）') >= 0 && detail.indexOf('不在') >= 0, 'DA詳細: 理由別内訳と非適合明細');
  t.sandbox.ccV1SelectDa(0);
  assert(t.elements['cc-v1-da-detail'].innerHTML === '', '再クリックで詳細を閉じる');

  // 並び替え
  t.elements['cc-v1-aff-sort'].value = 'rateAsc';
  t.sandbox.renderCcV1Affiliation();
  var v = t.sandbox.ccV1DaView;
  for (var i = 1; i < v.length; i++) assert(v[i - 1].rate <= v[i].rate, 'CC率昇順');

  // 選択中のタブがマスタ更新後の再判定で消えた場合は全体へ戻る
  t.sandbox.ccV1Tab = '存在しない所属';
  t.sandbox.renderCcV1Affiliation();
  assert(t.sandbox.ccV1Tab === '__all__', '存在しないタブは全体へ');
}

// ---- マスタ参照: 同一データソース・表記ゆれ・マスタ更新後の再判定・所属未判定の条件 ----
function testMasterLookup() {
  var rows = [['Event Date', 'Scannable ID', 'Destination Address ID', 'Transporter ID', 'Shipment Reason', 'Call Event', 'Text Event']];
  function add(tid, reason, call) { rows.push(['2026-10-04', 'S' + rows.length, 'D' + rows.length, tid, reason, call ? 'Calls to Customer' : '', '']); }
  var U = 'CUSTOMER_UNAVAILABLE';
  add('A1B2C3', U, true); add('A1B2C3', U, false);          // 完全一致
  add('  a1b2c3\u00a0', U, false);                           // 小文字・空白・NBSP → 同一DA(A1B2C3)に統合されない行は別TID扱いだが所属は同じ
  add('Ａ２Ｂ３', U, false);                                   // 全角 → A2B3
  add('A3-4 5', U, true);                                     // ハイフン・空白 → A345
  add('A5NODEPT', U, false);                                  // マスタ登録済・所属未設定
  add('A6GHOST', U, false);                                   // マスタ未登録
  add('', U, false);                                          // ID空
  // マスタ（実アプリと同じ: 氏名→TID / 氏名→所属）。TIDは型・表記がまちまち。
  var master = { '甲': ' A1B2C3 ', '乙': 'a2b3', '丙': 'A345', '丁': 'A5NODEPT', '戊': 12345 };
  var t = buildSandbox(master);
  t.sandbox.driverDepartments = { '甲': 'JHS', '乙': 'AE物流', '丙': 'JHS', '戊': 'OFK6' };

  var before = null;
  var res = t.sandbox.renderCcV1FromRows(rows);
  assert(res.ok, '算出成功');
  var r = t.sandbox.ccV1Result;
  var affOf = function (r2, tidNorm) {
    var f = null;
    r2.byAffiliation.forEach(function (a) { a.drivers.forEach(function (d) { if (t.sandbox.normalizeCcTid(d.transporterId) === t.sandbox.normalizeCcTid(tidNorm)) f = a.affiliation; }); });
    return f;
  };
  assert(affOf(r, 'A1B2C3') === 'JHS', '小文字・前後空白・NBSP付きIDでも照合: ' + affOf(r, 'A1B2C3'));
  assert(affOf(r, 'A2B3') === 'AE物流', '全角IDでも照合');
  assert(affOf(r, 'A3-45') === 'JHS', 'ハイフン・空白入りでも照合');
  assert(affOf(r, 'A5NODEPT') === '所属未判定' && affOf(r, 'A6GHOST') === '所属未判定', '所属未設定・未登録は所属未判定');
  var unk = r.byAffiliation.filter(function (a) { return a.affiliation === '所属未判定'; })[0];
  assert(unk.total === 3 && unk.drivers.length === 3, '所属未判定=所属未設定1+未登録1+ID空1 の3DA/3件: ' + unk.total);
  // 名前もマスタから解決される（照合に成功したDAは「未特定」にならない）
  var named = r.byDriver.filter(function (d) { return d.identified; }).length;
  assert(named === 5, 'マスタ照合できたDA名が解決される: ' + named);
  var st = t.sandbox.ccV1AffStats;
  assert(st.ok === 4 && st.noDept === 1 && st.notInMaster === 2, '所属判定内訳: ' + JSON.stringify(st));
  assert(r.summary.total === 8 && r.summary.compliant === 2 && r.summary.nonCompliant === 6, 'CC件数は照合結果に依存しない');

  // マスタ更新 → 再判定で最新の所属が反映（CC件数・率は不変）
  var sig1 = t.sandbox.ccV1MasterSig;
  assert(sig1 === t.sandbox.ccV1MasterSignature(), '署名は未更新なら同じ');
  t.sandbox.driverDepartments['丁'] = 'GDSパート';          // 所属を設定
  t.sandbox.transportIDs['己'] = 'A6GHOST';                  // 未登録DAを新規登録
  t.sandbox.driverDepartments['己'] = 'JHS';
  t.sandbox.driverDepartments['甲'] = 'AGENTLINE';           // 所属変更
  assert(sig1 !== t.sandbox.ccV1MasterSignature(), 'マスタ更新で署名が変わる');
  var totalBefore = JSON.stringify(r.summary);
  assert(t.sandbox.refreshCcV1Affiliation() === true, '再判定を実行');
  var r2 = t.sandbox.ccV1Result;
  assert(JSON.stringify(r2.summary) === totalBefore, '再判定でCC件数・CC率は不変');
  assert(affOf(r2, 'A1B2C3') === 'AGENTLINE' && affOf(r2, 'A5NODEPT') === 'GDSパート' && affOf(r2, 'A6GHOST') === 'JHS', '更新後のマスタが反映');
  var unk2 = r2.byAffiliation.filter(function (a) { return a.affiliation === '所属未判定'; })[0];
  assert(unk2.total === 1 && unk2.drivers.length === 1, '残る所属未判定はID空のみ');
  assert(t.sandbox.ccV1MasterSig === t.sandbox.ccV1MasterSignature(), '再判定後は署名が最新');
  assert(r2.aggregationCheck.ok, '再判定後も集計整合');
}

// 画面タブ切替で、マスタ更新を検知して再判定される・マスタ管理機能に変更が無い
function testMasterNotModified() {
  var sw = extractFunction(html, 'switchTab');
  assert(/ccV1MasterSig !== ccV1MasterSignature\(\)/.test(sw), 'FTDS/CCタブ表示時にマスタ更新を検知して再判定');
  var helpers = ['normalizeCcTid', 'ccV1MasterSignature', 'buildCcMasterLookup', 'summarizeCcAffiliationStatus'].map(function (n) { return extractFunction(html, n); }).join('\n');
  assert(!/(transportIDs|driverDepartments)\s*(\[[^\]]*\])?\s*=[^=]/.test(helpers) && helpers.indexOf('localStorage') < 0 && helpers.indexOf('delete ') < 0,
    'CCの所属判定はマスタを読むだけ（書き込み・削除・保存をしない）');
}

// ---- Transporter ID 重複登録: 同一所属は正常 / 異なる所属は「所属競合」（自動振り分けしない） ----
function testDuplicateIdConflict() {
  var rows = [['Event Date', 'Scannable ID', 'Destination Address ID', 'Transporter ID', 'Shipment Reason', 'Call Event', 'Text Event']];
  function add(tid, call) { rows.push(['2026-10-04', 'S' + rows.length, 'D' + rows.length, tid, 'CUSTOMER_UNAVAILABLE', call ? 'Calls to Customer' : '', '']); }
  add('SAME1', true); add('SAME1', false);            // 同一ID・同一所属(2登録)
  add('BLANK1', false);                                // 同一ID・片方は所属空
  add('CONF1', false); add('CONF1', false); add('CONF1', true); // 同一ID・異なる所属
  add('SOLO1', true);
  var master = { '甲': 'SAME1', '甲別表記': ' same1 ', '乙': 'BLANK1', '乙別表記': 'BLANK1', '丙': 'CONF1', '丙別表記': 'conf1', '丁': 'SOLO1' };
  var depts = { '甲': 'JHS', '甲別表記': 'JHS', '乙': 'AE物流', '乙別表記': '', '丙': 'JHS', '丙別表記': 'AE物流', '丁': 'JHS' };
  var t = buildSandbox(master);
  t.sandbox.driverDepartments = depts;
  assert(t.sandbox.renderCcV1FromRows(rows).ok, '算出成功');
  var r = t.sandbox.ccV1Result;
  var grp = function (n) { return r.byAffiliation.filter(function (a) { return a.affiliation === n; })[0]; };
  var tids = function (a) { return a.drivers.map(function (d) { return d.transporterId; }).sort().join(); };
  assert(tids(grp('JHS')) === 'SAME1,SOLO1', '同一ID・同一所属は正常にJHS: ' + tids(grp('JHS')));
  assert(tids(grp('AE物流')) === 'BLANK1', '片方が所属空でも競合にしない（所属ありの登録を採用）');
  var c = grp('所属競合');
  assert(c && c.conflict && tids(c) === 'CONF1' && c.total === 3 && c.nonCompliant === 2, '異なる所属は「所属競合」へ（JHS/AE物流のどちらにも入れない）');
  assert(c.drivers[0].affiliationCandidates.join() === 'AE物流,JHS', '候補所属を保持: ' + c.drivers[0].affiliationCandidates);
  assert(grp('JHS').drivers.every(function (d) { return d.transporterId !== 'CONF1'; }) && grp('AE物流').drivers.every(function (d) { return d.transporterId !== 'CONF1'; }), '競合IDは特定所属に自動振り分けしない');
  var st = t.sandbox.ccV1AffStats;
  assert(st.conflict === 1 && st.ok === 3 && st.noDept === 0 && st.duplicateSame === 2 && st.duplicateConflict === 1, '内訳: ' + JSON.stringify(st));
  assert(r.summary.total === 7 && r.summary.compliant === 3 && r.summary.nonCompliant === 4, 'CC件数は競合に影響されない');
  assert(r.aggregationCheck.ok, '競合ありでも集計整合');
  // 競合の有無でCC計算が変わらない: マスタ無しで解析した結果と summary/byReason/byDriver が一致
  var base = Cc2().analyzeCcRows(rows, null);
  assert(JSON.stringify(base.summary) === JSON.stringify(r.summary) && JSON.stringify(base.byReason) === JSON.stringify(r.byReason), 'CC率・理由別はマスタに依存しない');
  // 画面
  t.sandbox.renderCcV1Affiliation();
  var body = t.elements['cc-v1-aff-body'].innerHTML;
  assert(body.indexOf('所属競合') >= 0 && body.indexOf('bg-amber-50') >= 0, '全体タブに所属競合を強調表示');
  var ci = t.sandbox.ccV1TabList.map(function (x) { return x.label; }).indexOf('所属競合');
  assert(ci > 0 && t.sandbox.ccV1TabList[ci].kind === 'conflict' && /bg-amber/.test(t.elements['cc-v1-aff-tabs'].innerHTML) === false, '所属競合は独立タブ');
  t.sandbox.ccV1SelectTab(ci);
  assert(t.elements['cc-v1-aff-body'].innerHTML.indexOf('候補: AE物流 / JHS') >= 0, '所属競合タブに候補を併記');
  assert(/bg-amber-600/.test(t.elements['cc-v1-aff-tabs'].innerHTML), '所属競合タブは選択時に琥珀色');
  assert(t.elements['cc-v1-aff-check'].innerHTML.indexOf('所属競合 1名') >= 0, '内訳に所属競合');
  // Excel
  var wb = roundTrip(t.sandbox.ContactComplianceCore.buildCcExportWorkbook(XLSX, r));
  var aoa = function (n) { return XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: '', raw: true }); };
  var sum = {}; aoa('CCサマリー').forEach(function (x) { sum[x[0]] = x[1]; });
  assert(sum['所属競合DA数'] === 1 && sum['CC対象件数'] === 7 && sum['CC率'] === 42.86, 'サマリーに競合DA数・CC率維持: ' + JSON.stringify(sum));
  assert(aoa('所属別サマリー').some(function (x) { return x[0] === '所属競合' && x[2] === 3; }), '所属別サマリーに所属競合行');
  var da = aoa('所属別DA分析').filter(function (x) { return x[0] === '所属競合'; });
  assert(da.length === 1 && da[0][12] === 'AE物流 / JHS', '所属別DA分析に候補所属: ' + JSON.stringify(da));
  assert(aoa('Non-Compliant明細').filter(function (x) { return x[10] === '所属競合'; }).length === 2, '明細の所属列にも所属競合');
}

function Cc2() { return require('../contact-compliance-core.js'); }

// ---- 分析開始時のマスタ同期（既存 loadMasterFromServer を利用。失敗は警告・古いマスタを最新扱いしない・CC結果は不変） ----
async function testMasterSyncOnAnalysisStart() {
  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var master = { '甲': 'T1' };
  // 成功: 完了後に取込が始まり、状態は fresh・警告なし
  var ok = buildSandbox(master);
  ok.sandbox.driverDepartments = { '甲': 'JHS' };
  var calls = 0;
  ok.sandbox.loadMasterFromServer = function () {
    calls++;
    setTimeout(function () { ok.sandbox.driverDepartments['甲'] = 'AGENTLINE'; ok.sandbox.window.__ofk3MasterLoadStatus = { completedAt: Date.now(), driverCount: 3, updated: true }; }, 120);
  };
  ok.sandbox.handleCcFile('a.xlsx');
  assert(!ok.sandbox.__impl, '同期完了前は取込を始めない');
  await wait(450);
  assert(calls === 1 && ok.sandbox.__impl && ok.sandbox.__impl[0] === 'cc:a.xlsx:fresh', '同期完了後に取込開始(fresh): ' + JSON.stringify(ok.sandbox.__impl));
  assert(ok.elements['master-sync-warning'].classList.contains('hidden'), '成功時は警告なし');
  assert(/最新/.test(ok.sandbox.ccMasterSyncLabel()), '最新ラベル');

  // 失敗: 応答なし → タイムアウトで stale。警告表示・取込は続行・古いマスタを最新と表示しない
  var ng = buildSandbox(master);
  ng.sandbox.driverDepartments = { '甲': 'JHS' };
  ng.sandbox.loadMasterFromServer = function () { /* オフライン: 何も起きない */ };
  ng.sandbox.window.__ofk3MasterLoadStatus = { completedAt: Date.now() - 100000, driverCount: 9 }; // 過去の成功記録
  ng.sandbox.handleFtdsFile('b.csv');
  await wait(800);
  assert(ng.sandbox.__impl && ng.sandbox.__impl[0] === 'ftds:b.csv:stale', '失敗でも取込は続行(stale): ' + JSON.stringify(ng.sandbox.__impl));
  var warn = ng.elements['master-sync-warning'];
  assert(!warn.classList.contains('hidden') && /最新のドライバーマスタを取得できませんでした/.test(warn.innerHTML) && /CC率などの計算結果には影響しません/.test(warn.innerHTML), '同期失敗の警告を表示');
  assert(ng.sandbox.window.__ofk3MasterLoadStatus.driverCount === 9, '過去の成功記録を最新として扱わず、かつ壊さない');
  assert(/未同期/.test(ng.sandbox.ccMasterSyncLabel()) && !/^最新/.test(ng.sandbox.ccMasterSyncLabel()), '古いローカルマスタを「最新」と表示しない');

  // 同期有無でCC計算結果は変わらない（所属の振り分けのみ変わり得る）。Excelに同期状態を残す。
  var rows = wk40Rows();
  var a = buildSandbox({ 'DA0': rows[1][5] }); a.sandbox.driverDepartments = { 'DA0': 'JHS' };
  var b = buildSandbox({ 'DA0': rows[1][5] }); b.sandbox.driverDepartments = { 'DA0': 'AE物流' };
  a.sandbox.ccMasterSync = { state: 'fresh', at: Date.now(), reason: '' };
  b.sandbox.ccMasterSync = { state: 'stale', at: Date.now(), reason: 'x' };
  a.sandbox.renderCcV1FromRows(wk40Rows()); b.sandbox.renderCcV1FromRows(wk40Rows());
  var ra = a.sandbox.ccV1Result, rb = b.sandbox.ccV1Result;
  assert(JSON.stringify(ra.summary) === JSON.stringify(rb.summary) && JSON.stringify(ra.byReason) === JSON.stringify(rb.byReason) &&
    JSON.stringify(ra.byDate) === JSON.stringify(rb.byDate) && ra.summary.total === 575 && ra.summary.nonCompliant === 122, '同期状態・マスタ内容でCC計算結果は不変(575/453/122)');
  var cell = function (t2) {
    var w = roundTrip(t2.sandbox.ContactComplianceCore.buildCcExportWorkbook(XLSX, t2.sandbox.ccV1Result));
    var v = {}; XLSX.utils.sheet_to_json(w.Sheets['CCサマリー'], { header: 1, defval: '' }).forEach(function (x) { v[x[0]] = x[1]; }); return v['マスタ同期状態'];
  };
  assert(/^最新/.test(cell(a)) && /^未同期/.test(cell(b)), 'Excelのサマリーにマスタ同期状態: ' + cell(a) + ' / ' + cell(b));

  // 実装の静的確認: 既存の保存・マージには触れない
  var fn = ['syncMasterBeforeAnalysis', 'finishMasterSync', 'renderMasterSyncWarning'].map(function (n) { return extractFunction(html, n); }).join('\n');
  assert(fn.indexOf('localStorage') < 0 && !/(transportIDs|driverDepartments|driverDB|lineMapping)\s*(\[[^\]]*\])?\s*=[^=]/.test(fn), '同期処理はマスタを書き換えない（既存の loadMasterFromServer に任せる）');
  assert(fn.indexOf('loadMasterFromServer()') >= 0, '既存の同期機構 loadMasterFromServer を呼ぶ');
}

// ---- 画面の所属別タブとExcelの所属別シートが一致（同じ分類・集計結果を使用）。実際の出力ボタン経路で検証 ----
function testScreenTabsMatchExcel() {
  var rows = wk40Rows();
  var tids = Array.from(new Set(rows.slice(1).map(function (r) { return r[5]; }))).filter(Boolean);
  var master = {}; var depts = {};
  tids.forEach(function (tid, i) {
    master['DA' + i] = tid;
    if (i % 4 !== 0) depts['DA' + i] = ['GDSダイレクト', 'JHS', 'AE物流'][i % 3];
  });
  master['重複'] = tids[1]; depts['重複'] = 'OFK6'; // tids[1] は JHS... と OFK6 に二重登録 → 所属競合
  var t = buildSandbox(master);
  t.sandbox.driverDepartments = depts;
  assert(t.sandbox.renderCcV1FromRows(wk40Rows()).ok, '算出成功');
  t.sandbox.exportCcV1Result();
  assert(t.writes.length === 1, '従来どおり1ファイル出力');
  var wb = roundTrip(t.writes[0].wb);
  var tabs = t.sandbox.ccV1TabList;
  assert(tabs.length >= 4 && tabs.some(function (x) { return x.kind === 'conflict'; }) && tabs.some(function (x) { return x.kind === 'unknown'; }), '競合・未判定タブを含む: ' + tabs.map(function (x) { return x.label; }));
  assert(wb.SheetNames.slice(0, tabs.length).join() === tabs.map(function (x) { return x.label; }).join(), '画面のタブ順 = Excelのシート順');
  assert(wb.SheetNames.slice(tabs.length).join() === 'CCサマリー,所属別サマリー,所属別DA分析,理由別,DA別,日別,Non-Compliant明細', '続けて既存7分析シート');
  var sel = t.elements['cc-v1-aff-sort'];
  tabs.forEach(function (tab, i) {
    t.sandbox.ccV1SelectTab(i);
    var screenRows = t.sandbox.ccV1DaView;
    var a = XLSX.utils.sheet_to_json(wb.Sheets[tab.label], { header: 1, defval: '', raw: true });
    var body = a.slice(5, -1);
    assert(body.length === screenRows.length, 'DA行数が画面と一致: ' + tab.label + ' ' + body.length + '/' + screenRows.length);
    var o = tab.kind === 'all' ? 1 : 0;
    screenRows.forEach(function (d, k) {
      var x = body[k];
      assert(x[0] === d.driverName && x[1] === d.transporterId && x[2 + o] === d.total && x[3 + o] === d.compliant && x[4 + o] === d.nonCompliant, '行内容が画面と一致: ' + tab.label + ' ' + d.transporterId);
    });
    assert(a[2][1] === tab.total && a[2][3] === tab.nonCompliant, 'タブ合計が画面と一致: ' + tab.label);
  });
  var all = tabs[0];
  var sumOthers = tabs.slice(1).reduce(function (s, x) { return s + x.total; }, 0);
  assert(all.total === 575 && sumOthers === 575, '全体575 = 所属別合計（競合・未判定含む）: ' + sumOthers);
  var summary = XLSX.utils.sheet_to_json(wb.Sheets['CCサマリー'], { header: 1, defval: '' }).filter(function (x) { return x[0] === 'CC対象件数'; })[0];
  assert(summary[1] === 575, '既存CCサマリーは従来どおり');
}

var tests = [testButtonsAreSeparated, testWk40ScreenAndV1Excel, testV1ExportBlockedWithoutRawData, testNoFallbackWhenColumnsMissing, testBulkImportRoutesLegacyName, testAffiliationTabs, testMasterLookup, testMasterNotModified, testDuplicateIdConflict, testMasterSyncOnAnalysisStart, testScreenTabsMatchExcel];
for (var i = 0; i < tests.length; i++) {
  await tests[i]();
  console.log('PASS ' + tests[i].name);
}
console.log('cc-export-ui tests passed (' + tests.length + ')');
