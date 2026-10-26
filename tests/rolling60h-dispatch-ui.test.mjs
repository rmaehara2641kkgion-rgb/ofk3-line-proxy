import assert from 'node:assert/strict';
import fs from 'node:fs';

const loaded = await import('../rolling60h-dispatch-ui.js');
const ui = loaded.default && loaded.default.avoidText ? loaded.default : loaded;
const source = fs.readFileSync(new URL('../rolling60h-dispatch-ui.js', import.meta.url), 'utf8');
const index = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const screen = fs.readFileSync(new URL('../rolling60h-ui.js', import.meta.url), 'utf8');

function side(status, origin, hours, over, remaining) {
  return {
    status: status,
    origin: origin,
    label: status === 'missing' ? 'データ未取得' : status === 'unconfirmed' ? '予定未確定' : status === 'within' ? '以内' : status === 'exceed' ? '超過' : status,
    totalHours: hours,
    overHours: over,
    remainingHours: remaining
  };
}

function row(extra) {
  return Object.assign({
    transportId: 'T1',
    name: '架空',
    today: side('within', 'actual', 0, 0, 60),
    tomorrow: side('within', 'actual', 0, 0, 60),
    simulatedTomorrow: side('within', 'simulation', 0, 0, 60),
    requiredCutHours: null,
    avoidable: false,
    avoidReason: 'not-exceeding',
    undetermined: false
  }, extra);
}

const missing = row({
  name: '架空未取得',
  undetermined: true,
  today: side('missing', 'missing', null, null, null),
  tomorrow: side('unconfirmed', 'unconfirmed', 8, null, null),
  simulatedTomorrow: side('missing', 'missing', null, null, null),
  avoidReason: 'tomorrow-missing'
});
const zero = row({ name: '架空ゼロ' });
const adjustable = row({
  name: '架空調整',
  today: side('within', 'roster', 8, 0, 52),
  tomorrow: side('exceed', 'roster', 63.5, 3.5, 0),
  simulatedTomorrow: side('within', 'simulation', 60, 0, 0),
  requiredCutHours: 3.5,
  avoidable: true,
  avoidReason: 'today-cut'
});
const blocked = row({
  name: '架空不可',
  today: side('within', 'actual', 10, 0, 50),
  tomorrow: side('exceed', 'roster', 72, 12, 0),
  simulatedTomorrow: side('exceed', 'simulation', 62, 2, 0),
  avoidable: false,
  avoidReason: 'today-shortening-insufficient'
});

assert.equal(ui.avoidText(missing), '判定不能');
assert.equal(ui.hoursView(missing.today), '実績未取得');
assert.equal(ui.hoursView(zero.today), '実績 0.0h');
assert.equal(ui.avoidText(zero), '超過なし');
assert.equal(ui.avoidText(adjustable), '回避可能');
assert.equal(ui.avoidText(blocked), '回避不可');
assert.doesNotMatch(source, /tomorrow\.status !== 'exceed'\) return '超過なし'/);
assert.doesNotMatch(source, /writeFile|unlink|DAILY_DIR/);

const board = {
  ok: true,
  drivers: [missing, zero, adjustable, blocked],
  todayDanger: [],
  tomorrowDanger: [adjustable, blocked],
  adjustable: [adjustable],
  undetermined: [missing]
};
const html = ui.renderHtml(board, { query: '', filter: 'all', sort: 'over', open: false }, {
  exceed: 78,
  approach: 39,
  ongoing: 117,
  undetermined: 43
}, {});

assert.doesNotMatch(html, /rolling-dispatch-panel/);
assert.match(html, /auto-fill/);
assert.match(html, /7日窓の判定件数/);
assert.match(html, /人数ではない/);
assert.match(html, /超過78／接近39／継続117／判定不能43/);
assert.match(html, /今日の調整で回避できるDA/);
assert.match(html, /架空調整/);
assert.match(html, /予定 63\.5h/);
assert.match(html, /超過3\.5h/);
assert.match(html, /3\.5h/);
assert.match(html, /回避可能/);
assert.match(html, /回避不可/);
assert.match(html, /判定不能者/);
assert.match(html, /今日は実績未取得/);
assert.match(html, /明日は予定未確定/);
assert.match(html, /今日の危険者[\s\S]*該当なし/);
assert.match(html, /仮変更は原本と正式シフトには反映しません/);
assert.match(html, /dry-run/);
assert.doesNotMatch(html, /<details id="rolling-dispatch-details" open/);
assert.equal((html.match(/超過なし/g) || []).length > 0, true);
const missingSlice = html.slice(html.indexOf('判定不能者'), html.indexOf('全DA詳細一覧'));
assert.doesNotMatch(missingSlice, /超過なし/);

const indexPanel = index.slice(index.indexOf('id="panel-duty-risk"'), index.indexOf('id="panel-tw-extract"'));
assert.match(indexPanel, /id="rolling-dispatch-host"/);
assert.match(indexPanel, /id="duty-risk-root"/);
assert.equal(index.split('id="rolling-dispatch-host"').length, 2);
assert.doesNotMatch(screen, /<div id="rolling-dispatch-host"><\/div>/);
assert.match(screen, /unit: '7日窓の判定件数'/);

console.log('rolling60h dispatch ui ok');
