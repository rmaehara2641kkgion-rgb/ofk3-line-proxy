/**
 * OFK3 delivery-window session (Phase 5) - readiness state machine, pure logic, no DOM.
 *
 * Owns: mode (OFF at start, never persisted), the two input files (elimination workbook +
 * SearchResults text), the stale-load guard, table (re)building, and the "may we scan?" gate.
 * Independent of the normal DA search (manifest) state: that one is never read or changed here.
 *
 *   status: 'needs_files' | 'loading' | 'ready' | 'error'
 *   Scanning is possible only when mode is ON and status is 'ready'.
 *
 * Stale-load guard: every loadSr()/loadElimi() call takes a ticket. When its promise settles, the
 * result is applied only if no newer call for the same kind has started - an old, slow file read can
 * never overwrite newer data. Any failed or in-flight load makes scanning unavailable (no silent
 * use of old data).
 * ES5, no template literals, no logging, no storage.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./delivery-window-core.js'), require('./delivery-window-report.js'));
  } else {
    root.DeliveryWindowSession = factory(root.DeliveryWindowCore, root.DeliveryWindowReport);
  }
}(typeof self !== 'undefined' ? self : this, function (Core, Report) {
  'use strict';

  var FILE_LABEL = { elimi: 'エリミ報告書(.xlsx)', sr: 'SearchResults(.csv)' };
  var MIN_COMPLETE_LEN = 12; // a Tracking ID has 12 characters; shorter values are still being typed

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function stamp(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /**
   * createSession({ XLSX, controller, now():Date, onChange(state), tableOptions })
   * controller: { setTable(table, loadedAtLabel) } (delivery-window-scan controller)
   */
  function createSession(deps) {
    var d = deps || {};
    var now = d.now || function () { return new Date(); };
    var mode = false;
    var files = { elimi: null, sr: null };           // parsed inputs held in memory only
    var pending = { elimi: false, sr: false };        // newest load per kind still in flight
    var ticket = { elimi: 0, sr: 0 };
    var fileErr = { elimi: null, sr: null };          // read failures
    var built = { status: null, errors: [], warnings: [], loadedAt: null, srLastUpdated: null, report: null };

    function emit() { if (typeof d.onChange === 'function') { try { d.onChange(getState()); } catch (e) { /* UI must not break logic */ } } }

    function missing() {
      var m = [];
      if (!files.elimi || fileErr.elimi) m.push('elimi');
      if (!files.sr || fileErr.sr) m.push('sr');
      return m;
    }

    function invalidate() {
      built = { status: null, errors: [], warnings: [], loadedAt: null, srLastUpdated: null, report: null };
      if (d.controller) d.controller.setTable(null);
    }

    function rebuild() {
      if (pending.elimi || pending.sr) return;
      if (!files.elimi || !files.sr || fileErr.elimi || fileErr.sr) { invalidate(); return; }
      var ing;
      try {
        ing = Report.ingest({ srText: files.sr, XLSX: d.XLSX, workbook: files.elimi, options: d.tableOptions || {}, loadedAt: stamp(now()) });
      } catch (e) {
        ing = { ok: false, errors: [{ code: 'ingest_exception', detail: '' }], warnings: [], table: null };
      }
      if (!ing.ok) {
        built = { status: 'error', errors: ing.errors, warnings: ing.warnings, loadedAt: null, srLastUpdated: null, report: null };
        if (d.controller) d.controller.setTable(null);
        return;
      }
      built = { status: 'ready', errors: [], warnings: ing.warnings, loadedAt: ing.table.meta.loadedAt, srLastUpdated: ing.table.meta.srLastUpdated || null, report: ing.table.report };
      if (d.controller) d.controller.setTable(ing.table, ing.table.meta.loadedAt);
    }

    function load(kind, source) {
      var my = ++ticket[kind];
      pending[kind] = true;                 // only the NEWEST load of a kind counts as "in flight"
      // a load in progress makes the old table unusable immediately
      files[kind] = null; fileErr[kind] = null;
      invalidate();
      emit();
      var p;
      try { p = Promise.resolve(typeof source === 'function' ? source() : source); } catch (e) { p = Promise.reject(e); }
      return p.then(function (value) {
        if (my !== ticket[kind]) { return getState(); }                    // superseded by a newer load: drop silently
        pending[kind] = false;
        files[kind] = value;
        rebuild(); emit(); return getState();
      }, function () {
        if (my !== ticket[kind]) { return getState(); }
        pending[kind] = false;
        files[kind] = null; fileErr[kind] = 'read_failed';
        built = { status: 'error', errors: [{ code: kind + '_read_failed', detail: '' }], warnings: [], loadedAt: null, srLastUpdated: null, report: null };
        if (d.controller) d.controller.setTable(null);
        emit(); return getState();
      });
    }

    function getState() {
      var m = missing();
      var status;
      if (pending.elimi || pending.sr) status = 'loading';
      else if (built.status === 'error' || fileErr.elimi || fileErr.sr) status = 'error';
      else if (m.length) status = 'needs_files';
      else status = built.status === 'ready' ? 'ready' : 'needs_files';
      return {
        mode: mode, status: status,
        missing: m, missingLabels: m.map(function (k) { return FILE_LABEL[k]; }),
        errors: built.errors.slice(), warnings: built.warnings.slice(),
        loadedAt: built.loadedAt, srLastUpdated: built.srLastUpdated, report: built.report,
        canScan: mode && status === 'ready'
      };
    }

    /**
     * Gate for a raw input value.
     *  explicit: Enter / paste (a finished scan). Implicit: idle-timer path of the existing input.
     * -> 'off' (mode OFF: pass through to the normal DA search untouched)
     *    'blocked' (mode ON but data not ready: do not scan)
     *    'empty' | 'wait' (implicit and shorter than a Tracking ID: keep typing)
     *    'process'
     */
    function gate(value, explicit) {
      if (!mode) return 'off';
      if (getState().status !== 'ready') return 'blocked';
      var v = value === null || value === undefined ? '' : String(value).replace(/^\s+|\s+$/g, '');
      if (!v) return 'empty';
      if (!explicit && v.length < MIN_COMPLETE_LEN) return 'wait';
      return 'process';
    }

    return {
      setMode: function (on) { mode = !!on; emit(); return mode; },
      getMode: function () { return mode; },
      loadSr: function (source) { return load('sr', source); },
      loadElimi: function (source) { return load('elimi', source); },
      getState: getState,
      gate: gate
    };
  }

  return { createSession: createSession, FILE_LABEL: FILE_LABEL, MIN_COMPLETE_LEN: MIN_COMPLETE_LEN };
}));
