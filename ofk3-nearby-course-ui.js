/**
 * OFK3 追加荷物・近隣コース検索 — UI（住所検索タブ内に挿入）
 *
 * - 管理者が手動で選んだマニフェスト(xlsx)をブラウザ内だけで解析する。外部通信・ログ出力なし。
 * - データはメモリ保持のみ（ページ再読込で消える）。localStorage/サーバーには保存しない。
 * - 画面描画は textContent / createElement のみ（HTMLインジェクション対策）。
 * - 既存の住所検索（DA番号検索・daAddressMap）には一切触れない。
 */
(function () {
  'use strict';
  var Core = window.NearbyCourseCore;
  if (!Core) return;

  var state = null; // {fileName, date, cycle, importedAt, index, warnings}
  var els = {};

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  function jstNowText() {
    var d = new Date(Date.now() + 9 * 3600 * 1000);
    function p(n) { return ('0' + n).slice(-2); }
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ' (JST)';
  }

  function build() {
    var panel = document.getElementById('panel-addr-search');
    if (!panel || document.getElementById('nearby-course-card')) return;

    var card = el('div', 'card p-6 mb-4');
    card.id = 'nearby-course-card';
    card.appendChild(el('h3', 'text-base font-bold mb-1', '📦 追加荷物・近隣コース検索'));
    card.appendChild(el('p', 'text-xs text-ink-lighter mb-3',
      '本日のマニフェストに無い荷物の配送先住所から、近隣住所を配送するコースを探します。データはこのブラウザ内のみで処理し、外部へ送信しません。'));

    // --- 取込エリア
    var imp = el('div', 'mb-4 p-3 rounded-lg border border-gray-200');
    var row = el('div', 'flex flex-wrap items-center gap-2');
    els.file = el('input'); els.file.type = 'file'; els.file.accept = '.xlsx';
    els.file.className = 'text-xs';
    els.importBtn = el('button', 'px-3 py-2 bg-blue-500 text-white rounded-lg text-xs font-bold hover:bg-blue-600', '取込');
    els.importBtn.type = 'button';
    els.clearBtn = el('button', 'px-3 py-2 bg-white border border-border rounded-lg text-xs font-medium hover:bg-gray-50', 'データクリア');
    els.clearBtn.type = 'button';
    row.appendChild(els.file); row.appendChild(els.importBtn); row.appendChild(els.clearBtn);
    imp.appendChild(row);
    els.msg = el('p', 'text-xs mt-2');
    imp.appendChild(els.msg);
    els.status = el('dl', 'grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-1 text-xs mt-2 hidden');
    imp.appendChild(els.status);
    imp.appendChild(el('p', 'text-xs text-ink-lighter mt-2',
      '※ 管理者が正規の手順でダウンロードしたマニフェスト(xlsx)のみ使用します。取込データはメモリ上のみで、ページ再読込でも消えます（再度取込が必要）。'));
    card.appendChild(imp);

    // --- 検索エリア
    var q = el('div', 'mb-4');
    q.appendChild(el('label', 'text-xs font-bold text-ink mb-1 block', '追加荷物の配送先住所'));
    els.addr = el('input', 'w-full text-base px-4 py-3 border-2 border-blue-300 rounded-xl focus:border-blue-500 outline-none');
    els.addr.type = 'text'; els.addr.autocomplete = 'off';
    els.addr.placeholder = '例: 福岡県福岡市東区香椎駅前2-15-8';
    els.addr.maxLength = 200;
    q.appendChild(els.addr);
    var r2 = el('div', 'flex flex-wrap items-center gap-2 mt-2');
    els.postal = el('input', 'px-3 py-2 border border-gray-300 rounded-lg text-sm w-40');
    els.postal.type = 'text'; els.postal.placeholder = '郵便番号（任意）'; els.postal.maxLength = 10;
    els.searchBtn = el('button', 'px-5 py-2 bg-emerald-600 text-white rounded-lg text-sm font-bold hover:bg-emerald-700', '検索');
    els.searchBtn.type = 'button';
    els.resetBtn = el('button', 'px-3 py-2 bg-white border border-border rounded-lg text-xs font-medium hover:bg-gray-50', '入力クリア');
    els.resetBtn.type = 'button';
    r2.appendChild(els.postal); r2.appendChild(els.searchBtn); r2.appendChild(els.resetBtn);
    q.appendChild(r2);
    card.appendChild(q);

    els.results = el('div');
    card.appendChild(els.results);

    panel.insertBefore(card, panel.firstChild);

    els.importBtn.addEventListener('click', doImport);
    els.clearBtn.addEventListener('click', clearAll);
    els.searchBtn.addEventListener('click', doSearch);
    els.resetBtn.addEventListener('click', function () {
      els.addr.value = ''; els.postal.value = ''; els.results.textContent = ''; els.addr.focus();
    });
    function enter(e) { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } }
    els.addr.addEventListener('keydown', enter);
    els.postal.addEventListener('keydown', enter);
    renderStatus();
  }

  function setMsg(text, kind) {
    els.msg.textContent = text || '';
    els.msg.style.color = kind === 'error' ? '#b91c1c' : kind === 'warn' ? '#b45309' : '#047857';
  }

  function doImport() {
    var f = els.file.files && els.file.files[0];
    if (!f) { setMsg('取り込むマニフェスト(xlsx)を選択してください', 'error'); return; }
    if (!/\.xlsx$/i.test(f.name)) { setMsg('xlsxファイルのみ取り込めます', 'error'); return; }
    if (f.size > Core.LIMITS.maxFileBytes) { setMsg('ファイルサイズが大きすぎます（上限 ' + Math.round(Core.LIMITS.maxFileBytes / 1048576) + 'MB）', 'error'); return; }
    if (typeof XLSX === 'undefined') { setMsg('Excel読込ライブラリが利用できません', 'error'); return; }
    setMsg('読込中…', 'warn');
    var reader = new FileReader();
    reader.onerror = function () { setMsg('ファイルを読み込めませんでした（既存データは維持されています）', 'error'); };
    reader.onload = function (e) {
      var next;
      try {
        var bytes = new Uint8Array(e.target.result);
        var z = Core.inspectZip(bytes);
        if (!z.ok) throw new Error(z.error);
        // 数式は評価せず、書式・HTML・VBA等は読まない（キャッシュ値のみ）
        var wb = XLSX.read(bytes, { type: 'array', cellFormula: false, cellHTML: false, cellStyles: false, cellNF: false, bookVBA: false });
        var ex = Core.extractManifest(XLSX, wb);
        wb = null;
        if (!ex.ok) throw new Error(ex.error);
        var idx = Core.buildIndex(ex);
        if (!idx.validCount) throw new Error('有効な配送データ（Tracking IDあり）が1件もありません');
        var meta = Core.parseFileName(f.name);
        var warnings = [];
        var today = Core.todayJst();
        if (!meta.date) warnings.push('ファイル名から対象配送日を特定できません。本日のマニフェストか確認してください。');
        else if (meta.date < today) warnings.push('⚠ 過去日付(' + meta.date + ')のマニフェストです。本日(' + today + ')のものか確認してください。');
        else if (meta.date > today) warnings.push('対象配送日(' + meta.date + ')が本日(' + today + ')と異なります。');
        if (ex.sheetsSkipped) warnings.push('コースとして読めないシートを' + ex.sheetsSkipped + '件スキップしました。');
        if (ex.noAddress) warnings.push('住所が空の配送行 ' + ex.noAddress + '件は検索対象外です。');
        if (idx.unparsed) warnings.push('住所を解析できない行が' + idx.unparsed + '件あります（郵便番号一致のみ対象）。');
        next = { fileName: f.name, date: meta.date, cycle: meta.cycle, importedAt: jstNowText(), index: idx, warnings: warnings };
      } catch (err) {
        setMsg('取込失敗: ' + (err && err.message ? err.message : '不明なエラー') + '（既存データは維持されています）', 'error');
        return;
      }
      state = next; // 正常に解析できた場合のみ置換
      els.results.textContent = '';
      els.file.value = '';
      setMsg(next.warnings.length ? '取込完了（要確認あり）' : '取込完了', next.warnings.length ? 'warn' : 'ok');
      renderStatus();
    };
    reader.readAsArrayBuffer(f);
  }

  function clearAll() {
    state = null;
    els.results.textContent = '';
    els.file.value = '';
    setMsg('データをクリアしました', 'ok');
    renderStatus();
  }

  function renderStatus() {
    els.status.textContent = '';
    if (!state) { els.status.classList.add('hidden'); els.clearBtn.disabled = true; return; }
    els.clearBtn.disabled = false;
    els.status.classList.remove('hidden');
    function item(k, v) {
      var d = el('div');
      d.appendChild(el('dt', 'text-ink-lighter', k));
      d.appendChild(el('dd', 'font-bold', v));
      els.status.appendChild(d);
    }
    item('取込済みファイル', state.fileName);
    item('対象配送日', state.date || '不明');
    item('CYCLE', state.cycle || '不明');
    item('取込時刻', state.importedAt);
    item('取込コース数', String(state.index.routeCount));
    item('有効配送件数', String(state.index.validCount));
    for (var i = 0; i < state.warnings.length; i++) {
      var w = el('p', 'text-xs font-bold col-span-full', state.warnings[i]);
      w.style.color = '#b45309';
      els.status.appendChild(w);
    }
  }

  function doSearch() {
    els.results.textContent = '';
    if (!state) { setMsg('先にマニフェストを取り込んでください', 'error'); return; }
    var addr = els.addr.value.trim();
    if (!addr && !els.postal.value.trim()) { setMsg('配送先住所を入力してください', 'error'); return; }
    setMsg('', 'ok');
    var r = Core.search(state.index, addr, els.postal.value);
    if (!r.ok) { setMsg(r.error, 'error'); return; }
    renderResults(r);
    els.addr.select();
  }

  function renderResults(r) {
    var box = els.results;
    if (r.query && r.query.display) {
      box.appendChild(el('p', 'text-xs text-ink-lighter mb-2', '照合に使った基本住所: ' + r.query.display));
    }
    if (!r.candidates.length) {
      var none = el('div', 'rounded-xl p-5 text-center font-bold', '該当する近隣コースが見つかりません');
      none.style.background = '#FEF2F2'; none.style.color = '#991b1b';
      box.appendChild(none);
    }
    for (var i = 0; i < r.candidates.length; i++) box.appendChild(card(r.candidates[i]));
    box.appendChild(el('p', 'text-xs text-ink-lighter mt-3', '住所一致度による参考候補です。実際の配送状況を確認して判断してください'));
  }

  function card(c) {
    var top = c.rank === 1;
    var d = el('div', 'rounded-xl p-4 mb-2');
    d.style.border = top ? '3px solid #059669' : '1px solid #d1d5db';
    d.style.background = top ? '#ECFDF5' : '#ffffff';
    var h = el('div', 'flex items-center gap-2 mb-2');
    h.appendChild(el('span', top ? 'text-base font-bold' : 'text-sm font-bold', '【第' + c.rank + '候補】' + c.route));
    if (c.reference) h.appendChild(el('span', 'text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-800', '参考'));
    if (c.tie) h.appendChild(el('span', 'text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-700', '同等の候補あり'));
    d.appendChild(h);
    function line(k, v) {
      var p = el('p', 'text-sm');
      p.appendChild(el('span', 'text-ink-lighter', k + '：'));
      p.appendChild(el('span', 'font-medium', v));
      d.appendChild(p);
    }
    line('住所一致', 'LEVEL ' + c.level + '（' + c.levelLabel + '）');
    line('最寄り候補住所', c.bestAddress);
    if (c.banchiDiff !== null && c.level === 3) line('番地番号の差', String(c.banchiDiff));
    line('同一番地', c.sameBanchi + '件');
    line('同一丁目', c.sameChome + '件');
    line('同一町名', c.sameTown + '件');
    if (c.stop !== null) line('Stop番号', String(c.stop));
    line('推奨理由', c.reason);
    return d;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
