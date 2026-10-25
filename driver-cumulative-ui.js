/**
 * ドライバー別画面「累計データ作成」モードのUI。
 * 計算は driver-cumulative-core.js、xlsx生成は driver-cumulative-xlsx.js に委譲する。
 * 元Excelは読み取り専用（FileReaderで読むだけ）。検証エラー・未確認の警告が残る間は出力できない。
 */
(function () {
  'use strict';

  var core = window.DriverCumulative;
  var writer = window.DriverCumulativeXlsx;
  var state = { base: null, adds: [], plan: null, weekOverrides: {}, manualMappings: {}, baseWeeksOverride: '', ack: false, output: null, role: 'main', rowFilter: 'all', issueFilter: 'all', busy: false };
  var MAX_ROWS = 300;

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmt(v, d) {
    if (v == null) return '<span class="text-ink-lighter">(空欄)</span>';
    if (typeof v !== 'number') return esc(v);
    return Number.isInteger(v) ? v.toLocaleString() : v.toFixed(d == null ? 2 : d);
  }

  function setMode(mode) {
    var cum = mode === 'cumulative';
    $('driver-normal-mode').classList.toggle('hidden', cum);
    $('driver-cumulative-mode').classList.toggle('hidden', !cum);
    $('driver-mode-normal-btn').className = (cum ? 'btn-secondary' : 'btn-primary') + ' text-xs px-3 py-1.5 rounded';
    $('driver-mode-cumulative-btn').className = (cum ? 'btn-primary' : 'btn-secondary') + ' text-xs px-3 py-1.5 rounded';
    if (cum) render();
  }

  function sha256Hex(buf) {
    if (!(window.crypto && window.crypto.subtle)) return Promise.resolve('');
    return window.crypto.subtle.digest('SHA-256', buf).then(function (d) {
      return Array.prototype.map.call(new Uint8Array(d), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    });
  }

  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onerror = function () { reject(new Error('ファイルを読み込めませんでした: ' + file.name)); };
      fr.onload = function () {
        var buf = fr.result;
        sha256Hex(buf).then(function (hash) {
          var wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
          var aoa = {};
          wb.SheetNames.forEach(function (n) { aoa[n] = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: null }); });
          resolve(core.parseWorkbook({ fileName: file.name, fileHash: hash, sheetNames: wb.SheetNames, aoa: aoa }));
        }).catch(reject);
      };
      fr.readAsArrayBuffer(file);
    });
  }

  function invalidate() { state.plan = null; state.output = null; }

  function onBase(ev) {
    var f = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!f) return;
    readFile(f).then(function (p) { state.base = p; invalidate(); render(); })
      .catch(function (e) { alert('基準ファイルを読み込めません: ' + e.message); });
  }

  function onAdds(ev) {
    var files = Array.prototype.slice.call(ev.target.files || []);
    ev.target.value = '';
    Promise.all(files.map(readFile)).then(function (list) {
      list.forEach(function (p) {
        var dup = state.adds.some(function (a) { return a.fileName === p.fileName && a.fileHash === p.fileHash; });
        if (!dup) state.adds.push(p);
      });
      invalidate(); render();
    }).catch(function (e) { alert('追加ファイルを読み込めません: ' + e.message); });
  }

  function removeAdd(i) { state.adds.splice(i, 1); invalidate(); render(); }

  function validate() {
    var opts = {
      weekOverrides: state.weekOverrides, manualMappings: state.manualMappings,
      baseWeeksOverride: state.baseWeeksOverride || '', acknowledgeInsufficientHistory: state.ack
    };
    state.plan = core.planMerge(state.base, state.adds, opts);
    state.output = null;
    render();
  }

  function generate() {
    var plan = state.plan;
    if (!plan || !plan.canGenerate) { alert('先に「データ検証」を実行し、エラー・未確認の警告を解消してください'); return; }
    if (typeof JSZip === 'undefined') { alert('JSZipを読み込めていないためExcelを生成できません'); return; }
    state.busy = true; render();
    var model;
    try {
      model = core.buildOutputModel(plan, {
        nowIso: new Date().toISOString(),
        addedFiles: state.adds.map(function (f) { return { name: f.fileName, hash: f.fileHash }; })
      });
    } catch (e) { state.busy = false; render(); alert('累計データを生成できませんでした: ' + e.message); return; }
    writer.buildXlsx(model, JSZip).then(function (bytes) {
      state.output = { fileName: model.fileName, bytes: bytes };
      state.busy = false; render();
    }).catch(function (e) {
      state.output = null; state.busy = false; render();
      alert('Excelの生成に失敗したため、出力は作成していません: ' + e.message);
    });
  }

  function download() {
    if (!state.output) return;
    var blob = new Blob([state.output.bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = state.output.fileName;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }

  function fileLine(p, extra) {
    var weeks = p.note && p.note.weeks && p.note.weeks.length ? core.weeksLabel(p.note.weeks, '〜') : '(期間不明)';
    var ok = p.ok ? '' : ' <span class="text-accent">読込エラー</span>';
    return '<span class="font-medium">' + esc(p.fileName) + '</span> <span class="text-ink-lighter">/ ' + esc(weeks) + ' / ' +
      (p.main ? p.main.rows.length : 0) + '名</span>' + ok + (extra || '');
  }

  function renderFiles() {
    $('cum-base-name').innerHTML = state.base ? fileLine(state.base) : '<span class="text-ink-lighter">未選択</span>';
    $('cum-add-list').innerHTML = state.adds.length ? state.adds.map(function (p, i) {
      var needWeek = !(p.note && p.note.weeks && p.note.weeks.length);
      var ov = needWeek ? ' <input type="text" class="border border-border rounded px-1 text-xs w-24" placeholder="例: W41" value="' + esc(state.weekOverrides[p.fileName] || '') + '" data-cum-week="' + esc(p.fileName) + '">' : '';
      return '<div class="flex items-center gap-2 text-xs py-0.5">' + fileLine(p, ov) +
        ' <button class="text-ink-lighter hover:text-accent cursor-pointer" data-cum-remove="' + i + '">✕</button></div>';
    }).join('') : '<span class="text-xs text-ink-lighter">未選択（複数選択可）</span>';
    var needBase = state.base && !(state.base.note && state.base.note.weeks && state.base.note.weeks.length);
    $('cum-base-override-wrap').classList.toggle('hidden', !(needBase || state.baseWeeksOverride));
    $('cum-base-override').value = state.baseWeeksOverride;
  }

  function renderStats() {
    var plan = state.plan;
    var s = plan && plan.summary && plan.summary.sheets.main;
    $('cum-stat-period').textContent = plan && plan.periodLabel ? plan.periodLabel : '—';
    $('cum-stat-merge').textContent = s ? s.merged + '名' : '—';
    $('cum-stat-new').textContent = s ? s.added + '名' : '—';
    $('cum-stat-warn').textContent = plan ? plan.warnCount + '件' + (plan.errorCount ? ' / エラー' + plan.errorCount + '件' : '') : '—';
    $('cum-stat-warn').className = 'text-lg font-medium ' + (plan && plan.errorCount ? 'text-accent' : '');
  }

  function renderPreview() {
    var plan = state.plan, box = $('cum-preview');
    if (!plan || !plan.rows) { box.innerHTML = '<p class="text-xs text-ink-lighter p-4">「データ検証」を実行するとプレビューを表示します（エラーがある場合は表示されません）。</p>'; return; }
    var role = state.role, hasMis = role === 'main';
    var rows = plan.rows[role].filter(function (r) {
      if (state.rowFilter === 'merged') return r.fromBase && r.touched;
      if (state.rowFilter === 'new') return !r.fromBase;
      if (state.rowFilter === 'baseOnly') return r.fromBase && !r.touched;
      return true;
    });
    var head = '<tr class="border-b border-border bg-surface text-xs text-ink-lighter"><th class="px-2 py-2 text-left">ドライバー</th><th class="px-2 py-2 text-left">状態</th>' +
      '<th class="px-2 py-2 text-right">統合前 日数</th><th class="px-2 py-2 text-right">統合前 個数</th><th class="px-2 py-2 text-right">追加分 日数</th><th class="px-2 py-2 text-right">追加分 個数</th>' +
      '<th class="px-2 py-2 text-right">統合後 日数</th><th class="px-2 py-2 text-right">統合後 時間(h)</th><th class="px-2 py-2 text-right">統合後 個数</th><th class="px-2 py-2 text-right">個/時</th>' +
      (hasMis ? '<th class="px-2 py-2 text-right">誤配率</th>' : '') + '<th class="px-2 py-2 text-right">配管率%</th></tr>';
    var body = rows.slice(0, MAX_ROWS).map(function (r) {
      var st = !r.fromBase ? '新規' : r.touched ? '統合' : '基準のみ';
      var stc = !r.fromBase ? 'text-emerald-600' : r.touched ? 'text-ink' : 'text-ink-lighter';
      var b = r.before || {}, a = r.added || {}, v = r.v;
      return '<tr class="border-b border-border"><td class="px-2 py-1.5">' + esc(r.name) + '</td><td class="px-2 py-1.5 ' + stc + '">' + st + '</td>' +
        '<td class="px-2 py-1.5 text-right font-mono">' + (r.fromBase ? fmt(b.days) : '—') + '</td><td class="px-2 py-1.5 text-right font-mono">' + (r.fromBase ? fmt(b.pkg) : '—') + '</td>' +
        '<td class="px-2 py-1.5 text-right font-mono">' + (r.touched ? fmt(a.days) : '—') + '</td><td class="px-2 py-1.5 text-right font-mono">' + (r.touched ? fmt(a.pkg) : '—') + '</td>' +
        '<td class="px-2 py-1.5 text-right font-mono">' + fmt(v.days) + '</td><td class="px-2 py-1.5 text-right font-mono">' + fmt(v.hours) + '</td><td class="px-2 py-1.5 text-right font-mono">' + fmt(v.pkg) + '</td>' +
        '<td class="px-2 py-1.5 text-right font-mono">' + fmt(v.pph) + '</td>' + (hasMis ? '<td class="px-2 py-1.5 text-right font-mono">' + fmt(v.mis, 4) + '</td>' : '') +
        '<td class="px-2 py-1.5 text-right font-mono">' + fmt(v.rate) + '</td></tr>';
    }).join('');
    var t = plan.summary.sheets[role];
    function tot(o) { return fmt(o.days) + '日 / ' + fmt(o.pkg) + '個'; }
    box.innerHTML = '<div class="px-3 py-2 text-xs text-ink-lighter border-b border-border">合計（統合前）' + tot(t.before) + '　→　追加分 ' + tot(t.add) + '　→　統合後 <span class="font-medium text-ink">' + tot(t.after) + '</span>' +
      (rows.length > MAX_ROWS ? '　※先頭' + MAX_ROWS + '名のみ表示（出力には全員が含まれます）' : '') + '</div>' +
      '<div class="overflow-x-auto" style="max-height:420px;overflow-y:auto"><table class="w-full text-xs"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>';
  }

  function renderIssues() {
    var plan = state.plan, box = $('cum-issues');
    var list = plan ? plan.issues.filter(function (i) { return state.issueFilter === 'all' ? true : i.level === state.issueFilter; }) : [];
    if (!plan) { box.innerHTML = ''; return; }
    if (!list.length) { box.innerHTML = '<p class="text-xs text-emerald-600 p-3">該当するエラー・警告はありません。</p>'; return; }
    var lv = { error: ['エラー', 'text-accent'], warn: ['警告', 'text-amber-600'], info: ['情報', 'text-ink-lighter'] };
    box.innerHTML = '<div class="overflow-x-auto" style="max-height:320px;overflow-y:auto"><table class="w-full text-xs"><thead><tr class="border-b border-border bg-surface text-ink-lighter">' +
      '<th class="px-2 py-2 text-left">区分</th><th class="px-2 py-2 text-left">対象ファイル</th><th class="px-2 py-2 text-left">対象ドライバー</th><th class="px-2 py-2 text-left">問題項目</th><th class="px-2 py-2 text-left">原因</th><th class="px-2 py-2 text-left">手動確認</th></tr></thead><tbody>' +
      list.slice(0, MAX_ROWS).map(function (i) {
        var l = lv[i.level] || lv.info;
        var act = '';
        if (i.code === 'NAME_AMBIGUOUS' && i.candidates && i.candidates.length === 1) {
          act = '<label class="cursor-pointer"><input type="checkbox" data-cum-merge="' + esc(i.reviewKey) + '" data-cum-merge-to="' + esc(i.candidates[0]) + '"' +
            (state.manualMappings[i.reviewKey] ? ' checked' : '') + '> 同一人物として統合</label>';
        } else if (i.code === 'NAME_AMBIGUOUS') act = '候補が複数のため自動統合不可';
        return '<tr class="border-b border-border align-top"><td class="px-2 py-1.5 ' + l[1] + '">' + l[0] + '</td><td class="px-2 py-1.5">' + esc(i.file) + '</td><td class="px-2 py-1.5">' + esc(i.driver) +
          '</td><td class="px-2 py-1.5">' + esc(i.field) + '</td><td class="px-2 py-1.5">' + esc(i.cause) + '</td><td class="px-2 py-1.5">' + act + '</td></tr>';
      }).join('') + '</tbody></table></div>' + (list.length > MAX_ROWS ? '<p class="text-xs text-ink-lighter p-2">先頭' + MAX_ROWS + '件のみ表示（全' + list.length + '件）</p>' : '');
  }

  function render() {
    if (!$('driver-cumulative-mode')) return;
    renderFiles(); renderStats(); renderPreview(); renderIssues();
    var plan = state.plan;
    $('cum-ack-wrap').classList.toggle('hidden', !(plan && (plan.needsAck || state.ack)));
    $('cum-ack').checked = state.ack;
    $('cum-validate-btn').disabled = !(state.base && state.adds.length) || state.busy;
    $('cum-generate-btn').disabled = !(plan && plan.canGenerate) || state.busy;
    $('cum-download-btn').disabled = !state.output;
    var msg = '';
    if (!state.base || !state.adds.length) msg = '基準累計ファイルと追加週ファイルを選択してください';
    else if (!plan) msg = '「データ検証」を実行してください';
    else if (plan.errorCount) msg = 'エラーがあるため統合できません。内容を修正して再検証してください';
    else if (plan.needsAck) msg = '基準ファイルの統合履歴が不十分です。内容を確認し、確認済みにチェックしてください';
    else if (state.output) msg = '生成済み: ' + state.output.fileName;
    else msg = '検証OK。「累計データ生成」を押してください';
    $('cum-status').textContent = msg;
  }

  function bind() {
    var root = $('driver-cumulative-mode');
    if (!root) return;
    $('driver-mode-normal-btn').addEventListener('click', function () { setMode('normal'); });
    $('driver-mode-cumulative-btn').addEventListener('click', function () { setMode('cumulative'); });
    $('cum-base-input').addEventListener('change', onBase);
    $('cum-add-input').addEventListener('change', onAdds);
    $('cum-validate-btn').addEventListener('click', validate);
    $('cum-generate-btn').addEventListener('click', generate);
    $('cum-download-btn').addEventListener('click', download);
    $('cum-ack').addEventListener('change', function (e) { state.ack = e.target.checked; invalidate(); render(); });
    $('cum-base-override').addEventListener('change', function (e) { state.baseWeeksOverride = e.target.value.trim(); invalidate(); render(); });
    $('cum-role').addEventListener('change', function (e) { state.role = e.target.value; renderPreview(); });
    $('cum-row-filter').addEventListener('change', function (e) { state.rowFilter = e.target.value; renderPreview(); });
    $('cum-issue-filter').addEventListener('change', function (e) { state.issueFilter = e.target.value; renderIssues(); });
    root.addEventListener('click', function (e) {
      var rm = e.target.getAttribute && e.target.getAttribute('data-cum-remove');
      if (rm != null) removeAdd(parseInt(rm, 10));
    });
    root.addEventListener('change', function (e) {
      var t = e.target;
      var wk = t.getAttribute && t.getAttribute('data-cum-week');
      if (wk != null) { state.weekOverrides[wk] = t.value.trim(); invalidate(); render(); return; }
      var mk = t.getAttribute && t.getAttribute('data-cum-merge');
      if (mk != null) {
        if (t.checked) state.manualMappings[mk] = t.getAttribute('data-cum-merge-to'); else delete state.manualMappings[mk];
        validate();
      }
    });
    render();
  }

  window.DriverCumulativeUI = { setMode: setMode, _state: state };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind); else bind();
})();
