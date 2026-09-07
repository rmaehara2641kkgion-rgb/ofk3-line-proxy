// /tenko-sync 認証（TENKO_SYNC_TOKEN）のエンドポイント統合テスト。
// render-webhook-server.js を実プロセスとして子プロセス起動し、実際のHTTPリクエストで検証する。
// 他の *-core.js 系テスト（純粋関数のみ）とは異なり、これは意図的にエンドポイントの
// 実挙動（正規化・fingerprint・401/200判定・既存データ保護）まで確認するためのテスト。
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, '..', 'render-webhook-server.js');
const PORT = 3919; // このテスト専用のポート（本番/他テストと衝突しない番号）
const BASE = 'http://127.0.0.1:' + PORT;

// Render環境変数への「貼り付け事故」を模した、前後に空白・改行を含むtoken。
// 正規化後の実トークンは 'test-tenko-secret-token-987' になるはず。
const RAW_ENV_TOKEN = '  test-tenko-secret-token-987\n';
const CLEAN_TOKEN = 'test-tenko-secret-token-987';

function assert(condition, message) {
  if (!condition) throw new Error('FAIL: ' + message);
}

function startServer(env) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [SERVER_PATH], {
      env: Object.assign({}, process.env, { PORT: String(PORT) }, env),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    let settled = false;
    const onData = (buf) => {
      out += buf.toString();
      if (!settled && out.indexOf('Server running on port') !== -1) {
        settled = true;
        resolve({ child, getLog: () => out });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      if (!settled) reject(new Error('server exited before ready, code=' + code + ', log:\n' + out));
    });
    setTimeout(() => {
      if (!settled) reject(new Error('server did not become ready within timeout, log so far:\n' + out));
    }, 10000);
  });
}

function stopServer(child) {
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} resolve(); }, 3000);
  });
}

async function runTests() {
  const { child, getLog } = await startServer({ TENKO_SYNC_TOKEN: RAW_ENV_TOKEN });
  try {
    // A: 正しいtoken -> GET 200
    let res = await fetch(BASE + '/tenko-sync', { headers: { 'X-Tenko-Sync-Token': CLEAN_TOKEN } });
    assert(res.status === 200, 'A: GET /tenko-sync with correct token -> 200, got ' + res.status);

    // B: 正しいtoken -> POST 200
    res = await fetch(BASE + '/tenko-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenko-Sync-Token': CLEAN_TOKEN },
      body: JSON.stringify({ schedule: [{ name: 'テスト太郎', licenseAuth: true, mentorAuth: false }], date: '2026-09-07', source: 'pc' })
    });
    assert(res.status === 200, 'B: POST /tenko-sync with correct token -> 200, got ' + res.status);
    let body = await res.json();
    assert(body.status === 'ok' && body.count === 1, 'B: POST response reflects saved schedule count=1, got ' + JSON.stringify(body));

    // U: 既存の同期データ往復（回帰）— 保存した内容がGETで取得できる
    res = await fetch(BASE + '/tenko-sync', { headers: { 'X-Tenko-Sync-Token': CLEAN_TOKEN } });
    body = await res.json();
    assert(body.status === 'ok' && body.data && body.data.schedule.length === 1 && body.data.schedule[0].name === 'テスト太郎',
      'U: round-trip GET returns the previously POSTed schedule unchanged, got ' + JSON.stringify(body));

    // C: 誤token -> 401
    res = await fetch(BASE + '/tenko-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenko-Sync-Token': 'wrong-token' },
      body: JSON.stringify({ schedule: [{ name: '別のドライバー' }], date: '2026-09-07', source: 'pc' })
    });
    assert(res.status === 401, 'C: wrong token -> 401, got ' + res.status);

    // N: 401後もサーバー側データは変化しない（不正リクエストの内容が反映されていないこと）
    res = await fetch(BASE + '/tenko-sync', { headers: { 'X-Tenko-Sync-Token': CLEAN_TOKEN } });
    body = await res.json();
    assert(body.data.schedule.length === 1 && body.data.schedule[0].name === 'テスト太郎',
      'N: data unchanged after a 401 attempt, got ' + JSON.stringify(body.data.schedule));

    // D: token未設定 -> 401
    res = await fetch(BASE + '/tenko-sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert(res.status === 401, 'D: missing token header -> 401, got ' + res.status);

    // クライアントが前後に空白/改行を付けて送っても、サーバー側正規化により成功する
    // （E/F相当。クライアント側は本来saveTenkoSyncToken()で正規化済みの値を送るが、
    // ヘッダーレベルでも defense-in-depth として同じ正規化がサーバー側に効いていることを確認）
    res = await fetch(BASE + '/tenko-sync', { headers: { 'X-Tenko-Sync-Token': '  ' + CLEAN_TOKEN + '  ' } });
    assert(res.status === 200, 'client-side edge whitespace in header still authenticates (server-side normalize), got ' + res.status);

    // G/H: サーバーenv側の前後空白/改行（起動時に投入したRAW_ENV_TOKEN）を正規化した上で、
    // クリーンなtokenを送るクライアントが認証成功する（既にA/Bで実証済みだが、明示的に再掲）
    res = await fetch(BASE + '/tenko-sync', { headers: { 'X-Tenko-Sync-Token': CLEAN_TOKEN } });
    assert(res.status === 200, 'G/H: server-side env token with leading/trailing whitespace+CRLF still normalizes to authenticate, got ' + res.status);

    // S/T: /tenko-sync/status はtoken本体を含まず、fingerprint/length/configuredのみを返す
    res = await fetch(BASE + '/tenko-sync/status');
    assert(res.status === 200, 'status endpoint reachable without auth, got ' + res.status);
    const statusBody = await res.json();
    assert(statusBody.configured === true, 'status: configured=true');
    assert(typeof statusBody.fingerprint === 'string' && /^[0-9a-f]{12}$/.test(statusBody.fingerprint), 'status: fingerprint is a 12-hex-char string, got ' + statusBody.fingerprint);
    assert(statusBody.length === CLEAN_TOKEN.length, 'status: length matches the normalized token length, got ' + statusBody.length);
    assert(JSON.stringify(statusBody).indexOf(CLEAN_TOKEN) === -1, 'status: response body never contains the raw token');

    // T: サーバーログにtoken本体が一切出ていないこと（fingerprint/lengthのみ）
    const log = getLog();
    assert(log.indexOf(CLEAN_TOKEN) === -1, 'T: raw token never appears in server logs');
    assert(log.indexOf('fingerprint:') !== -1, 'T: startup log shows a fingerprint line');
    assert(/providedFingerprint=[0-9a-f]{12}\b/.test(log), 'T: 401 diagnostic log includes providedFingerprint');
    assert(/expectedFingerprint=[0-9a-f]{12}\b/.test(log), 'T: 401 diagnostic log includes expectedFingerprint');
    assert(/providedLength=\d+/.test(log) && /expectedLength=\d+/.test(log), 'T: 401 diagnostic log includes provided/expected lengths');

    console.log('tenko-sync-endpoint.test.mjs: all endpoint tests passed');
  } finally {
    await stopServer(child);
  }
}

async function runUnconfiguredTest() {
  // token未設定サーバー: fail-closed(503)であることの回帰確認
  const { child } = await startServer({ TENKO_SYNC_TOKEN: '' });
  try {
    const res = await fetch(BASE + '/tenko-sync', { headers: { 'X-Tenko-Sync-Token': 'anything' } });
    assert(res.status === 503, 'unconfigured server -> 503 fail-closed, got ' + res.status);

    const statusRes = await fetch(BASE + '/tenko-sync/status');
    const statusBody = await statusRes.json();
    assert(statusBody.configured === false, 'status endpoint reports configured=false when unset');
    assert(statusBody.fingerprint === null, 'status endpoint fingerprint is null when unset');

    console.log('tenko-sync-endpoint.test.mjs: unconfigured (fail-closed) test passed');
  } finally {
    await stopServer(child);
  }
}

(async () => {
  await runTests();
  await runUnconfiguredTest();
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
