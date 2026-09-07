// /lat-export のライブAPI契約テスト（render-webhook-server.jsを実際に子プロセスとして起動）。
// 使用するfixtureはすべて完全synthetic（tests/fixtures/lat-verify/synthetic/、実運用データ
// 一切なし。生成: tests/fixtures/lat-verify/gen-lat-core-synthetic-fixtures.mjs）。
//
// lat-core.test.mjs は純粋関数（列判定・JOIN・時刻復元・判定境界値等）をカバーする。
// 本ファイルはそれとは別に、HTTPレイヤー（認証・multipart・ステータスコード）の契約を
// テストする。既存リポジトリにはrender-webhook-server.jsを実際に起動してHTTPで叩く
// テストが無かったため、このファイルで新規に追加する。
//
// 対象:
//   17. RAW片方のみでは完成扱いしない（422）
//   18. 非LAT → 422
//   19. LAT_API_TOKEN未設定 → 503
//   20. token不一致 → 401
//   21. 正常LOW（synthetic-low.xlsx） → 200
//   22. 正常RAW2ファイル（synthetic-raw-turnover.xlsx + synthetic-raw-routes.xlsx、投入順2パターン） → 200
//   24. FTDS/CC/DNR/TWC回帰（同一サーバー上で既存4APIの認証層が壊れていないことを確認）
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const FIX = join(__dirname, 'fixtures/lat-verify/synthetic');
const PORT = 34519;
const BASE = 'http://127.0.0.1:' + PORT;

function assert(condition, message) {
  if (!condition) throw new Error('FAIL: ' + message);
}

function waitForServerReady(proc, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var buf = '';
    var timer = setTimeout(function () { reject(new Error('server did not start within ' + timeoutMs + 'ms. output so far:\n' + buf)); }, timeoutMs);
    function onData(chunk) {
      buf += chunk.toString();
      if (buf.indexOf('Server running on port') >= 0) {
        clearTimeout(timer);
        proc.stdout.removeListener('data', onData);
        resolve();
      }
    }
    proc.stdout.on('data', onData);
    proc.stderr.on('data', function (chunk) { buf += chunk.toString(); });
  });
}

function fileFromDisk(path, name) {
  var buf = readFileSync(path);
  return new File([buf], name || path.split('/').pop(), { type: 'application/octet-stream' });
}

async function runAgainstServer(env, testFn) {
  var proc = spawn(process.execPath, ['render-webhook-server.js'], {
    cwd: repoRoot,
    env: Object.assign({}, process.env, { PORT: String(PORT) }, env)
  });
  var crashed = null;
  proc.on('exit', function (code, signal) {
    if (code !== null && code !== 0) crashed = 'exited with code ' + code;
  });
  try {
    await waitForServerReady(proc, 15000);
    await testFn();
  } finally {
    proc.kill('SIGTERM');
    // ポート解放を待つ（次のrunAgainstServer呼び出しがEADDRINUSEにならないように）
    await new Promise(function (r) { setTimeout(r, 400); });
  }
  if (crashed) throw new Error('server process crashed during test: ' + crashed);
}

// ---- 19. LAT_API_TOKEN未設定 → 503 ----
async function test503WhenTokenNotConfigured() {
  await runAgainstServer({ LAT_API_TOKEN: '' }, async function () {
    var res = await fetch(BASE + '/lat-export', { method: 'POST' });
    assert(res.status === 503, 'LAT_API_TOKEN未設定時は503, got ' + res.status);
    var body = await res.json();
    assert(body.status === 'error', 'エラーレスポンス形式');
  });
  console.log('  [19] LAT_API_TOKEN未設定 → 503: OK');
}

// ---- 20. token不一致 → 401 / トークンヘッダ無し → 401（トークン設定済みの場合） ----
async function test401OnTokenMismatch() {
  await runAgainstServer({ LAT_API_TOKEN: 'correct-secret', FTDS_API_TOKEN: 'f', CC_API_TOKEN: 'c', DNR_API_TOKEN: 'd', TWC_API_TOKEN: 't' }, async function () {
    var res1 = await fetch(BASE + '/lat-export', { method: 'POST', headers: { 'X-Lat-Api-Token': 'wrong-secret' } });
    assert(res1.status === 401, 'token不一致は401, got ' + res1.status);
    var res2 = await fetch(BASE + '/lat-export', { method: 'POST' });
    assert(res2.status === 401, 'tokenヘッダ無し(トークン設定済み)も401, got ' + res2.status);

    // ---- 18. 非LAT → 422 ----
    var fd = new FormData();
    fd.append('files', new Blob(['a,b,c\n1,2,3\n'], { type: 'text/csv' }), 'garbage.csv');
    var res3 = await fetch(BASE + '/lat-export', { method: 'POST', headers: { 'X-Lat-Api-Token': 'correct-secret' }, body: fd });
    assert(res3.status === 422, '非LATファイルは422, got ' + res3.status);

    // ---- 24. FTDS/CC/DNR/TWC回帰: 同一サーバー上で既存4APIの認証層が引き続き機能する ----
    var ftds = await fetch(BASE + '/ftds-export', { method: 'POST' });
    assert(ftds.status === 401, '/ftds-exportの認証は無変更(token無し=401), got ' + ftds.status);
    var cc = await fetch(BASE + '/cc-export', { method: 'POST' });
    assert(cc.status === 401, '/cc-exportの認証は無変更(token無し=401), got ' + cc.status);
    var dnr = await fetch(BASE + '/dnr-export', { method: 'POST' });
    assert(dnr.status === 401, '/dnr-exportの認証は無変更(token無し=401), got ' + dnr.status);
    var twc = await fetch(BASE + '/twc-export', { method: 'POST' });
    assert(twc.status === 401, '/twc-exportの認証は無変更(token無し=401), got ' + twc.status);
  });
  console.log('  [20] token不一致/無し → 401: OK');
  console.log('  [18] 非LATファイル → 422: OK');
  console.log('  [24] FTDS/CC/DNR/TWC認証層の回帰: OK（4API全て401のまま、LAT追加による影響なし）');
}

// ---- 17. RAWの片方だけでは完成扱いにしない（422） ----
async function test422WhenOnlyOneRawFile() {
  await runAgainstServer({ LAT_API_TOKEN: 'secret' }, async function () {
    var fd = new FormData();
    fd.append('files', fileFromDisk(join(FIX, 'synthetic-raw-turnover.xlsx')));
    var res = await fetch(BASE + '/lat-export', { method: 'POST', headers: { 'X-Lat-Api-Token': 'secret' }, body: fd });
    assert(res.status === 422, 'Turnoverのみ(Routesが無い)は422で完成扱いにしない, got ' + res.status);

    var fd2 = new FormData();
    fd2.append('files', fileFromDisk(join(FIX, 'synthetic-raw-routes.xlsx')));
    var res2 = await fetch(BASE + '/lat-export', { method: 'POST', headers: { 'X-Lat-Api-Token': 'secret' }, body: fd2 });
    assert(res2.status === 422, 'Routesのみ(Turnoverが無い)は422で完成扱いにしない, got ' + res2.status);
  });
  console.log('  [17] RAW片方のみ → 422（完成扱いにしない）: OK');
}

// ---- 21. 正常LOW（synthetic-low.xlsx） → 200 ----
async function test200Low() {
  await runAgainstServer({ LAT_API_TOKEN: 'secret' }, async function () {
    var fd = new FormData();
    fd.append('files', fileFromDisk(join(FIX, 'synthetic-low.xlsx')));
    var res = await fetch(BASE + '/lat-export', { method: 'POST', headers: { 'X-Lat-Api-Token': 'secret' }, body: fd });
    var csv = await res.text();
    assert(res.status === 200, 'LOW単一ファイルは200, got ' + res.status + ' body=' + csv);
    assert(res.headers.get('content-type').indexOf('text/csv') >= 0, 'Content-TypeはCSV');
    var lineCount = csv.trim().split(/\r?\n/).length;
    assert(lineCount === 4, 'ヘッダー1行+データ3行=4行, got ' + lineCount);
    assert(csv.indexOf('出発予定') < 0, 'planned_departure列が無いLOWは14列構成（出発予定列を含まない）');
  });
  console.log('  [21] 正常LOW(synthetic) → 200: OK');
}

// ---- 22. 正常RAW2ファイル（synthetic Turnover+Routes、投入順2パターン） → 200 ----
async function test200RawBothOrders() {
  await runAgainstServer({ LAT_API_TOKEN: 'secret' }, async function () {
    var turnoverPath = join(FIX, 'synthetic-raw-turnover.xlsx');
    var routesPath = join(FIX, 'synthetic-raw-routes.xlsx');

    var fdA = new FormData();
    fdA.append('files', fileFromDisk(turnoverPath));
    fdA.append('files', fileFromDisk(routesPath));
    var resA = await fetch(BASE + '/lat-export', { method: 'POST', headers: { 'X-Lat-Api-Token': 'secret' }, body: fdA });
    var csvA = await resA.text();
    assert(resA.status === 200, 'Turnover→Routes順は200, got ' + resA.status + ' body=' + csvA);

    var fdB = new FormData();
    fdB.append('files', fileFromDisk(routesPath));
    fdB.append('files', fileFromDisk(turnoverPath));
    var resB = await fetch(BASE + '/lat-export', { method: 'POST', headers: { 'X-Lat-Api-Token': 'secret' }, body: fdB });
    assert(resB.status === 200, 'Routes→Turnover順(逆順)も200, got ' + resB.status);
    var csvB = await resB.text();

    assert(csvA === csvB, '投入順が逆でも出力CSVは完全に同一');
    // synthetic-raw-turnover.xlsx: SYN-R001/002/003/004(重複除く)の4件。
    // うちSYN-R004はRoutesに対応が無いunmatchedだがbeaconMapには残る＝ヘッダー+4行=5行
    var lineCount = csvA.trim().split(/\r?\n/).length;
    assert(lineCount === 5, 'ヘッダー1行+データ4行=5行, got ' + lineCount);
    assert(csvA.indexOf('出発予定') >= 0 && csvA.indexOf('判定') >= 0, 'RAW(planned_departureあり)は17列構成（出発予定/差分/判定を含む）');
    assert(csvA.indexOf('早着出発') >= 0 && csvA.indexOf('定刻') >= 0 && csvA.indexOf('遅延') >= 0, '早着出発/定刻/遅延の3判定すべてが出力に含まれる');
  });
  console.log('  [22] 正常RAW2ファイル(投入順2パターン) → 200、出力同一: OK');
}

async function runTests() {
  await test503WhenTokenNotConfigured();
  await test401OnTokenMismatch();
  await test422WhenOnlyOneRawFile();
  await test200Low();
  await test200RawBothOrders();
  console.log('lat-export-api.test.mjs: all tests passed');
}

runTests().catch(function (err) {
  console.error(err);
  process.exit(1);
});
