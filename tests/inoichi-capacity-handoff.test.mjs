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

test('authentication failure is not an unfetched count', () => {
  const view = handoff.present({ httpStatus: 401, serviceDate: '2026-10-30' });
  assert.equal(view.label, '認証が必要');
  assert.equal(view.lines.length, 0);
  const html = handoff.render(view);
  assert.equal(html.includes('認証が必要'), true);
  assert.equal(html.includes('>0<'), false);
});

test('a 29-day row keeps a missing plan as unfetched', () => {
  const view = handoff.present({
    data: {
      serviceDate: '2026-10-30',
      overall: { judgment: 'missing', label: '未取得' },
      lines: [],
      sources: {}
    },
    window: {
      dates: [{
        serviceDate: '2026-10-30',
        daDeadlineOpen: false,
        capacityChangeFocus: false,
        overall: { label: '未取得' },
        counts: { plan: null, reservation: null, assignments: null, inputFile: null }
      }],
      priority: ['2026-10-31']
    }
  });
  const html = handoff.render(view);
  assert.equal(html.includes('未取得'), true);
  assert.equal(html.includes('data-ino-capacity-day="2026-10-30"'), true);
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
  const again = handoff.render(null);
  assert.equal(again.includes('data-ino-capacity-state="loaded"'), true);
  assert.equal(again.includes('CYCLE_2'), true);
});

test('a missing plan does not become a zero delta and deadline days sort first', () => {
  const view = handoff.present({
    data: {
      serviceDate: '2026-10-30',
      overall: { judgment: 'missing', label: '未取得' },
      sources: {},
      lines: [{
        serviceDate: '2026-10-30',
        cycleId: 'CYCLE_2',
        serviceTypeName: 'Standard Parcel',
        serviceTime: '8',
        routeTarget: null,
        inputQuantity: 15,
        label: '未取得'
      }, {
        serviceDate: '2026-10-30',
        cycleId: 'CYCLE_1',
        serviceTypeName: 'Standard Parcel',
        serviceTime: '8',
        routeTarget: 4,
        inputQuantity: 4,
        label: '一致'
      }]
    },
    window: {
      dates: [
        { serviceDate: '2026-10-23', daDeadlineOpen: false, attentionRank: 5, attentionTie: 2, overall: { label: '一致' }, counts: { plan: 4, reservation: 4, assignments: 4, inputFile: 4 } },
        { serviceDate: '2026-10-31', daDeadlineOpen: true, attentionRank: 1, attentionTie: 2, overall: { label: '未取得' }, counts: { plan: null, reservation: null, assignments: null, inputFile: null } }
      ],
      priority: ['2026-10-31']
    }
  });
  assert.equal(view.lines[0].delta, null);
  assert.equal(view.lines[1].delta, 0);
  const html = handoff.render(view);
  assert.equal(html.indexOf('2026-10-31') < html.indexOf('2026-10-23'), true);
  assert.equal(html.includes('>0<'), true);
  assert.equal(html.includes('未取得'), true);
});
