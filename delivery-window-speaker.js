/**
 * OFK3 delivery-window speaker (Phase 4) - browser speechSynthesis wrapper, dependency-injected.
 *
 * Separate from the existing scan voice (speakRouteNumber / scanVoiceEnabled): nothing here reads or
 * changes those. Only the delivery-window read-out uses this module and its own enabled flag.
 *
 * Policies when a new scan arrives while speech is still playing:
 *   'latest' (default): cancel what is playing and drop anything pending, speak the newest result only.
 *   'queue'           : keep playing, queue the new one (bounded by maxQueue, oldest dropped).
 * Re-scanning the same item is never suppressed.
 *
 * Failures never throw and never hide the on-screen result: speak() returns {ok:false, reason}
 * and onFail(reason) is called. Timing: scanAt (caller) -> spoken call -> onstart is reported to
 * onTiming({toCallMs, toStartMs}); numbers only, never text.
 * ES5, no template literals, no logging.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./delivery-window-voice.js'));
  } else {
    root.DeliveryWindowSpeaker = factory(root.DeliveryWindowVoice);
  }
}(typeof self !== 'undefined' ? self : this, function (Voice) {
  'use strict';

  var FAIL = {
    UNSUPPORTED: 'unsupported',
    DISABLED: 'disabled',
    EMPTY: 'empty_text',
    SPEAK_THROW: 'speak_threw',
    ERROR_EVENT: 'error_event',
    NO_START: 'no_start'
  };

  /**
   * createSpeaker(deps, opts)
   * deps: { synth, Utterance, now():ms, setTimer(fn,ms)->id, clearTimer(id) }   (all optional except synth/Utterance for sound)
   * opts: { policy, maxQueue, rate, pitch, volume, lang, preferredVoice, startTimeoutMs, enabled,
   *         onFail(reason), onTiming({toCallMs,toStartMs}), onVoiceChange(status) }
   */
  function createSpeaker(deps, opts) {
    var d = deps || {}, o = opts || {};
    var synth = d.synth || null, Utt = d.Utterance || null;
    var now = d.now || function () { return Date.now(); };
    var setT = d.setTimer || function (fn, ms) { return setTimeout(fn, ms); };
    var clearT = d.clearTimer || function (id) { clearTimeout(id); };
    var policy = o.policy === 'queue' ? 'queue' : 'latest';
    var maxQueue = o.maxQueue > 0 ? o.maxQueue : 3;
    var startTimeout = o.startTimeoutMs > 0 ? o.startTimeoutMs : 2500;
    var cfg = { rate: o.rate || 1.05, pitch: o.pitch || 0.85, volume: o.volume === undefined ? 1 : o.volume, lang: o.lang || 'ja-JP' };
    var enabled = o.enabled === false ? false : true;
    var preferred = o.preferredVoice || null;
    var seq = 0, playing = null, pending = [];
    var voiceInfo = null;

    function supported() { return !!(synth && Utt && typeof synth.speak === 'function'); }

    function refreshVoice() {
      var list = [];
      try { list = (synth && synth.getVoices && synth.getVoices()) || []; } catch (e) { list = []; }
      var p = Voice.pickVoice(list, preferred);
      var changed = !voiceInfo || (voiceInfo.name || null) !== (p.voice ? p.voice.name : null) || voiceInfo.male !== p.male;
      voiceInfo = { voice: p.voice, name: p.voice ? p.voice.name : null, male: p.male, reason: p.reason, count: list.length };
      if (changed && typeof o.onVoiceChange === 'function') { try { o.onVoiceChange(getStatus()); } catch (e2) { /* UI callback must not break speech */ } }
      return voiceInfo;
    }

    if (synth && typeof synth.addEventListener === 'function') {
      try { synth.addEventListener('voiceschanged', refreshVoice); } catch (e) { /* ignore */ }
    }

    function getStatus() {
      var v = voiceInfo || refreshVoice();
      return { supported: supported(), enabled: enabled, voiceName: v.name, male: v.male, voiceReason: v.reason, jaVoiceCount: v.count, policy: policy };
    }

    function fail(reason, extra) {
      if (typeof o.onFail === 'function') { try { o.onFail(reason); } catch (e) { /* ignore */ } }
      var r = { ok: false, reason: reason };
      if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) r[k] = extra[k];
      return r;
    }

    function startOne(job) {
      var u;
      try {
        u = new Utt(job.text);
        u.lang = cfg.lang; u.rate = cfg.rate; u.pitch = cfg.pitch; u.volume = cfg.volume;
        var v = (voiceInfo || refreshVoice()).voice;
        if (v) u.voice = v;
        playing = job;
        job.callAt = now();
        job.timer = setT(function () {
          if (playing === job && !job.started) { job.timedOut = true; fail(FAIL.NO_START); }
        }, startTimeout);
        u.onstart = function () {
          job.started = true;
          if (job.timer !== null) { clearT(job.timer); job.timer = null; }
          if (typeof o.onTiming === 'function') {
            var t = now();
            try { o.onTiming({ toCallMs: job.callAt - job.scanAt, toStartMs: t - job.scanAt }); } catch (e) { /* ignore */ }
          }
        };
        u.onend = function () { finish(job); };
        u.onerror = function (ev) {
          // 'canceled' / 'interrupted' are our own cancel() calls, not failures
          var err = ev && ev.error ? String(ev.error) : '';
          var current = playing === job; // a superseded utterance erroring is not a failure of the latest one
          finish(job);
          if (current && err !== 'canceled' && err !== 'interrupted') fail(FAIL.ERROR_EVENT);
        };
        synth.speak(u);
        return { ok: true };
      } catch (e) {
        if (job.timer !== null && job.timer !== undefined) { clearT(job.timer); job.timer = null; }
        if (playing === job) playing = null;
        return fail(FAIL.SPEAK_THROW);
      }
    }

    function finish(job) {
      if (job.timer !== null && job.timer !== undefined) { clearT(job.timer); job.timer = null; }
      if (playing === job) {
        playing = null;
        if (pending.length) startOne(pending.shift());
      }
    }

    /** speak(text, meta?) meta: { scanAt } -> {ok} | {ok:false, reason} */
    function speak(text, meta) {
      if (!enabled) return { ok: false, reason: FAIL.DISABLED };
      if (!supported()) return fail(FAIL.UNSUPPORTED);
      var s = text === null || text === undefined ? '' : String(text);
      if (!s) return fail(FAIL.EMPTY);
      var job = { id: ++seq, text: s, scanAt: meta && meta.scanAt !== undefined ? meta.scanAt : now(), started: false, timer: null };
      if (policy === 'queue') {
        if (playing) {
          pending.push(job);
          while (pending.length > maxQueue) pending.shift();
          return { ok: true, queued: true };
        }
        return startOne(job);
      }
      // latest: newest result wins
      pending = [];
      if (playing) {
        var prev = playing;
        if (prev.timer !== null) { clearT(prev.timer); prev.timer = null; }
        playing = null;
        try { synth.cancel(); } catch (e) { /* ignore */ }
      }
      return startOne(job);
    }

    function cancel() {
      pending = [];
      if (playing) { if (playing.timer !== null) { clearT(playing.timer); playing.timer = null; } playing = null; }
      try { if (synth && synth.cancel) synth.cancel(); } catch (e) { /* ignore */ }
    }

    return {
      speak: speak, cancel: cancel, getStatus: getStatus, refreshVoice: refreshVoice,
      setEnabled: function (v) { enabled = !!v; if (!enabled) cancel(); },
      isEnabled: function () { return enabled; },
      setPreferredVoice: function (name) { preferred = name || null; refreshVoice(); },
      listVoices: function () { try { return Voice.listJaVoices(synth && synth.getVoices ? synth.getVoices() : []); } catch (e) { return []; } },
      pendingCount: function () { return pending.length; },
      isPlaying: function () { return !!playing; }
    };
  }

  return { createSpeaker: createSpeaker, FAIL: FAIL };
}));
