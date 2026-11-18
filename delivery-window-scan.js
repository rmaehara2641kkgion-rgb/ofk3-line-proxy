/**
 * OFK3 delivery-window scan controller + keyboard-wedge input assembler (Phase 4).
 *
 * Independent of the page: no DOM access, no storage. The page (Phase 5) feeds it raw scan strings
 * (from the existing #scan-input, from createKeyAssembler, or - later - another source) and renders
 * the view-model it returns. One scan -> one result -> one read-out. Scan values are never kept:
 * the history holds only status + the last 4 characters of the ID.
 * ES5, no template literals, no logging.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./delivery-window-core.js'));
  } else {
    root.DeliveryWindowScan = factory(root.DeliveryWindowCore);
  }
}(typeof self !== 'undefined' ? self : this, function (Core) {
  'use strict';

  var TABLE_NOT_LOADED = 'table_not_loaded';

  function tail(id) { return id ? String(id).slice(-4) : ''; }

  /**
   * View-model for the screen. kind: 'window' | 'no_window' | 'unknown'
   * No raw scan value; id only as a 4-char tail.
   */
  function toView(res, extra) {
    var kind = res.status;
    var v = {
      kind: kind,
      label: kind === 'window' ? res.label : (kind === 'no_window' ? Core.LABEL_NO_WINDOW : Core.LABEL_UNKNOWN),
      speech: res.speech,
      range: kind === 'window' ? (res.startText + '〜' + res.endText) : null,
      reason: kind === 'unknown' ? res.reason : null,
      allReasons: res.allReasons ? res.allReasons.slice() : [],
      headingDiffers: !!res.headingDiffers,
      matchKind: res.matchKind || null,
      idTail: tail(res.id),
      cycles: res.cycles ? res.cycles.slice() : []
    };
    for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) v[k] = extra[k];
    return v;
  }

  function percentile(sorted, p) {
    if (!sorted.length) return null;
    var i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
    return sorted[i];
  }

  /**
   * createScanController({ speaker, now, onResult, onSpeakFail, historyMax, tableProvider })
   *   speaker: { speak(text, {scanAt}) -> {ok}|{ok:false,reason} }  (see delivery-window-speaker.js)
   */
  function createScanController(deps) {
    var d = deps || {};
    var now = d.now || function () { return Date.now(); };
    var table = null, tableLoadedAt = null;
    var history = [], historyMax = d.historyMax > 0 ? d.historyMax : 20;
    var lookupMs = [], callMs = [];
    var count = 0;

    function setTable(t, loadedAtLabel) {
      table = t || null;
      tableLoadedAt = loadedAtLabel || (t && t.meta && t.meta.loadedAt) || null;
      // a new table never inherits answers from the old one; history keeps only status+tail
    }

    function dataInfo() {
      return {
        loaded: !!table,
        loadedAt: tableLoadedAt,
        srLastUpdated: table && table.meta ? table.meta.srLastUpdated || null : null,
        referenceDate: table && table.meta ? table.meta.referenceDate || null : null,
        report: table ? table.report : null
      };
    }

    /** One scan in, one view-model out. Never throws. */
    function handleScan(raw) {
      var t0 = now();
      var res, view;
      try {
        if (!table) {
          res = { id: null, status: 'unknown', reason: TABLE_NOT_LOADED, speech: Core.SPEECH_UNKNOWN, label: Core.LABEL_UNKNOWN, allReasons: [TABLE_NOT_LOADED] };
        } else {
          res = Core.lookup(table, raw);
        }
      } catch (e) {
        res = { id: null, status: 'unknown', reason: 'internal_error', speech: Core.SPEECH_UNKNOWN, label: Core.LABEL_UNKNOWN, allReasons: ['internal_error'] };
      }
      var t1 = now();
      // Speak first (latency), then report; a failed speech never hides the result.
      var sp = { ok: false, reason: 'no_speaker' };
      if (d.speaker) {
        try { sp = d.speaker.speak(res.speech, { scanAt: t0 }) || { ok: true }; } catch (e2) { sp = { ok: false, reason: 'speak_threw' }; }
      }
      var t2 = now();
      view = toView(res, { spoke: !!sp.ok, speakFailReason: sp.ok ? null : sp.reason });
      count += 1;
      lookupMs.push(t1 - t0); callMs.push(t2 - t0);
      if (lookupMs.length > 500) { lookupMs.shift(); callMs.shift(); }
      history.unshift({ kind: view.kind, label: view.label, idTail: view.idTail, reason: view.reason, at: t0 });
      if (history.length > historyMax) history.pop();
      if (typeof d.onResult === 'function') { try { d.onResult(view); } catch (e3) { /* UI error must not break scanning */ } }
      if (!sp.ok && sp.reason !== 'disabled' && typeof d.onSpeakFail === 'function') { try { d.onSpeakFail(sp.reason); } catch (e4) { /* ignore */ } }
      return view;
    }

    function metrics() {
      var a = lookupMs.slice().sort(function (x, y) { return x - y; });
      var b = callMs.slice().sort(function (x, y) { return x - y; });
      return {
        scans: count,
        lookupMs: { p50: percentile(a, 0.5), p95: percentile(a, 0.95), max: a.length ? a[a.length - 1] : null },
        scanToSpeakCallMs: { p50: percentile(b, 0.5), p95: percentile(b, 0.95), max: b.length ? b[b.length - 1] : null }
      };
    }

    return {
      setTable: setTable, handleScan: handleScan, dataInfo: dataInfo, metrics: metrics,
      getHistory: function () { return history.map(function (h) { return { kind: h.kind, label: h.label, idTail: h.idTail, reason: h.reason, at: h.at }; }); },
      clearHistory: function () { history = []; }
    };
  }

  // ------------------------------------------------------------------ keyboard-wedge input
  var MODIFIERS = { Shift: 1, Control: 1, Alt: 1, Meta: 1, CapsLock: 1, NumLock: 1, ScrollLock: 1, AltGraph: 1, Process: 1, Dead: 1, Unidentified: 1 };

  /**
   * Assembles characters typed by a keyboard-wedge scanner into one scan per terminator.
   * opts: { terminators:['Enter','Tab'], idleFlushMs:null|ms, minLen:1, maxLen:64, now(), setTimer, clearTimer,
   *         onScan(raw), onDrop(reason) }
   * feedKey(key)   : single printable char, 'Enter', 'Tab', 'Backspace', 'Escape'; modifiers ignored
   * feedPaste(text): appended then flushed (paste is a complete scan)
   * The buffer is emptied on every flush, so scan N+1 never contains scan N.
   */
  function createKeyAssembler(opts) {
    var o = opts || {};
    var terms = o.terminators || ['Enter', 'Tab'];
    var minLen = o.minLen > 0 ? o.minLen : 1;
    var maxLen = o.maxLen > 0 ? o.maxLen : 64;
    var idle = o.idleFlushMs > 0 ? o.idleFlushMs : null;
    var setT = o.setTimer || function (fn, ms) { return setTimeout(fn, ms); };
    var clearT = o.clearTimer || function (id) { clearTimeout(id); };
    var buf = '', timer = null, overflow = false;

    function stopTimer() { if (timer !== null) { clearT(timer); timer = null; } }
    function drop(reason) { buf = ''; overflow = false; stopTimer(); if (typeof o.onDrop === 'function') { try { o.onDrop(reason); } catch (e) { /* ignore */ } } }
    function flush(reasonIfShort) {
      stopTimer();
      var raw = buf, ov = overflow;
      buf = ''; overflow = false;
      if (ov) { if (typeof o.onDrop === 'function') { try { o.onDrop('overflow'); } catch (e) { /* ignore */ } } return false; }
      if (raw.length < minLen) { if (raw.length && typeof o.onDrop === 'function') { try { o.onDrop(reasonIfShort || 'too_short'); } catch (e2) { /* ignore */ } } return false; }
      if (typeof o.onScan === 'function') o.onScan(raw);
      return true;
    }
    function armIdle() {
      stopTimer();
      if (idle !== null) timer = setT(function () { timer = null; flush('too_short_idle'); }, idle);
    }
    function feedChar(ch) {
      if (overflow) return;
      if (buf.length >= maxLen) { overflow = true; buf = ''; return; }
      buf += ch;
      armIdle();
    }
    function feedKey(key) {
      if (typeof key !== 'string' || !key) return false;
      if (MODIFIERS[key]) return false;
      if (terms.indexOf(key) >= 0) { return flush(); }
      if (key === 'Backspace') { buf = buf.slice(0, -1); armIdle(); return false; }
      if (key === 'Escape') { drop('escape'); return false; }
      if (key.length === 1 && key.charCodeAt(0) >= 32 && key.charCodeAt(0) !== 127) { feedChar(key); return false; }
      return false; // F-keys, arrows, ctrl combos: not scan data
    }
    function feedPaste(text) {
      var s = text === null || text === undefined ? '' : String(text);
      // a paste is a complete scan: split on line breaks, each non-empty line is its own scan
      var parts = s.split(/[\r\n]+/), i;
      for (i = 0; i < parts.length; i++) {
        var p = parts[i].replace(/[\u0000-\u001F\u007F]/g, '');
        if (!p) continue;
        for (var j = 0; j < p.length; j++) feedChar(p.charAt(j));
        flush();
      }
    }
    return { feedKey: feedKey, feedPaste: feedPaste, reset: function () { drop('reset'); }, pendingLength: function () { return buf.length; } };
  }

  return { createScanController: createScanController, createKeyAssembler: createKeyAssembler, toView: toView, TABLE_NOT_LOADED: TABLE_NOT_LOADED };
}));
