// 追加荷物・近隣コース検索 コアテスト。すべて合成データ（実在顧客データ・実Tracking IDは含まない）。
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const XLSX = require('xlsx');
const C = require('../nearby-course-core.js');

let passed = 0;
function assert(cond, msg) { if (!cond) throw new Error('FAIL: ' + msg); passed++; }
function eq(a, b, msg) { assert(JSON.stringify(a) === JSON.stringify(b), msg + ' => ' + JSON.stringify(a) + ' !== ' + JSON.stringify(b)); }

const HEADER = ['Stop', 'Tracking ID', 'Customer Notes', 'Phone', 'Name', 'Address', 'Postal'];
function sheetRows(title, rows) {
  const aoa = [[title], HEADER];
  rows.forEach((r, i) => aoa.push([r.stop === undefined ? i + 1 : r.stop, r.tid === undefined ? 'TBA' + String(i).padStart(9, '0') : r.tid, 'note', '', '', r.addr, r.postal || '']));
  return XLSX.utils.aoa_to_sheet(aoa);
}
function makeWb(courses) {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(courses)) XLSX.utils.book_append_sheet(wb, sheetRows('Route for ' + name, rows), 'sequencedRoute_' + name);
  return wb;
}
function indexOf(courses) {
  const ex = C.extractManifest(XLSX, makeWb(courses));
  assert(ex.ok, 'extract ok');
  return C.buildIndex(ex);
}

const COURSES = {
  DCX1: [
    { addr: '福岡県福岡市東区香椎駅前2-15-6', postal: '813-0013' },
    { addr: '福岡市東区香椎駅前2丁目15番6号 ○○マンション101', postal: '8130013' },  // 同一住所・複数荷物
    { addr: '福岡市東区香椎駅前2-15-7', postal: '813-0013' },
    { addr: '福岡市東区香椎駅前2-15-9', postal: '813-0013' },
    { addr: '福岡市東区香椎駅前2-16-1', postal: '813-0013' },
    { addr: '福岡市東区香椎駅前2-17-3', postal: '813-0013' },
    { addr: '福岡市東区拠点町1-1-1', tid: '' },                // Tracking IDなし（拠点住所）→除外
    { addr: '', tid: 'TBA000000099' },                          // 住所なし
  ],
  DCX23: [
    { addr: '福岡県福岡市東区香椎駅前２丁目１５番８号', postal: '813-0013' },
    { addr: '福岡市東区香椎駅前2-15-6', postal: '813-0013' },  // 複数コースに同一住所
    { addr: '福岡市東区香椎駅前2-14-1', postal: '813-0013' },
    { addr: '福岡市東区香椎駅前2-13-1', postal: '813-0013' },
  ],
  DCMRA1: [
    { addr: '福岡市東区香椎駅前3-1-1', postal: '813-0013' },
    { addr: '福岡市東区香椎駅前3-2-1', postal: '813-0013' },
    { addr: '福岡市東区香椎駅前3-3-1', postal: '813-0013' },
  ],
  DCMRB1: [
    { addr: '福岡市博多区香椎駅前2-15-8', postal: '812-0011' }, // 区違いの同名町域
    { addr: '福岡市博多区博多駅前3-1-1', postal: '812-0011' },
    { addr: '福岡市東区箱崎1-1-1', postal: '812-0053' },
  ],
  DCZ9: [
    { addr: '糟屋郡粕屋町大隈123-4', postal: '811-2301' },
    { addr: '糟屋郡粕屋町大隈125', postal: '811-2301' },
  ],
};

// --- 取込
const ex = C.extractManifest(XLSX, makeWb(COURSES));
eq(ex.routes.map((r) => r.route), ['DCX1', 'DCX23', 'DCMRA1', 'DCMRB1', 'DCZ9'], 'DCX/DCMRA/DCMRB の全コースを認識');
eq(ex.routes[0].rows.length, 6, '拠点住所(Tracking IDなし)と住所なし行を除外');
assert(ex.noAddress === 1, '住所なし行カウント');
assert(!JSON.stringify(ex).includes('note'), 'Customer Notes は取り込まない');
const idx = C.buildIndex(ex);
assert(idx.validCount === 6 + 4 + 3 + 3 + 2, '有効配送件数');
assert(idx.routeCount === 5, 'コース数');

// ヘッダー位置が変わっても列名で特定できる
{
  const aoa = [['Route for DCX9'], ['Zip', 'Address', 'Tracking ID', 'Stop'], ['810-0001', '福岡市中央区天神1-1-1', 'TBA1', 5]];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'sequencedRoute_DCX9');
  const r = C.extractManifest(XLSX, wb);
  assert(r.ok && r.routes[0].rows[0].stop === 5 && r.routes[0].rows[0].postal === '810-0001', '列名ベースで特定');
}
// コース形式でないシートはスキップ、全部だめならエラー
{
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['a', 'b'], [1, 2]]), 'Sheet1');
  assert(!C.extractManifest(XLSX, wb).ok, 'コースシート無しは拒否');
}

// --- 住所正規化
const parse = (s, towns) => { const p = C.parseAddress(s); const r = C.resolveParts(p, towns || {}); delete r.pref; return r; };
const BASE = { muni: '福岡市東区', town: '香椎駅前', chome: 2, banchi: 15, go: 8 };
['福岡市東区香椎駅前２丁目１５番８号', '福岡県福岡市東区香椎駅前2-15-8', '福岡市東区香椎駅前2丁目15-8 ○○マンション101',
  '福岡市東区香椎駅前二丁目十五番八号', '福岡市東区　香椎駅前　２－１５－８', '〒813-0013 福岡県福岡市東区香椎駅前2‐15‐8',
  '福岡市東区香椎駅前2-15-8-101', '福岡市東区香椎駅前2丁目15番8号ABCビル203号室'].forEach((a) => eq(parse(a), BASE, '表記揺れ: ' + a));
eq(parse('糟屋郡粕屋町大隈123-4').banchi, 123, '丁目無し町域 番地');
eq(parse('糟屋郡粕屋町大隈125').banchi, 125, '番地のみ');
eq(parse('福岡市東区香椎駅前2-15', { '福岡市東区|香椎駅前': true }).chome, 2, '丁目あり町域の2数字は丁目-番');
eq(C.normalizePostal('８１３-００１３'), '8130013', '郵便番号 全角/ハイフン');
eq(C.normalizePostal('813-0013'), C.normalizePostal('8130013'), '郵便番号 ハイフン有無');
assert(C.parseAddress('').ok === false, '空住所は解析不可');

// --- 検索
const top = (r) => r.candidates.map((c) => c.route + ':' + c.level);
let r = C.search(idx, '福岡県福岡市東区香椎駅前2-15-6');
assert(r.ok, 'search ok');
eq(top(r).slice(0, 2).sort(), ['DCX1:1', 'DCX23:1'], '完全一致(複数コースに同一住所) 両方LEVEL1');
assert(r.candidates.length <= 3, '上位3件以内');
assert(new Set(r.candidates.map((c) => c.route)).size === r.candidates.length, 'コース重複なし');
assert(r.candidates[0].route === 'DCX1', '同LEVELは該当エリア件数の多いコースが上位');
assert(r.candidates[0].sameBanchi === 3 && r.candidates[0].sameChome === 5, '件数は基本住所単位(同一住所複数荷物を1件)');
assert(r.candidates[0].stop !== null, 'Stop番号');

r = C.search(idx, '福岡市東区香椎駅前２丁目１５番８号 ABCビル');  // DCX23に完全一致
eq(r.candidates[0].route + ':' + r.candidates[0].level, 'DCX23:1', '建物名付きでも完全一致');

r = C.search(idx, '福岡市東区香椎駅前2-15-99');  // 同一番地
eq(top(r)[0], 'DCX1:2', '同一番地 LEVEL2');

r = C.search(idx, '福岡市東区香椎駅前2-18-1');  // 番地近い(17と差1)
eq(top(r)[0], 'DCX1:3', '番地近い LEVEL3');
assert(r.candidates[0].banchiDiff === 1, '番地差');

r = C.search(idx, '福岡市東区香椎駅前2-40-1');  // 同一丁目だが遠い
assert(r.candidates[0].level === 4, '同一丁目 LEVEL4');

r = C.search(idx, '福岡市東区香椎駅前9-1-1');  // 丁目違い、同一町名
assert(r.candidates[0].level === 5, '同一町名 LEVEL5');

// 区違い・市違いの同名町域を誤検出しない
r = C.search(idx, '福岡市博多区香椎駅前2-15-6');
assert(r.candidates.every((c) => c.route === 'DCMRB1'), '区が異なる同名町域をDCXに誤判定しない');
r = C.search(idx, '北九州市小倉北区香椎駅前2-15-6');
eq(r.candidates.length, 0, '市違いは該当なし');

// 該当なし
r = C.search(idx, '福岡市西区姪浜1-1-1');
eq(r.candidates.length, 0, '該当住所なし');

// 郵便番号のみ一致は参考候補
r = C.search(idx, '福岡市西区姪浜1-1-1', '811-2301');
assert(r.candidates.length === 1 && r.candidates[0].level === 6 && r.candidates[0].reference, '郵便番号のみ一致=参考(LEVEL6)');
// 住所一致があるときはLEVEL6を混ぜない
r = C.search(idx, '福岡市東区香椎駅前2-15-6', '812-0011');
assert(r.candidates.every((c) => c.level <= 5), 'LEVEL6はLEVEL1-5がある場合は出さない');

// 丁目無し町域（番地差）
r = C.search(idx, '糟屋郡粕屋町大隈124');
eq(top(r)[0].endsWith(':3') || top(r)[0].endsWith(':2'), true, '丁目無し町域の近接番地');

// 解析不能入力
r = C.search(idx, '１２３');
assert(r.ok === false, '市区町村不明は検索エラー');

// 連続検索（indexは不変）
const before = JSON.stringify(idx.records);
for (let i = 0; i < 20; i++) C.search(idx, '福岡市東区香椎駅前2-15-' + i);
assert(JSON.stringify(idx.records) === before, '連続検索でインデックスが変化しない');

// 同等候補の明示
{
  const i2 = indexOf({ A1: [{ addr: '福岡市東区香椎駅前2-15-6' }], A2: [{ addr: '福岡市東区香椎駅前2-15-6' }] });
  const rr = C.search(i2, '福岡市東区香椎駅前2-15-6');
  assert(rr.candidates.length === 2 && rr.candidates.every((c) => c.tie), '同等の候補は tie 表示');
}

// 距離(m)表現を出さない
assert(!/\d\s*(m|メートル|km)\b/.test(JSON.stringify(C.search(idx, '福岡市東区香椎駅前2-18-1'))), '距離表記なし');

// --- ファイル検証
eq(C.parseFileName('OFK3_CYCLE_1_2026-11-25_C.xlsx'), { date: '2026-11-25', cycle: '1' }, 'ファイル名から日付とCYCLE');
eq(C.parseFileName('x_2026-13-45.xlsx').date, '', '不正日付');
eq(C.todayJst(Date.UTC(2026, 10, 24, 15, 30)), '2026-11-25', 'JST日付(UTC 15:30 → 翌日)');
eq(C.todayJst(Date.UTC(2026, 10, 25, 14, 59)), '2026-11-25', 'JST日付境界');

const good = XLSX.write(makeWb(COURSES), { type: 'buffer', bookType: 'xlsx' });
assert(C.inspectZip(new Uint8Array(good)).ok, '正常xlsxを許可');
assert(!C.inspectZip(new Uint8Array(Buffer.from('これはxlsxではありません'))).ok, 'テキストを拒否');
assert(!C.inspectZip(new Uint8Array(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))).ok, '壊れたZIPを拒否');
{
  // 展開サイズ上限（zip bomb対策）: 中央ディレクトリの宣言サイズを書き換えて検証
  const b = Buffer.from(good);
  const eocd = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const cd = b.readUInt32LE(eocd + 16);
  b.writeUInt32LE(0x7fffffff, cd + 24);
  assert(!C.inspectZip(new Uint8Array(b)).ok, '展開サイズ過大を拒否');
}
{
  // 行数上限
  const rows = []; for (let i = 0; i < C.LIMITS.maxRowsPerSheet + 10; i++) rows.push({ addr: '福岡市東区箱崎1-1-' + (i + 1) });
  assert(!C.extractManifest(XLSX, makeWb({ BIG: rows })).ok, '行数上限超過を拒否');
}
{
  // 数式セルは評価・実行されず、保存済みキャッシュ値だけが読まれる
  const ws = sheetRows('Route for F1', [{ addr: 'x' }]);
  ws['F3'] = { t: 's', f: 'HYPERLINK("http://example.invalid","x")', v: '福岡市東区箱崎1-1-1' };
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'sequencedRoute_F1');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const wb2 = XLSX.read(buf, { type: 'buffer', cellFormula: false, cellHTML: false, cellStyles: false, bookVBA: false });
  const rr = C.extractManifest(XLSX, wb2);
  assert(rr.ok && rr.routes[0].rows[0].address === '福岡市東区箱崎1-1-1', '数式はキャッシュ値のみ');
}


// ================= Amazonマニフェスト形式（町域・番地, 市区町村, 都道府県）=================
const AMZ = [
  '香椎駅前2-15-8, 福岡市東区, 福岡県',
  '香椎駅前2-15-8, 福岡市東区, 福岡',                       // 都道府県の略称
  '香椎駅前2丁目15番8号 ○○マンション101, 福岡市東区, 福岡県', // 建物名・部屋番号
  '香椎駅前２－１５－８，福岡市東区，福岡県',                 // 全角カンマ/数字
  '香椎駅前2-15-8,福岡市東区,福岡県',                         // 空白なし
  '香椎駅前二丁目十五番八号, 福岡市東区, 福岡県, 日本',       // 漢数字・国名付き
  '福岡県, 福岡市東区, 香椎駅前2-15-8',                       // カンマ入り日本語順
  '福岡県福岡市東区香椎駅前2-15-8',                           // 従来形式（カンマなし）
  '福岡市東区香椎駅前2-15-8',                                 // 都道府県なし
];
AMZ.forEach((a) => eq(parse(a), BASE, 'Amazon/日本語順の同値: ' + a));
eq(C.parseAddress('香椎駅前2-15-8, 福岡市東区, 福岡').pref, '福岡県', '略称「福岡」→福岡県');
eq(C.parseAddress('x1-1, 港区, 東京').pref, '東京都', '略称「東京」→東京都');
eq(C.parseAddress('天神1-1, 京都市中京区, 京都').pref, '京都府', '略称「京都」→京都府');
eq(C.parseAddress('札幌市中央区北1条西2-1, 北海道').pref, '北海道', '北海道');
eq(parse('大隈123-4, 粕屋町, 福岡県'), parse('糟屋郡粕屋町大隈123-4'), '郡あり/なしを同一視(Amazon形式 vs 従来)');
eq(parse('大隈123-4, 糟屋郡粕屋町, 福岡県'), parse('糟屋郡粕屋町大隈123-4'), '郡付きAmazon形式');
eq(C.parseAddress('福岡市博多区, 御供所町').muni, '福岡市博多区', '町で終わる町域を市区町村と取り違えない');
eq(C.parseAddress('御供所町, 福岡市博多区, 福岡県').town, '御供所町', 'Amazon形式で町域が町で終わる');

// 誤認識の排除（市区町村なし・取り違え）
for (const bad of ['香椎駅前2-15-8, 福岡県', '香椎駅前2-15-8', '福岡県', '2-15-8, 福岡市東区, 福岡県', ', , ,']) {
  assert(C.parseAddress(bad).ok === false, '不正住所は解析不可: ' + bad);
}

// 両形式の検索: カンマの有無・形式でインデックス/結果が変わらない
const amzIdx = indexOf({
  DCX1: [{ addr: '香椎駅前2-15-6, 福岡市東区, 福岡県', postal: '813-0013' }, { addr: '香椎駅前2-15-7 ○○ビル301, 福岡市東区, 福岡県', postal: '813-0013' }, { addr: '香椎駅前2-16-1, 福岡市東区, 福岡県', postal: '813-0013' }],
  DCMRA1: [{ addr: '香椎駅前2-15-6, 福岡市東区, 福岡県', postal: '813-0013' }, { addr: '香椎駅前3-1-1, 福岡市東区, 福岡県', postal: '813-0013' }],
  DCMRB1: [{ addr: '香椎駅前2-15-6, 福岡市博多区, 福岡県', postal: '812-0011' }, { addr: '大隈123-4, 糟屋郡粕屋町, 福岡県', postal: '811-2301' }],
  DCZ1: [{ addr: '香椎駅前2-15-6, 福岡市東区, 福岡県', postal: '999-9999' }, { addr: '拠点所在地不明, 福岡県', postal: '813-0013' }], // 後者は解析不可→除外
});
assert(amzIdx.unparsed === 1, 'Amazon形式: 解析失敗の件数');
assert(amzIdx.records.every((x) => x.postal !== '' || true) && !amzIdx.records.some((x) => x.display.indexOf('拠点') >= 0), '解析失敗行は検索対象外');
const QUERIES = ['福岡県福岡市東区香椎駅前2-15-6', '香椎駅前2-15-6, 福岡市東区, 福岡', '福岡県, 福岡市東区, 香椎駅前２丁目１５番６号', '福岡市東区香椎駅前2-15-6 ○○ビル'];
const sig = (r) => JSON.stringify(r.candidates.map((c) => [c.route, c.level, c.sameBanchi, c.sameChome, c.sameTown, c.bestAddress]));
const base0 = sig(C.search(amzIdx, QUERIES[0]));
QUERIES.forEach((q) => eq(sig(C.search(amzIdx, q)), base0, 'カンマ有無・形式で検索結果が不変: ' + q));
{
  const rr = C.search(amzIdx, QUERIES[0]);
  const routes = rr.candidates.map((c) => c.route);
  assert(!routes.includes('DCMRB1') || rr.candidates.find((c) => c.route === 'DCMRB1').level >= 6 === false, '区違い(博多区)のコースを東区住所に誤一致させない');
  assert(rr.candidates.filter((c) => c.level === 1).map((c) => c.route).sort().join() === 'DCMRA1,DCX1,DCZ1', '複数コースの同一住所は全て LEVEL1');
  assert(!routes.includes('DCMRB1'), '博多区のみのコースは候補に入らない');
}
// 郵便番号一致より住所構造を優先
{
  const r2 = C.search(amzIdx, '福岡市東区香椎駅前2-16-1', '812-0011'); // 郵便番号は博多区DCMRB1と一致
  assert(r2.candidates[0].route === 'DCX1' && r2.candidates[0].level === 1, '住所構造一致が郵便番号一致に優先');
  assert(r2.candidates.every((c) => c.level <= 5), '構造一致がある限り郵便番号のみの候補は出さない');
}
// 同名ward(中央区)でも都道府県が異なれば誤一致しない
{
  const i3 = indexOf({ T1: [{ addr: '銀座1-1-1, 中央区, 東京都' }], O1: [{ addr: '銀座1-1-1, 中央区, 大阪府' }] });
  const r3 = C.search(i3, '東京都中央区銀座1-1-1');
  eq(r3.candidates.map((c) => c.route), ['T1'], '都道府県が異なる同名区を区別');
  const r4 = C.search(i3, '中央区銀座1-1-1'); // 都道府県なしなら両方
  eq(r4.candidates.length, 2, '都道府県なし入力は両方を候補にする');
}
// Amazon形式でも拠点(Tracking IDなし)は除外され、全件が同一形式で取り込める
{
  const rowsAmz = [{ addr: '拠点町1-1, 福岡市東区, 福岡県', tid: '' }, { addr: '箱崎1-1-1, 福岡市東区, 福岡県' }];
  const ix = indexOf({ H1: rowsAmz });
  assert(ix.validCount === 1 && ix.unparsed === 0, '拠点住所除外・Amazon形式を全件解析');
}

console.log('nearby-course-core: ' + passed + ' assertions passed');
