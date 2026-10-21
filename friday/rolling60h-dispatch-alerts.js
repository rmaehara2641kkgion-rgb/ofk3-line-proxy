/**
 * 配車調整の読み上げ文を、FRIDAY既存の speakText へ渡す。
 * 文言の判定は rolling60h-dispatch.js が行い、ここでは音声の順番と占有だけを見る。
 */
(function (root) {
  'use strict';
  if (!root || !root.document) return;

  function audioBusy() {
    return root.__FRIDAY_CALENDAR_SPEAKING === true
      || root.__FRIDAY_CALENDAR_STARTUP === 'pending'
      || !!(root.speechSynthesis && (root.speechSynthesis.speaking || root.speechSynthesis.pending));
  }

  function speak(items) {
    if (typeof root.speakText !== 'function') return Promise.resolve(false);
    if (audioBusy()) return Promise.resolve(false);
    var chain = Promise.resolve(true);
    (items || []).forEach(function (item) {
      chain = chain.then(function (ok) {
        if (ok !== true || !item || !item.text) return false;
        return Promise.resolve(root.speakText(item.text)).then(function (spoken) {
          return spoken === true;
        });
      });
    });
    return chain;
  }

  root.RollingDispatchSpeech = { speak: speak, audioBusy: audioBusy };
})(typeof window !== 'undefined' ? window : null);
