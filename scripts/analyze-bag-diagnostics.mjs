#!/usr/bin/env node
// Bag diagnostics analyzer (v3.6 / v3.7 "Bag診断保存" JSON).
//   node scripts/analyze-bag-diagnostics.mjs cortex-bag-diagnostics_2026-09-25.json [--json]
// Groups stop_expand_failed packages by Route + Stop, classifies each failed Stop from its click
// evidence, and lists package-fallback and captured_null targets. Read-only; prints a report.
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/analyze-bag-diagnostics.mjs <cortex-bag-diagnostics.json> [--json]');
  process.exit(2);
}
const asJson = process.argv.includes('--json');
const d = JSON.parse(readFileSync(file, 'utf8'));

const targets = d.targets || [];
const results = d.results || {};
const tdiag = {};
(d.targetDiagnostics || []).forEach((t) => { tdiag[t.referenceId] = t; });
const statusOf = (ref) => (tdiag[ref] && tdiag[ref].status) || (d.summary && d.summary.byReferenceId && d.summary.byReferenceId[ref]) ||
  (results[ref] && results[ref].status) || 'not_attempted';
const key = (routeCode, stop) => routeCode + '#' + stop;

// Stop click evidence (v3.6: capped at 40 entries; v3.7 keeps every failed / retried open).
const clickByStop = {};
(d.stopClickDiagnostics || []).forEach((c) => { clickByStop[key(c.routeCode, c.stop)] = c; });
const procByStop = {};
(d.stopProcessingDiagnostics || []).forEach((p) => { procByStop[key(p.routeCode, p.stopNumber)] = p; });

function classify(c, pkgs) {
  if (!c) return 'no_click_diagnostics';
  const sl = c.stopList || {};
  const trArrived = pkgs.some((p) => tdiag[p.referenceId] && tdiag[p.referenceId].trDetailsReceived);
  if (c.result === 'covered') return 'click_covered';
  if (c.result === 'click_failed') {
    const det = String(c.detail || '');
    if (/no safe point/.test(det)) return 'no_safe_point';
    if (/見つかりません/.test(det)) return 'button_not_found';
    return 'cdp_click_failed';
  }
  if (trArrived) return 'trdetails_arrived_but_judged_failed';
  if (sl.selectedStopIdAfter != null && sl.selectedStopIdAfter !== sl.selectedStopIdBefore) return 'selected_stop_changed_not_expanded';
  if (sl.ariaExpandedAfter === 'true') return 'aria_true_after_window';
  if (sl.rowElementsAfter != null && sl.rowElementsBefore != null && sl.rowElementsAfter > sl.rowElementsBefore) return 'row_grew_not_expanded';
  if (c.afterWait && c.afterWait.targetDaVisible > 0) return 'da_visible_after_window';
  if (c.afterWait && c.before && c.afterWait.url !== c.before.url) return 'url_changed_only';
  return 'no_change_after_click';
}

const failedStops = {};
targets.forEach((t) => {
  if (statusOf(t.referenceId) !== 'stop_expand_failed') return;
  const k = key(t.routeCode, t.stop);
  if (!failedStops[k]) failedStops[k] = { routeCode: t.routeCode, stopNumber: t.stop, stopStatus: t.stopStatus || null, packages: [] };
  failedStops[k].packages.push(t);
});

const stopRows = Object.keys(failedStops).map((k) => {
  const s = failedStops[k];
  const c = clickByStop[k];
  const p = procByStop[k];
  const sl = (c && c.stopList) || {};
  const r = results[s.packages[0].referenceId] || {};
  return {
    routeCode: s.routeCode,
    stopNumber: s.stopNumber,
    stopStatus: s.stopStatus,
    targetPackages: s.packages.length,
    stopRowCandidates: c && c.before ? c.before.stopLabels : null,
    buttonCandidates: p && p.clickAttempts && p.clickAttempts[0] ? p.clickAttempts[0].candidateCount : null,
    ariaExpandedBefore: sl.ariaExpandedBefore ?? null,
    ariaExpandedAfter: sl.ariaExpandedAfter ?? null,
    safeClickPoint: c && c.clicked ? c.clicked : null,
    elementFromPoint: c && c.points ? c.points.map((pt) => pt.label + ':' + pt.hit + '=>' + pt.relation) : null,
    urlBefore: c && c.before ? c.before.url : null,
    urlAfter: c && c.afterWait ? c.afterWait.url : null,
    selectedStopIdBefore: sl.selectedStopIdBefore ?? null,
    selectedStopIdAfter: sl.selectedStopIdAfter ?? null,
    targetDaVisibleBefore: c && c.before ? c.before.targetDaVisible : null,
    targetDaVisibleAfter: c && c.afterWait ? c.afterWait.targetDaVisible : null,
    trDetailsReceived: s.packages.filter((t) => tdiag[t.referenceId] && tdiag[t.referenceId].trDetailsReceived).length,
    rowElementsBefore: sl.rowElementsBefore ?? null,
    rowElementsAfter: sl.rowElementsAfter ?? null,
    retried: c ? !!(c.extendedWait || (c.attempts && c.attempts.length > 1)) : null,
    attempts: c && c.attempts ? c.attempts.map((a) => a.strategy + ':' + a.result) : null,
    elapsedMs: c ? c.elapsedMs : null,
    failureDetail: r.detail || '',
    cause: classify(c, s.packages)
  };
});

const byCause = {};
stopRows.forEach((s) => {
  byCause[s.cause] = byCause[s.cause] || { stops: 0, packages: 0 };
  byCause[s.cause].stops += 1;
  byCause[s.cause].packages += s.targetPackages;
});

const fallback = targets.filter((t) => {
  const td = tdiag[t.referenceId];
  return (td && td.stopOpenResult === 'no_trdetails') || ['package_dom_not_found', 'package_click_target_not_found', 'dom_ambiguous'].includes(statusOf(t.referenceId));
}).map((t) => {
  const td = tdiag[t.referenceId] || {};
  const fb = (d.packageFallbackDiagnostics || []).find((x) => x.referenceId === t.referenceId) || {};
  const st = statusOf(t.referenceId);
  return {
    routeCode: t.routeCode, stopNumber: t.stop, scannableId: t.scannableId, referenceId: t.referenceId,
    packageDomFound: fb.packageDomFound ?? (st === 'package_dom_not_found' ? false : st === 'package_click_target_not_found' ? true : null),
    packageCandidateCount: fb.packageCandidateCount ?? null,
    clickTargetFound: fb.clickTargetFound ?? (st === 'package_click_target_not_found' ? false : null),
    actualClickAttempted: fb.actualClickAttempted ?? !!td.actualPackageClick,
    failureReason: fb.failureReason || (st === 'dom_ambiguous' ? 'package_ambiguous' : st),
    finalStatus: st
  };
});

const nulls = (d.bagNullDiagnostics && d.bagNullDiagnostics.length ? d.bagNullDiagnostics : targets.filter((t) => statusOf(t.referenceId) === 'captured_null').map((t) => {
  const td = tdiag[t.referenceId] || {};
  return { routeCode: t.routeCode, stopNumber: t.stop, stopStatus: td.stopStatus || t.stopStatus || null, referenceId: t.referenceId,
    scannableId: t.scannableId, elapsedAfterStopOpenMs: td.elapsedAfterStopOpenMs ?? null, bagNameRaw: td.bagName === undefined ? 'n/a' : td.bagName,
    responseKeys: null, note: 'v3.6 JSON has no row shape; v3.7 records it' };
}));

const report = {
  build: d.build || null,
  summaryCounts: d.summary ? d.summary.counts : null,
  stopExpandFailed: {
    packages: stopRows.reduce((n, s) => n + s.targetPackages, 0),
    stops: stopRows.length,
    stopClickDiagnosticsEntries: (d.stopClickDiagnostics || []).length,
    stopsWithoutClickDiagnostics: stopRows.filter((s) => s.cause === 'no_click_diagnostics').length,
    byCause
  },
  failedStops: stopRows,
  packageFallback: fallback,
  bagNull: nulls
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const f = report.stopExpandFailed;
  console.log('build: ' + report.build);
  console.log('stop_expand_failed: ' + f.packages + ' package / ' + f.stops + ' Stop' +
    ' (click診断 ' + f.stopClickDiagnosticsEntries + '件, 診断なしStop ' + f.stopsWithoutClickDiagnostics + ')');
  Object.keys(f.byCause).sort((a, b) => f.byCause[b].packages - f.byCause[a].packages).forEach((c) => {
    console.log('  ' + c + ': ' + f.byCause[c].stops + ' Stop / ' + f.byCause[c].packages + ' package');
  });
  stopRows.forEach((s) => {
    console.log('  - ' + s.routeCode + ' #' + s.stopNumber + ' pkg ' + s.targetPackages + ' [' + s.cause + '] aria ' + s.ariaExpandedBefore + '->' +
      s.ariaExpandedAfter + ' sel ' + s.selectedStopIdBefore + '->' + s.selectedStopIdAfter + ' DA ' + s.targetDaVisibleBefore + '->' +
      s.targetDaVisibleAfter + ' tr ' + s.trDetailsReceived + ' ' + (s.elapsedMs != null ? s.elapsedMs + 'ms' : ''));
  });
  const fr = {};
  fallback.forEach((x) => { fr[x.failureReason] = (fr[x.failureReason] || 0) + 1; });
  console.log('package fallback: ' + fallback.length + ' ' + JSON.stringify(fr));
  console.log('bag null: ' + nulls.length);
  nulls.forEach((n) => console.log('  - ' + n.routeCode + ' #' + n.stopNumber + ' ' + n.stopStatus + ' ' + n.referenceId + ' bagNameRaw=' + JSON.stringify(n.bagNameRaw)));
  console.log('(--json で全項目)');
}
