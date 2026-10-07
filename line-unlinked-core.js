/**
 * LINE未紐付け候補。DOM・トークン非依存。
 * 将来のQRセルフ登録（OFK3_Dxxx をLINEへ送って自動紐付け）は
 * registrationCode / source を残してある。今回は人手の確定だけが status を linked にする。
 */
(function (global) {
  'use strict';

  function createStore() {
    return { users: {}, knownLineIds: {} };
  }

  // /proxy と同じ簡易認証。秘密が未設定のときは既存管理APIと同様に通す。
  // CHANNEL_ACCESS_TOKEN は使わない。
  function proxySecretAllows(configuredSecret, presentedSecret) {
    if (!configuredSecret) return true;
    return String(presentedSecret || '') === String(configuredSecret);
  }

  function normalizeUserId(userId) {
    return String(userId || '').trim();
  }

  function findLineIdOfDriver(store, driverName) {
    var known = (store && store.knownLineIds) || {};
    for (var id in known) {
      if (known[id] === driverName) return id;
    }
    return '';
  }

  function captureLineUser(store, input) {
    input = input || {};
    store.users = store.users || {};
    store.knownLineIds = store.knownLineIds || {};
    var userId = normalizeUserId(input.userId);
    if (!userId) return { captured: false, reason: 'missing_user_id' };
    if (store.knownLineIds[userId]) return { captured: false, reason: 'already_linked' };
    var now = input.now || new Date().toISOString();
    var profile = input.profile || {};
    var existing = store.users[userId];
    if (existing && existing.status === 'linked') {
      return { captured: false, reason: 'already_linked' };
    }
    if (!existing) {
      store.users[userId] = {
        userId: userId,
        displayName: profile.displayName || '',
        pictureUrl: profile.pictureUrl || '',
        firstSeenAt: now,
        lastSeenAt: now,
        status: 'pending',
        registrationCode: '',
        source: 'webhook'
      };
      return { captured: true, created: true, user: store.users[userId] };
    }
    existing.lastSeenAt = now;
    existing.status = 'pending';
    if (profile.displayName) existing.displayName = profile.displayName;
    if (profile.pictureUrl) existing.pictureUrl = profile.pictureUrl;
    return { captured: true, created: false, user: existing };
  }

  function mergeKnownLineIds(store, mapping) {
    store.users = store.users || {};
    store.knownLineIds = store.knownLineIds || {};
    mapping = mapping || {};
    for (var id in mapping) {
      var userId = normalizeUserId(id);
      if (!userId) continue;
      store.knownLineIds[userId] = String(mapping[id] || '');
      if (store.users[userId] && store.users[userId].status === 'pending') {
        store.users[userId].status = 'linked';
        store.users[userId].linkedDriverName = store.knownLineIds[userId];
      }
    }
    return store.knownLineIds;
  }

  function replaceKnownLineIds(store, mapping) {
    store.users = store.users || {};
    store.knownLineIds = {};
    mapping = mapping || {};
    for (var id in mapping) {
      var userId = normalizeUserId(id);
      if (!userId) continue;
      store.knownLineIds[userId] = String(mapping[id] || '');
      if (store.users[userId] && store.users[userId].status === 'pending') {
        store.users[userId].status = 'linked';
        store.users[userId].linkedDriverName = store.knownLineIds[userId];
      }
    }
    for (var knownId in store.users) {
      var knownUser = store.users[knownId];
      if (knownUser && knownUser.status === 'linked' && !store.knownLineIds[knownId]) {
        knownUser.status = 'pending';
      }
    }
    return store.knownLineIds;
  }

  function listPending(store) {
    store.users = store.users || {};
    store.knownLineIds = store.knownLineIds || {};
    var out = [];
    for (var id in store.users) {
      var user = store.users[id];
      if (!user || user.status !== 'pending') continue;
      if (store.knownLineIds[id]) continue;
      out.push(user);
    }
    out.sort(function (a, b) {
      if (a.firstSeenAt !== b.firstSeenAt) return String(a.firstSeenAt).localeCompare(String(b.firstSeenAt));
      return String(a.userId).localeCompare(String(b.userId));
    });
    return out;
  }

  function compactName(value) {
    return String(value || '').replace(/[\s\u3000]/g, '').toLowerCase();
  }

  function suggestDriverCandidates(displayName, driverNames) {
    var needle = compactName(displayName);
    if (needle.length < 2) return [];
    var out = [];
    var names = driverNames || [];
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var compact = compactName(name);
      if (!compact) continue;
      if (compact === needle || compact.indexOf(needle) >= 0 || needle.indexOf(compact) >= 0) {
        out.push(name);
      }
    }
    return out;
  }

  function linkPendingUser(store, input) {
    input = input || {};
    store.users = store.users || {};
    store.knownLineIds = store.knownLineIds || {};
    var userId = normalizeUserId(input.userId);
    var driverName = String(input.driverName || '').trim();
    if (!userId || !driverName) return { ok: false, error: 'missing_fields' };
    var user = store.users[userId];
    if (!user || user.status !== 'pending' || store.knownLineIds[userId]) {
      return { ok: false, error: 'not_pending' };
    }
    var owner = store.knownLineIds[userId] || input.lineIdOwner || '';
    if (owner && owner !== driverName) return { ok: false, error: 'duplicate_line_id' };
    var currentLineId = normalizeUserId(input.currentLineId || findLineIdOfDriver(store, driverName));
    if (currentLineId && currentLineId !== userId) return { ok: false, error: 'overwrite_blocked' };
    user.status = 'linked';
    user.linkedDriverName = driverName;
    user.linkedAt = input.now || new Date().toISOString();
    user.linkSource = input.source || 'manual';
    store.knownLineIds[userId] = driverName;
    return { ok: true, user: user };
  }

  var api = {
    createStore: createStore,
    proxySecretAllows: proxySecretAllows,
    captureLineUser: captureLineUser,
    mergeKnownLineIds: mergeKnownLineIds,
    replaceKnownLineIds: replaceKnownLineIds,
    listPending: listPending,
    suggestDriverCandidates: suggestDriverCandidates,
    linkPendingUser: linkPendingUser,
    findLineIdOfDriver: findLineIdOfDriver
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof global !== 'undefined') global.LineUnlinked = api;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
