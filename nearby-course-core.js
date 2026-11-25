/**
 * OFK3 追加荷物・近隣コース検索 — コアロジック（DOM非依存・純粋関数）
 *
 * 管理者が手動ダウンロードしたマニフェスト(xlsx)の内容だけを使い、ブラウザ内で完結する。
 * 外部通信・ログ出力・永続化は一切行わない（配送先住所/Tracking IDを扱うため）。
 * Tracking ID は「有効な配送荷物か」の判定にのみ使い、保持しない。
 *
 * 住所は 市区町村 / 町名 / 丁目 / 番地 / 号 に分解し、階層一致度で LEVEL 1〜6 を判定する。
 * 文字列類似度は使わない。番地差は地理距離ではなく「番地番号の差」であり、距離表示はしない。
 */
(function (global) {
  'use strict';

  var LIMITS = {
    maxFileBytes: 20 * 1024 * 1024,        // アップロードファイル
    maxUncompressedBytes: 200 * 1024 * 1024, // 展開後サイズ合計（zip bomb対策）
    maxZipEntries: 2000,
    maxSheets: 300,
    maxRowsPerSheet: 5000,
    maxValidRows: 100000,
    maxRouteLen: 40,
    nearBanchiMax: 5                       // LEVEL3: 番地番号の差がこの値以内なら「近い」
  };

  var LEVEL_LABEL = {
    1: '基本住所 完全一致',
    2: '同一町名・丁目・番地',
    3: '同一町名・丁目（番地が近い）',
    4: '同一町名・丁目',
    5: '同一町名のみ'
  };

  var PREFECTURES = ['北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県',
    '埼玉県', '千葉県', '東京都', '神奈川県', '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県',
    '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県', '鳥取県', '島根県',
    '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県', '熊本県',
    '大分県', '宮崎県', '鹿児島県', '沖縄県'];

  // ---------------------------------------------------------------- 正規化

  var KANJI_DIGIT = { '〇': 0, '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };

  function kanjiToInt(str) {
    // 例: 十五→15, 二十三→23, 百二→102, 一二→12(桁表記)
    var total = 0, cur = 0, seenUnit = false, i, ch;
    if (/^[〇零一二三四五六七八九]+$/.test(str)) {
      var s = '';
      for (i = 0; i < str.length; i++) s += KANJI_DIGIT[str.charAt(i)];
      return parseInt(s, 10);
    }
    for (i = 0; i < str.length; i++) {
      ch = str.charAt(i);
      if (ch in KANJI_DIGIT) { cur = KANJI_DIGIT[ch]; }
      else if (ch === '十') { total += (cur || 1) * 10; cur = 0; seenUnit = true; }
      else if (ch === '百') { total += (cur || 1) * 100; cur = 0; seenUnit = true; }
      else return NaN;
    }
    total += cur;
    return seenUnit || cur ? total : NaN;
  }

  // 全角英数記号・全角スペース→半角（String.prototype.normalize 非依存）
  function toHalf(v) {
    return String(v).replace(/[\uff01-\uff5e]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xfee0); })
      .replace(/\u3000/g, ' ');
  }

  function normalizePostal(p) {
    if (p === null || p === undefined) return '';
    var d = toHalf(p).replace(/[^0-9]/g, '');
    if (d.length === 6) d = '0' + d; // Excelで先頭0が落ちた郵便番号
    return d.length === 7 ? d : '';
  }

  // 都道府県の正式名・略称（福岡→福岡県, 東京→東京都, 京都→京都府, 大阪→大阪府）
  var PREF_LOOKUP = {};
  PREFECTURES.forEach(function (pf) {
    PREF_LOOKUP[pf] = pf;
    PREF_LOOKUP[pf === '北海道' ? pf : pf.slice(0, -1)] = pf;
  });
  function prefOf(str) {
    var key = String(str).replace(/\s+/g, '');
    if (/^fukuoka(?:-?ken|prefecture)?$/i.test(key)) return '福岡県';
    return Object.prototype.hasOwnProperty.call(PREF_LOOKUP, key) ? PREF_LOOKUP[key] : '';
  }

  // 福岡県の市町村・政令市の区。住所本文と独立セグメントに同じ境界規則を使う。
  // 対象外地域は既存の解析規則を維持する。
  var FUKUOKA_MUNI = ('北九州市門司区 北九州市若松区 北九州市戸畑区 北九州市小倉北区 北九州市小倉南区 北九州市八幡東区 北九州市八幡西区 福岡市東区 福岡市博多区 福岡市中央区 福岡市南区 福岡市西区 福岡市城南区 福岡市早良区 北九州市 福岡市 大牟田市 久留米市 直方市 飯塚市 田川市 柳川市 八女市 筑後市 大川市 行橋市 豊前市 中間市 小郡市 筑紫野市 春日市 大野城市 宗像市 太宰府市 古賀市 福津市 うきは市 宮若市 嘉麻市 朝倉市 みやま市 糸島市 那珂川市 糟屋郡宇美町 糟屋郡篠栗町 糟屋郡志免町 糟屋郡須恵町 糟屋郡新宮町 糟屋郡久山町 糟屋郡粕屋町 遠賀郡芦屋町 遠賀郡水巻町 遠賀郡岡垣町 遠賀郡遠賀町 鞍手郡小竹町 鞍手郡鞍手町 嘉穂郡桂川町 朝倉郡筑前町 朝倉郡東峰村 三井郡大刀洗町 三潴郡大木町 八女郡広川町 田川郡香春町 田川郡添田町 田川郡糸田町 田川郡川崎町 田川郡大任町 田川郡赤村 田川郡福智町 京都郡苅田町 京都郡みやこ町 築上郡吉富町 築上郡上毛町 築上郡築上町').split(' ');
  var FUKUOKA_NAMES = Object.create(null);
  FUKUOKA_MUNI.forEach(function (full) {
    FUKUOKA_NAMES[full] = full;
    var short = full.replace(/^.+?郡/, '');
    FUKUOKA_NAMES[short] = full;
  });
  var FUKUOKA_KEYS = Object.keys(FUKUOKA_NAMES).sort(function(a,b){return b.length-a.length;});
  // Explicit aliases only; do not transliterate unknown town or building names.
  var ROMAN_MUNI = Object.create(null);
  var romanCities = 'Kitakyushu:北九州市 Fukuoka:福岡市 Omuta:大牟田市 Kurume:久留米市 Nogata:直方市 Iizuka:飯塚市 Tagawa:田川市 Yanagawa:柳川市 Yame:八女市 Chikugo:筑後市 Okawa:大川市 Yukuhashi:行橋市 Buzen:豊前市 Nakama:中間市 Ogori:小郡市 Chikushino:筑紫野市 Kasuga:春日市 Onojo:大野城市 Munakata:宗像市 Dazaifu:太宰府市 Koga:古賀市 Fukutsu:福津市 Ukiha:うきは市 Miyawaka:宮若市 Kama:嘉麻市 Asakura:朝倉市 Miyama:みやま市 Itoshima:糸島市 Nakagawa:那珂川市';
  romanCities.split(' ').forEach(function(pair){
    var a=pair.split(':'); ROMAN_MUNI[a[0].toLowerCase()+'shi']=a[1]; ROMAN_MUNI[a[0].toLowerCase()+'city']=a[1];
  });
  function romanMunicipality(s) {
    var k=s.toLowerCase().replace(/[\s-]/g,'');
    return Object.prototype.hasOwnProperty.call(ROMAN_MUNI,k) ? ROMAN_MUNI[k] : '';
  }
  function fukuokaMatch(s, exact) {
    s = s.replace(/\s+/g, '');
    var roman = exact ? romanMunicipality(s) : '';
    if (roman) return {full:roman,rest:''};
    for (var i=0;i<FUKUOKA_KEYS.length;i++) {
      var k=FUKUOKA_KEYS[i];
      if (exact ? s===k : s.indexOf(k)===0) return {full:FUKUOKA_NAMES[k], rest:s.slice(k.length)};
    }
    return null;
  }

  /** 先頭の都道府県を切り出す。 */
  function takePrefecture(s) {
    for (var i = 0; i < PREFECTURES.length; i++) {
      if (s.indexOf(PREFECTURES[i]) === 0) return { pref: PREFECTURES[i], rest: s.slice(PREFECTURES[i].length) };
    }
    return { pref: '', rest: s };
  }

  /**
   * カンマ区切り住所を日本語順（都道府県→市区町村→町域・番地）に再構成する。
   * - Amazon形式: 「町域・番地[, 建物], 市区町村, 都道府県」
   * - カンマ入りの日本語順: 「都道府県, 市区町村, 町域・番地」
   * カンマが無ければ null。市区町村判定は 市/区(強) → 町/村(弱) の順で、末尾→先頭の順に探す。
   */
  function reorderComma(s) {
    if (!/[,、]/.test(s)) return null;
    var parts = s.split(/\s*[,、]\s*/).map(function (x) { return x.trim(); })
      .filter(function (x) { return x && !/^(日本|japan|jp)$/i.test(x); });
    if (!parts.length) return { pref: '', muni: '', street: '', muniPos: '', muniKind: '', partCount: 0 };
    // 都道府県セグメントの位置が語順の根拠: 末尾=Amazon形式(町域・番地,…,市区町村,都道府県) / 先頭=日本語順
    var pref = '', prefEnd = false, prefStart = false, i;
    if (prefOf(parts[parts.length - 1])) prefEnd = true;
    else if (prefOf(parts[0])) prefStart = true;
    for (i = parts.length - 1; i >= 0; i--) {
      if (prefOf(parts[i])) { pref = prefOf(parts[i]); parts.splice(i, 1); break; }
    }
    function nd(x) { return !/\d/.test(x); }
    function strong(x) { return nd(x) && /([市区]|郡.+[町村])$/.test(x.replace(/\s+/g, '')); }
    function weak(x) { return nd(x) && /[町村]$/.test(x.replace(/\s+/g, '')); }
    var muni = '', pos = '', kind = '', last = parts.length - 1;
    if (parts.length >= 2) {
      if (pref === '福岡県' && (prefEnd || prefStart)) {
        var ix = prefEnd ? last : 0;
        var fm = fukuokaMatch(parts[ix], true);
        if (fm) { muni = fm.full; parts.splice(ix,1); pos = prefEnd ? 'last' : 'first'; kind = 'strong'; }
      } else if (prefEnd) {
        // 都道府県の直前だけが市区町村の候補（それ以外の位置は推測しない）
        if (strong(parts[last])) { muni = parts.pop(); pos = 'last'; kind = 'strong'; }
        else if (weak(parts[last])) { muni = parts.pop(); pos = 'last'; kind = 'weak'; }
      } else if (prefStart) {
        // 都道府県の直後だけが候補。町・村で終わる先頭セグメントは町域の可能性があるため強いものだけ採用
        if (strong(parts[0])) { muni = parts.shift(); pos = 'first'; kind = 'strong'; }
      } else {
        // 都道府県セグメントなし: 数字を含まない市区町村様セグメントが1つだけの場合のみ採用。
        // 2つ以上ある（例:「福岡市東区, 新宮区」「新宮区, 粕屋町」）はどちらが町域か判別できないため採用しない。
        var cands = [];
        parts.forEach(function (x, ix) { if (strong(x) || weak(x)) cands.push(ix); });
        if (cands.length === 1) {
          var ci = cands[0];
          if (ci === last && (strong(parts[ci]) || weak(parts[ci]))) { muni = parts.pop(); pos = 'last'; kind = strong(muni) ? 'strong' : 'weak'; }
          else if (ci === 0 && strong(parts[0])) { muni = parts.shift(); pos = 'first'; kind = 'strong'; }
        }
      }
    }
    // If the municipality is embedded in a non-leading segment, move only a
    // uniquely identified official municipality+street prefix to the front.
    if (pref === '福岡県' && !muni) {
      var hits = [];
      parts.forEach(function(part, ix) {
        var hit = fukuokaMatch(part, false);
        if (hit && hit.rest && !/^\d/.test(hit.rest)) hits.push(ix);
      });
      if (hits.length === 1 && hits[0] > 0) {
        var at = hits[0];
        // Do not move a segment across a preceding numeric address block.
        if (parts.slice(0,at).every(function(part){return !/\d/.test(part);})) {
          var primary = parts.splice(at,1)[0];
          parts.unshift(primary);
        }
      }
    }
    return { pref: pref, muni: muni, street: parts.join(' '), muniPos: pos, muniKind: kind, partCount: parts.length + (muni ? 1 : 0) + (pref ? 1 : 0) };
  }

  /** 住所文字列を正規化し、構成要素に分解する（丁目の省略解釈は resolveParts で確定）。 */
  function parseAddress(raw) {
    var out = { ok: false, reason: '', via: '', pref: '', gun: '', muni: '', town: '', nums: null, explicit: false, postal: '', hasTail: false };
    if (raw === null || raw === undefined) { out.reason = 'empty'; return out; }
    var s = toHalf(raw).replace(/[\t\r\n]+/g, ' ').trim();
    // 先頭の郵便番号
    var pm = s.match(/^〒?\s*(\d{3}-?\d{4})\s*/);
    if (pm) { out.postal = normalizePostal(pm[1]); s = s.slice(pm[0].length); }
    // カンマ区切り（Amazonマニフェスト形式を含む）→ 日本語順へ再構成
    var explicitMuni = '';
    var rc = reorderComma(s);
    if (rc) { out.pref = rc.pref; explicitMuni = rc.muni; s = rc.street; }
    // ハイフン類（NFKCで未変換のもの）→ '-'
    s = s.replace(/[‐-―−ーｰ]/g, function (c, off, all) {
      // 長音は数字に挟まれる場合のみハイフン扱い（「ビー」等を壊さない）
      if (c === 'ー' || c === 'ｰ') {
        return /\d/.test(all.charAt(off - 1)) && /\d/.test(all.charAt(off + 1)) ? '-' : c;
      }
      return '-';
    });
    if (!out.pref) { var tp = takePrefecture(s.replace(/^\s+/, '')); out.pref = tp.pref; s = tp.rest; }
    if (explicitMuni) {
      var tm = takePrefecture(explicitMuni.replace(/\s+/g, ''));
      if (tm.pref && !out.pref) out.pref = tm.pref;
      explicitMuni = tm.rest;
    }
    // 数字直前の漢数字の丁目: 二丁目→2丁目 / 数字直後の漢数字の番・号
    s = s.replace(/([〇零一二三四五六七八九十百]+)(丁目)/g, function (m, k, u) {
      var n = kanjiToInt(k); return isNaN(n) ? m : n + u;
    });
    for (var pass = 0; pass < 3; pass++) {
      s = s.replace(/(\d|丁目|番地|番)([〇零一二三四五六七八九十百]+)(番地|番|号)/g, function (m, p, k, u) {
        var n = kanjiToInt(k); return isNaN(n) ? m : p + n + u;
      });
    }
    // 番地/号の「の」「ノ」→ハイフン
    s = s.replace(/(\d)\s*[のノ]\s*(\d)/g, '$1-$2');
    s = s.replace(/\s*-\s*/g, '-').replace(/(\d)\s+(丁目|番地|番|号)/g, '$1$2');

    var di = s.search(/\d/);
    var head = di < 0 ? s : s.slice(0, di);
    var tail = di < 0 ? '' : s.slice(di);
    head = head.replace(/\s+/g, '');
    if (!head) { out.reason = explicitMuni ? 'town_empty' : (s ? 'no_text_before_number' : 'empty'); return out; }

    // 市区町村: 郡+町村 / 市(+区) / 区のみ
    var muni = '', town = head, mm;
    if (out.pref === '福岡県') {
      var fm = fukuokaMatch(explicitMuni || head, !!explicitMuni);
      if (!fm) { out.reason = 'unknown_fukuoka_municipality'; return out; }
      var fg = fm.full.match(/^(.+?郡)(.+)$/);
      out.gun = fg ? fg[1] : '';
      muni = fg ? fg[2] : fm.full;
      town = explicitMuni ? head : fm.rest;
      out.via = explicitMuni ? 'segment' : 'inline';
    } else if (explicitMuni) {
      // 郡は別属性として保持（「糟屋郡粕屋町」と「粕屋町」は一致扱い、郡が両方にあり異なれば不一致）
      var gm = explicitMuni.match(/^(.+?郡)(.+)$/);
      if (gm) { out.gun = gm[1]; muni = gm[2]; } else muni = explicitMuni;
      out.via = 'segment';
    } else {
      mm = head.match(/^(.+?郡)(.+?[町村])/);
      if (mm) { out.gun = mm[1]; muni = mm[2]; town = head.slice(mm[0].length); out.via = 'inline'; }
      else {
        // 「市」を含まない区のみの表記（東京23区など）は、町域名との区別が付かないため都道府県が明示されている場合だけ採用
        mm = head.match(/^(.+?市)((?:[^市郡]{1,4}?区))?/);
        // 「粕屋町市場通」のように町・村の直後の「市」を市名の末尾と取り違えない（市名が町/村で終わることはない）
        if (mm && /[町村]市$/.test(mm[1])) mm = null;
        else if (!mm && out.pref) mm = head.match(/^([^市郡]{1,4}?区)/);
        if (mm) { muni = mm[0]; town = head.slice(mm[0].length); out.via = 'inline'; }
      }
    }
    town = town.replace(/^大?字/, '').replace(/[ヶヵケ]/g, 'ケ').replace(/(\d|-)+$/, '');
    out.muni = muni;
    out.town = town;

    // 番地ブロック: 数字+単位 を順に読む（空白を跨がない。以降は建物名・部屋番号として捨てる）
    var re = /^(\d+)(丁目|番地|番|号)?(-)?/;
    var nums = [null, null, null], ptr = 0, explicit = false, count = 0, m, pos = 0;
    while (pos < tail.length) {
      m = re.exec(tail.slice(pos));
      if (!m) break;
      var n = parseInt(m[1], 10), unit = m[2], slot;
      if (unit === '丁目') { slot = 0; explicit = true; }
      else if (unit === '番地' || unit === '番') { slot = 1; explicit = true; }
      else if (unit === '号') { slot = 2; explicit = true; }
      else slot = ptr;
      count++;
      if (slot > 2) break; // 4個目以降（部屋番号等）は捨てる
      nums[slot] = n;
      ptr = slot + 1;
      pos += m[0].length;
      if (unit === '号') break;
      if (!m[3] && !/\d/.test(tail.charAt(pos))) break; // 区切り無し・次が数字でなければ終了
    }
    out.hasTail = pos < tail.length;
    out.nums = nums;
    out.explicit = explicit;
    out.count = count;
    // 市区町村と町域を取り違えた住所は不正として扱う（検索対象外）
    out.ok = !!(out.muni && out.town && /[市区町村]$/.test(out.muni) && out.muni.length <= 12 && out.town.length <= 20);
    if (!out.ok) {
      out.reason = !out.muni ? (rc ? 'comma_no_municipality_part' : 'no_municipality_found')
        : !out.town ? 'town_empty'
        : !/[市区町村]$/.test(out.muni) ? 'municipality_bad_suffix'
        : out.muni.length > 12 ? 'municipality_too_long' : 'town_too_long';
    }
    return out;
  }

  /**
   * 丁目の省略解釈を確定して {muni, town, chome, banchi, go} にする。
   * 単位無し(例 2-15-8)は 3個→丁目-番-号 / 1個→番地 / 2個→「丁目あり町域」なら丁目-番、それ以外は番-号。
   */
  function townKey(p) {
    return [p.pref || '', p.gun || '', p.muni, p.town].join('|');
  }

  function resolveParts(p, chomeTowns) {
    var n = p.nums || [null, null, null];
    var chome = n[0], banchi = n[1], go = n[2];
    if (!p.explicit) {
      var c = p.count || 0;
      if (c === 1) { banchi = n[0]; chome = null; go = null; }
      else if (c === 2 && !(chomeTowns && chomeTowns[townKey(p)])) { banchi = n[0]; go = n[1]; chome = null; }
    }
    return { pref: p.pref || '', gun: p.gun || '', muni: p.muni, town: p.town, chome: chome, banchi: banchi, go: go };
  }

  function isChomeEvidence(p) {
    return !!(p.nums && (p.nums[0] !== null && (p.explicit || p.count >= 3)));
  }

  function baseKey(a) {
    return [a.pref || '', a.gun || '', a.muni, a.town, a.chome === null ? '' : a.chome, a.banchi === null ? '' : a.banchi, a.go === null ? '' : a.go].join('|');
  }

  function formatBase(a) {
    var s = a.muni + a.town;
    var parts = [];
    if (a.chome !== null) parts.push(a.chome);
    if (a.banchi !== null) parts.push(a.banchi);
    if (a.go !== null) parts.push(a.go);
    return s + parts.join('-');
  }

  // ---------------------------------------------------------------- ファイル検証・解析

  function inspectZip(bytes) {
    // 返り値: {ok, error, entries, uncompressed}
    var len = bytes.length;
    if (len < 22 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
      return { ok: false, error: 'xlsx形式（ZIP）ではありません' };
    }
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var eocd = -1, i;
    for (i = len - 22; i >= Math.max(0, len - 22 - 65535); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return { ok: false, error: 'ZIP構造を確認できません' };
    var total = dv.getUint16(eocd + 10, true);
    var cdOff = dv.getUint32(eocd + 16, true);
    if (total === 0xffff || cdOff === 0xffffffff) return { ok: false, error: 'ZIP64形式は対応していません' };
    if (total > LIMITS.maxZipEntries) return { ok: false, error: 'ZIP内のファイル数が多すぎます' };
    var p = cdOff, sum = 0, names = [];
    for (i = 0; i < total; i++) {
      if (p + 46 > len || dv.getUint32(p, true) !== 0x02014b50) return { ok: false, error: 'ZIP構造が不正です' };
      var flags = dv.getUint16(p + 8, true);
      var usz = dv.getUint32(p + 24, true);
      var nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
      if (flags & 1) return { ok: false, error: '暗号化されたファイルは対応していません' };
      if (usz === 0xffffffff) return { ok: false, error: 'ZIP64形式は対応していません' };
      sum += usz;
      if (sum > LIMITS.maxUncompressedBytes) return { ok: false, error: '展開後のサイズが大きすぎます' };
      var nameBytes = bytes.subarray(p + 46, p + 46 + nl), nm = '';
      for (var k = 0; k < nameBytes.length; k++) nm += String.fromCharCode(nameBytes[k]);
      names.push(nm);
      p += 46 + nl + el + cl;
    }
    if (names.indexOf('xl/workbook.xml') < 0) return { ok: false, error: 'Excelブック(xlsx)ではありません' };
    for (i = 0; i < names.length; i++) {
      if (/vbaProject\.bin$/i.test(names[i])) return { ok: false, error: 'マクロ付きファイルは対応していません' };
    }
    return { ok: true, entries: total, uncompressed: sum };
  }

  function parseFileName(name) {
    var out = { date: '', cycle: '' };
    var s = String(name || '');
    var m = s.match(/(20\d{2})[-_]?(\d{2})[-_]?(\d{2})/);
    if (m) {
      var y = +m[1], mo = +m[2], d = +m[3];
      var dt = new Date(Date.UTC(y, mo - 1, d));
      if (dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d) {
        out.date = m[1] + '-' + m[2] + '-' + m[3];
      }
    }
    var c = s.match(/CYCLE[_\-\s]?([A-Za-z0-9]+)/i);
    if (c) out.cycle = c[1];
    return out;
  }

  /** 日本時間の今日(YYYY-MM-DD)。端末タイムゾーンに依存しない。 */
  function todayJst(nowMs) {
    var d = new Date((nowMs === undefined ? Date.now() : nowMs) + 9 * 3600 * 1000);
    return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2);
  }

  function cellStr(v) { return v === null || v === undefined ? '' : toHalf(v).trim(); }

  function findColumns(rows) {
    // 先頭10行からヘッダー行を探す（通常は2行目）。列番号は固定しない。
    for (var r = 0; r < Math.min(rows.length, 10); r++) {
      var row = rows[r] || [], cols = {};
      for (var c = 0; c < row.length; c++) {
        var h = cellStr(row[c]).toLowerCase().replace(/\s+/g, ' ');
        if (h === 'tracking id' || h === 'trackingid') cols.tid = c;
        else if (h === 'address') cols.addr = c;
        else if (h === 'postal' || h === 'postal code' || h === 'zip' || h === 'zip code') cols.postal = c;
        else if (h === 'stop' || h === 'stop #' || h === 'stop no') cols.stop = c;
      }
      if (cols.tid !== undefined && cols.addr !== undefined) { cols.headerRow = r; return cols; }
    }
    return null;
  }

  function routeFromSheet(name, rows) {
    var m = String(name).match(/^sequencedRoute_(.+)$/i);
    var route = m ? m[1] : '';
    if (!route && rows && rows[0] && rows[0][0]) {
      var m2 = cellStr(rows[0][0]).match(/^Route for\s+(\S+)/i);
      if (m2) route = m2[1];
    }
    route = route.trim();
    return route && route.length <= LIMITS.maxRouteLen ? route : '';
  }

  /**
   * SheetJSのworkbookからコース別の配送先を取り出す。
   * XLSX: SheetJSオブジェクト（utils.sheet_to_json / decode_range を使用）。数式は評価しない（キャッシュ値のみ）。
   * 返り値: {ok, error, routes:[{route, rows:[{stop,postal,address}]}], sheetsSkipped, noAddress}
   */
  function extractManifest(XLSX, wb) {
    var names = wb.SheetNames || [];
    if (names.length > LIMITS.maxSheets) return { ok: false, error: 'シート数が多すぎます' };
    var routes = [], seen = {}, skipped = 0, noAddress = 0, valid = 0, dup = 0;
    for (var i = 0; i < names.length; i++) {
      var ws = wb.Sheets[names[i]];
      if (!ws || !ws['!ref']) { skipped++; continue; }
      var rg = XLSX.utils.decode_range(ws['!ref']);
      if (rg.e.r - rg.s.r + 1 > LIMITS.maxRowsPerSheet) return { ok: false, error: '行数が上限(' + LIMITS.maxRowsPerSheet + ')を超えるシートがあります' };
      var rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '', blankrows: false });
      var route = routeFromSheet(names[i], rows);
      var cols = route ? findColumns(rows) : null;
      if (!route || !cols) { skipped++; continue; }
      if (seen[route]) { dup++; continue; }
      seen[route] = true;
      var out = [];
      for (var r = cols.headerRow + 1; r < rows.length; r++) {
        var row = rows[r] || [];
        if (!cellStr(row[cols.tid])) continue; // Tracking ID無し（拠点住所・空行等）は対象外
        var addr = cellStr(row[cols.addr]);
        if (!addr) { noAddress++; continue; }
        var stopN = cols.stop === undefined ? NaN : parseInt(cellStr(row[cols.stop]), 10);
        out.push({
          stop: isNaN(stopN) ? null : stopN,
          postal: cols.postal === undefined ? '' : cellStr(row[cols.postal]),
          address: addr
        });
        if (++valid > LIMITS.maxValidRows) return { ok: false, error: '有効配送件数が上限を超えています' };
      }
      routes.push({ route: route, rows: out });
    }
    if (!routes.length) return { ok: false, error: 'マニフェストのコースシート(sequencedRoute_*)が見つかりません' };
    return { ok: true, routes: routes, sheetsSkipped: skipped, noAddress: noAddress, duplicateRoutes: dup };
  }

  // ---------------------------------------------------------------- インデックス

  /** extractManifest の結果から検索用インデックスを作る。元の住所全文・Tracking IDは保持しない。 */
  function buildIndex(extracted) {
    var chomeTowns = {}, parsed = [], i, j;
    for (i = 0; i < extracted.routes.length; i++) {
      var R = extracted.routes[i];
      for (j = 0; j < R.rows.length; j++) {
        var p = parseAddress(R.rows[j].address);
        if (p.ok && isChomeEvidence(p)) chomeTowns[townKey(p)] = true;
        parsed.push({ route: R.route, row: R.rows[j], p: p });
      }
    }
    var byBase = {}, list = [], unparsed = 0;
    for (i = 0; i < parsed.length; i++) {
      var it = parsed[i], postal = normalizePostal(it.row.postal) || it.p.postal;
      // 住所構造(市区町村/町域)を解析できない行は検索対象から除外（郵便番号だけでは候補にしない）
      if (!it.p.ok) { unparsed++; continue; }
      var a = resolveParts(it.p, chomeTowns);
      var key = it.route + '#' + baseKey(a);
      var rec = byBase[key];
      if (!rec) {
        rec = byBase[key] = {
          route: it.route, pref: a.pref, gun: a.gun, via: it.p.via, muni: a.muni, town: a.town, chome: a.chome, banchi: a.banchi, go: a.go,
          key: baseKey(a), display: formatBase(a), postal: postal, stop: it.row.stop, packages: 0
        };
        list.push(rec);
      }
      rec.packages++;
      if (!rec.pref && a.pref) rec.pref = a.pref;
      if (!rec.gun && a.gun) rec.gun = a.gun;
      if (it.row.stop !== null && (rec.stop === null || it.row.stop < rec.stop)) rec.stop = it.row.stop;
    }
    var routeSet = {};
    for (i = 0; i < list.length; i++) routeSet[list[i].route] = true;
    return {
      records: list, chomeTowns: chomeTowns, unparsed: unparsed,
      routeCount: extracted.routes.length, validCount: parsed.length,
      baseCount: list.length, routesWithData: Object.keys(routeSet).length
    };
  }

  // ---------------------------------------------------------------- 検索

  function levelOf(q, rec) {
    // 町名一致が前提（市区町村・町名が異なれば LEVEL1〜5 には絶対にならない）
    if (q.pref && rec.pref && q.pref !== rec.pref) return null; // 都道府県が明確に異なれば別地域
    if (q.gun && rec.gun && q.gun !== rec.gun) return null;     // 郡が明確に異なれば別自治体
    if (q.muni && q.town && rec.muni === q.muni && rec.town === q.town) {
      if (rec.chome === q.chome && rec.banchi === q.banchi && rec.go === q.go && q.banchi !== null) return { level: 1, diff: 0 };
      // 丁目が無い町域は「丁目なし同士」を同一丁目扱いにする
      if (rec.chome === q.chome) {
        if (q.banchi !== null && rec.banchi === q.banchi) return { level: 2, diff: 0 };
        if (q.banchi !== null && rec.banchi !== null) {
          var d = Math.abs(rec.banchi - q.banchi);
          if (d <= LIMITS.nearBanchiMax) return { level: 3, diff: d };
        }
        return { level: 4, diff: q.banchi !== null && rec.banchi !== null ? Math.abs(rec.banchi - q.banchi) : Infinity };
      }
      return { level: 5, diff: Infinity };
    }
    return null;
  }

  /**
   * 近隣コース検索。postalInput は互換のため受け取るが候補判定には使わない（郵便番号のみ一致の候補表示は無効）。
   * opts.limit: 返す候補数（既定3。検証スクリプトは Infinity を指定）。
   */
  function search(index, addressInput, postalInput, opts) {
    var limit = opts && opts.limit ? opts.limit : 3;
    var res = { ok: true, query: null, candidates: [], note: '' };
    var p = parseAddress(addressInput);
    // In a single-prefecture manifest, retry omitted-prefecture queries with
    // that known context, never override an explicitly supplied prefecture.
    if (!p.pref && index.records.length) {
      var known = index.records[0].pref;
      if (known && index.records.every(function(r){return r.pref === known;})) {
        var retry = parseAddress(known + ', ' + addressInput);
        if (retry.ok) p = retry;
      }
    }
    if (!p.ok) {
      return { ok: false, error: '住所から市区町村・町名を判別できません。都道府県または市区町村から入力してください', candidates: [] };
    }
    var q = resolveParts(p, index.chomeTowns);
    res.query = { display: formatBase(q) };

    // コース単位に集約
    var courses = {}, i, rec, lv;
    for (i = 0; i < index.records.length; i++) {
      rec = index.records[i];
      lv = levelOf(q, rec); // 住所構造の一致のみで判定（郵便番号は使わない）
      if (!lv) continue;
      var c = courses[rec.route] || (courses[rec.route] = {
        route: rec.route, level: 99, diff: Infinity, goDiff: Infinity, best: null,
        sameBanchi: 0, sameChome: 0, sameTown: 0
      });
      var sameTown = p.ok && rec.muni === q.muni && rec.town === q.town && !(q.pref && rec.pref && q.pref !== rec.pref) && !(q.gun && rec.gun && q.gun !== rec.gun);
      if (sameTown) {
        c.sameTown++;
        if (rec.chome === q.chome) c.sameChome++;
        if (q.banchi !== null && rec.banchi === q.banchi && rec.chome === q.chome) c.sameBanchi++;
      }
      var goDiff = q.go !== null && rec.go !== null ? Math.abs(rec.go - q.go) : Infinity;
      var better = lv.level < c.level || (lv.level === c.level && (lv.diff < c.diff ||
        (lv.diff === c.diff && (goDiff < c.goDiff || (goDiff === c.goDiff && rec.stop !== null && (c.best.stop === null || rec.stop < c.best.stop))))));
      if (better) { c.level = lv.level; c.diff = lv.diff; c.goDiff = goDiff; c.best = rec; }
    }
    var arr = Object.keys(courses).map(function (k) { return courses[k]; });
    if (!arr.length) { res.note = 'none'; return res; }

    function areaCount(c) {
      if (c.level <= 2) return c.sameBanchi;
      if (c.level <= 4) return c.sameChome;
      return c.sameTown;
    }
    arr.sort(function (a, b) {
      if (a.level !== b.level) return a.level - b.level;
      if (a.diff !== b.diff) return a.diff - b.diff;
      if (a.goDiff !== b.goDiff) return a.goDiff - b.goDiff;
      var ca = areaCount(a), cb = areaCount(b);
      if (ca !== cb) return cb - ca;
      return a.route < b.route ? -1 : a.route > b.route ? 1 : 0;
    });

    res.candidates = arr.slice(0, limit).map(function (c, idx) {
      var next = arr[idx + 1], prev = arr[idx - 1];
      function same(x, y) { return x && y && x.level === y.level && x.diff === y.diff && x.goDiff === y.goDiff && areaCount(x) === areaCount(y); }
      return {
        rank: idx + 1, route: c.route, baseKey: c.best.key, level: c.level, levelLabel: LEVEL_LABEL[c.level],
        bestAddress: c.best.display, stop: c.best.stop,
        sameBanchi: c.sameBanchi, sameChome: c.sameChome, sameTown: c.sameTown,
        banchiDiff: c.diff === Infinity ? null : c.diff,
        tie: same(c, next) || same(c, prev),
        reason: reasonFor(c)
      };
    });
    return res;
  }

  function reasonFor(c) {
    var s;
    switch (c.level) {
      case 1: s = '同じ基本住所に配送先が存在します'; break;
      case 2: s = '同一番地に配送先が存在します'; break;
      case 3: s = '同一丁目内で番地番号が近い(差' + c.diff + ')配送先が存在します'; break;
      case 4: s = '同一丁目に配送先が存在します'; break;
      case 5: s = '同一町名に配送先が存在します（丁目は異なる／不明）'; break;
    }
    if (c.level <= 4 && c.sameChome > 1) s += '。同一丁目の配送先も' + c.sameChome + '件あります';
    else if (c.level === 5 && c.sameTown > 1) s += '。同一町名の配送先は' + c.sameTown + '件です';
    return s + '。';
  }

  /**
   * インデックス済み配送先の「正規形」クエリ（丁目/番/号の単位付き・Amazon形式）。
   * formatBase(表示用)は単位・郡・都道府県を落とす非可逆表現のため、検証にはこちらを使う。
   * 例: 香椎駅前2丁目15番8号, 福岡市東区, 福岡県
   */
  function canonicalQuery(rec) {
    var t = rec.town;
    if (rec.chome !== null) t += rec.chome + '丁目';
    if (rec.banchi !== null) t += rec.banchi + '番';
    if (rec.go !== null) t += rec.go + '号';
    return t + ', ' + (rec.gun || '') + rec.muni + (rec.pref ? ', ' + rec.pref : '');
  }

  // 区切り(セグメント)ごとの種別記号。住所の文字列は含めず、構造のパターンだけを表す。
  //  P=都道府県(正式) p=都道府県(略称) C=国名 Z=郵便番号様 L=英字のみ S=市区町村様(市/区/郡〇町村で終わる)
  //  W=町村で終わる M=先頭に市区町村様+後続テキスト N=数字で始まる D=数字を含む A=その他(数字なし)
  function segClass(x) {
    var t = x.replace(/\s+/g, '');
    if (PREFECTURES.indexOf(t) >= 0) return 'P';
    if (prefOf(t)) return 'p';
    if (/^(日本|japan|jp)$/i.test(t)) return 'C';
    if (/^\d{3}-?\d{4}$/.test(t)) return 'Z';
    if (/[A-Za-z]/.test(t) && !/[぀-ヿ一-鿿]/.test(t)) return 'L';
    if (!/\d/.test(t) && /([市区]|郡.+[町村])$/.test(t)) return 'S';
    if (!/\d/.test(t) && /[町村]$/.test(t)) return 'W';
    if (/^(.+?郡.+?[町村]|.+?市([^市郡]{1,4}?区)?|[^市郡]{1,4}?区).+/.test(t)) return 'M';
    if (/^\d/.test(t)) return 'N';
    if (/\d/.test(t)) return 'D';
    return 'A';
  }

  function bucketLen(n) { return n === 0 ? '0' : n <= 2 ? '1-2' : n <= 6 ? '3-6' : n <= 12 ? '7-12' : n <= 20 ? '13-20' : '21+'; }
  function bucketN(n) { return n >= 5 ? '5+' : String(n); }

  /**
   * 住所1件の構造診断（診断モード用）。返すのは列挙値・真偽・件数のみで、住所の文字列は一切含めない。
   */
  function explainAddress(raw) {
    var p = parseAddress(raw);
    var s = toHalf(raw === null || raw === undefined ? '' : raw).trim();
    var pm = s.match(/^〒?\s*(\d{3}-?\d{4})\s*/);
    var body = pm ? s.slice(pm[0].length) : s;
    var rc = reorderComma(body);
    var parts = body.split(/\s*[,、]\s*/).filter(function (x) { return x; });
    var prefForm = 'none', i;
    for (i = 0; i < parts.length; i++) {
      if (PREFECTURES.indexOf(parts[i]) >= 0) prefForm = 'full';
      else if (prefOf(parts[i])) prefForm = prefForm === 'full' ? 'full' : 'abbr';
    }
    if (prefForm === 'none' && takePrefecture(body).pref) prefForm = 'embedded';
    var street = rc ? rc.street : body;
    var munisrc = rc ? rc.muni : p.muni;
    var suffix = munisrc ? munisrc.replace(/\s+/g, '').slice(-1) : '';
    return {
      ok: p.ok, reason: p.reason || '',
      f: {
        commaCount: bucketN((s.match(/[,、]/g) || []).length),
        partCount: bucketN(parts.length),
        prefForm: prefForm,
        muniSource: rc ? (rc.muni ? 'comma_' + rc.muniKind + '_' + rc.muniPos : 'comma_none') : (p.muni ? 'regex' : 'none'),
        muniSuffix: /[市区町村]/.test(suffix) ? suffix : (suffix ? 'other' : 'none'),
        muniLen: bucketLen(munisrc ? munisrc.replace(/\s+/g, '').length : 0),
        townLen: bucketLen(p.town ? p.town.length : 0),
        digitBlocks: bucketN((street.match(/\d+/g) || []).length),
        startsWithDigit: /^\s*\d/.test(street),
        noDigits: !/\d/.test(street),
        hasTailAfterNumbers: !!p.hasTail,
        hasKanjiNumeral: /[〇一二三四五六七八九十百]/.test(street),
        hasLatin: /[A-Za-z]/.test(street),
        hasParen: /[()\[\]【】「」]/.test(body),
        hasPostalInAddress: !!pm,
        hasCountryToken: /(^|[,、]\s*)(日本|japan|jp)\s*($|[,、])/i.test(body),
        hasUnitMarks: /(丁目|番地|番|号)/.test(street),
        muniHasLatin: /[A-Za-z]/.test(munisrc || ''),
        muniHasKana: /[぀-ヿ]/.test(p.muni || ''),
        muniHasBuildingWord: /(ビル|マンション|ハイツ|コーポ|荘|棟|館|センター|アパート|ハウス)/.test(p.muni || '')
      },
      sig: parts.map(segClass).join('|'),
      via: p.via || '',
      shape: p.ok ? ((p.nums && p.nums[0] !== null ? 'C' : '-') + (p.nums && p.nums[1] !== null ? 'B' : '-') + (p.nums && p.nums[2] !== null ? 'G' : '-') + (p.explicit ? 'x' : 'i')) : ''
    };
  }

  var api = {
    LIMITS: LIMITS, LEVEL_LABEL: LEVEL_LABEL,
    parseAddress: parseAddress, resolveParts: resolveParts, normalizePostal: normalizePostal,
    inspectZip: inspectZip, parseFileName: parseFileName, todayJst: todayJst,
    extractManifest: extractManifest, buildIndex: buildIndex, search: search,
    canonicalQuery: canonicalQuery, explainAddress: explainAddress, formatBase: formatBase, baseKeyOf: baseKey
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.NearbyCourseCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
