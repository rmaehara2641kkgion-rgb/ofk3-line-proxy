/**
 * QR一斉印刷の並び。QRの中身は触らない。
 * createdAt がある新規登録だけ末尾へ。無い既存データへ現在時刻は付けない。
 * 既存分は従来の氏名ロケール順を維持し、同値は driverId・氏名で決定的に整列する。
 */
(function (global) {
  'use strict';

  function createdAtMs(value) {
    if (typeof value === 'number' && isFinite(value) && value > 0) return value;
    if (typeof value === 'string' && value) {
      var parsed = Date.parse(value);
      if (!isNaN(parsed)) return parsed;
    }
    return null;
  }

  function driverIdNum(value) {
    if (typeof value === 'number' && isFinite(value)) return value;
    var parsed = parseInt(value, 10);
    return isNaN(parsed) ? null : parsed;
  }

  function compareQrPrintOrder(a, b, lookup) {
    lookup = lookup || function () { return {}; };
    var ia = lookup(a) || {};
    var ib = lookup(b) || {};
    var ca = createdAtMs(ia.createdAt);
    var cb = createdAtMs(ib.createdAt);
    var ga = ca == null ? 0 : 1;
    var gb = cb == null ? 0 : 1;
    if (ga !== gb) return ga - gb;
    if (ga === 1 && ca !== cb) return ca - cb;
    if (ga === 0) {
      var nameCmp = String(a).localeCompare(String(b), 'ja');
      if (nameCmp !== 0) return nameCmp;
    }
    var ida = driverIdNum(ia.driverId);
    var idb = driverIdNum(ib.driverId);
    if (ida == null) ida = Number.MAX_SAFE_INTEGER;
    if (idb == null) idb = Number.MAX_SAFE_INTEGER;
    if (ida !== idb) return ida - idb;
    return String(a).localeCompare(String(b), 'ja');
  }

  function sortDriversForBulkQr(names, lookup) {
    return (names || []).slice().sort(function (a, b) {
      return compareQrPrintOrder(a, b, lookup);
    });
  }

  function pageOfIndex(index, pageSize) {
    var size = pageSize > 0 ? pageSize : 1;
    return Math.floor(index / size) + 1;
  }

  function namesOnLastPage(sortedNames, pageSize) {
    var names = sortedNames || [];
    if (!names.length) return [];
    var last = pageOfIndex(names.length - 1, pageSize);
    var out = [];
    for (var i = 0; i < names.length; i++) {
      if (pageOfIndex(i, pageSize) === last) out.push(names[i]);
    }
    return out;
  }

  var api = {
    compareQrPrintOrder: compareQrPrintOrder,
    sortDriversForBulkQr: sortDriversForBulkQr,
    pageOfIndex: pageOfIndex,
    namesOnLastPage: namesOnLastPage
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof global !== 'undefined') global.QrPrintOrder = api;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
