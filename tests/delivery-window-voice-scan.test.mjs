import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const Core = require(join(root, 'delivery-window-core.js'));
const Spk = require(join(root, 'delivery-window-speaker.js'));
const Scan = require(join(root, 'delivery-window-scan.js'));

let passed = 0;
function assert(cond, msg) { if (!cond) throw new Error('FAIL: ' + msg); }
function eq(a, b, msg) {
  const x = JSON.stringify(a); const y = JSON.stringify(b);
  if (x !== y) throw new Error('FAIL: ' + msg + '\n  actual:   ' + x + '\n  expected: ' + y);
}
function t(name, fn) {
  try { fn(); passed += 1; console.log('  ok - ' + name); } catch (e) { console.error('  NOT OK - ' + name + '\n' + e.message); process.exit(1); }
}

// ---------------- fakes (synthetic only) ----------------
function fakeClock() {
  let ms = 1000; const timers = [];
  return {
    now: () => ms,
    advance(d) { ms += d; for (const tm of timers.slice()) if (!tm.done && tm.at <= ms) { tm.done = true; tm.fn(); } },
    setTimer(fn, d) { const tm = { fn, at: ms + d, done: false }; timers.push(tm); return tm; },
    clearTimer(tm) { if (tm) tm.done = true; }
  };
}
function voice(name, lang) { return { name, lang: lang || 'ja-JP', localService: true }; }
function fakeSynth(voices, behavior) {
  const b = behavior || {};
  const s = {
    voices: voices || [], spoken: [], cancels: 0, current: null, listeners: {},
    getVoices() { return this.voices; },
    addEventListener(n, f) { this.listeners[n] = f; },
    speak(u) {
      if (b.throwOnSpeak) { b.throwOnSpeak -= 1; throw new Error('boom'); }
      this.spoken.push({ text: u.text, voice: u.voice ? u.voice.name : null, pitch: u.pitch, rate: u.rate, lang: u.lang });
      this.current = u;
    },
    cancel() { this.cancels += 1; const u = this.current; this.current = null; if (u && u.onerror) u.onerror({ error: 'canceled' }); },
    start() { if (this.current && this.current.onstart) this.current.onstart(); },
    end() { const u = this.current; this.current = null; if (u && u.onend) u.onend(); },
    fail(err) { const u = this.current; this.current = null; if (u && u.onerror) u.onerror({ error: err }); }
  };
  return s;
}
function Utt(text) { this.text = text; }
const MALE = voice('Microsoft Ichiro - Japanese (Japan)');
const FEMALE = voice('Google 日本語');

function makeSpeaker(synth, clock, opts) {
  const events = { fails: [], timings: [], voice: [] };
  const spk = Spk.createSpeaker({ synth, Utterance: Utt, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer },
    Object.assign({ onFail: (r) => events.fails.push(r), onTiming: (x) => events.timings.push(x), onVoiceChange: (x) => events.voice.push(x) }, opts || {}));
  return { spk, events };
}

const REF = '2026-11-17';
const D = REF + ' ';
const id = (n) => 'DA' + String(n).padStart(10, '0');
function sr(n, s, e, p) { return { id: id(n), start: s || '', end: e || '', promised: p === undefined ? REF : p, updated: '' }; }
const C1 = { cycle: 'Cycle1', heading: 'AM指定・14-16指定・BC', mixed: true, expected: null };
const C2 = { cycle: 'Cycle2', heading: '16-18時指定', mixed: false, expected: [[960, 1080]] };
function el(n, c) { return Object.assign({ id: id(n), row: 1 }, c || C1); }
function table(srRows, elRecs, opts) { return Core.buildTable({ srRows, elimiRecords: elRecs, reportDate: REF, loadedAt: '2026-11-17 10:00' }, opts); }
const BASE = table([
  sr(1, D + '08:00:00', D + '12:00:00'),                         // window 8-12
  sr(2, D + '14:00:00', D + '16:00:00'),                         // window 14-16
  sr(3, D + '08:00:00', D + '22:00:00'),                         // no_window
  sr(4, '', ''),                                                  // blank -> unknown
  sr(5, '2026-11-18 08:00:00', '2026-11-18 12:00:00', REF),      // date mismatch
  sr(6, D + '08:00:00', D + '12:00:00'), sr(6, D + '14:00:00', D + '16:00:00'), // dup conflict
  sr(7, '2026-11-25 08:00:00', '2026-11-25 12:00:00', '2026-11-25'), // out of range
  sr(8, D + '08:00:00', D + '22:00:00')                          // Cycle2 heading conflict
], [el(1), el(2), el(3), el(4), el(5), el(6), el(7), el(8, C2), el(9)]);

console.log('delivery-window voice/scan tests');

// ================= speaker =================
t('voice: male ja voice is selected and used; pitch/lang/rate set; status says male', () => {
  const clock = fakeClock(); const synth = fakeSynth([FEMALE, MALE, voice('Alex', 'en-US')]);
  const { spk } = makeSpeaker(synth, clock);
  eq(spk.speak('8時から12時！').ok, true, 'ok');
  eq([synth.spoken[0].voice, synth.spoken[0].lang], [MALE.name, 'ja-JP'], 'voice+lang');
  assert(synth.spoken[0].pitch < 1, 'lower pitch');
  const st = spk.getStatus();
  eq([st.male, st.voiceName, st.supported, st.enabled, st.policy], [true, MALE.name, true, true, 'latest'], 'status');
});
t('voice: no male voice -> speaks with a ja voice and reports male:false (never claims male)', () => {
  const clock = fakeClock(); const synth = fakeSynth([FEMALE]);
  const { spk } = makeSpeaker(synth, clock);
  spk.speak('時間指定なし！');
  eq([synth.spoken[0].voice, spk.getStatus().male, spk.getStatus().voiceReason], [FEMALE.name, false, 'no_known_male_voice'], 'fallback');
});
t('voice: voices that load late (voiceschanged) switch to the male voice and notify the UI', () => {
  const clock = fakeClock(); const synth = fakeSynth([]);
  const { spk, events } = makeSpeaker(synth, clock);
  eq(spk.getStatus().male, false, 'initially none');
  synth.voices = [MALE]; synth.listeners.voiceschanged();
  eq([spk.getStatus().male, events.voice.length > 0], [true, true], 'refreshed');
  spk.speak('x');
  eq(synth.spoken[0].voice, MALE.name, 'uses it');
});
t('voice: user-preferred voice name wins and can be changed', () => {
  const clock = fakeClock(); const synth = fakeSynth([MALE, voice('Otoya')]);
  const { spk } = makeSpeaker(synth, clock, { preferredVoice: 'Otoya' });
  spk.speak('a'); eq(synth.spoken[0].voice, 'Otoya', 'preferred');
  spk.setPreferredVoice(MALE.name); spk.speak('b'); eq(synth.spoken[1].voice, MALE.name, 'changed');
  eq(spk.listVoices().map((v) => v.male), [true, true], 'list');
});
t('policy latest: a new scan cancels the one playing; stale "canceled" is not a failure; only the newest remains', () => {
  const clock = fakeClock(); const synth = fakeSynth([MALE]);
  const { spk, events } = makeSpeaker(synth, clock);
  spk.speak('A'); spk.speak('B'); spk.speak('C');
  eq(synth.spoken.map((s) => s.text), ['A', 'B', 'C'], 'each spoken once, in order');
  eq(synth.cancels, 2, 'two cancels');
  eq(events.fails, [], 'canceled is not a failure');
  eq([spk.pendingCount(), spk.isPlaying()], [0, true], 'only newest playing');
  synth.end(); eq(spk.isPlaying(), false, 'finished');
});
t('policy queue: new results wait for the current one; bounded, oldest dropped', () => {
  const clock = fakeClock(); const synth = fakeSynth([MALE]);
  const { spk } = makeSpeaker(synth, clock, { policy: 'queue', maxQueue: 2 });
  spk.speak('A'); spk.speak('B'); spk.speak('C'); spk.speak('D');
  eq(synth.spoken.map((s) => s.text), ['A'], 'only A started');
  eq(spk.pendingCount(), 2, 'bounded');
  synth.end(); eq(synth.spoken.map((s) => s.text), ['A', 'C'], 'B dropped, C next');
  synth.end(); eq(synth.spoken.map((s) => s.text), ['A', 'C', 'D'], 'D last');
  eq(synth.cancels, 0, 'queue never cancels');
});
t('re-scanning the same item is spoken again every time (never suppressed)', () => {
  const clock = fakeClock(); const synth = fakeSynth([MALE]);
  const { spk } = makeSpeaker(synth, clock);
  for (let i = 0; i < 3; i++) { spk.speak('8時から12時！'); synth.end(); }
  eq(synth.spoken.length, 3, 'three times');
});
t('disabled: nothing is spoken (ok:false, reason disabled, no onFail noise); enabling again works; disabling cancels', () => {
  const clock = fakeClock(); const synth = fakeSynth([MALE]);
  const { spk, events } = makeSpeaker(synth, clock, { enabled: false });
  eq(spk.speak('x'), { ok: false, reason: 'disabled' }, 'disabled');
  eq([synth.spoken.length, events.fails.length], [0, 0], 'silent');
  spk.setEnabled(true); eq(spk.speak('y').ok, true, 'enabled');
  spk.setEnabled(false); eq([synth.cancels, spk.isPlaying()], [1, false], 'cancel on disable');
});
t('failure: no speechSynthesis -> ok:false unsupported, onFail called, no throw', () => {
  const clock = fakeClock();
  const events = []; const spk = Spk.createSpeaker({ now: clock.now }, { onFail: (r) => events.push(r) });
  eq(spk.speak('x'), { ok: false, reason: 'unsupported' }, 'unsupported');
  eq(events, ['unsupported'], 'reported');
  eq(spk.getStatus().supported, false, 'status');
});
t('failure: synth.speak throws -> caught (speak_threw), next speak still works', () => {
  const clock = fakeClock(); const synth = fakeSynth([MALE], { throwOnSpeak: 1 });
  const { spk, events } = makeSpeaker(synth, clock);
  eq(spk.speak('x'), { ok: false, reason: 'speak_threw' }, 'caught');
  eq(spk.isPlaying(), false, 'not stuck');
  eq(spk.speak('y').ok, true, 'recovers');
  eq(events.fails, ['speak_threw'], 'reported once');
});
t('failure: error event reported; empty text rejected', () => {
  const clock = fakeClock(); const synth = fakeSynth([MALE]);
  const { spk, events } = makeSpeaker(synth, clock);
  spk.speak('x'); synth.fail('synthesis-failed');
  eq(events.fails, ['error_event'], 'error event');
  eq(spk.speak(''), { ok: false, reason: 'empty_text' }, 'empty');
});
t('failure: speech that never starts is reported (no_start watchdog); starting in time clears it', () => {
  const clock = fakeClock(); const synth = fakeSynth([MALE]);
  const { spk, events } = makeSpeaker(synth, clock, { startTimeoutMs: 2000 });
  spk.speak('x'); clock.advance(2100);
  eq(events.fails, ['no_start'], 'watchdog');
  spk.speak('y'); synth.start(); clock.advance(5000);
  eq(events.fails, ['no_start'], 'no second failure when started');
});
t('timing: scan -> speak call -> speech start are reported as numbers only', () => {
  const clock = fakeClock(); const synth = fakeSynth([MALE]);
  const { spk, events } = makeSpeaker(synth, clock);
  const scanAt = clock.now(); clock.advance(3);
  spk.speak('x', { scanAt }); clock.advance(40); synth.start();
  eq(events.timings, [{ toCallMs: 3, toStartMs: 43 }], 'timings');
});

t('stale speech events: a superseded utterance finishing, starting or failing late cannot touch the newest speech state', () => {
  const clock = fakeClock(); const synth = fakeSynth([MALE]);
  const { spk, events } = makeSpeaker(synth, clock, { startTimeoutMs: 1000 });
  spk.speak('A'); const uA = synth.current;
  spk.speak('B');                                   // cancels A
  uA.onstart && uA.onstart(); uA.onend && uA.onend(); uA.onerror && uA.onerror({ error: 'synthesis-failed' }); // late events of A
  eq([spk.isPlaying(), events.timings, events.fails], [true, [], []], 'A cannot change anything');
  synth.start(); eq(events.timings.length, 1, 'only B reports timing');
  clock.advance(5000); eq(events.fails, [], 'B started in time: no watchdog failure');
});

// ================= scan controller =================
function makeCtl(tbl, synth, clock, copts) {
  const sp = makeSpeaker(synth, clock, copts && copts.speaker);
  const views = [], fails = [];
  const ctl = Scan.createScanController({ speaker: sp.spk, now: clock.now, onResult: (v) => views.push(v), onSpeakFail: (r) => fails.push(r) });
  if (tbl) ctl.setTable(tbl);
  return { ctl, sp, views, fails, synth };
}
t('three outcomes are distinguished in speech, label and kind', () => {
  const clock = fakeClock(); const synth = fakeSynth([MALE]);
  const { ctl } = makeCtl(BASE, synth, clock);
  const a = ctl.handleScan(id(1)), b = ctl.handleScan(id(3)), c = ctl.handleScan(id(4));
  eq([a.kind, a.label, a.range], ['window', '8時から12時', '08:00〜12:00'], 'window');
  eq([b.kind, b.label, b.range], ['no_window', '時間指定なし', null], 'no window');
  eq([c.kind, c.label, c.reason], ['unknown', '確認できません', 'time_blank'], 'unknown');
  eq(synth.spoken.map((s) => s.text), ['8時から12時！', '時間指定なし！', '確認できません！'], 'speech');
});
t('safety conditions hold end-to-end: mismatch, out of range, dup conflict, heading, not found, blank all say 確認できません！', () => {
  const clock = fakeClock(); const synth = fakeSynth([MALE]);
  const { ctl } = makeCtl(BASE, synth, clock);
  const want = { 4: 'time_blank', 5: 'date_mismatch', 6: 'dup_conflict_sr', 7: 'date_out_of_range', 8: 'conflict_elimi', 9: 'not_in_sr', 99: 'not_found' };
  for (const n of Object.keys(want)) {
    const v = ctl.handleScan(id(Number(n)));
    eq([v.kind, v.reason], ['unknown', want[n]], 'id ' + n);
    eq(synth.spoken[synth.spoken.length - 1].text, '確認できません！', 'spoken ' + n);
  }
});
t('8:00-22:00 is the only "時間指定なし"; neighbours are ordinary windows', () => {
  const T = table([sr(1, D + '08:00:00', D + '22:00:00'), sr(2, D + '08:00:00', D + '21:00:00'), sr(3, D + '09:00:00', D + '22:00:00'), sr(4, '', '')], [el(1), el(2), el(3), el(4)]);
  const clock = fakeClock(); const { ctl } = makeCtl(T, fakeSynth([MALE]), clock);
  eq([1, 2, 3, 4].map((n) => ctl.handleScan(id(n)).kind), ['no_window', 'window', 'window', 'unknown'], 'kinds');
});
t('no data loaded: unknown (table_not_loaded) and still spoken/visible', () => {
  const clock = fakeClock(); const synth = fakeSynth([MALE]);
  const { ctl } = makeCtl(null, synth, clock);
  const v = ctl.handleScan(id(1));
  eq([v.kind, v.reason, v.label], ['unknown', 'table_not_loaded', '確認できません'], 'view');
  eq(synth.spoken[0].text, '確認できません！', 'spoken');
  eq(ctl.dataInfo().loaded, false, 'info');
});
t('speech failure never hides the result: view is returned and flagged, onSpeakFail called', () => {
  const clock = fakeClock(); const synth = fakeSynth([MALE], { throwOnSpeak: 1 });
  const { ctl, views, fails } = makeCtl(BASE, synth, clock);
  const v = ctl.handleScan(id(1));
  eq([v.kind, v.label, v.spoke, v.speakFailReason], ['window', '8時から12時', false, 'speak_threw'], 'visible');
  eq([views.length, fails.length], [1, 1], 'callbacks');
  const v2 = ctl.handleScan(id(2));
  eq([v2.kind, v2.spoke], ['window', true], 'next scan fine');
});
t('speaker OFF is not a failure: result shown, spoke:false, no failure callback', () => {
  const clock = fakeClock(); const synth = fakeSynth([MALE]);
  const { ctl, fails, sp } = makeCtl(BASE, synth, clock);
  sp.spk.setEnabled(false);
  const v = ctl.handleScan(id(1));
  eq([v.kind, v.spoke, v.speakFailReason, fails.length], ['window', false, 'disabled', 0], 'off');
  eq(synth.spoken.length, 0, 'silent');
});
t('no speaker / throwing speaker / throwing UI callback never break scanning', () => {
  const clock = fakeClock();
  const a = Scan.createScanController({ now: clock.now }); a.setTable(BASE);
  eq(a.handleScan(id(1)).kind, 'window', 'no speaker');
  const b = Scan.createScanController({ speaker: { speak() { throw new Error('x'); } }, now: clock.now, onResult() { throw new Error('ui'); } }); b.setTable(BASE);
  eq(b.handleScan(id(1)).speakFailReason, 'speak_threw', 'throwing speaker');
});
t('consecutive scans: each result belongs to its own scan, in order; latest speech wins', () => {
  const clock = fakeClock(); const synth = fakeSynth([MALE]);
  const { ctl } = makeCtl(BASE, synth, clock);
  const seq = [1, 2, 3, 99, 1, 1, 4, 2];
  const kinds = seq.map((n) => ctl.handleScan(id(n)).kind);
  eq(kinds, ['window', 'window', 'no_window', 'unknown', 'window', 'window', 'unknown', 'window'], 'kinds');
  eq(synth.spoken.map((s) => s.text), ['8時から12時！', '14時から16時！', '時間指定なし！', '確認できません！', '8時から12時！', '8時から12時！', '確認できません！', '14時から16時！'], 'spoken in order');
  eq(synth.cancels, 7, 'each new scan cancels the previous');
});
t('rescanning the same item gives the same answer and speaks again', () => {
  const clock = fakeClock(); const synth = fakeSynth([MALE]);
  const { ctl } = makeCtl(BASE, synth, clock);
  const r = [ctl.handleScan(id(3)), ctl.handleScan(id(3)), ctl.handleScan(id(3))];
  eq(r.map((x) => x.kind), ['no_window', 'no_window', 'no_window'], 'same');
  eq(synth.spoken.length, 3, 'spoken thrice');
});
t('privacy: views and history never contain a full Tracking ID or the raw scan value', () => {
  const clock = fakeClock(); const synth = fakeSynth([MALE]);
  const { ctl, views } = makeCtl(BASE, synth, clock);
  for (const raw of [id(1), 'SCN-' + id(2), id(99), 'garbage-' + id(3) + '-x']) ctl.handleScan(raw);
  const dump = JSON.stringify(views) + JSON.stringify(ctl.getHistory()) + JSON.stringify(ctl.metrics());
  assert(!/[A-Z]{2}\d{10}/.test(dump), 'no full id in ' + dump.slice(0, 80));
  assert(dump.indexOf('garbage') < 0 && dump.indexOf('SCN-') < 0, 'no raw scan');
  eq(ctl.getHistory()[0].idTail.length, 4, 'tail only');
  ctl.clearHistory(); eq(ctl.getHistory(), [], 'cleared');
});
t('file update: a new table replaces the old answers completely; history keeps no old table data', () => {
  const clock = fakeClock(); const synth = fakeSynth([MALE]);
  const { ctl } = makeCtl(BASE, synth, clock);
  eq(ctl.handleScan(id(1)).label, '8時から12時', 'old');
  const T2 = table([sr(1, D + '14:00:00', D + '16:00:00')], [el(1)]);
  T2.meta.loadedAt = '2026-11-17 11:00';
  ctl.setTable(T2, '2026-11-17 11:00');
  eq(ctl.handleScan(id(1)).label, '14時から16時', 'new');
  eq(ctl.handleScan(id(3)).reason, 'not_found', 'old-only id gone');
  eq(ctl.dataInfo().loadedAt, '2026-11-17 11:00', 'last updated');
});
t('scan prefix: only a configured prefix is accepted; a wrong partial value stays unknown', () => {
  const T = table([sr(1, D + '08:00:00', D + '12:00:00'), sr(2, D + '14:00:00', D + '16:00:00')], [el(1), el(2)], { allowedAffixes: ['SCN-'] });
  const clock = fakeClock(); const { ctl } = makeCtl(T, fakeSynth([MALE]), clock);
  eq(ctl.handleScan('SCN-' + id(1)).kind, 'window', 'configured prefix');
  eq(ctl.handleScan('XYZ' + id(1)).kind, 'unknown', 'unknown glued prefix');
  eq(ctl.handleScan(id(1).slice(0, 11)).kind, 'unknown', 'truncated');
  eq(ctl.handleScan(id(1) + id(2)).kind, 'unknown', 'two scans glued together are never mixed up');
  eq(ctl.handleScan(id(1) + ' ' + id(2)).reason, 'ambiguous_scan', 'two ids in one value');
});
t('metrics: lookup and scan->speak-call timings are numbers; a 5,000-row table answers in well under 5ms (p95)', () => {
  const rows = [], els = [];
  for (let i = 1; i <= 5000; i++) { rows.push(sr(i, D + '08:00:00', D + '12:00:00')); els.push(el(i)); }
  const T = table(rows, els);
  const synth = fakeSynth([MALE]);
  const real = { now: () => performance.now() };
  const sp = Spk.createSpeaker({ synth, Utterance: Utt, now: real.now }, {});
  const ctl = Scan.createScanController({ speaker: sp, now: real.now }); ctl.setTable(T);
  for (let i = 0; i < 2000; i++) ctl.handleScan(id(1 + (i * 7) % 5000));
  const m = ctl.metrics();
  eq(m.scans, 2000, 'count');
  assert(typeof m.lookupMs.p95 === 'number' && m.lookupMs.p95 < 5, 'lookup p95 ' + m.lookupMs.p95);
  assert(m.scanToSpeakCallMs.p95 < 5, 'scan->call p95 ' + m.scanToSpeakCallMs.p95);
});

// ================= keyboard-wedge assembler =================
function makeAsm(opts) {
  const clock = fakeClock(); const scans = [], drops = [];
  const asm = Scan.createKeyAssembler(Object.assign({ onScan: (r) => scans.push(r), onDrop: (r) => drops.push(r), setTimer: clock.setTimer, clearTimer: clock.clearTimer }, opts || {}));
  const type = (s) => { for (const ch of s) asm.feedKey(ch); };
  return { asm, scans, drops, clock, type };
}
t('wedge: Enter ends a scan; back-to-back scans never mix; buffer is empty after each', () => {
  const { asm, scans, type } = makeAsm();
  type(id(1)); asm.feedKey('Enter'); eq(asm.pendingLength(), 0, 'empty after flush');
  type(id(2)); asm.feedKey('Enter'); type(id(1)); asm.feedKey('Enter');
  eq(scans, [id(1), id(2), id(1)], 'three separate scans');
});
t('wedge: Tab terminator, empty Enter ignored, modifiers/function keys ignored, Backspace/Escape', () => {
  const { asm, scans, drops, type } = makeAsm();
  asm.feedKey('Enter'); asm.feedKey('Shift'); asm.feedKey('F5'); asm.feedKey('ArrowLeft'); asm.feedKey('Control');
  type(id(1)); asm.feedKey('Tab');
  type('DAX'); asm.feedKey('Backspace'); type('Z'); asm.feedKey('Enter');
  type('junk'); asm.feedKey('Escape'); asm.feedKey('Enter');
  eq(scans, [id(1), 'DAZ'], 'scans');
  eq(drops, ['escape'], 'escape drop');
});
t('wedge: scanner prefix/suffix characters are passed through for the resolver (not guessed here)', () => {
  const { asm, scans, type } = makeAsm();
  type('SCN-' + id(1)); asm.feedKey('Enter');
  eq(scans, ['SCN-' + id(1)], 'raw kept for resolveScan');
});
t('wedge: no terminator -> idle flush completes the scan; too short is dropped', () => {
  const { asm, scans, drops, clock, type } = makeAsm({ idleFlushMs: 300, minLen: 6 });
  type(id(1)); clock.advance(100); eq(scans, [], 'not yet');
  clock.advance(250); eq(scans, [id(1)], 'flushed after idle');
  type('ab'); clock.advance(400); eq(scans.length, 1, 'short dropped'); eq(drops, ['too_short_idle'], 'reported');
  type(id(2)); clock.advance(50); type('X'); clock.advance(299); eq(scans.length, 1, 'idle timer restarts on every key');
});
t('wedge: runaway input is dropped (overflow) and the next scan is clean', () => {
  const { asm, scans, drops, type } = makeAsm({ maxLen: 20 });
  type('A'.repeat(50)); asm.feedKey('Enter');
  eq([scans, drops], [[], ['overflow']], 'dropped');
  type(id(1)); asm.feedKey('Enter'); eq(scans, [id(1)], 'recovers');
});
t('wedge: paste of one or many lines = one scan per line; control characters stripped', () => {
  const { asm, scans } = makeAsm();
  asm.feedPaste(id(1) + '\r\n'); asm.feedPaste(id(2) + '\n' + id(3) + '\u0003\n\n'); asm.feedPaste(null);
  eq(scans, [id(1), id(2), id(3)], 'pastes');
});
t('wedge -> controller: glued scans without terminator are not misread; terminated ones are exact', () => {
  const clock = fakeClock(); const synth = fakeSynth([MALE]);
  const { ctl } = makeCtl(BASE, synth, clock);
  const { asm, type } = makeAsm();
  const out = [];
  const asm2 = Scan.createKeyAssembler({ onScan: (raw) => out.push(ctl.handleScan(raw).kind) });
  for (const ch of id(1) + id(2)) asm2.feedKey(ch); asm2.feedKey('Enter'); // scanner lost its Enter in between
  for (const ch of id(2)) asm2.feedKey(ch); asm2.feedKey('Enter');
  eq(out, ['unknown', 'window'], 'glued -> 確認できません, next is clean');
  assert(asm && type, 'unused helpers exist');
});

// ================= isolation =================
t('existing female scan voice is untouched (Phase 5 only adds script tags and one container to index.html)', () => {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  assert(html.indexOf('function speakRouteNumber') > 0 && html.indexOf('utter.pitch = 1.3') > 0 && html.indexOf('function lookupDA() {') > 0, 'female voice + lookupDA code present and unchanged');
  assert(html.indexOf('delivery-window-ui.js') > 0 && html.indexOf('id="dw-root"') > 0, 'integration points present');
  assert(html.indexOf('delivery-window') < html.indexOf('</body>'), 'script tags sit at the end of the body, after the page script');
});
t('hygiene: new modules have no template literals, arrow functions, console or storage access', () => {
  for (const f of ['delivery-window-speaker.js', 'delivery-window-scan.js']) {
    const src = readFileSync(join(root, f), 'utf8');
    assert(src.indexOf('`') < 0, f + ' backtick');
    assert(!/=>/.test(src), f + ' arrow');
    assert(!/console\./.test(src), f + ' console');
    assert(!/localStorage|sessionStorage|XMLHttpRequest|fetch\(/.test(src), f + ' storage/network');
  }
});

console.log('\n' + passed + ' tests passed');
