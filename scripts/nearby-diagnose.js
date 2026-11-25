// 近隣コース検索の診断集計（Node専用・ブラウザには読み込まない）。
// 出力は「原因別の件数」だけ。住所・町名・市区町村・Tracking ID・建物名・郵便番号は一切含めない。
// 値はすべて固定の列挙語・真偽・長さの区分・件数であり、顧客データ由来の文字列は出力に入らない。
'use strict';

function inc(o, k, n) { o[k] = (o[k] || 0) + (n === undefined ? 1 : n); }

function sortObj(o) {
  var out = {};
  Object.keys(o).sort(function (a, b) { return o[b] - o[a] || (a < b ? -1 : 1); }).forEach(function (k) { out[k] = o[k]; });
  return out;
}

function diffFields(a, b) {
  var f = [];
  ['muni', 'town', 'chome', 'banchi', 'go'].forEach(function (k) { if (a[k] !== b[k]) f.push(k); });
  return f.join('+');
}

function parts(C, text, chomeTowns) {
  var p = C.parseAddress(text);
  return { p: p, r: p.ok ? C.resolveParts(p, chomeTowns) : null };
}

function diagnose(C, extracted, idx) {
  var features = {}, failFeatures = {}, failReasons = {}, failCross = {}, shapes = {}, total = 0, failed = 0;

  extracted.routes.forEach(function (R) {
    R.rows.forEach(function (row) {
      var e = C.explainAddress(row.address);
      total++;
      Object.keys(e.f).forEach(function (k) {
        var v = String(e.f[k]);
        (features[k] = features[k] || {});
        inc(features[k], v);
        if (!e.ok) { (failFeatures[k] = failFeatures[k] || {}); inc(failFeatures[k], v); }
      });
      if (e.ok) inc(shapes, e.shape); // C=丁目 B=番地 G=号 / x=単位表記あり i=単位なし(省略解釈)
      else {
        failed++;
        inc(failReasons, e.reason);
        inc(failCross, e.reason + ' | 区切り数=' + e.f.partCount + ' | 市区町村源=' + e.f.muniSource + ' | 数字なし=' + e.f.noDigits + ' | 先頭が数字=' + e.f.startsWithDigit);
      }
    });
  });

  // ---- 自己検索（正規形クエリ）と、旧方式（表示用文字列でのクエリ）の比較
  function selfTest(makeQuery) {
    var res = { top3_LEVEL1: 0, LEVEL1だが候補数制限で未表示: 0, 検索漏れ: 0 };
    var causes = {}, falseL1 = 0, falseL1Causes = {};
    var byKey = {};
    idx.records.forEach(function (r) { byKey[r.route + '#' + r.key] = r; });
    idx.records.forEach(function (rec) {
      var q = makeQuery(rec);
      var s = C.search(idx, q, '', { limit: Infinity });
      var own = s.ok ? s.candidates.find(function (c) { return c.route === rec.route; }) : null;
      if (own && own.level === 1 && own.baseKey === rec.key) {
        if (own.rank <= 3) res.top3_LEVEL1++; else res.LEVEL1だが候補数制限で未表示++;
      } else {
        res.検索漏れ++;
        if (!s.ok) {
          var pp = C.parseAddress(q);
          inc(causes, 'クエリ解析不可:' + (pp.reason || 'unknown'));
        } else {
          var rp = parts(C, q, idx.chomeTowns);
          var d = rp.r ? diffFields(rp.r, rec) : 'parse_fail';
          if (d) inc(causes, '再解析で構造が変化:' + d);
          else inc(causes, 'LEVEL1にならない:own=' + (own ? 'LEVEL' + own.level : '候補なし'));
        }
      }
      if (s.ok) {
        s.candidates.forEach(function (c) {
          if (c.level === 1 && c.baseKey !== rec.key) {
            falseL1++;
            var other = byKey[c.route + '#' + c.baseKey];
            var f = other ? diffFields(other, rec) : '?';
            inc(falseL1Causes, '別構造がLEVEL1:' + f + (other && C.formatBase(other) === C.formatBase(rec) ? ' (表示文字列は同一)' : ''));
          }
        });
      }
    });
    return { 件数: res, 検索漏れ原因別: sortObj(causes), LEVEL1誤一致件数: falseL1, LEVEL1誤一致原因別: sortObj(falseL1Causes) };
  }

  var townRoutes = {};
  idx.records.forEach(function (r) { var k = r.muni + '|' + r.town; (townRoutes[k] = townRoutes[k] || {})[r.route] = 1; });

  return {
    診断対象行数: total,
    住所解析失敗: { 件数: failed, 原因別: sortObj(failReasons), 原因別_詳細: sortObj(failCross) },
    住所構造の特徴_全行: features,
    住所構造の特徴_解析失敗行のみ: failFeatures,
    解析成功住所の構造: sortObj(shapes),
    丁目あり町域数: Object.keys(idx.chomeTowns).length,
    複数コースにまたがる町域数: Object.keys(townRoutes).filter(function (k) { return Object.keys(townRoutes[k]).length > 1; }).length,
    自己検索_正規形クエリ: selfTest(function (rec) { return C.canonicalQuery(rec); }),
    自己検索_旧方式_表示用文字列: selfTest(function (rec) { return C.formatBase(rec); })
  };
}

module.exports = { diagnose: diagnose };
