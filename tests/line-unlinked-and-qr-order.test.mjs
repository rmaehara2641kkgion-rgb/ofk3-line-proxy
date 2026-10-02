import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const Line = require(join(root, 'line-unlinked-core.js'));
const Qr = require(join(root, 'qr-print-order-core.js'));
const serverSrc = readFileSync(join(root, 'render-webhook-server.js'), 'utf8');
const indexSrc = readFileSync(join(root, 'index.html'), 'utf8');

function testNewUserIsCapturedOnce() {
  var store = Line.createStore();
  var first = Line.captureLineUser(store, {
    userId: 'Unew',
    now: '2026-10-02T00:12:00.000Z',
    profile: { displayName: '山田太郎', pictureUrl: 'https://profile.example/a' }
  });
  assert.equal(first.created, true);
  assert.equal(Line.listPending(store).length, 1);
  assert.equal(Line.listPending(store)[0].displayName, '山田太郎');
  assert.equal(Line.listPending(store)[0].pictureUrl, 'https://profile.example/a');
  assert.equal(Line.listPending(store)[0].firstSeenAt, '2026-10-02T00:12:00.000Z');

  var second = Line.captureLineUser(store, {
    userId: 'Unew',
    now: '2026-10-02T01:00:00.000Z',
    profile: { displayName: '山田太郎' }
  });
  assert.equal(second.created, false);
  assert.equal(Line.listPending(store).length, 1, 'same userId does not duplicate');
  assert.equal(store.users.Unew.firstSeenAt, '2026-10-02T00:12:00.000Z');
  assert.equal(store.users.Unew.lastSeenAt, '2026-10-02T01:00:00.000Z');
}

function testKnownUserIsNotPending() {
  var store = Line.createStore();
  Line.replaceKnownLineIds(store, { Uknown: '陸 安樂' });
  var result = Line.captureLineUser(store, { userId: 'Uknown', now: '2026-10-02T00:00:00.000Z' });
  assert.equal(result.reason, 'already_linked');
  assert.equal(Line.listPending(store).length, 0);
}

function testManualLinkRemovesPendingAndBlocksOverwrite() {
  var store = Line.createStore();
  Line.captureLineUser(store, { userId: 'Unew', now: '2026-10-02T00:00:00.000Z', profile: { displayName: '山田太郎' } });
  var blocked = Line.linkPendingUser(store, { userId: 'Unew', driverName: '陸 安樂', currentLineId: 'Uother' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'overwrite_blocked');
  assert.equal(Line.listPending(store).length, 1, 'failed link stays pending');

  var duplicate = Line.linkPendingUser(store, { userId: 'Unew', driverName: '別人', lineIdOwner: '陸 安樂' });
  assert.equal(duplicate.error, 'duplicate_line_id');

  var linked = Line.linkPendingUser(store, { userId: 'Unew', driverName: '陸 安樂', currentLineId: '', source: 'manual' });
  assert.equal(linked.ok, true);
  assert.equal(Line.listPending(store).length, 0);
  assert.equal(store.knownLineIds.Unew, '陸 安樂');
  var again = Line.captureLineUser(store, { userId: 'Unew', now: '2026-10-02T02:00:00.000Z' });
  assert.equal(again.reason, 'already_linked');
  Line.replaceKnownLineIds(store, {});
  assert.equal(Line.listPending(store).length, 1, 'clearing the driver LINE ID returns the user to the pending list');
}

function testSuggestDoesNotAutoLink() {
  var names = Line.suggestDriverCandidates('山田太郎', ['山田 太郎', '佐藤']);
  assert.deepEqual(names, ['山田 太郎']);
  var store = Line.createStore();
  Line.captureLineUser(store, { userId: 'Unew', now: '2026-10-02T00:00:00.000Z', profile: { displayName: '山田太郎' } });
  assert.equal(store.users.Unew.status, 'pending');
  assert.equal(store.users.Unew.registrationCode, '');
}

function testQrOrderKeepsUndatedAndAppendsNew() {
  var meta = {
    '佐藤': { driverId: 2 },
    '山田': { driverId: 9 },
    '新人A': { driverId: 100, createdAt: 2000 },
    '新人B': { driverId: 101, createdAt: 3000 }
  };
  function lookup(name) { return meta[name]; }
  var once = Qr.sortDriversForBulkQr(['山田', '新人B', '佐藤', '新人A'], lookup);
  var twice = Qr.sortDriversForBulkQr(['新人A', '佐藤', '山田', '新人B'], lookup);
  assert.deepEqual(once, ['佐藤', '山田', '新人A', '新人B']);
  assert.deepEqual(twice, once, 'order is deterministic across reloads');
  var legacy = ['佐藤', '山田'].sort(function (a, b) { return a.localeCompare(b, 'ja'); });
  assert.deepEqual(once.slice(0, 2), legacy, 'undated drivers keep the previous name order');
}

function testQrPagesPutNewDriversLast() {
  var names = [];
  var meta = {};
  for (var i = 0; i < 90; i++) {
    var name = '既存' + String(i).padStart(2, '0');
    names.push(name);
    meta[name] = { driverId: i + 1 };
  }
  names.push('新人1', '新人2');
  meta['新人1'] = { driverId: 200, createdAt: 10 };
  meta['新人2'] = { driverId: 201, createdAt: 20 };
  var sorted = Qr.sortDriversForBulkQr(names, function (name) { return meta[name]; });
  assert.deepEqual(sorted.slice(-2), ['新人1', '新人2']);
  var lastPage = Qr.namesOnLastPage(sorted, 8);
  assert.ok(lastPage.indexOf('新人1') >= 0 && lastPage.indexOf('新人2') >= 0);
  assert.equal(Qr.pageOfIndex(sorted.length - 1, 8), Qr.pageOfIndex(sorted.indexOf('新人1'), 8));
}

function testWiringLeavesQrPayloadAndWebhookLog() {
  assert.match(serverSrc, /USER ID FOUND/);
  assert.match(serverSrc, /captureUnlinkedLineUser\(event\.source\.userId\)/);
  assert.match(serverSrc, /sendWelcomeMessage\(event\.source\.userId\)/);
  assert.match(serverSrc, /Authorization: 'Bearer ' \+ CHANNEL_ACCESS_TOKEN/);
  assert.equal(indexSrc.indexOf('CHANNEL_ACCESS_TOKEN'), -1);
  assert.match(indexSrc, /function getQRData\(name\)/);
  assert.match(indexSrc, /return "OFK3_D" \+ normalizeIdToken\(db\.driverId\)/);
  assert.match(indexSrc, /return "OFK3_DRIVER:" \+ name/);
  assert.match(indexSrc, /QrPrintOrder\.sortDriversForBulkQr/);
  assert.match(indexSrc, /createdAt: Date\.now\(\)/);
  assert.match(indexSrc, /openLineUnlinkedPanel/);
  var createdCount = indexSrc.split('createdAt: Date.now()').length - 1;
  assert.equal(createdCount, 1, 'createdAt is stamped only by the new-driver helper');
}

testNewUserIsCapturedOnce();
testKnownUserIsNotPending();
testManualLinkRemovesPendingAndBlocksOverwrite();
testSuggestDoesNotAutoLink();
testQrOrderKeepsUndatedAndAppendsNew();
testQrPagesPutNewDriversLast();
testWiringLeavesQrPayloadAndWebhookLog();
console.log('line-unlinked-and-qr-order tests passed');
