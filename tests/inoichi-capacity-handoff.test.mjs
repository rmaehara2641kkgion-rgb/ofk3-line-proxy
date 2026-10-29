import { createRequire } from 'module';
import { strict as assert } from 'assert';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const handoff = require('../inoichi-capacity-handoff.js');

test('a failed ENOU connection is not zero vehicles', () => {
  const view = handoff.present({ connectionFailed: true });
  assert.equal(view.state, 'connection_failed');
  assert.equal(view.label, '接続失敗');
  assert.equal(view.lines.length, 0);
  const html = handoff.render(view);
  assert.equal(html.includes('接続失敗'), true);
  assert.equal(html.includes('>0<'), false);
});

test('missing Amazon counts stay unfetched on the card', () => {
  const view = handoff.present({
    data: {
      serviceDate: '2026-10-30',
      reconciledAt: '2026-10-30T01:00:00.000Z',
      overall: { judgment: 'missing', label: '未取得' },
      sources: {
        amazon_schedule: { state: 'not_collected', origin: null, acquiredAt: null },
        inputfile: { state: 'imported', origin: 'excel_readonly', acquiredAt: '2026-10-30T01:00:00.000Z' }
      },
      lines: [{
        serviceDate: '2026-10-30',
        cycleId: 'CYCLE_2',
        serviceTypeName: 'Standard Parcel',
        serviceTime: '8',
        routeTarget: null,
        effectiveReservationQuantity: null,
        assignedCount: null,
        inputQuantity: 15,
        label: '未取得'
      }]
    }
  });
  assert.equal(view.lines[0].plan, null);
  assert.equal(view.lines[0].inputFile, 15);
  const html = handoff.render(view);
  assert.equal(html.includes('未取得'), true);
  assert.equal(html.includes('excel_readonly'), true);
  assert.equal(html.includes('>0<'), false);
});
