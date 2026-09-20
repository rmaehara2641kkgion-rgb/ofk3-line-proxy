import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const uiSrc = readFileSync(join(root, 'ofk3-cortex-priority-ui.js'), 'utf8');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const serverSrc = readFileSync(join(root, 'render-webhook-server.js'), 'utf8');

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
}

assert(uiSrc.indexOf('new MutationObserver') < 0, 'UI must not construct MutationObserver');
assert(!/observe\s*\(\s*document\.body/.test(uiSrc), 'UI must not observe document.body');
assert(uiSrc.indexOf('setInterval(') < 0, 'UI must not poll DOM with setInterval');
assert(uiSrc.indexOf('querySelectorAll(\'h1,h2') < 0, 'UI must not scan all headings');
assert(uiSrc.indexOf('function renderCortexPriorityDashboard') >= 0, 'independent dashboard renderer exists');
assert(uiSrc.indexOf("DASH_ID = 'ofk3-cortex13-dash-card'") >= 0, 'fixed dashboard card id');
assert(uiSrc.indexOf("TW_ID = 'ofk3-cortex13-tw-panel'") >= 0, 'fixed time-window panel id');
assert(uiSrc.indexOf('本日のデータなし') >= 0, 'empty state copy exists');
assert(uiSrc.indexOf('本日分なし・最新') >= 0, 'latest fallback date is labeled');
assert(uiSrc.indexOf('latest=1') >= 0, 'today miss falls back to latest=1');
assert(uiSrc.indexOf('OFK3_Cortex_13時必達詳細_') >= 0, 'existing CSV filename kept');
assert(uiSrc.indexOf('splash-screen') < 0 && uiSrc.indexOf('splash-hidden') < 0, 'UI must not touch splash');

assert(html.indexOf('id="ofk3-cortex13-dash-card"') >= 0, 'dashboard host exists in index.html');
assert(html.indexOf('id="ofk3-cortex13-tw-panel"') >= 0, 'time-window host exists in index.html');
assert(/id="cortex13-card"[^>]*class="[^"]*\bhidden\b|class="[^"]*\bhidden\b[^"]*" id="cortex13-card"/.test(html), 'legacy Cortex PoC card is hidden');
assert(html.indexOf('OFK3Cortex13.onTab') >= 0, 'switchTab calls Cortex onTab hook');
assert(html.indexOf('renderCortexPriorityDashboard') >= 0, 'renderDashboard refreshes Cortex card');
assert(html.indexOf('/ofk3-cortex-priority-ui.js?v=20260921-1') >= 0, 'UI script is loaded from index.html');
assert(html.indexOf('id="splash-screen"') >= 0, 'splash markup unchanged');
assert(html.indexOf('住所マスターJSON読込') >= 0, 'non-Cortex JSON loader remains');

assert(serverSrc.indexOf("app.post('/cortex-priority/import'") >= 0, 'import API unchanged');
assert(serverSrc.indexOf("app.get('/cortex-priority'") >= 0, 'GET API unchanged');
assert(serverSrc.indexOf("status: 'empty'") >= 0, 'empty GET still returns JSON empty');

console.log('ok cortex-dashboard-card');
