import { createRequire } from 'module';
import { strict as assert } from 'assert';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const fujin = require('../inoichi-fujin-capacity.js');

test('a missing FUJIN result is unfetched and sends nothing', () => {
  const view = fujin.present(null);
  assert.equal(view.state, 'missing');
  assert.equal(view.label, '未取得');
  assert.equal(view.notificationsSent, false);
  const html = fujin.render(view);
  assert.equal(html.includes('未取得'), true);
  assert.equal(html.includes('通知は送っていません'), true);
  assert.equal(html.includes('>0<'), false);
});

test('shows a three-source match without treating assigned quantity as the reserved count', () => {
  const view = fujin.present({
    contract: fujin.CONTRACT,
    executedAt: '2026-10-30T14:00:00.000Z',
    serviceDate: '2026-10-30',
    rows: [{
      serviceDate: '2026-10-30',
      cycle: 'C1',
      serviceType: 'Standard Parcel',
      reservation: { quantity: 4, assignedQuantity: 1 },
      scheduling: { reservationQuantity: 4 },
      inputFile: { quantity: 4 },
      delta: 0,
      judgment: 'MATCH',
      label: '一致',
    }, {
      serviceDate: '2026-10-30',
      cycle: 'C2',
      serviceType: 'Biker',
      block: '08:00',
      reservation: { quantity: null, assignedQuantity: null },
      scheduling: { reservationQuantity: null },
      inputFile: { quantity: null },
      delta: null,
      judgment: 'MISSING',
      label: '未取得',
    }],
  });
  assert.equal(view.rows[0].reservationQuantity, 4);
  assert.equal(view.rows[0].assignedQuantity, 1);
  assert.equal(view.rows[1].reservationQuantity, null);
  const html = fujin.render(view);
  assert.equal(html.includes('一致'), true);
  assert.equal(html.includes('未取得'), true);
  assert.equal(html.includes('>0<'), false);
  assert.equal(view.notificationsSent, false);
});

test('a wrong contract stays unfetched', () => {
  const view = fujin.present({ contract: 'other', rows: [{ quantity: 3 }] });
  assert.equal(view.state, 'missing');
  assert.equal(view.rows.length, 0);
});
