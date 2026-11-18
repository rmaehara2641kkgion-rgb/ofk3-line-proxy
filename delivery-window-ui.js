/**
 * OFK3 delivery-window UI (Phase 5) - integrates the time-window mode into the existing scan tab.
 *
 * Touches the page only through: <div id="dw-root"> (own markup), the existing #scan-input /
 * #scan-ready / #scan-dropzone elements (visibility + disabled only), and two global wrappers:
 *   window.lookupDA          : mode OFF -> the original function, untouched, same arguments.
 *                              mode ON  -> the time-window engine; the original is NOT called (so the
 *                              existing female route-number voice cannot overlap).
 *   window.updateScanStatus  : original runs first; then, in mode ON, the scan input stays reachable.
 * The original lookupDA / speakRouteNumber / scanVoiceEnabled are never edited or read.
 *
 * Mode is OFF at every page load (never persisted). Delivery files are read into memory only: never
 * stored, never sent. Only the voice ON/OFF flag and the chosen voice name are saved (localStorage,
 * wrapped in try/catch). Screen text is set with textContent; scan values are cleared from the input
 * immediately and never shown (history shows the last 4 characters of an ID only).
 * ES5, no template literals.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory;
  } else {
    root.DeliveryWindowUI = { init: function (env) { return factory(env || {}); } };
    if (typeof document !== 'undefined' && document.getElementById && document.getElementById('dw-root') &&
        root.DeliveryWindowCore && root.DeliveryWindowSession && root.DeliveryWindowScan && root.DeliveryWindowSpeaker) {
      root.DeliveryWindowUI.instance = factory({});
    }
  }
}(typeof self !== 'undefined' ? self : this, function (env) {
  'use strict';

  var win = env.window || (typeof window !== 'undefined' ? window : null);
  var doc = env.document || (win && win.document);
  var Core = env.Core || win.DeliveryWindowCore;
  var Report = env.Report || win.DeliveryWindowReport;
  var Session = env.Session || win.DeliveryWindowSession;
  var Scan = env.Scan || win.DeliveryWindowScan;
  var Speaker = env.Speaker || win.DeliveryWindowSpeaker;
  var XLSXLib = env.XLSX || win.XLSX;
  if (win.__dwInstalled) return win.__dwInstalled;

  var KEY_VOICE_ON = 'ofk3.dw.voiceOn', KEY_VOICE_NAME = 'ofk3.dw.voiceName';
  var EXPLICIT_WINDOW_MS = 400;

  // ---------------------------------------------------------------- small helpers
  function $(id) { return doc.getElementById(id); }
  function el(tag, attrs, kids) {
    var e = doc.createElement(tag), k;
    if (attrs) for (k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k === 'style') e.setAttribute('style', attrs[k]);
      else e.setAttribute(k, attrs[k]);
    }
    if (kids) for (var i = 0; i < kids.length; i++) if (kids[i]) e.appendChild(kids[i]);
    return e;
  }
  function store(op, key, val) {
    try {
      if (!win.localStorage) return null;
      if (op === 'get') return win.localStorage.getItem(key);
      win.localStorage.setItem(key, val); return val;
    } catch (e) { return null; }
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function clock(ms) { var d = new Date(ms); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()); }
  function nowMs() { return (win.performance && win.performance.now) ? win.performance.now() : new Date().getTime(); }

  var REASON_TEXT = {
    time_blank: '時間欄が空欄', time_partial: '開始・終了の片方が空欄', time_invalid: '時刻が不正',
    not_found: '照合できません', ambiguous_scan: '複数の荷物番号を読み取りました', not_in_sr: 'SearchResultsに無い',
    not_in_elimi: 'エリミに無い', dup_cycle_elimi: 'エリミで複数サイクルに重複', dup_conflict_sr: 'SearchResultsの重複で内容が不一致',
    date_span: '開始日と終了日が異なる', date_promised_missing: '約束日が空欄', date_mismatch: '約束日と時間帯の日付が不一致',
    date_out_of_range: '当日・翌日の範囲外', date_ref_missing: '基準日がありません', conflict_elimi: 'エリミ区分と時間帯が不一致',
    table_not_loaded: 'データ未読込', internal_error: '内部エラー'
  };
  function matchText(v) {
    if (v.kind !== 'unknown') return '一致(エリミ' + (v.cycles.length ? ' ' + v.cycles.join('+') : '') + ' / SearchResults)';
    if (v.reason === 'not_in_sr') return 'エリミのみ(SearchResultsに無い)';
    if (v.reason === 'not_in_elimi') return 'SearchResultsのみ(エリミに無い)';
    if (v.reason === 'not_found' || v.reason === 'ambiguous_scan') return '未照合';
    if (v.reason === 'table_not_loaded') return 'データ未読込';
    return '要確認';
  }
  var SPEAK_FAIL_TEXT = {
    disabled: '音声OFF', unsupported: 'この端末は音声合成に非対応', speak_threw: '音声エラー', error_event: '音声が中断されました',
    no_start: '音声が開始しません', empty_text: '音声なし', no_speaker: '音声なし'
  };

  // ---------------------------------------------------------------- state
  var lastView = null, lastSpeech = { text: '', failed: false }, lastTimingMs = null, lastScanAt = 0;
  var explicitUntil = 0;
  var disabledByUs = false, origPlaceholder = null, dropzoneHiddenByUs = false;

  var speaker = Speaker.createSpeaker(
    { synth: win.speechSynthesis || null, Utterance: win.SpeechSynthesisUtterance || null, now: nowMs },
    {
      policy: 'latest',
      enabled: store('get', KEY_VOICE_ON) !== '0',
      preferredVoice: store('get', KEY_VOICE_NAME) || null,
      onFail: function (reason) { lastSpeech = { text: SPEAK_FAIL_TEXT[reason] || '音声エラー', failed: true }; renderCard(); },
      onTiming: function (t) { lastTimingMs = Math.round(t.toStartMs); renderCard(); },
      onVoiceChange: function () { renderVoice(); }
    });

  var controller = Scan.createScanController({
    speaker: speaker, now: nowMs,
    onResult: function (v) {
      lastView = v; lastScanAt = new Date().getTime(); lastTimingMs = null;
      lastSpeech = v.spoke ? { text: '再生中', failed: false } : { text: SPEAK_FAIL_TEXT[v.speakFailReason] || '音声なし', failed: v.speakFailReason !== 'disabled' };
      renderCard(); renderHistory();
    }
  });

  var session = Session.createSession({
    XLSX: XLSXLib, controller: controller,
    now: function () { return new Date(); },
    tableOptions: {},               // production conditions: headingCheck true, date range 0..+1, 08:00-22:00 rule
    onChange: function () { renderAll(); applyVisibility(); }
  });

  // ---------------------------------------------------------------- file reading
  function readText(file) {
    return new Promise(function (resolve, reject) {
      var r = new win.FileReader();
      r.onload = function () { resolve(String(r.result)); };
      r.onerror = function () { reject(new Error('read')); };
      r.readAsText(file, 'utf-8');
    });
  }
  function readWorkbook(file) {
    return new Promise(function (resolve, reject) {
      var r = new win.FileReader();
      r.onload = function () { try { resolve(XLSXLib.read(r.result, { type: 'array' })); } catch (e) { reject(e); } };
      r.onerror = function () { reject(new Error('read')); };
      r.readAsArrayBuffer(file);
    });
  }

  // ---------------------------------------------------------------- DOM
  var root = $('dw-root');
  var ui = {};
  function build() {
    root.innerHTML = '';
    root.setAttribute('style', 'margin-bottom:16px;border:1px solid #cbd5e1;border-radius:12px;padding:12px 16px;background:#f8fafc;');
    ui.toggle = el('input', { type: 'checkbox', id: 'dw-mode-toggle' });
    var head = el('label', { style: 'display:flex;align-items:center;gap:8px;font-weight:700;cursor:pointer;' }, [
      ui.toggle, el('span', { text: '配送時間帯モード' }), el('span', { id: 'dw-mode-badge', style: 'font-size:12px;font-weight:400;color:#475569;', text: 'OFF' })
    ]);
    ui.body = el('div', { id: 'dw-body', style: 'display:none;margin-top:10px;' });
    ui.state = el('div', { id: 'dw-state', style: 'font-size:14px;font-weight:700;margin-bottom:6px;', 'aria-live': 'polite' });
    ui.files = el('div', { id: 'dw-files', style: 'display:flex;flex-wrap:wrap;gap:8px;margin-bottom:6px;' });
    ui.elimiIn = el('input', { type: 'file', id: 'dw-elimi-file', accept: '.xlsx,.xls', style: 'display:none;' });
    ui.srIn = el('input', { type: 'file', id: 'dw-sr-file', accept: '.csv', style: 'display:none;' });
    ui.elimiBtn = el('button', { type: 'button', id: 'dw-elimi-btn', style: 'padding:6px 10px;border:1px solid #94a3b8;border-radius:8px;background:#fff;cursor:pointer;' });
    ui.srBtn = el('button', { type: 'button', id: 'dw-sr-btn', style: 'padding:6px 10px;border:1px solid #94a3b8;border-radius:8px;background:#fff;cursor:pointer;' });
    ui.files.appendChild(ui.elimiBtn); ui.files.appendChild(ui.srBtn); ui.files.appendChild(ui.elimiIn); ui.files.appendChild(ui.srIn);
    ui.errors = el('div', { id: 'dw-errors', style: 'font-size:12px;color:#b91c1c;margin-bottom:6px;' });
    ui.updated = el('div', { id: 'dw-updated', style: 'font-size:12px;color:#475569;margin-bottom:6px;' });
    ui.voiceOn = el('input', { type: 'checkbox', id: 'dw-voice-toggle' });
    ui.voiceSel = el('select', { id: 'dw-voice-select', style: 'max-width:240px;' });
    ui.voiceNote = el('span', { id: 'dw-voice-note', style: 'font-size:12px;' });
    var vrow = el('div', { style: 'display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:8px;font-size:13px;' }, [
      el('label', { style: 'display:flex;align-items:center;gap:4px;cursor:pointer;' }, [ui.voiceOn, el('span', { text: '音声' })]), ui.voiceSel, ui.voiceNote
    ]);
    ui.card = el('div', { id: 'dw-card', 'aria-live': 'assertive', style: 'border-radius:12px;padding:16px;text-align:center;background:#e2e8f0;' });
    ui.cardLabel = el('div', { id: 'dw-card-label', style: 'font-size:48px;font-weight:900;line-height:1.2;', text: 'スキャンしてください' });
    ui.cardRange = el('div', { id: 'dw-card-range', style: 'font-size:20px;font-weight:700;' });
    ui.cardReason = el('div', { id: 'dw-card-reason', style: 'font-size:14px;margin-top:4px;' });
    ui.cardMatch = el('div', { id: 'dw-card-match', style: 'font-size:12px;color:#334155;margin-top:4px;' });
    ui.cardSpeech = el('div', { id: 'dw-card-speech', style: 'font-size:12px;margin-top:4px;' });
    ui.card.appendChild(ui.cardLabel); ui.card.appendChild(ui.cardRange); ui.card.appendChild(ui.cardReason); ui.card.appendChild(ui.cardMatch); ui.card.appendChild(ui.cardSpeech);
    ui.history = el('div', { id: 'dw-history', style: 'margin-top:8px;font-size:12px;' });
    ui.clear = el('button', { type: 'button', id: 'dw-history-clear', style: 'font-size:12px;color:#b91c1c;background:none;border:none;cursor:pointer;', text: '履歴クリア' });
    ui.body.appendChild(ui.state); ui.body.appendChild(ui.files); ui.body.appendChild(ui.errors); ui.body.appendChild(ui.updated);
    ui.body.appendChild(vrow); ui.body.appendChild(ui.card); ui.body.appendChild(ui.history); ui.body.appendChild(ui.clear);
    root.appendChild(head); root.appendChild(ui.body);

    ui.toggle.onchange = function () { setMode(ui.toggle.checked); };
    ui.elimiBtn.onclick = function () { ui.elimiIn.click(); };
    ui.srBtn.onclick = function () { ui.srIn.click(); };
    ui.elimiIn.onchange = function () { var f = ui.elimiIn.files && ui.elimiIn.files[0]; ui.elimiIn.value = ''; if (f) session.loadElimi(function () { return readWorkbook(f); }); };
    ui.srIn.onchange = function () { var f = ui.srIn.files && ui.srIn.files[0]; ui.srIn.value = ''; if (f) session.loadSr(function () { return readText(f); }); };
    ui.voiceOn.checked = speaker.isEnabled();
    ui.voiceOn.onchange = function () { speaker.setEnabled(ui.voiceOn.checked); store('set', KEY_VOICE_ON, ui.voiceOn.checked ? '1' : '0'); renderVoice(); };
    ui.voiceSel.onchange = function () { speaker.setPreferredVoice(ui.voiceSel.value); store('set', KEY_VOICE_NAME, ui.voiceSel.value); renderVoice(); };
    ui.clear.onclick = function () { controller.clearHistory(); renderHistory(); focusInput(); };
  }

  // ---------------------------------------------------------------- rendering
  var COLORS = {
    window: { bg: '#dbeafe', fg: '#1e3a8a' }, no_window: { bg: '#dcfce7', fg: '#14532d' },
    unknown: { bg: '#fee2e2', fg: '#7f1d1d' }, idle: { bg: '#e2e8f0', fg: '#334155' }
  };

  function renderState() {
    var st = session.getState(), txt, color = '#475569';
    if (st.status === 'ready') { txt = '✅ 使用可能(スキャンできます)'; color = '#166534'; }
    else if (st.status === 'loading') { txt = '読み込み中...'; }
    else if (st.status === 'error') { txt = '⚠ データを使用できません。ファイルを選び直してください'; color = '#b91c1c'; }
    else { txt = '⚠ データ未読込: スキャンできません。必要なファイル: ' + st.missingLabels.join(' と '); color = '#b45309'; }
    ui.state.textContent = txt; ui.state.style.color = color;
    ui.elimiBtn.textContent = (st.missing.indexOf('elimi') >= 0 ? '未読込: ' : '読込済: ') + 'エリミ報告書(.xlsx)を選択';
    ui.srBtn.textContent = (st.missing.indexOf('sr') >= 0 ? '未読込: ' : '読込済: ') + 'SearchResults(.csv)を選択';
    ui.elimiBtn.style.borderColor = st.missing.indexOf('elimi') >= 0 ? '#b45309' : '#16a34a';
    ui.srBtn.style.borderColor = st.missing.indexOf('sr') >= 0 ? '#b45309' : '#16a34a';
    var codes = [], i;
    for (i = 0; i < st.errors.length; i++) codes.push(st.errors[i].code + (st.errors[i].detail ? '(' + st.errors[i].detail + ')' : ''));
    ui.errors.textContent = codes.length ? 'エラー: ' + codes.join(', ') : '';
    var parts = [];
    if (st.loadedAt) parts.push('データ読込: ' + st.loadedAt);
    if (st.srLastUpdated) parts.push('SearchResults最終更新: ' + st.srLastUpdated);
    if (st.report && st.report.referenceDate) parts.push('基準日: ' + st.report.referenceDate);
    if (st.report) parts.push('エリミ対象 ' + st.report.elimiUniqueIds + '件 / 要確認 ' + st.report.needsCheck + '件');
    if (st.warnings.length) parts.push('警告 ' + st.warnings.length + '件');
    ui.updated.textContent = parts.length ? parts.join(' / ') : '最終データ更新: -';
  }

  function renderVoice() {
    if (!ui.voiceSel) return;
    var st = speaker.getStatus(), list = speaker.listVoices(), i;
    ui.voiceOn.checked = st.enabled;
    ui.voiceSel.innerHTML = '';
    for (i = 0; i < list.length; i++) {
      var o = el('option', { value: list[i].name, text: list[i].name + (list[i].male ? '(男性)' : '') + (list[i].local ? '' : ' [通信の可能性]') });
      if (list[i].name === st.voiceName) o.selected = true;
      ui.voiceSel.appendChild(o);
    }
    var note, color = '#166534';
    if (!st.supported) { note = '音声合成に非対応の端末です(結果は画面で確認してください)'; color = '#b91c1c'; }
    else if (!st.enabled) { note = '音声OFF'; color = '#475569'; }
    else if (st.male) { note = '男性声: ' + st.voiceName; }
    else if (st.voiceName) { note = '⚠ 男性声が見つかりません(使用中: ' + st.voiceName + ')'; color = '#b45309'; }
    else { note = '⚠ 日本語の音声がありません(結果は画面で確認してください)'; color = '#b91c1c'; }
    ui.voiceNote.textContent = note; ui.voiceNote.style.color = color;
  }

  function renderCard() {
    if (!ui.card) return;
    var v = lastView, c = v ? COLORS[v.kind] : COLORS.idle;
    ui.card.style.background = c.bg; ui.cardLabel.style.color = c.fg;
    if (!v) {
      ui.cardLabel.textContent = 'スキャンしてください'; ui.cardRange.textContent = ''; ui.cardReason.textContent = ''; ui.cardMatch.textContent = ''; ui.cardSpeech.textContent = '';
      ui.card.setAttribute('data-kind', 'idle'); return;
    }
    ui.card.setAttribute('data-kind', v.kind);
    ui.cardLabel.textContent = v.label;
    ui.cardRange.textContent = v.range || '';
    ui.cardReason.textContent = v.kind === 'unknown' ? (REASON_TEXT[v.reason] || v.reason || '') : (v.headingDiffers ? '参考: エリミ区分と異なる' : '');
    ui.cardMatch.textContent = '照合状態: ' + matchText(v) + (v.idTail ? ' / …' + v.idTail : '') + ' / ' + clock(lastScanAt);
    ui.cardSpeech.textContent = '音声: ' + lastSpeech.text + (lastTimingMs !== null && !lastSpeech.failed ? ' (開始 ' + lastTimingMs + 'ms)' : '');
    ui.cardSpeech.style.color = lastSpeech.failed ? '#b91c1c' : '#334155';
  }

  function renderHistory() {
    if (!ui.history) return;
    var h = controller.getHistory(), i;
    ui.history.innerHTML = '';
    for (i = 0; i < h.length && i < 10; i++) {
      ui.history.appendChild(el('div', { style: 'display:flex;gap:8px;padding:2px 0;border-bottom:1px solid #e2e8f0;' }, [
        el('span', { style: 'width:64px;color:#64748b;', text: clock(h[i].at) }),
        el('span', { style: 'width:100px;font-weight:700;', text: h[i].label }),
        el('span', { style: 'color:#64748b;', text: h[i].idTail ? '…' + h[i].idTail : '' })
      ]));
    }
  }

  function renderAll() {
    if (!ui.state) return;
    var on = session.getMode();
    ui.toggle.checked = on;
    $('dw-mode-badge').textContent = on ? 'ON(この画面のスキャンは時間帯を読み上げます)' : 'OFF';
    ui.body.style.display = on ? 'block' : 'none';
    renderState(); renderVoice(); renderCard(); renderHistory();
  }

  // ---------------------------------------------------------------- existing-panel coordination
  function focusInput() { var i = $('scan-input'); if (i && !i.disabled && i.focus) i.focus(); }

  function applyVisibility() {
    var input = $('scan-input'), ready = $('scan-ready'), drop = $('scan-dropzone');
    var st = session.getState();
    if (st.mode) {
      if (ready) ready.classList.remove('hidden');                 // reachable even without the manifest
      if (drop && !drop.classList.contains('hidden')) { drop.classList.add('hidden'); dropzoneHiddenByUs = true; }
      if (input) {
        if (st.status !== 'ready') {
          if (!disabledByUs) { origPlaceholder = input.getAttribute('placeholder'); }
          input.disabled = true; disabledByUs = true;
          input.setAttribute('placeholder', 'データ未読込: エリミ報告書とSearchResultsを読み込んでください');
        } else if (disabledByUs) {
          input.disabled = false; disabledByUs = false;
          if (origPlaceholder !== null) input.setAttribute('placeholder', origPlaceholder);
          focusInput();
        }
      }
    }
  }

  function restoreOriginalPanel() {
    var input = $('scan-input');
    if (input && disabledByUs) {
      input.disabled = false; disabledByUs = false;
      if (origPlaceholder !== null) input.setAttribute('placeholder', origPlaceholder);
    }
    dropzoneHiddenByUs = false;
    if (typeof origUpdateScanStatus === 'function') { try { origUpdateScanStatus(); } catch (e) { /* the page's own function */ } }
  }

  function setMode(on) {
    session.setMode(on);
    if (!on) { speaker.cancel(); restoreOriginalPanel(); }
    else { applyVisibility(); }
    renderAll();
    if (on) focusInput();
  }

  // ---------------------------------------------------------------- wrappers (installed once)
  var origLookupDA = win.lookupDA;
  var origUpdateScanStatus = win.updateScanStatus;

  function wrappedLookupDA() {
    var input = $('scan-input');
    var explicit = new Date().getTime() <= explicitUntil;
    var g = session.gate(input ? input.value : '', explicit);
    if (g === 'off') {
      return typeof origLookupDA === 'function' ? origLookupDA.apply(this, arguments) : undefined;
    }
    if (g !== 'process') return undefined;             // blocked / wait / empty: nothing is scanned or spoken
    var raw = input.value;
    input.value = '';                                   // the scan value never stays on screen
    focusInput();
    controller.handleScan(raw);
    return undefined;
  }
  function wrappedUpdateScanStatus() {
    var r = typeof origUpdateScanStatus === 'function' ? origUpdateScanStatus.apply(this, arguments) : undefined;
    if (session.getMode()) applyVisibility();
    return r;
  }

  function markExplicit() { explicitUntil = new Date().getTime() + EXPLICIT_WINDOW_MS; }
  function installWrappers() {
    win.lookupDA = wrappedLookupDA;
    win.updateScanStatus = wrappedUpdateScanStatus;
    var ready = $('scan-ready');
    if (ready && ready.addEventListener) {
      ready.addEventListener('keydown', function (e) { if (e && e.key === 'Enter') markExplicit(); }, true);
      ready.addEventListener('paste', markExplicit, true);
    }
  }

  // ---------------------------------------------------------------- start
  build(); installWrappers(); renderAll();
  var api = {
    session: session, controller: controller, speaker: speaker,
    setMode: setMode, renderAll: renderAll, wrappedLookupDA: wrappedLookupDA
  };
  win.__dwInstalled = api;
  return api;
}));
