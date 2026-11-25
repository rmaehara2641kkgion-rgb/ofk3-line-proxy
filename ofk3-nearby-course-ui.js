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
  var importGeneration = 0;
  var importing = false;

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

    // --- 取込エリア（ドラッグ＆ドロップ領域 + ファイル選択ボタン。どちらも同じ importFile() を使う）
    var imp = el('div', 'mb-4 p-3 rounded-lg border border-gray-200');
    els.file = el('input'); els.file.type = 'file'; els.file.accept = '.xlsx';
    els.file.style.display = 'none';
    els.zone = el('div', 'text-center rounded-lg cursor-pointer');
    els.zone.tabIndex = 0;
    els.zone.setAttribute('role', 'button');
    els.zone.setAttribute('aria-label', 'マニフェストExcelをドロップ、またはクリックしてファイルを選択');
    zoneStyle('idle');
    els.zone.appendChild(el('div', 'text-3xl mb-1', '📂'));
    els.zone.appendChild(el('p', 'text-sm font-bold', 'マニフェストExcel(xlsx)をここにドラッグ＆ドロップ'));
    els.zone.appendChild(el('p', 'text-xs text-ink-lighter mt-1', 'またはクリックしてファイルを選択（選択・ドロップすると自動で取込みます）'));
    imp.appendChild(els.zone);
    var row = el('div', 'flex flex-wrap items-center gap-2 mt-2');
    els.importBtn = el('button', 'px-3 py-2 bg-blue-500 text-white rounded-lg text-xs font-bold hover:bg-blue-600', '取込（ファイルを選択）');
    els.importBtn.type = 'button';
    els.clearBtn = el('button', 'px-3 py-2 bg-white border border-border rounded-lg text-xs font-medium hover:bg-gray-50', 'データクリア');
    els.clearBtn.type = 'button';
    row.appendChild(els.importBtn); row.appendChild(els.clearBtn); row.appendChild(els.file);
    imp.appendChild(row);
    els.msg = el('div', 'text-sm font-bold rounded-lg mt-2');
    els.msg.setAttribute('role', 'status');
    els.msg.style.display = 'none';
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
    els.addr.type = 'text'; els.addr.autocomplete = 'off'; els.addr.spellcheck = false;
    els.addr.placeholder = '例: 福岡県福岡市東区香椎駅前2-15-8';
    els.addr.maxLength = 200;
    q.appendChild(els.addr);
    var r2 = el('div', 'flex flex-wrap items-center gap-2 mt-2');
    els.postal = el('input', 'px-3 py-2 border border-gray-300 rounded-lg text-sm w-40');
    els.postal.type = 'text'; els.postal.placeholder = '郵便番号（任意・候補判定には不使用）'; els.postal.maxLength = 10;
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

    wireImport();
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

  // 画面の表示状態: kind = ok | warn | error | busy
  function setMsg(text, kind) {
    var m = els.msg;
    m.textContent = text || '';
    if (!text) { m.style.display = 'none'; return; }
    var c = kind === 'error' ? ['#991b1b', '#fef2f2', '#fca5a5'] : kind === 'warn' || kind === 'busy' ? ['#92400e', '#fffbeb', '#fcd34d'] : ['#065f46', '#ecfdf5', '#6ee7b7'];
    m.style.display = 'block';
    m.style.color = c[0]; m.style.background = c[1]; m.style.border = '1px solid ' + c[2]; m.style.padding = '8px 12px';
    m.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  }

  // ドロップ領域の見た目: idle | drag（ドラッグ中: 枠線と背景色を変える） | busy
  function zoneStyle(mode) {
    var st = els.zone.style;
    st.padding = '18px 12px';
    st.border = '2px dashed ' + (mode === 'drag' ? '#2563eb' : mode === 'busy' ? '#d97706' : '#9ca3af');
    st.background = mode === 'drag' ? '#dbeafe' : mode === 'busy' ? '#fffbeb' : '#f9fafb';
    st.transition = 'background .1s, border-color .1s';
  }

  function setBusy(b) {
    importing = b;
    els.importBtn.disabled = b;
    els.searchBtn.disabled = b;
    zoneStyle(b ? 'busy' : 'idle');
  }

  /** 共通取込処理: ファイル選択・ドロップ・ボタンのすべてがここを通る。失敗時は必ず画面にエラーを表示する。 */
  function importFile(f, note) {
    note = note ? ' ' + note : '';
    if (!f) { els.file.click(); return; }
    if (!/\.xlsx$/i.test(f.name)) { setMsg('取込失敗: xlsxファイルのみ取り込めます（既存データは維持されています）', 'error'); return; }
    if (!f.size) { setMsg('取込失敗: ファイルが空です（既存データは維持されています）', 'error'); return; }
    if (f.size > Core.LIMITS.maxFileBytes) { setMsg('取込失敗: ファイルサイズが大きすぎます（上限 ' + Math.round(Core.LIMITS.maxFileBytes / 1048576) + 'MB）（既存データは維持されています）', 'error'); return; }
    if (typeof XLSX === 'undefined') { setMsg('取込失敗: Excel読込ライブラリが利用できません', 'error'); return; }
    var generation = ++importGeneration;
    setBusy(true);
    els.clearBtn.disabled = false;
    setMsg('読込中… ' + f.name + note, 'busy');
    function fail(text) {
      if (generation !== importGeneration) return;
      setBusy(false); renderStatus();
      setMsg('取込失敗: ' + text + '（既存データは維持されています）' + note, 'error');
    }
    var reader;
    try { reader = new FileReader(); } catch (err) { fail('ファイルを読み込めません'); return; }
    reader.onerror = function () { fail('ファイルを読み込めませんでした'); };
    reader.onabort = function () { fail('ファイルの読込が中断されました'); };
    reader.onload = function (e) {
      if (generation !== importGeneration) return;
      // 「読込中」表示を描画させてから解析する（大きなファイルで画面が固まって見えないように）
      setTimeout(function () {
        if (generation !== importGeneration) return;
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
          if (!idx.records.length) throw new Error('住所を解析できた配送先が1件もありません（住所形式を確認してください）');
          if (idx.unparsed) warnings.push('⚠ 住所の市区町村・町域を解析できない' + idx.unparsed + '件（有効' + idx.validCount + '件中）は検索対象から除外しました。');
          next = { fileName: f.name, date: meta.date, cycle: meta.cycle, importedAt: jstNowText(), index: idx, warnings: warnings };
        } catch (err) {
          fail(err && err.message ? err.message : '不明なエラー');
          return;
        }
        state = next; // 正常に解析できた場合のみ置換
        els.results.textContent = '';
        setBusy(false);
        setMsg((next.warnings.length ? '取込完了（要確認あり）: ' : '取込完了: ') + next.fileName + note, next.warnings.length ? 'warn' : 'ok');
        renderStatus();
      }, 30);
    };
    try { reader.readAsArrayBuffer(f); } catch (err) { fail('ファイルを読み込めません'); }
  }

  function hasFiles(ev) {
    var dt = ev && ev.dataTransfer;
    if (!dt || !dt.types) return false;
    for (var i = 0; i < dt.types.length; i++) if (dt.types[i] === 'Files') return true;
    return false;
  }

  function wireImport() {
    // ファイル選択: 選択したら自動で取込。同じファイルを選び直しても反応するよう、毎回 value を空にする
    els.file.addEventListener('change', function () {
      var f = els.file.files && els.file.files[0];
      els.file.value = '';
      if (f) importFile(f);
    });
    els.importBtn.addEventListener('click', function () { els.file.click(); });
    els.zone.addEventListener('click', function () { els.file.click(); });
    els.zone.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.file.click(); }
    });
    // ドラッグ＆ドロップ（領域内）
    ['dragenter', 'dragover'].forEach(function (t) {
      els.zone.addEventListener(t, function (e) {
        if (!hasFiles(e)) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        if (!importing) zoneStyle('drag');
      });
    });
    els.zone.addEventListener('dragleave', function (e) {
      if (e.relatedTarget && els.zone.contains(e.relatedTarget)) return;
      zoneStyle(importing ? 'busy' : 'idle');
    });
    els.zone.addEventListener('drop', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      zoneStyle(importing ? 'busy' : 'idle');
      var fl = e.dataTransfer.files;
      if (!fl || !fl.length) return;
      importFile(fl[0], fl.length > 1 ? '※複数ファイルがドロップされたため、最初の1ファイルのみ取り込みました' : '');
    });
    // 領域外にドロップしてもブラウザがExcelを直接開かないようにする（住所検索タブ表示中のみ）
    var panel = document.getElementById('panel-addr-search');
    function panelVisible() { return !!panel && panel.offsetParent !== null; }
    document.addEventListener('dragover', function (e) {
      if (hasFiles(e) && panelVisible()) { e.preventDefault(); if (e.dataTransfer && !els.zone.contains(e.target)) e.dataTransfer.dropEffect = 'none'; }
    });
    document.addEventListener('drop', function (e) {
      if (hasFiles(e) && panelVisible()) e.preventDefault(); // 領域内のドロップは zone の drop ハンドラが処理する
    });
  }

  function clearAll() {
    ++importGeneration;
    setBusy(false);
    els.addr.value = '';
    els.postal.value = '';
    state = null;
    els.results.textContent = '';
    setMsg('データをクリアしました', 'ok');
    renderStatus();
  }

  function renderStatus() {
    els.status.textContent = '';
    if (!state) { els.status.classList.add('hidden'); els.clearBtn.disabled = !importing; return; }
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
    if (importing) return;
    els.results.textContent = '';
    if (!state) { setMsg('先にマニフェストを取り込んでください', 'error'); return; }
    var addr = els.addr.value.trim();
    if (!addr) { setMsg('配送先住所を入力してください', 'error'); return; }
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
    if (c.tie) h.appendChild(el('span', 'text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-700', '同等の候補あり'));
    d.appendChild(h);
    function line(k, v) {
      var p = el('p', 'text-sm');
      p.appendChild(el('span', 'text-ink-lighter', k + '：'));
      p.appendChild(el('span', 'font-medium', v));
      d.appendChild(p);
    }
    line('住所一致', 'LEVEL ' + c.level + '（' + c.levelLabel + '）');
    line('照合候補住所', c.bestAddress);
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
