// ドライバー能力DB: 累計Excelは同一ドライバーをExcel値で置換し、
// Excelにいない既存ドライバーは残す。週次アップロードの加算は維持する。
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const root = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(root, '..');
const Import = require(join(repoRoot, 'driver-ability-import-core.js'));

function row(name, overrides) {
  return Object.assign({
    '配達アソシエート': name,
    '集計対象稼働日数': 12,
    '1時間あたり配送個数': 22.5,
    '配送個数合計(集計対象日)': 1100,
    '正配依頼合計': 4,
    '誤配率': 1.25,
    '配管率%(平均)': 97.5
  }, overrides || {});
}

function baseDb() {
  return {
    '陸 安樂': {
      driverId: 7,
      packagesPerHour: 20,
      deliveryRate: 90,
      misdeliveryRate: 1.5,
      workDays: 10,
      totalPackages: 1000,
      incidents: 2,
      totalHours: 40,
      lastUpdated: '2026/9/1',
      history: [{ date: '2026/9/1', pph: 20, days: 10 }]
    },
    '晴樹 藤永': {
      driverId: 8,
      packagesPerHour: 18,
      workDays: 5,
      totalPackages: 400,
      incidents: 1,
      lastUpdated: '2026/9/1',
      history: [{ date: '2026/9/1', pph: 18, days: 5 }]
    }
  };
}

function testCumulativeReplacesSameDriverAndKeepsOthers() {
  var db = baseDb();
  var beforeOther = JSON.parse(JSON.stringify(db['晴樹 藤永']));
  var result = Import.applyDriverAbilityRows(db, [
    row('陸 安樂'),
    row('新人 太郎', { '集計対象稼働日数': 3, '配送個数合計(集計対象日)': 90, '正配依頼合計': 0, '1時間あたり配送個数': 15 })
  ], {
    mode: 'cumulative',
    today: '2026/10/1',
    nextDriverId: function () { return 100; }
  });

  assert.equal(db['陸 安樂'].workDays, 12, '累計は稼働日数をExcel値で置換（10+12にしない）');
  assert.equal(db['陸 安樂'].totalPackages, 1100, '累計は総配送数をExcel値で置換（1000+1100にしない）');
  assert.equal(db['陸 安樂'].incidents, 4, '累計は正配依頼をExcel値で置換（2+4にしない）');
  assert.equal(db['陸 安樂'].packagesPerHour, 22.5, '累計は個/時間をExcel値で置換');
  assert.equal(db['陸 安樂'].driverId, 7, '既存driverIdは保持');
  assert.equal(db['陸 安樂'].totalHours, 40, 'Excelに無い既存フィールドは保持');
  assert.equal(db['陸 安樂'].deliveryRate, 97.5, '累計は配管率をExcel値で置換');
  assert.equal(db['陸 安樂'].misdeliveryRate, 1.25, '累計は誤配率をExcel値で置換');
  assert.deepEqual(db['晴樹 藤永'], beforeOther, 'Excelにいない既存ドライバーは無変更');
  assert.equal(db['新人 太郎'].workDays, 3, 'Excelにだけいるドライバーは追加');
  assert.equal(db['新人 太郎'].driverId, 100, '新規だけ採番');
  assert.deepEqual(result.newlyRegisteredNames, ['新人 太郎'], '既存の置換は新規登録にしない');
}

function testCumulativeReuploadDoesNotDouble() {
  var db = baseDb();
  var rows = [row('陸 安樂', { '集計対象稼働日数': 30, '配送個数合計(集計対象日)': 3000, '正配依頼合計': 6, '1時間あたり配送個数': 25 })];
  var opts = { mode: 'cumulative', today: '2026/10/1', nextDriverId: function () { return 1; } };
  Import.applyDriverAbilityRows(db, rows, opts);
  Import.applyDriverAbilityRows(db, rows, opts);
  assert.equal(db['陸 安樂'].workDays, 30, '同じ累計の再取込でも再加算しない');
  assert.equal(db['陸 安樂'].totalPackages, 3000, '同じ累計の再取込でも総配送数を再加算しない');
  assert.equal(db['陸 安樂'].incidents, 6, '同じ累計の再取込でも正配依頼を再加算しない');
  assert.equal(db['陸 安樂'].packagesPerHour, 25, '同じ累計の再取込でも個/時間を再加算しない');
  assert.equal(db['晴樹 藤永'].workDays, 5, '再取込でもExcel外ドライバーを消さない');
}

function testCumulativeZeroRatesReplace() {
  var db = baseDb();
  Import.applyDriverAbilityRows(db, [
    row('陸 安樂', { '誤配率': 0, '配管率%(平均)': 0, '正配依頼合計': 0 })
  ], { mode: 'cumulative', today: '2026/10/1', nextDriverId: function () { return 1; } });
  assert.equal(db['陸 安樂'].misdeliveryRate, 0, '累計の誤配率0は既存値を残さず置換');
  assert.equal(db['陸 安樂'].deliveryRate, 0, '累計の配管率0は既存値を残さず置換');
  assert.equal(db['陸 安樂'].incidents, 0, '累計の正配依頼0は既存値を残さず置換');
}

function testCumulativeReplacesDriverWithoutPriorPph() {
  var db = { '陸 安樂': { driverId: 7, workDays: 10, totalPackages: 1000, incidents: 2 } };
  Import.applyDriverAbilityRows(db, [row('陸 安樂')], {
    mode: 'cumulative',
    today: '2026/10/1',
    nextDriverId: function () { throw new Error('existing driver must not be reissued an id'); }
  });
  assert.equal(db['陸 安樂'].driverId, 7, 'packagesPerHourが無くても既存IDを維持');
  assert.equal(db['陸 安樂'].workDays, 12, '能力未設定の既存行もExcel値で置換');
  assert.equal(db['陸 安樂'].totalPackages, 1100);
}

function testWeeklyStillAdds() {
  var db = baseDb();
  var beforeOther = JSON.parse(JSON.stringify(db['晴樹 藤永']));
  Import.applyDriverAbilityRows(db, [
    row('陸 安樂', {
      '集計対象稼働日数': 10,
      '1時間あたり配送個数': 30,
      '配送個数合計(集計対象日)': 50,
      '正配依頼合計': 2
    })
  ], { mode: 'weekly', today: '2026/10/1', nextDriverId: function () { return 1; } });

  assert.equal(db['陸 安樂'].workDays, 20, '週次は稼働日数を加算');
  assert.equal(db['陸 安樂'].totalPackages, 1050, '週次は総配送数を加算');
  assert.equal(db['陸 安樂'].incidents, 4, '週次は正配依頼を加算');
  assert.equal(db['陸 安樂'].packagesPerHour, 25, '週次は稼働日数加重の個/時間');
  assert.equal(db['陸 安樂'].driverId, 7, '週次加算でもdriverIdは保持');
  assert.deepEqual(db['晴樹 藤永'], beforeOther, '週次でもExcel外ドライバーは保持');
}

function testWeeklySameDayStillOverwrites() {
  var db = baseDb();
  db['陸 安樂'].history = [{ date: '2026/10/1', pph: 20, days: 10 }];
  Import.applyDriverAbilityRows(db, [
    row('陸 安樂', {
      '集計対象稼働日数': 4,
      '1時間あたり配送個数': 30,
      '配送個数合計(集計対象日)': 80,
      '正配依頼合計': 1
    })
  ], { mode: 'weekly', today: '2026/10/1', nextDriverId: function () { return 1; } });
  assert.equal(db['陸 安樂'].workDays, 4, '週次の同日再取込は加算せず上書き');
  assert.equal(db['陸 安樂'].totalPackages, 80, '週次の同日再取込は総配送数を上書き');
  assert.equal(db['陸 安樂'].incidents, 1, '週次の同日再取込は正配依頼を上書き');
  assert.equal(db['陸 安樂'].packagesPerHour, 30, '週次の同日再取込は個/時間を上書き');
}

function testWeeklyAfterCumulativeStillAdds() {
  var db = baseDb();
  var rows = [row('陸 安樂', { '集計対象稼働日数': 30, '配送個数合計(集計対象日)': 3000, '正配依頼合計': 6, '1時間あたり配送個数': 20 })];
  Import.applyDriverAbilityRows(db, rows, { mode: 'cumulative', today: '2026/10/1', nextDriverId: function () { return 1; } });
  Import.applyDriverAbilityRows(db, [
    row('陸 安樂', { '集計対象稼働日数': 2, '配送個数合計(集計対象日)': 40, '正配依頼合計': 1, '1時間あたり配送個数': 20 })
  ], { mode: 'weekly', today: '2026/10/1', nextDriverId: function () { return 1; } });
  assert.equal(db['陸 安樂'].workDays, 32, '累計置換のあと同日の週次は加算する');
  assert.equal(db['陸 安樂'].totalPackages, 3040, '累計置換のあと週次は総配送数を加算する');
  assert.equal(db['陸 安樂'].incidents, 7, '累計置換のあと週次は正配依頼を加算する');
}

function testCumulativeDetection() {
  assert.equal(Import.isCumulativeDriverUpload('ドライバー別配送データ_累計W22-W31.xlsx', 'Sheet1'), true);
  assert.equal(Import.isCumulativeDriverUpload('weekly.xlsx', '累計W28'), true);
  assert.equal(Import.isCumulativeDriverUpload('ドライバー別配送データ_2026-10-01.csv', '配送実績'), false);
  assert.equal(Import.isCumulativeDriverUpload('', ''), false);
}

function testIndexWiringKeepsWeeklyAggregation() {
  var html = readFileSync(join(repoRoot, 'index.html'), 'utf8');
  assert.match(html, /DriverAbilityImport\.isCumulativeDriverUpload\(file\.name,\s*targetSheetName\)/);
  assert.match(html, /DriverAbilityImport\.applyDriverAbilityRows\(driverDB,\s*data/);
  assert.match(html, /mode:\s*mode/);
  assert.match(html, /prevWorkDays \+ r\.workDays/);
  assert.match(html, /prevTotalPkg \+ r\.totalPkg/);
  assert.match(html, /prevIncidents \+ r\.seihai/);
  var aggStart = html.indexOf('function mergeDriverAggData');
  var aggEnd = html.indexOf('function exportDriverAggCSV');
  assert.ok(aggStart >= 0 && aggEnd > aggStart, 'mergeDriverAggData exists');
  var agg = html.slice(aggStart, aggEnd);
  assert.match(agg, /上書きではなく蓄積/);
  assert.equal(agg.indexOf("mode: 'cumulative'"), -1, '3ファイル週次集計は累計置換モードを使わない');
}

testCumulativeReplacesSameDriverAndKeepsOthers();
testCumulativeReuploadDoesNotDouble();
testCumulativeZeroRatesReplace();
testCumulativeReplacesDriverWithoutPriorPph();
testWeeklyStillAdds();
testWeeklySameDayStillOverwrites();
testWeeklyAfterCumulativeStillAdds();
testCumulativeDetection();
testIndexWiringKeepsWeeklyAggregation();
console.log('driver-ability-import tests passed');
