// 近隣コース検索UIの配線テスト（簡易DOMスタブ。ブラウザ不要）。合成データのみ。
// 取込ボタン/ファイル選択/ドラッグ＆ドロップが同じ取込処理に繋がり、成功・失敗が画面に出ることを確認する。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const XLSX = require('xlsx');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

class El {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.parent = null; this.listeners = {}; this.style = {}; this.attrs = {}; this._text = ''; this.id = ''; this.className = ''; this.value = ''; this.disabled = false; this.clicks = 0; this.files = null; this.offsetParent = {}; }
  get classList() { const s = this; return { add: (c) => { if (!s.className.split(' ').includes(c)) s.className += ' ' + c; }, remove: (c) => { s.className = s.className.split(' ').filter((x) => x && x !== c).join(' '); }, contains: (c) => s.className.split(' ').includes(c) }; }
  set textContent(v) { this.children = []; this._text = String(v); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  insertBefore(c, ref) { c.parent = this; const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; }
  get firstChild() { return this.children[0] || null; }
  contains(x) { for (let e = x; e; e = e.parent) if (e === this) return true; return false; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  fire(t, ev = {}) { ev.type = t; ev.target = ev.target || this; ev.defaultPrevented = false; ev.preventDefault = () => { ev.defaultPrevented = true; }; (this.listeners[t] || []).forEach((f) => f(ev)); return ev; }
  click() { this.clicks++; this.fire('click'); }
  select() {} focus() {}
  walk(f) { f(this); this.children.forEach((c) => c.walk(f)); }
}
const panel = new El('div'); panel.id = 'panel-addr-search';
const body = new El('body'); body.appendChild(panel);
const docListeners = {};
const document = {
  readyState: 'complete', body,
  createElement: (t) => new El(t),
  getElementById: (id) => { let r = null; body.walk((e) => { if (e.id === id && !r) r = e; }); return r; },
  addEventListener: (t, f) => { (docListeners[t] = docListeners[t] || []).push(f); },
};
const fireDoc = (t, ev) => { ev.type = t; ev.defaultPrevented = false; ev.preventDefault = () => { ev.defaultPrevented = true; }; (docListeners[t] || []).forEach((f) => f(ev)); return ev; };
class FileReaderStub { readAsArrayBuffer(f) { Promise.resolve().then(() => { if (f.failRead) this.onerror && this.onerror(); else this.onload && this.onload({ target: { result: f.buf } }); }); } }
const window = {};
const sandbox = { window, document, XLSX, FileReader: FileReaderStub, setTimeout, Date, Uint8Array, Math, String, Array, Object, JSON, console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'nearby-course-core.js'), 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'ofk3-nearby-course-ui.js'), 'utf8'), sandbox);

const find = (pred) => { let r = null; body.walk((e) => { if (!r && pred(e)) r = e; }); return r; };
const card = document.getElementById('nearby-course-card');
ok(card && panel.firstChild === card, '住所検索タブ先頭にカードが挿入される');
const fileInput = find((e) => e.tagName === 'INPUT' && e.type === 'file');
const zone = find((e) => e.attrs.role === 'button');
const importBtn = find((e) => e.tagName === 'BUTTON' && e.textContent.startsWith('取込'));
const clearBtn = find((e) => e.tagName === 'BUTTON' && e.textContent === 'データクリア');
const msgEl = find((e) => e.attrs.role === 'status' || e.attrs.role === 'alert');
const statusEl = find((e) => e.tagName === 'DL');
ok(fileInput && zone && importBtn && clearBtn && msgEl, '主要要素が存在する');
ok((importBtn.listeners.click || []).length === 1 && (zone.listeners.click || []).length === 1 && (fileInput.listeners.change || []).length === 1, 'イベントが登録されている');
ok(['dragenter', 'dragover', 'dragleave', 'drop'].every((t) => (zone.listeners[t] || []).length >= 1), 'ドラッグ＆ドロップのイベントが登録されている');

const wait = () => new Promise((r) => setTimeout(r, 120));
function xlsxFile(name, rows, opts = {}) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Route for DCX1'], ['Stop', 'Tracking ID', 'Address', 'Postal'], ...rows]), 'sequencedRoute_DCX1');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return { name, size: buf.byteLength, buf: opts.buf || buf };
}
const good = xlsxFile('OFK3_CYCLE_1_2026-11-25_C.xlsx', [[1, 'T1', '福岡県福岡市東区香椎駅前2-15-6', '813-0013'], [2, 'T2', '福岡市東区香椎駅前2-15-7', '813-0013']]);
const msg = () => msgEl.textContent;

// ボタン/領域クリック → ファイル選択ダイアログ
importBtn.click(); ok(fileInput.clicks === 1, '取込ボタンでファイル選択を開く');
zone.click(); ok(fileInput.clicks === 2, '領域クリックでファイル選択を開く');

// ファイル選択 → 自動取込（成功）
fileInput.files = [good]; fileInput.fire('change'); ok(msg().startsWith('読込中'), '読込中を表示'); ok(importBtn.disabled === true, '読込中はボタン無効');
await wait();
ok(msg().startsWith('取込完了'), '取込成功を表示: ' + msg());
ok(statusEl.textContent.includes('取込コース数1') && statusEl.textContent.includes('有効配送件数2'), '取込結果を表示');
ok(importBtn.disabled === false, '完了でボタン有効');
ok(fileInput.value === '', '選択後にinputを空にし、同じファイルを再選択できる');

// 失敗: 不正ファイル・拡張子・空ファイル・読込エラー（エラー表示 + 既存データ維持）
fileInput.files = [{ name: 'bad.xlsx', size: 12, buf: new TextEncoder().encode('not an excel').buffer }]; fileInput.fire('change'); await wait();
ok(msg().startsWith('取込失敗') && msgEl.attrs.role === 'alert', '不正ファイルはエラー表示: ' + msg());
ok(statusEl.textContent.includes('OFK3_CYCLE_1_2026-11-25_C.xlsx'), '失敗時は既存データを維持');
fileInput.files = [{ name: 'a.csv', size: 5, buf: new ArrayBuffer(5) }]; fileInput.fire('change'); ok(msg().includes('xlsx'), '拡張子エラー');
fileInput.files = [{ name: 'e.xlsx', size: 0, buf: new ArrayBuffer(0) }]; fileInput.fire('change'); ok(msg().includes('空'), '空ファイルエラー');
fileInput.files = [{ name: 'r.xlsx', size: 100, buf: null, failRead: true }]; fileInput.fire('change'); await wait(); ok(msg().startsWith('取込失敗'), '読込エラー表示');

// ドラッグ中の見た目
const idleLook = zone.style.border + zone.style.background;
const dtFiles = { types: ['Files'], files: [good] };
zone.fire('dragenter', { dataTransfer: dtFiles });
ok(zone.style.border + zone.style.background !== idleLook, 'ドラッグ中は枠線と背景色が変わる');
zone.fire('dragleave', { dataTransfer: dtFiles, relatedTarget: null });
ok(zone.style.border + zone.style.background === idleLook, 'ドラッグ終了で元に戻る');
const over = zone.fire('dragover', { dataTransfer: dtFiles }); ok(over.defaultPrevented, 'dragoverでdropを許可');
const overText = zone.fire('dragover', { dataTransfer: { types: ['text/plain'] } }); ok(!overText.defaultPrevented, 'ファイル以外のドラッグには反応しない');

// ドロップ → 自動取込（同じ importFile）
clearBtn.fire('click'); ok(statusEl.className.includes('hidden'), 'データクリアで取込状態を消去');
const drop = zone.fire('drop', { dataTransfer: { types: ['Files'], files: [good] } });
ok(drop.defaultPrevented, 'ドロップでブラウザの既定動作(ファイルを開く)を止める');
ok(msg().startsWith('読込中'), 'ドロップで取込開始'); await wait(); ok(msg().startsWith('取込完了'), 'ドロップで取込成功');
zone.fire('drop', { dataTransfer: { types: ['Files'], files: [good, good] } }); await wait(); ok(msg().startsWith('取込完了') && msg().includes('最初の1ファイルのみ'), '複数ドロップは最初の1件のみ取込し、その旨を表示');

// 領域外ドロップでもブラウザがファイルを開かない（住所検索タブ表示中）
ok(fireDoc('dragover', { dataTransfer: dtFiles, target: body }).defaultPrevented, '領域外dragoverを抑止');
ok(fireDoc('drop', { dataTransfer: dtFiles, target: body }).defaultPrevented, '領域外dropを抑止');
panel.offsetParent = null;
ok(!fireDoc('drop', { dataTransfer: dtFiles, target: body }).defaultPrevented, 'タブ非表示時は他機能のドロップに干渉しない');
panel.offsetParent = {};

console.log('nearby-course-ui.test.mjs: ' + n + ' assertions passed');
