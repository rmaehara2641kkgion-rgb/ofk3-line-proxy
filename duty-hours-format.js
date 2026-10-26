/**
 * 小数時間を画面用の「時間・分」に変換する。
 * 保存値や判定用の小数時間は変更しない。分は hours*60 を四捨五入し、秒は作らない。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DutyHoursFormat = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function pad2(value) {
    return value < 10 ? '0' + value : String(value);
  }

  function splitHours(hours) {
    if (typeof hours !== 'number' || !isFinite(hours)) return null;
    var sign = hours < 0 ? -1 : 1;
    var totalMinutes = Math.round(Math.abs(hours) * 60);
    return {
      sign: sign,
      hours: Math.floor(totalMinutes / 60),
      minutes: totalMinutes % 60,
    };
  }

  function body(parts) {
    if (parts.hours === 0 && parts.minutes > 0) return parts.minutes + '分';
    return parts.hours + '時間' + pad2(parts.minutes) + '分';
  }

  function durationText(hours) {
    var parts = splitHours(hours);
    if (!parts) return '未取得';
    var text = parts.hours + '時間' + pad2(parts.minutes) + '分';
    return (parts.sign < 0 ? '-' : '') + text;
  }

  function remainingText(hours) {
    var parts = splitHours(hours);
    if (!parts) return '未取得';
    if (parts.sign < 0) return overText(hours, 'forecast');
    return '残り' + body(parts);
  }

  function overText(hours, kind) {
    var parts = splitHours(Math.abs(typeof hours === 'number' ? hours : NaN));
    if (!parts) return '未取得';
    var label = kind === 'actual' ? '実績超過' : '超過見込み';
    return label + ' ' + body(parts);
  }

  return {
    splitHours: splitHours,
    durationText: durationText,
    remainingText: remainingText,
    overText: overText,
  };
});
