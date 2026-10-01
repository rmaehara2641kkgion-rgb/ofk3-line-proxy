// エリア経験DB Phase 1B: GAS保存形式（gas-area-experience-master.gs を vm 上で実行）と
// Render中継（/area-experience-master, /area-experience-events）のテスト。
// GASはモック環境（DriveApp/LockService等）で実ファイルのコードをそのまま実行する。
// データはすべてsynthetic（実在の氏名・TransportIDは使用しない）。
import { createRequire } from 'module';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import http from 'node:http';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');
const AEC = require('../area-experience-core.js');
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error('FAIL: ' + message);
  passed++;
}

// ---- GAS モック ----
function createGasRuntime(initialContent) {
  const state = { content: initialContent == null ? null : initialContent, lockAcquired: 0, lockReleased: 0, otherFiles: {}, setContentCalls: 0 };
  const file = {
    getBlob: () => ({ getDataAsString: () => state.content || '' }),
    setContent: (c) => {
      state.setContentCalls++;
      state.content = c;
    },
  };
  const ctx = {
    ContentService: {
      createTextOutput: (s) => ({ setMimeType: () => ({ getContent: () => s }) }),
      MimeType: { JSON: 'json' },
    },
    MimeType: { PLAIN_TEXT: 'text' },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => 'FOLDER' }) },
    DriveApp: {
      getFolderById: () => ({
        getFilesByName: (name) => {
          let given = false;
          const exists = name === 'areaExperienceMaster.json' ? state.content !== null : name in state.otherFiles;
          return { hasNext: () => exists && !given, next: () => ((given = true), file) };
        },
        createFile: (name, c) => {
          if (name === 'areaExperienceMaster.json') {
            state.content = c;
            return file;
          }
          state.otherFiles[name] = c;
          return { getName: () => name };
        },
      }),
    },
    LockService: {
      getScriptLock: () => ({
        waitLock: () => {
          state.lockAcquired++;
        },
        releaseLock: () => {
          state.lockReleased++;
        },
      }),
    },
    Utilities: { formatDate: () => '2026-10-01' },
    JSON,
    Date,
    Object,
    String,
    Array,
  };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(join(repoRoot, 'gas-area-experience-master.gs'), 'utf8'), ctx);
  return {
    state,
    get: (action) => JSON.parse(ctx.doGet({ parameter: { action } }).getContent()),
    post: (action, body) => JSON.parse(ctx.doPost({ parameter: { action }, postData: { contents: JSON.stringify(body) } }).getContent()),
    stored: () => JSON.parse(state.content),
  };
}

// ---- synthetic スナップショット ----
const HEADER = ['TransportID', 'driverName', 'area', 'experienceDays', 'lastVisitDate', 'primaryCount', 'splitCount', 'rescueCount', 'stops', 'packages', 'confidence'];
const HISTORY = [
  ['weekKey', 'dateFrom', 'dateTo', 'importedAt', 'sourceFingerprint', 'rowCount', 'source'],
  ['LEGACY-BASELINE', '', '2026-09-10', '', 'legacy-baseline', 3, 'base.xlsx'],
  ['2026-W38', '2026-09-13', '2026-09-19', '', 'fp38', 3, 'w38.xlsx'],
  ['2026-W39', '2026-09-20', '2026-09-26', '', 'fp39', 3, 'w39.xlsx'],
];
const ROWS = [
  HEADER,
  ['TID_A', 'driver a', '東油山', 28, '2026-09-26', 30, 2, 1, 1177, 1450, 'high'],
  ['TID_A', 'driver a', '片江', 27, '2026-09-26', 29, 1, 2, 928, 1195, 'high'],
  ['', '一郎 試験', '別府', 12, '2026-09-24', 10, 1, 1, 300, 320, 'high'],
  ['', '三郎 不明', '室見', 2, '2026-09-21', 1, 1, 0, 20, 21, 'low'],
];
const MASTER = { 'driver a': 'TID_A', '一郎 試験': 'TID_ICHI' };

function buildSnapshot(rows, history, master) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'areaExperience');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(history), 'importHistory');
  const rt = XLSX.read(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }), { type: 'array' });
  return AEC.buildSnapshotLayer(AEC.parseExperienceWorkbook(rt, XLSX, { fileName: 'cumulative.xlsx' }), { transportIDs: master || MASTER });
}
const ADDR = ['城南区東油山4丁目1-2, 福岡市, 福岡'];
const normCap = (date, route, tid, capturedAt) =>
  AEC.normalizeRouteCapture({ serviceDate: date, routeCode: route, transporterId: tid, addresses: ADDR, capturedAt: capturedAt || date + 'T20:00:00Z' }).capture;

function mergedFromStored(stored) {
  const snap = AEC.restoreSnapshotLayer(stored.snapshot);
  return AEC.mergeSnapshotAndEvents(snap, AEC.collectExperienceEvents(stored.events));
}

// ===== 1. 旧形式互換: 空ファイル get / 旧 save =====
{
  const gas = createGasRuntime(null);
  assert(gas.get('get').data === null, 'empty master returns data null');
  const r = gas.post('save', { updatedAt: '2026-09-01', records: [{ transportId: 'T', area: 'x', experienceDays: 1 }], stats: { drivers: 1 } });
  assert(r.status === 'ok' && r.recordCount === 1, 'legacy save ok');
  assert(gas.get('get').data.records.length === 1, 'legacy get returns records');
  assert(gas.state.lockAcquired === 1 && gas.state.lockReleased === 1, 'legacy save uses lock');
}

// ===== 2. saveSnapshot: rawRows全保持・解決結果は別保持・events保持 =====
const snap = buildSnapshot(ROWS, HISTORY);
const payload = AEC.buildSnapshotSavePayload(snap, { updatedAt: '2026-10-01', registeredAt: '2026-10-01T00:00:00Z' });
{
  assert(payload.snapshot.rawRows.length === 4 && payload.snapshot.rawRows[2][0] === '', 'payload rawRows unchanged incl. blank TID');
  assert(payload.snapshot.resolution['一郎 試験'].transportId === 'TID_ICHI', 'resolution kept separately');
  assert(payload.snapshot.resolution['一郎 試験'].resolutionMethod === 'exact_name', 'resolutionMethod recorded');
  assert(payload.snapshot.missingPeriods[0].from === '2026-09-11', 'missingPeriods saved');
  assert(payload.snapshot.snapshotThroughDate === '2026-09-26', 'throughDate saved');
  assert(payload.unresolved.drivers.length === 1 && payload.unresolved.drivers[0].driverName === '三郎 不明', 'unresolved saved');
  assert(payload.records.length === 3, 'records = TID rows + resolved rows');
}
const gas = createGasRuntime(null);
{
  const bad = gas.post('saveSnapshot', { records: [], snapshot: { header: [], rawRows: [], snapshotThroughDate: '9/26' } });
  assert(bad.status === 'error', 'saveSnapshot rejects invalid throughDate');
  const r = gas.post('saveSnapshot', payload);
  assert(r.status === 'ok' && r.rawRowCount === 4 && r.snapshotThroughDate === '2026-09-26', 'saveSnapshot ok');
  const st = gas.stored();
  assert(st.records && st.stats && st.updatedAt === '2026-10-01', 'legacy fields kept (records/stats/updatedAt)');
  assert(st.snapshot.rawRows[2][0] === '' && st.snapshot.rawRows[2][1] === '一郎 試験', 'stored rawRows not rewritten');
  const restored = mergedFromStored(gas.get('get').data);
  assert(restored.byTransportId.TID_ICHI.areas['別府'].experienceDays === 12, 'restored snapshot uses saved resolution');
}

// ===== 3. appendEvents 冪等性 =====
{
  const caps = [normCap('2026-09-27', 'DSX10', 'TID_A'), normCap('2026-09-27', 'DSX11', 'TID_A'), normCap('2026-09-28', 'DSX10', 'TID_A')];
  const item = AEC.normalizeExperienceEventItem({ transportId: 'TID_NEW', area: '別府', serviceDate: '2026-09-29' }).event;
  const lockBefore = gas.state.lockAcquired;
  const r1 = gas.post('appendEvents', { routeCaptures: caps, events: [item] });
  assert(r1.status === 'ok' && r1.capturesApplied === 3 && r1.eventsAdded === 1, 'first append');
  assert(gas.state.lockAcquired === lockBefore + 1 && gas.state.lockAcquired === gas.state.lockReleased, 'appendEvents uses lock');
  const d1 = mergedFromStored(gas.stored());
  assert(d1.byTransportId.TID_A.areas['東油山'].experienceDays === 30, 'two dates (2 routes same day) → +2');
  assert(d1.byTransportId.TID_NEW.areas['別府'].experienceDays === 1, 'direct event item counted');
  for (let i = 0; i < 3; i++) gas.post('appendEvents', { routeCaptures: caps, events: [item] });
  const r2 = gas.post('appendEvents', { routeCaptures: caps, events: [item] });
  assert(r2.eventsAdded === 0 && r2.eventsUnchanged === 1 && r2.routeCaptureCount === 3 && r2.eventItemCount === 1, 'resend keeps counts');
  const d2 = mergedFromStored(gas.stored());
  assert(d2.byTransportId.TID_A.areas['東油山'].experienceDays === 30, 'resend → no increase');
  assert(gas.stored().lastAggregatedDate === '2026-09-29', 'lastAggregatedDate');
  // 古い取得は無視、新しい取得で差し替え（TID変更）
  const stale = gas.post('appendEvents', { routeCaptures: [normCap('2026-09-27', 'DSX10', 'TID_B', '2026-09-27T01:00:00Z')] });
  assert(stale.capturesStale === 1, 'stale capture ignored by GAS');
  gas.post('appendEvents', { routeCaptures: [normCap('2026-09-27', 'DSX11', 'TID_B', '2026-09-27T23:00:00Z'), normCap('2026-09-27', 'DSX10', 'TID_B', '2026-09-27T23:00:00Z')] });
  const d3 = mergedFromStored(gas.stored());
  assert(d3.byTransportId.TID_A.areas['東油山'].experienceDays === 29, 'reassigned routes drop old driver day');
  assert(d3.byTransportId.TID_B.areas['東油山'].experienceDays === 1, 'new driver gets the day once');
  // 不正キーは拒否
  const inv = gas.post('appendEvents', { routeCaptures: [{ key: 'x', serviceDate: '2026-09-30', routeCode: 'R' }], events: [{ key: 'bad', transportId: 'T', normalizedArea: 'a', serviceDate: '2026-09-30' }] });
  assert(inv.invalid === 2 && inv.capturesApplied === 0, 'inconsistent keys rejected');
  // core 側の同一規則
  const pure = AEC.applyAppendEvents({}, { routeCaptures: [caps[0], caps[0]], events: [item, item] });
  assert(pure.eventsAdded === 1 && pure.eventsUnchanged === 1 && Object.keys(pure.store.routeCaptures).length === 1, 'core applyAppendEvents idempotent');
}

// ===== 4. スナップショット再登録: events 保持・throughDate 前進で旧イベント除外 =====
{
  const eventsBefore = JSON.stringify(gas.stored().events);
  const reg = gas.post('saveSnapshot', payload);
  assert(reg.preservedRouteCaptures === 3 && reg.preservedEventItems === 1, 're-register reports preserved events');
  assert(JSON.stringify(gas.stored().events) === eventsBefore, 're-register keeps events intact');
  const rows40 = ROWS.map((r) => r.slice());
  rows40[1] = ['TID_A', 'driver a', '東油山', 29, '2026-09-28', 31, 2, 1, 1200, 1480, 'high'];
  const hist40 = HISTORY.concat([['2026-W40', '2026-09-27', '2026-10-03', '', 'fp40', 3, 'w40.xlsx']]);
  const snap40 = buildSnapshot(rows40, hist40);
  gas.post('saveSnapshot', AEC.buildSnapshotSavePayload(snap40, { updatedAt: '2026-10-04' }));
  const st = gas.stored();
  assert(st.snapshot.snapshotThroughDate === '2026-10-03', 'W40 throughDate stored');
  assert(Object.keys(st.events.routeCaptures).length === 3, 'events physically kept after W40');
  const d40 = mergedFromStored(st);
  assert(d40.byTransportId.TID_A.areas['東油山'].experienceDays === 29, 'W40 value not double counted with ≤W40 events');
  assert(d40.meta.eventsBeforeThrough > 0 && d40.meta.eventsCounted === 0, 'events ≤ throughDate excluded');
  // 旧 save でも events/snapshot は消えない
  gas.post('save', { records: [], stats: null });
  assert(gas.stored().snapshot && Object.keys(gas.stored().events.routeCaptures).length === 3, 'legacy save keeps snapshot/events');
}

// ===== 5. Render中継（実サーバーを子プロセス起動 → モックGAS） =====
async function withMockGas(fn) {
  const gasRt = createGasRuntime(null);
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const action = u.searchParams.get('action');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const out = req.method === 'GET' ? gasRt.get(action) : gasRt.post(action, JSON.parse(body || '{}'));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    await fn('http://127.0.0.1:' + srv.address().port + '/exec', gasRt);
  } finally {
    srv.close();
  }
}

async function withServer(env, fn) {
  const PORT = 34627;
  const proc = spawn(process.execPath, ['render-webhook-server.js'], { cwd: repoRoot, env: Object.assign({}, process.env, { PORT: String(PORT) }, env) });
  let out = '';
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server start timeout\n' + out)), 15000);
    proc.stdout.on('data', (c) => {
      out += c;
      if (out.indexOf('Server running on port') >= 0) {
        clearTimeout(t);
        resolve();
      }
    });
    proc.stderr.on('data', (c) => (out += c));
  });
  try {
    await fn('http://127.0.0.1:' + PORT, () => out);
  } finally {
    proc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 400));
  }
}

await withMockGas(async (gasUrl, gasRt) => {
  await withServer({ AREA_EXPERIENCE_MASTER_GAS_URL: gasUrl }, async (base, serverLog) => {
    const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json().then((j) => ({ status: r.status, json: j })));
    const save = await post('/area-experience-master?action=saveSnapshot', payload);
    assert(save.json.status === 'ok' && save.json.rawRowCount === 4, 'API saveSnapshot via Render proxy');
    const rawCaps = [
      { serviceDate: '2026-09-30', routeCode: 'DSX10', transporterId: 'TID_A', addresses: ADDR, capturedAt: '2026-09-30T20:00:00Z' },
      { serviceDate: '2026-09-30', routeCode: 'DSX12', transporterId: 'TID_A', addresses: ADDR, capturedAt: '2026-09-30T20:00:00Z' },
      { serviceDate: 'bad', routeCode: 'X', transporterId: 'TID_A', addresses: ADDR },
    ];
    const a1 = await post('/area-experience-events', { routeCaptures: rawCaps });
    assert(a1.status === 200 && a1.json.capturesApplied === 2 && a1.json.invalidBeforeGas.length === 1, 'API appendEvents normalizes and forwards');
    const a2 = await post('/area-experience-events', { routeCaptures: rawCaps });
    assert(a2.json.routeCaptureCount === 2, 'API resend idempotent (capture count)');
    const stored = (await fetch(base + '/area-experience-master?action=get').then((r) => r.json())).data;
    const m = mergedFromStored(stored);
    assert(m.byTransportId.TID_A.areas['東油山'].experienceDays === 29, 'API end-to-end +1 for one date with two routes');
    assert(stored.events.routeCaptures['2026-09-30|DSX10'].areas[0] === '東油山', 'area extracted by existing extractor on server');
    const empty = await post('/area-experience-events', { routeCaptures: [] });
    assert(empty.status === 400, 'API rejects empty append');

    // 実データ規模（6,510行）の saveSnapshot payload が Render(express.json 10mb) → GAS を通る
    const bigRows = [HEADER];
    for (let i = 0; i < 6510; i++) {
      const tid = i % 2 ? 'BIGTID' + (i % 35) : '';
      bigRows.push([tid, '個人名' + (i % 96), '町' + (i % 360), (i % 30) + 1, '2026-09-' + String((i % 26) + 1).padStart(2, '0'), 3, 1, 0, 40, 50, 'high']);
    }
    const bigSnap = buildSnapshot(bigRows, HISTORY, {});
    const bigPayload = AEC.buildSnapshotSavePayload(bigSnap, { updatedAt: '2026-10-01' });
    const bigBytes = Buffer.byteLength(JSON.stringify(bigPayload));
    assert(bigBytes > 1024 * 1024, 'big payload is realistic (>1MB): ' + bigBytes);
    const bigSave = await post('/area-experience-master?action=saveSnapshot', bigPayload);
    assert(bigSave.status === 200 && bigSave.json.status === 'ok' && bigSave.json.rawRowCount === 6510, 'API accepts 6,510-row snapshot');
    assert(gasRt.stored().snapshot.rawRows.length === 6510, 'GAS stored all rawRows');
    const capRes = await fetch(base + '/area-experience-master?action=capabilities').then((r) => r.json());
    assert(capRes.status === 'ok' && capRes.actions.indexOf('appendEvents') >= 0 && capRes.currentBytes > 0, 'capabilities via Render');
    // ログ監査: 氏名・TransportID・rawRows を出力しない（集計値のみ）
    await new Promise((r) => setTimeout(r, 200));
    const log = serverLog();
    ['個人名', 'BIGTID', '一郎 試験', 'TID_A', 'driver a', '東油山'].forEach((needle) => {
      assert(log.indexOf(needle) < 0, 'server log does not contain ' + needle);
    });
    assert(log.indexOf('area-experience-events POST: captures') >= 0, 'server logs counts only');
  });
});

// ===== 6. 旧形式（schemaVersion 1 相当）→ schemaVersion 2 移行 =====
{
  const legacyRecords = [{ transportId: 'TID_A', driverName: 'driver a', area: '東油山', experienceDays: 27, lastVisitDate: '2026-09-20' }];
  const v1 = JSON.stringify({ updatedAt: '2026-09-21', records: legacyRecords, stats: { drivers: 1 } });
  const g = createGasRuntime(v1);
  const got = g.get('get').data;
  assert(got.records.length === 1 && got.mode === 'legacy_records', 'v1 GET returns records, mode legacy_records');
  const cap = g.get('capabilities');
  assert(cap.schemaVersion === 2 && cap.storedSchemaVersion === 1 && cap.actions.indexOf('saveSnapshot') >= 0 && cap.mode === 'legacy_records', 'capabilities on v1 data');
  // appendEvents on v1 data does not touch records
  g.post('appendEvents', { routeCaptures: [normCap('2026-09-27', 'DSX10', 'TID_A')] });
  assert(JSON.stringify(g.stored().records) === JSON.stringify(legacyRecords), 'appendEvents keeps v1 records');
  assert(g.get('get').data.mode === 'legacy_records', 'events alone do not promote to snapshot mode');
  // 旧 save on v1 data: records replaced by explicit save only
  g.post('save', { updatedAt: '2026-09-22', records: legacyRecords, stats: { drivers: 1 } });
  assert(g.stored().records.length === 1 && Object.keys(g.stored().events.routeCaptures).length === 1, 'legacy save keeps events');
  // saveSnapshot: 旧 records を別ファイルへ退避してから v2 化
  const r = g.post('saveSnapshot', payload);
  assert(r.status === 'ok' && r.legacyBackupFile.indexOf('areaExperienceMaster.legacy-backup-') === 0, 'legacy backup file created on first migration');
  const backup = JSON.parse(g.state.otherFiles[r.legacyBackupFile]);
  assert(JSON.stringify(backup.records) === JSON.stringify(legacyRecords), 'backup holds previous records verbatim');
  const st = g.stored();
  assert(st.schemaVersion === 2 && st.mode === 'snapshot' && st.legacyBackupFile === r.legacyBackupFile, 'migrated to v2 snapshot mode');
  assert(Object.keys(st.events.routeCaptures).length === 1, 'events captured before migration preserved');
  // 2回目の saveSnapshot では再バックアップしない
  const r2 = g.post('saveSnapshot', payload);
  assert(r2.legacyBackupFile === '' && Object.keys(g.state.otherFiles).length === 1, 'no second backup');
  // Legacy CSV 登録 → legacy_records モード（snapshot/events は保持、昇格しない）
  g.post('save', { updatedAt: '2026-10-02', records: legacyRecords, stats: { drivers: 1 } });
  const afterLegacy = g.get('get').data;
  assert(afterLegacy.mode === 'legacy_records' && afterLegacy.snapshot && Object.keys(afterLegacy.events.routeCaptures).length === 1, 'legacy save → legacy mode, snapshot/events kept');
  // 新方式XLSX再登録で自動更新モードへ戻る
  g.post('saveSnapshot', payload);
  assert(g.get('get').data.mode === 'snapshot', 're-register snapshot → snapshot mode');
}

// ===== 6b. ロールバック互換: 旧クライアント（records のみ読む）が v2 データで従来表示できる =====
{
  const ASC = require('../assign-support-core.js');
  const g = createGasRuntime(null);
  g.post('saveSnapshot', payload);
  g.post('appendEvents', { routeCaptures: [normCap('2026-09-27', 'DSX10', 'TID_A')] });
  const d = g.get('get').data;
  // 旧 assign-support.js loadExperienceFromServer と同じ処理
  const oldClientDb = ASC.buildExperienceDbFromRecords(d.records, {});
  const snapOnly = AEC.mergeSnapshotAndEvents(AEC.restoreSnapshotLayer(d.snapshot), []);
  assert(JSON.stringify(oldClientDb.byTransportId) === JSON.stringify(snapOnly.byTransportId), 'old client reads v2 records = snapshot values (events not applied)');
  // 旧クライアントの save（旧 payload 形式）でも snapshot/events は消えない
  g.post('save', ASC.serializeExperienceForSave(oldClientDb));
  const after = g.stored();
  assert(after.snapshot && Object.keys(after.events.routeCaptures).length === 1 && after.mode === 'legacy_records', 'old client save keeps snapshot/events (legacy mode)');
}

// ===== 7. サイズ上限: 超過時は書き込まず既存内容を保持 =====
{
  const g = createGasRuntime(null);
  g.post('saveSnapshot', payload);
  const before = g.state.content;
  const calls = g.state.setContentCalls;
  const huge = JSON.parse(JSON.stringify(payload));
  huge.snapshot.rawRows = Array.from({ length: 200000 }, (_, i) => ['T' + i, '名前' + i, 'エリア' + i, 1, '2026-09-26', 1, 0, 0, 1, 1, 'high']);
  const res = g.post('saveSnapshot', huge);
  assert(res.status === 'error' && res.message.indexOf('too large') >= 0, 'oversized write rejected');
  assert(g.state.content === before && g.state.setContentCalls === calls, 'existing content untouched on rejection');
  assert(res.message.indexOf('名前') < 0, 'error message has no personal data');
}

console.log('area-experience-gas-api tests passed (' + passed + ' assertions)');
