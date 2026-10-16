import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(repo, 'index.html'), 'utf8');
function assert(cond, msg) { if (!cond) throw new Error('FAIL: ' + msg); }

const start = html.indexOf('function normalizeExecCompanyName');
const end = html.indexOf('var execMonthPieInstance');
assert(start > 0 && end > start, 'monthly company normalizer is in the production dashboard');
const source = html.slice(start, end);
assert(source.indexOf('localStorage') < 0 && source.indexOf('driverDepartments') < 0, 'normalization does not rewrite the driver master or saved shift');
assert(html.indexOf('var effectiveDept = masterDept || currentDept;') > 0, 'shift rows still prefer the existing master department');
assert(html.indexOf('totalVehicles += entries.length;') > 0, 'vehicle totals still count each worked row');
assert(html.indexOf('var deptCounts = countExecDayComposition(entries).deptCounts;') > 0, 'the daily composition chart uses the shared company counter');
assert(html.indexOf("var deptLabel = e.dept || '不明';") < 0, 'the daily composition no longer buckets the raw company spelling');

const context = {
  EXEC_TYPE_LABELS: { maru: '○（11h）', c1: 'C1（6.5h）' },
  EXEC_RATE_TABLE: { maru: { hours: 11 }, c1: { hours: 6.5 } }
};
vm.createContext(context);
vm.runInContext(source, context, { filename: 'index.html#exec-company-name' });

['AGENTLINE', 'Agent Line', 'AgentLine', 'agent line', 'AGENT LINE', 'Agent　Line'].forEach(function (label) {
  assert(context.normalizeExecCompanyName(label) === 'AGENTLINE', label + ' joins AGENTLINE');
});
['JHS', 'GDSダイレクト', 'GDS管理', 'GDSパート', 'AE物流', 'ファンタジスタ', 'LINGｓ', 'OFK6', 'Agent Lines'].forEach(function (label) {
  assert(context.normalizeExecCompanyName(label) === label, label + ' stays separate');
});
assert(context.normalizeExecCompanyName('') === '不明' && context.normalizeExecCompanyName(null) === '不明', 'a blank company stays unknown');

function rows(count, dept, prefix) {
  var list = [];
  for (var i = 0; i < count; i++) list.push({ name: prefix + i, dept: dept, type: 'maru' });
  return list;
}
const summary = context.summarizeExecMonthCompanies({
  1: rows(53, 'AGENTLINE', 'sheet-').concat(rows(22, 'Agent Line', 'master-'), rows(4, 'JHS', 'jhs-'))
});
assert(summary.deptCounts.AGENTLINE === 75 && summary.deptCounts['Agent Line'] == null, '53 sheet rows and 22 master rows are one company');
assert(summary.deptCounts.JHS === 4, 'another company keeps its own count');
assert(summary.totalVehicles === 79 && summary.activeDays === 1, 'the vehicle total still counts every worked row');
assert(summary.driverCount === 79, 'each person is registered once');
assert(summary.driverDeptCount.AGENTLINE === 75 && summary.driverDeptCount.JHS === 4, 'registered drivers follow the merged company');
assert(summary.typeCounts['○（11h）'] === 79, 'course totals stay on the existing type labels');

const repeat = context.summarizeExecMonthCompanies({
  1: [{ name: '同じ人', dept: 'AGENTLINE', type: 'maru' }],
  2: [{ name: '同じ人', dept: 'Agent Line', type: 'c1' }]
});
assert(repeat.totalVehicles === 2 && repeat.driverCount === 1 && repeat.deptCounts.AGENTLINE === 2, 'a repeated person stays one driver and two vehicles');

const dayRows = rows(53, 'AGENTLINE', 'sheet-').concat(rows(22, 'Agent Line', 'master-'), rows(4, 'JHS', 'jhs-'), rows(3, 'GDSダイレクト', 'gds-'));
dayRows.push({ name: '単価なし', dept: 'AGENTLINE', type: 'unknown' });
const composition = context.countExecDayComposition(dayRows);
assert(composition.deptCounts.AGENTLINE === 75 && composition.deptCounts['Agent Line'] == null, 'the daily composition joins AGENTLINE and Agent Line');
assert(composition.deptCounts.JHS === 4 && composition.deptCounts['GDSダイレクト'] === 3, 'other companies keep separate daily counts');
assert(composition.total === 82 && composition.deptCounts.AGENTLINE + composition.deptCounts.JHS + composition.deptCounts['GDSダイレクト'] === 82, 'a row without a course rate stays out of the composition count');
assert(context.countExecDayComposition([{ name: '空', dept: '', type: 'maru' }, { name: 'なし', dept: null, type: 'c1' }]).deptCounts['不明'] === 2, 'a blank daily company stays unknown');

console.log('exec-company-name: ok');
