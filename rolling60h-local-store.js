/**
 * 60時間ボードの最後の正常集計結果をIndexedDBに保存する。
 * 保存先は「このブラウザ（このオリジン）」だけ。他のPC・ブラウザ・シークレットウィンドウとは共有されない。
 * 書き込みは1トランザクションで 'latest'（ボード）と 'friday-summary'（要約）を同時に置き換える。
 * 検証に失敗したボード、または書き込みに失敗した場合、前回の保存分は変わらない。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.Rolling60hLocalStore = api;
})(this, function () {
  'use strict';

  var DB_NAME = 'ofk3-rolling60h';
  var DB_VERSION = 1;
  var STORE = 'boards';
  var KEY_BOARD = 'latest';
  var KEY_SUMMARY = 'friday-summary';
  var MIRROR_KEY = 'ofk3.rolling60h.fridaySummary';

  function create(env) {
    env = env || {};
    var idb = env.indexedDB;
    var validate = env.validate || function () { return true; };
    var storage = env.localStorage || null;
    var dbPromise = null;

    function open() {
      if (dbPromise) return dbPromise;
      dbPromise = new Promise(function (resolve, reject) {
        if (!idb) { reject(new Error('indexeddb-unavailable')); return; }
        var request;
        try { request = idb.open(DB_NAME, DB_VERSION); } catch (e) { reject(e); return; }
        request.onupgradeneeded = function () {
          var db = request.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
        };
        request.onsuccess = function () { resolve(request.result); };
        request.onerror = function () { reject(request.error || new Error('indexeddb-open-failed')); };
      });
      dbPromise.catch(function () { dbPromise = null; });
      return dbPromise;
    }

    function readKey(key) {
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
          request.onsuccess = function () { resolve(request.result === undefined ? null : request.result); };
          request.onerror = function () { reject(request.error || new Error('indexeddb-read-failed')); };
        });
      });
    }

    function save(board, summary) {
      if (!validate(board)) return Promise.reject(new Error('invalid-board'));
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction(STORE, 'readwrite');
          var os = tx.objectStore(STORE);
          os.put(board, KEY_BOARD);
          os.put(summary, KEY_SUMMARY);
          tx.oncomplete = function () { resolve(true); };
          tx.onerror = function () { reject(tx.error || new Error('indexeddb-write-failed')); };
          tx.onabort = function () { reject(tx.error || new Error('indexeddb-aborted')); };
        });
      }).then(function () {
        // 同一ブラウザ内の接続コードが同期で読めるよう、個人情報を含まない要約だけ複製する。
        if (storage) { try { storage.setItem(MIRROR_KEY, JSON.stringify(summary)); } catch (e) {} }
        return true;
      });
    }

    return {
      save: save,
      loadBoard: function () { return readKey(KEY_BOARD); },
      loadSummary: function () { return readKey(KEY_SUMMARY); },
    };
  }

  return { create: create, DB_NAME: DB_NAME, STORE: STORE, KEY_BOARD: KEY_BOARD, KEY_SUMMARY: KEY_SUMMARY, MIRROR_KEY: MIRROR_KEY };
});
