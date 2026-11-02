// GAS Web App (gas/line-map-store.gs) の挙動を再現するテスト用モック。実GAS・実Driveには一切接続しない。
// fetchImpl として注入するか、serve() で実HTTPサーバーとして起動して使う。
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Store = require('../../line-map-store.js');

export function createGasMock(opts = {}) {
  const token = opts.token || 'gas-token-fake-0123456789';
  const m = { token, envelope: null, calls: [], fault: null, folderPrivate: true, bodies: [] };

  // 本体: { token, action, ... } を受け取り { status, text } を返す
  async function respond(bodyText) {
    m.bodies.push(bodyText);
    let body; try { body = JSON.parse(bodyText); } catch { return { status: 200, text: JSON.stringify({ status: 'error', reason: 'bad-request' }) }; }
    const reply = (o, status = 200) => ({ status, text: JSON.stringify(o) });
    switch (m.fault) {
      case 'unauthorized': return reply({ status: 'error', reason: 'unauthorized' });
      case '401': return reply({}, 401);
      case '429': return reply({}, 429);
      case '500': return reply({}, 500);
      case '503': return reply({}, 503);
      case 'html': return { status: 200, text: '<html>Sign in</html>' };
      case 'badjson': return { status: 200, text: '{"status":"ok","envelope":' }; // 途中で切れた応答
      case 'empty': return { status: 200, text: '' };
      case 'huge': return { status: 200, text: ' '.repeat(3 * 1024 * 1024 + 10) };
    }
    if (!body.token || body.token !== token) return reply({ status: 'error', reason: 'unauthorized' });
    if (body.action === 'load') {
      if (m.fault === 'partial-load') return reply({ status: 'ok' });                 // envelope キー自体が無い
      if (m.fault === 'corrupt-load' && m.envelope) { const e = JSON.parse(JSON.stringify(m.envelope)); const d = Object.keys(e.data)[0]; if (d) e.data[d].rows.pop(); return reply({ status: 'ok', envelope: e }); } // checksum 不一致
      if (m.fault === 'schema-load' && m.envelope) { const e = JSON.parse(JSON.stringify(m.envelope)); const d = Object.keys(e.data)[0]; e.data[d].rows[0].address = 'DUMMY-ADDRESS'; e.checksum = Store.checksumOf(e.data); return reply({ status: 'ok', envelope: e }); } // 想定外キー
      return reply({ status: 'ok', envelope: m.envelope });
    }
    if (body.action === 'save') {
      if (!m.folderPrivate) return reply({ status: 'error', reason: 'folder-not-private' });
      const env = body.envelope;
      if (!env || env.v !== 1 || !Number.isInteger(env.seq) || typeof env.checksum !== 'string' || !Store.validateStoredState(env.data).ok) return reply({ status: 'error', reason: 'bad-request' });
      const cur = m.envelope ? m.envelope.seq : 0;
      if (body.expectedSeq !== cur || env.seq !== cur + 1) return reply({ status: 'error', reason: 'conflict', seq: cur });
      if (m.fault === 'save-no-ack') { m.envelope = env; return reply({ status: 'ok' }); }                         // 成功だが seq/checksum を返さない
      if (m.fault === 'save-wrong-ack') { m.envelope = env; return reply({ status: 'ok', seq: env.seq, checksum: 'x'.repeat(64) }); }
      m.envelope = env;
      return reply({ status: 'ok', seq: env.seq, checksum: env.checksum });
    }
    return reply({ status: 'error', reason: 'unknown-action' });
  }

  const fetchImpl = async (url, init) => {
    m.calls.push({ url: String(url), method: init && init.method });
    if (m.fault === 'down') throw new TypeError('fetch failed: ECONNREFUSED ' + url); // 例外メッセージにURLが含まれても漏れないことを確認するため
    if (m.fault === 'timeout') await new Promise((_, rej) => { init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted ' + url), { name: 'AbortError' }))); });
    const r = await respond(init.body);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.text };
  };

  // 実HTTPサーバーとして起動 (子プロセスのOFK3から接続するテスト用)
  function serve() {
    const srv = http.createServer((req, res) => {
      let d = ''; req.on('data', c => d += c);
      req.on('end', async () => { const r = await respond(d); res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(r.text); });
    });
    return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ url: 'http://127.0.0.1:' + srv.address().port + '/exec', close: () => new Promise(c => { srv.closeAllConnections && srv.closeAllConnections(); srv.close(c); }) })));
  }
  m.fetchImpl = fetchImpl; m.serve = serve;
  return m;
}
