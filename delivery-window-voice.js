/**
 * OFK3 delivery-window voice helpers (Phase 2: voice selection only).
 *
 * Used ONLY by the delivery-window read-out. The existing scan voice (speakRouteNumber,
 * female-voice preference) is not touched or reused.
 *
 * Browsers expose no gender field on SpeechSynthesisVoice, so "male" is decided from a
 * name list. If no known male voice exists, pickVoice returns the best ja voice with
 * male:false so the UI can say "male voice not detected" instead of pretending.
 * ES5, no template literals.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.DeliveryWindowVoice = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // lower-case name fragments of known Japanese male voices (OS / browser supplied)
  var MALE_NAMES = ['ichiro', 'otoya', 'takumi', 'keita', 'naoki', 'show', 'ryusei', 'hattori', 'male', '男'];
  var FEMALE_NAMES = ['female', 'nanami', 'haruka', 'ayumi', 'sayaka', 'kyoko', 'o-ren', 'mizuki', 'google', '女'];

  function isJa(v) { return !!v && String(v.lang || '').toLowerCase().replace('_', '-').indexOf('ja') === 0; }
  function nameOf(v) { return String(v && v.name || '').toLowerCase(); }
  function anyIn(name, list) {
    for (var i = 0; i < list.length; i++) if (name.indexOf(list[i]) >= 0) return true;
    return false;
  }

  function isMaleName(v) {
    var n = nameOf(v);
    if (anyIn(n, FEMALE_NAMES)) return false;
    return anyIn(n, MALE_NAMES);
  }

  /**
   * pickVoice(voices, preferredName?) -> { voice|null, male:boolean, reason }
   * preferredName (e.g. a user choice saved earlier) wins when it still exists among ja voices.
   */
  function pickVoice(voices, preferredName) {
    var ja = [], i;
    for (i = 0; i < (voices || []).length; i++) if (isJa(voices[i])) ja.push(voices[i]);
    if (!ja.length) return { voice: null, male: false, reason: 'no_ja_voice' };
    if (preferredName) {
      for (i = 0; i < ja.length; i++) if (ja[i].name === preferredName) return { voice: ja[i], male: isMaleName(ja[i]), reason: 'preferred' };
    }
    for (i = 0; i < ja.length; i++) if (isMaleName(ja[i])) return { voice: ja[i], male: true, reason: 'male_by_name' };
    return { voice: ja[0], male: false, reason: 'no_known_male_voice' };
  }

  function listJaVoices(voices) {
    var out = [];
    for (var i = 0; i < (voices || []).length; i++) {
      if (isJa(voices[i])) out.push({ name: voices[i].name, male: isMaleName(voices[i]), local: voices[i].localService === true });
    }
    return out;
  }

  return { pickVoice: pickVoice, listJaVoices: listJaVoices, isMaleName: isMaleName };
}));
