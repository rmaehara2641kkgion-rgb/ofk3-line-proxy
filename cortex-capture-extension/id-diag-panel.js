/**
 * Mentor 右上パネルの中に、集計だけの ID 診断を足す。
 * 生の ID は受け取らない。
 */
(function (global) {
  'use strict';

  var Core = global.OFK3IdDiag;

  function onHost() {
    try { return global.location.hostname === 'vrm-mentor.edriving.com'; } catch (e) { return false; }
  }
  if (!onHost()) return;

  var latest = null;
  var focusDate = '';
  var mounted = false;
  var confirmReset = false;
  var confirmToken = 0;
  var confirmRetry = false;
  var rollToken = 0;
  var rollRows = [];
  var suspectToken = 0;
  var suspectRows = [];
  var SUSPECT_NOTE = '未起動疑いは調査用の参考情報です。Mentorの取得漏れがある可能性があり、未起動・点呼未実施を証明するものではありません。';
  var ACTIVE_NOTE = 'Active候補は本人確認・点呼完了を証明しない';
  var SUSPECT_PLAIN = '未起動疑いは未起動・点呼未実施の証明ではない';
  var STATUS_LABEL = { pending: '未確認', confirmed: '確認済み', rejected: '不一致' };
  var identityToken = 0;
  var latestSuspect = null;
  var IDENTITY_WARN = '氏名の類似だけでは本人確認になりません。管理者が別の本人情報を確認した場合のみ登録してください。';
  var SCHEDULING_ALERT = 'Schedulingのデータが取得できていません。Scheduling UIを開いて対象日の予約一覧を表示してください。すでに開いている場合はページを更新してください。';
  var MENTOR_ALERT = 'Mentorのデータが取得できていません。このMentor画面を更新してください。';
  var alertDismissed = '';
  var lastOpsVisible = false;
  var COUNT_CARDS = [
    { id: 'ofk3-count-active', label: '現在Active候補', key: 'active', warn: false },
    { id: 'ofk3-count-ended', label: '当日終了履歴あり', key: 'ended', warn: false },
    { id: 'ofk3-count-suspect', label: '未起動疑い', key: 'suspect', warn: true },
    { id: 'ofk3-count-undetermined', label: '判定不能', key: 'undetermined', warn: true }
  ];
  var CLASS_GROUPS = [
    { status: 'Mentor未起動疑い（要確認）', label: '未起動疑い', warn: true, countKey: 'suspect' },
    { status: '判定不能（原因付き）', label: '判定不能', warn: true, countKey: 'undetermined' },
    { status: '当日終了履歴あり（参考）', label: '当日終了履歴あり', warn: false, countKey: 'ended' },
    { status: '現在Active確認候補', label: '現在Active候補', warn: false, countKey: 'active' }
  ];

  function opsVisible() {
    var details = findDetails();
    return !!(details && details.style && details.style.display !== 'none');
  }

  function formatJst(iso) {
    var ms = Date.parse(iso || '');
    if (!iso || !isFinite(ms)) return '';
    try {
      var fmt = new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Asia/Tokyo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
      });
      return fmt.format(new Date(ms)).replace('T', ' ');
    } catch (e) {
      return '';
    }
  }

  function captureMoments(diag) {
    var found = [];
    function push(label, iso) {
      var ms = Date.parse(iso || '');
      if (!iso || !isFinite(ms)) return;
      found.push({ label: label, ms: ms });
    }
    if (diag && diag.scheduling) push('Scheduling', diag.scheduling.capturedAt);
    if (diag && diag.mentor) push('Mentor', diag.mentor.capturedAt);
    found.sort(function (a, b) { return b.ms - a.ms; });
    return found;
  }

  function dataStatusText(view) {
    var sources = view && view.sources;
    var schedulingState = sources && sources.scheduling;
    var mentorState = sources && sources.mentor;
    if ((view && view.reason === '15分超過') || schedulingState === 'stale' || mentorState === 'stale') return '取得が古い。判定しません';
    if (schedulingState === 'failed' || mentorState === 'failed') return '取得失敗。判定しません';
    if ((view && view.reason === 'データ未取得') || schedulingState === 'missing' || mentorState === 'missing' || (view && view.enabled === false)) return 'データ未取得。判定しません';
    if (view && view.enabled) return '取得済み';
    if (latest && latest.stale) return '取得が古い。判定しません';
    if (latest && latest.crossStatus === 'failed') return '取得失敗。判定しません';
    if (latest && latest.crossStatus === 'ready') return '集計待ち';
    return '未取得。判定しません';
  }

  function sourcesReady(view) {
    if (!view || !view.sources) return true;
    return view.sources.scheduling === 'ready' && view.sources.mentor === 'ready';
  }

  function countReady(view) {
    return !!(view && view.enabled && !view.reason && sourcesReady(view) && view.counts);
  }

  function alertSignature(view) {
    if (!view || !view.sources) return '';
    return String(view.sources.scheduling || '') + '/' + String(view.sources.mentor || '');
  }

  function alertMessages(view) {
    var messages = [];
    var sources = view && view.sources;
    if (!sources) return messages;
    if (sources.scheduling === 'missing' || sources.scheduling === 'failed' || sources.scheduling === 'stale') messages.push(SCHEDULING_ALERT);
    if (sources.mentor === 'missing' || sources.mentor === 'failed' || sources.mentor === 'stale') messages.push(MENTOR_ALERT);
    return messages;
  }

  function paintAlert(box, view) {
    var alert = box.querySelector('#ofk3-ops-alert');
    var text = alert && alert.querySelector('#ofk3-ops-alert-text');
    if (!alert || !text) return;
    var messages = alertMessages(view);
    var signature = alertSignature(view);
    if (!messages.length) alertDismissed = '';
    if (!messages.length || signature === alertDismissed) {
      alert.hidden = true;
      text.textContent = '';
      return;
    }
    alert.hidden = false;
    text.textContent = messages.join(' ');
  }

  function paintOps() {
    var details = findDetails();
    var box = details && details.querySelector('#ofk3-id-diag');
    if (!box) return;
    var updated = box.querySelector('#ofk3-ops-updated');
    var status = box.querySelector('#ofk3-ops-status');
    var people = box.querySelector('#ofk3-ops-people');
    var view = latestSuspect;
    var moments = captureMoments(latest);
    if (updated) {
      if (!moments.length) updated.textContent = '最終更新時刻（JST）: 未取得';
      else {
        updated.textContent = '最終更新時刻（JST）: ' + formatJst(new Date(moments[0].ms).toISOString())
          + '（' + moments.map(function (item) { return item.label + ' ' + formatJst(new Date(item.ms).toISOString()); }).join(' / ') + '）';
      }
    }
    if (status) status.textContent = 'データ取得状態: ' + dataStatusText(view);
    paintAlert(box, view);
    COUNT_CARDS.forEach(function (card) {
      var node = box.querySelector('#' + card.id);
      if (!node) return;
      node.textContent = countReady(view) ? String(view.counts[card.key] || 0) + '人' : '—';
    });
    if (!people) return;
    var visible = opsVisible();
    if (!visible || !view) {
      people.textContent = '';
      return;
    }
    if (!view.enabled || view.reason || !sourcesReady(view)) {
      people.textContent = '判定しません。氏名は表示しません。';
      return;
    }
    if (view.namesShown === false) {
      people.textContent = '氏名は表示しません。';
      return;
    }
    var rows = Array.isArray(view.rows) ? view.rows : [];
    people.textContent = '';
    var heading = document.createElement('div');
    heading.textContent = 'ドライバー一覧';
    heading.style.fontWeight = '700';
    heading.style.margin = '12px 0 6px';
    people.appendChild(heading);
    if (!rows.length && !(view.counts && view.counts.total)) {
      var empty = document.createElement('div');
      empty.textContent = '開始済みの対象者はいません。';
      people.appendChild(empty);
      return;
    }
    var used = Object.create(null);
    function addGroup(label, officialCount, warn, groupRows) {
      var group = document.createElement('div');
      group.style.margin = '8px 0';
      var title = document.createElement('div');
      title.textContent = label + ' ' + officialCount + '人';
      title.style.fontWeight = '700';
      title.style.marginBottom = '4px';
      if (warn) title.style.color = '#fecaca';
      group.appendChild(title);
      if (!groupRows.length) {
        var withheld = document.createElement('div');
        withheld.textContent = '氏名は表示しません。';
        group.appendChild(withheld);
        people.appendChild(group);
        return;
      }
      groupRows.forEach(function (row) {
        var line = document.createElement('div');
        line.style.margin = '6px 0';
        line.style.padding = '8px';
        line.style.borderRadius = '6px';
        line.style.background = warn ? 'rgba(127,29,29,.45)' : 'rgba(255,255,255,.06)';
        line.style.borderLeft = warn ? '4px solid #f87171' : '4px solid rgba(255,255,255,.28)';
        line.style.overflowWrap = 'anywhere';
        function field(text, strong) {
          var item = document.createElement('div');
          item.textContent = text;
          if (strong) {
            item.style.fontWeight = '700';
            item.style.fontSize = '15px';
          }
          line.appendChild(item);
        }
        field(row.schedulingName || '取得不可', true);
        field('所属会社: ' + (row.department || '所属なし'), false);
        field('開始予定時刻: ' + (row.startLabel || '時刻不明'), false);
        field('経過時間: ' + (row.elapsed || '経過不明'), false);
        field('現在の分類: ' + (row.status || label), false);
        appendIdentityControls(line, row);
        group.appendChild(line);
      });
      people.appendChild(group);
    }
    CLASS_GROUPS.forEach(function (spec) {
      var groupRows = rows.filter(function (row) { return row.status === spec.status; });
      groupRows.forEach(function (row) { used[rows.indexOf(row)] = true; });
      var officialCount = countReady(view) ? (view.counts[spec.countKey] || 0) : groupRows.length;
      if (!groupRows.length && !officialCount) return;
      addGroup(spec.label, officialCount, spec.warn, groupRows);
    });
    var rest = rows.filter(function (row, index) { return !used[index]; });
    if (rest.length) addGroup('その他', rest.length, true, rest);
  }

  function setDetailOpen(open) {
    var details = findDetails();
    var box = details && details.querySelector('#ofk3-id-diag');
    if (!box) return;
    var show = !!open;
    ['#ofk3-id-detail-heading', '#ofk3-detail-legend', '#ofk3-id-detail-actions', '#ofk3-id-diag-body'].forEach(function (sel) {
      var node = box.querySelector(sel);
      if (node) node.hidden = !show;
    });
    var tech = details.querySelector('#ofk3-mentor-tech');
    if (tech) tech.hidden = !show;
    var toggle = box.querySelector('#ofk3-detail-toggle');
    if (toggle) toggle.textContent = show ? '詳細診断・取得ログを閉じる' : '詳細診断・取得ログを表示';
    if (!show) {
      var confirmPanel = box.querySelector('#ofk3-id-confirm');
      var confirmButton = box.querySelector('#ofk3-id-confirm-toggle');
      var confirmBody = box.querySelector('#ofk3-id-confirm-body');
      if (confirmPanel) confirmPanel.hidden = true;
      if (confirmBody) confirmBody.textContent = '';
      if (confirmButton) confirmButton.textContent = '本人対応を確認する';
      confirmRetry = false;
    }
  }

  function origin() {
    try { return global.location.origin || ''; } catch (e) { return ''; }
  }

  function postDiag(type, extra) {
    var target = origin();
    if (!target || typeof global.postMessage !== 'function') return;
    var body = { source: 'OFK3_ID_DIAG', type: type, date: focusDate };
    if (extra) {
      Object.keys(extra).forEach(function (key) { body[key] = extra[key]; });
    }
    try { global.postMessage(body, target); } catch (e) {}
  }

  function requestRefresh() {
    postDiag('id-diag-refresh');
  }

  function confirmOpen() {
    var details = findDetails();
    var box = details && details.querySelector('#ofk3-id-confirm');
    return !!(box && !box.hidden);
  }

  function rollOpen() {
    var details = findDetails();
    var box = details && details.querySelector('#ofk3-rollcall');
    return !!(box && !box.hidden);
  }

  function requestRollCall() {
    rollToken += 1;
    postDiag('id-diag-rollcall', { includeRows: rollOpen(), token: rollToken });
  }

  function suspectOpen() {
    var details = findDetails();
    var box = details && details.querySelector('#ofk3-suspect');
    return !!(box && !box.hidden);
  }

  function requestIdentity(action, rowIndex, candidateIndex) {
    if (action === 'linked') {
      if (typeof global.confirm !== 'function' || global.confirm(IDENTITY_WARN) !== true) return;
    }
    identityToken += 1;
    postDiag(action === 'clear' ? 'id-diag-identity-clear' : 'id-diag-identity-set', {
      action: action,
      rowIndex: rowIndex,
      candidateIndex: candidateIndex,
      generation: latestSuspect && latestSuspect.identityGeneration,
      includeRows: opsVisible(),
      token: identityToken
    });
  }

  function appendIdentityControls(line, row) {
    var candidates = row && Array.isArray(row.nameCandidates) ? row.nameCandidates : [];
    if (row && row.matchBasis) {
      var basis = document.createElement('div');
      basis.textContent = '照合根拠: ' + row.matchBasis;
      basis.style.fontWeight = '700';
      basis.style.marginTop = '4px';
      line.appendChild(basis);
    }
    if (row && row.linkNote) {
      var note = document.createElement('div');
      note.textContent = row.linkNote;
      note.style.marginTop = '4px';
      line.appendChild(note);
    }
    if (!candidates.length && !(row && (row.matchBasis || row.linkNote))) return;
    if (candidates.length) {
      var toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.textContent = 'Mentor登録名の候補あり';
      toggle.style.margin = '6px 0 0';
      toggle.style.padding = '4px 8px';
      var box = document.createElement('div');
      box.hidden = true;
      box.style.marginTop = '6px';
      var heading = document.createElement('div');
      heading.textContent = '同一人物の可能性あり';
      heading.style.fontWeight = '700';
      box.appendChild(heading);
      var ask = document.createElement('div');
      ask.textContent = '同一人物の可能性があります。確認しますか？';
      box.appendChild(ask);
      var kind = document.createElement('div');
      kind.textContent = '機械的な推定候補です。管理者確認済みの対応とは別です。';
      box.appendChild(kind);
      var caution = document.createElement('div');
      caution.textContent = IDENTITY_WARN;
      caution.style.margin = '4px 0';
      box.appendChild(caution);
      candidates.forEach(function (item) {
        var card = document.createElement('div');
        card.style.margin = '6px 0';
        card.style.padding = '6px';
        card.style.background = 'rgba(0,0,0,.25)';
        function bit(text) {
          var node = document.createElement('div');
          node.textContent = text;
          card.appendChild(node);
        }
        bit('Scheduling正式名: ' + (row.schedulingName || '取得不可'));
        bit('所属会社: ' + (row.department || '所属なし'));
        bit('Mentor登録名: ' + (item.mentorName || '取得不可'));
        bit('照合理由: ' + (item.reason || '要確認'));
        bit('Active観測状況: ' + (item.mentorState || '観測あり'));
        bit('管理者確認の状態: ' + (item.adminState || '未確認'));
        if (item.adminState && item.adminState !== '未確認') {
          var mark = document.createElement('div');
          mark.textContent = item.adminState === '管理者確認済み' ? '管理者確認済みの対応' : item.adminState;
          mark.style.fontWeight = '700';
          card.appendChild(mark);
        }
        if (item.canSave) {
          [['linked', '同一人物として対応登録'], ['excluded', '別人として除外'], ['held', '保留']].forEach(function (pair) {
            var button = document.createElement('button');
            button.type = 'button';
            button.textContent = pair[1];
            button.style.margin = '4px 6px 0 0';
            button.style.padding = '4px 8px';
            button.addEventListener('click', function () {
              requestIdentity(pair[0], row.rowIndex, item.candidateIndex);
            });
            card.appendChild(button);
          });
        } else if (item.saveBlock) {
          bit(item.saveBlock);
        }
        if (item.adminState && item.adminState !== '未確認') {
          var clear = document.createElement('button');
          clear.type = 'button';
          clear.textContent = '登録済み対応の解除';
          clear.style.margin = '4px 6px 0 0';
          clear.style.padding = '4px 8px';
          clear.addEventListener('click', function () {
            requestIdentity('clear', row.rowIndex, item.candidateIndex);
          });
          card.appendChild(clear);
        }
        box.appendChild(card);
      });
      toggle.addEventListener('click', function () {
        box.hidden = !box.hidden;
        toggle.textContent = box.hidden ? 'Mentor登録名の候補あり' : 'Mentor登録名の候補を閉じる';
      });
      line.appendChild(toggle);
      line.appendChild(box);
    } else if (row && row.matchBasis) {
      var clearLinked = document.createElement('button');
      clearLinked.type = 'button';
      clearLinked.textContent = '登録済み対応の解除';
      clearLinked.style.margin = '4px 0 0';
      clearLinked.style.padding = '4px 8px';
      clearLinked.addEventListener('click', function () {
        requestIdentity('clear', row.rowIndex, 0);
      });
      line.appendChild(clearLinked);
    }
  }

  function requestSuspect() {
    suspectToken += 1;
    postDiag('id-diag-suspect', { includeRows: opsVisible() || suspectOpen(), token: suspectToken });
  }

  function fillRollFilters(deptSelect, statusSelect, rows) {
    if (!deptSelect || !statusSelect) return;
    var deptValue = deptSelect.value || 'すべて';
    var departments = { 'すべて': true };
    rows.forEach(function (row) {
      departments[row.department || '所属なし'] = true;
    });
    deptSelect.textContent = '';
    Object.keys(departments).forEach(function (name) {
      var option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      deptSelect.appendChild(option);
    });
    deptSelect.value = departments[deptValue] ? deptValue : 'すべて';
    if (!statusSelect.children.length) {
      ['すべて', '開始後5分以上・Active未確認', '開始後5分以上・照合不能', '時刻不明', '開始後5分以上・Active確認候補', '開始後5分未満', '開始前'].forEach(function (name) {
        var option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        statusSelect.appendChild(option);
      });
      statusSelect.value = 'すべて';
    }
  }

  function unmatchedCauseText(row) {
    if (!row || row.status !== '開始後5分以上・照合不能') return '';
    if (row.unmatchedCause) return row.unmatchedCause;
    if (row.identity === 'OFK3マスタ未登録' || row.identity === '氏名不一致' || row.identity === 'Mentor照合不能') return row.identity;
    return '原因未確定';
  }

  function paintRollRows(body, deptSelect, statusSelect) {
    if (!body) return;
    body.textContent = '';
    var dept = deptSelect ? deptSelect.value : 'すべて';
    var status = statusSelect ? statusSelect.value : 'すべて';
    var shown = rollRows.filter(function (row) {
      if (dept && dept !== 'すべて' && (row.department || '所属なし') !== dept) return false;
      if (status && status !== 'すべて' && row.status !== status) return false;
      return true;
    });
    if (!shown.length) {
      var empty = document.createElement('div');
      empty.textContent = '該当者なし';
      body.appendChild(empty);
      return;
    }
    shown.forEach(function (row) {
      var line = document.createElement('div');
      line.style.margin = '8px 0';
      line.style.paddingTop = '6px';
      line.style.borderTop = '1px solid rgba(255,255,255,.15)';
      if (row.endedHistoryMark === true && row.status === '開始後5分以上・Active未確認' && row.sameDayHistory === '当日終了時刻あり（同一人物候補）') {
        var badge = document.createElement('span');
        badge.textContent = 'Active未確認｜当日終了履歴あり（参考）';
        badge.style.fontWeight = '700';
        badge.style.display = 'inline-block';
        badge.style.border = '1px solid rgba(255,255,255,.7)';
        badge.style.padding = '1px 6px';
        badge.style.marginRight = '6px';
        line.appendChild(badge);
      }
      var text = document.createElement('span');
      var cause = unmatchedCauseText(row);
      text.textContent = row.status
        + (row.status === '開始後5分未満' ? '（待機中）' : '')
        + ' / Mentor当日履歴（参考）: ' + (row.sameDayHistory || 'データ未取得・期限切れ')
        + (cause ? ' / 照合不能の原因: ' + cause : '')
        + ' / Scheduling氏名: ' + (row.schedulingName || '取得不可')
        + ' / マスタ氏名: ' + (row.masterName || '取得不可')
        + ' / 所属: ' + (row.department || '所属なし')
        + ' / ' + (row.startLabel || '時刻不明')
        + ' / ' + (row.elapsed || '経過不明')
        + ' / 本人照合: ' + (row.identity || '判定不能')
        + ' / Mentor照合: ' + (row.mentorText || '判定不能')
        + (row.mentorName ? ' / Mentor氏名: ' + row.mentorName : '')
        + ' / 本人対応: ' + (row.confirmation || '未確認')
        + (row.note ? ' / ' + row.note : '');
      line.appendChild(text);
      body.appendChild(line);
    });
  }

  function sameDaySummary(sameDay) {
    var counts = sameDay || {};
    return ' Mentor当日履歴（参考）: 当日終了時刻あり ' + (counts.ended || 0)
      + ' / 当日終了履歴未検出 ' + (counts.absent || 0)
      + ' / 履歴照合不能 ' + (counts.unmatched || 0)
      + ' / 取得範囲未検証 ' + (counts.rangeUnverified || 0)
      + ' / データ未取得・期限切れ ' + (counts.unavailable || 0)
      + '。参考情報は要確認人数に入れません。未検出は未起動ではありません。終了時刻は点呼完了でも本人確認でもありません。取得の完全性は断定しません。';
  }

  function rollUiSummary(view) {
    var ui = view && view.ui ? view.ui : {};
    var causes = ui.causes || {};
    var otherLabel = (ui.activeUnseenRangeHold || 0) > 0 ? '範囲未検証・期限切れ等' : '当日終了履歴なし・照合不能等';
    var text = ' Active未確認のうち当日終了履歴あり ' + (ui.activeUnseenEnded || 0) + '人'
      + ' / Active未確認のうち' + otherLabel + ' ' + (ui.activeUnseenOther || 0) + '人'
      + '。照合不能の原因: OFK3マスタ未登録 ' + (causes['OFK3マスタ未登録'] || 0)
      + ' / Mentor照合不能 ' + (causes['Mentor照合不能'] || 0)
      + ' / 氏名不一致 ' + (causes['氏名不一致'] || 0)
      + ' / ID重複・競合 ' + (causes['ID重複・競合'] || 0)
      + ' / 取得データ不足 ' + (causes['取得データ不足'] || 0)
      + ' / 原因未確定 ' + (causes['原因未確定'] || 0);
    if ((ui.activeUnseenRangeHold || 0) > 0) text += '。取得範囲が未検証のため、履歴がないとは断定しません';
    return text;
  }

  function renderRoll(summary, filters, body, deptSelect, statusSelect, view, allowNames) {
    var captured = view && view.captured ? view.captured : {};
    var times = '最終取得 Scheduling ' + (captured.scheduling || '-') + ' / Mentor ' + (captured.mentor || '-') + ' / マスタ ' + (captured.master || '-');
    if (summary) {
      if (!view || !view.enabled) {
        var detail = view && view.detail ? '（' + view.detail + '）' : '';
        var held = view && view.sameDay ? view.sameDay.unavailable : 0;
        summary.textContent = '取得不足' + detail + '。判定しません。氏名は表示しません。Mentor当日履歴（参考）: データ未取得・期限切れ ' + (held || 0) + '。未検出は未起動ではありません。' + times;
      } else {
        var counts = view.counts || {};
        var attention = (counts.activeUnseen || 0) + (counts.after5Unmatched || 0) + (counts.unknownTime || 0);
        summary.textContent = '点呼要確認一覧（調査用） ' + (view.date || '')
          + ' / 総予約 ' + (counts.total || 0)
          + ' / 開始前 ' + (counts.before || 0)
          + ' / 開始後5分未満 ' + (counts.within5 || 0)
          + ' / 開始後5分以上・Active確認候補 ' + (counts.activeCandidate || 0)
          + ' / 開始後5分以上・Active未確認 ' + (counts.activeUnseen || 0)
          + ' / 開始後5分以上・照合不能 ' + (counts.after5Unmatched || 0)
          + ' / 時刻不明 ' + (counts.unknownTime || 0)
          + ' / 要確認人数 ' + attention
          + ' / 本人照合に課題あり ' + (counts.identityIssues || 0) + '（参考）'
          + '。' + times
          + '。開始前の照合課題は要確認人数に入れません。Active確認候補は氏名とIDの一致が取れた場合だけです。未起動の判定はしません。IDと氏名の一致だけでは確認済みにしません。'
          + sameDaySummary(view.sameDay)
          + rollUiSummary(view);
      }
    }
    if (!allowNames || !view || !view.enabled) {
      rollRows = [];
      if (body) body.textContent = '';
      if (filters) filters.hidden = true;
      return;
    }
    if (filters) filters.hidden = false;
    rollRows = view.rows || [];
    fillRollFilters(deptSelect, statusSelect, rollRows);
    paintRollRows(body, deptSelect, statusSelect);
  }

  function requestConfirmation() {
    if (!confirmReset) {
      confirmReset = true;
      postDiag('id-diag-confirm-reset');
      return;
    }
    if (!confirmOpen()) return;
    confirmToken += 1;
    postDiag('id-diag-confirm-read', { includeRows: true, token: confirmToken });
  }

  function revealConfirmation(detailsEl) {
    if (!detailsEl || typeof detailsEl.getBoundingClientRect !== 'function') return;
    var scroller = detailsEl.parentElement;
    while (scroller && scroller !== document.body && scroller !== document.documentElement) {
      if (scroller.scrollHeight > scroller.clientHeight + 1) break;
      scroller = scroller.parentElement;
    }
    if (!scroller || scroller === document.body || scroller === document.documentElement) return;
    if (typeof scroller.getBoundingClientRect !== 'function') return;
    scroller.scrollTop += detailsEl.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  }

  function renderConfirmation(host, view) {
    if (!host) return;
    host.textContent = '';
    var note = document.createElement('div');
    note.style.margin = '8px 0';
    if (!view || !view.enabled) {
      var disabled = '確認操作は無効です。' + ((view && view.reason) || '取得不足') + '。氏名は表示しません。';
      if (view && view.unregistered != null) disabled += 'マスタ未登録 ' + view.unregistered + '人。';
      if (view && view.noDepartment != null) disabled += '所属未登録 ' + view.noDepartment + '人。';
      note.textContent = disabled;
      host.appendChild(note);
      revealConfirmation(host.parentElement);
      return;
    }
    note.textContent = '未確認 ' + view.pending + '人 / 確認済み ' + view.confirmed + '人 / 不一致 ' + view.rejected + '人（運用対象外）。マスタ未登録 ' + (view.unregistered == null ? '-' : view.unregistered) + '人。所属未登録 ' + (view.noDepartment == null ? '-' : view.noDepartment) + '人。IDの一致だけでは確認済みにしません。未起動の判定はしません。';
    host.appendChild(note);
    view.rows.forEach(function (row) {
      var line = document.createElement('div');
      line.style.margin = '8px 0';
      line.style.paddingTop = '6px';
      line.style.borderTop = '1px solid rgba(255,255,255,.15)';
      var text = document.createElement('div');
      var stateLabel = STATUS_LABEL[row.status] || '未確認';
      if (row.status === 'rejected') stateLabel += '（運用対象外）';
      text.textContent = 'Scheduling氏名: ' + (row.schedulingName || '取得不可') + ' / マスタ氏名: ' + (row.masterName || '取得不可') + ' / 所属: ' + (row.department || '未登録') + ' / ' + stateLabel;
      if (row.mentorSession || row.mentorNameCompare || row.mentorName) {
        text.textContent += ' / Mentorセッション: ' + (row.mentorSession || '判定不能');
        text.textContent += ' / Mentor氏名照合: ' + (row.mentorNameCompare || '判定不能');
        if (row.mentorName) text.textContent += ' / Mentor氏名: ' + row.mentorName;
      }
      line.appendChild(text);
      var actions = document.createElement('div');
      [['confirmed', '確認済みにする'], ['rejected', '不一致にする'], ['pending', '未確認に戻す']].forEach(function (item) {
        var button = document.createElement('button');
        button.type = 'button';
        button.textContent = item[1];
        button.style.margin = '4px 6px 0 0';
        button.addEventListener('click', function () {
          postDiag('id-diag-confirm', { index: row.index, status: item[0], generation: view.generation, token: confirmToken });
        });
        actions.appendChild(button);
      });
      line.appendChild(actions);
      host.appendChild(line);
    });
    revealConfirmation(host.parentElement);
  }

  function render(pre) {
    if (!pre) return;
    if (!Core) Core = global.OFK3IdDiag;
    if (!Core || typeof Core.panelLines !== 'function') return;
    pre.textContent = Core.panelLines(latest, focusDate).join('\n');
  }

  function fillDates(select) {
    var keys = latest && latest.scheduling && latest.scheduling.schedule ? latest.scheduling.schedule.dateKeys || [] : [];
    var previous = focusDate;
    select.textContent = '';
    keys.forEach(function (date) {
      var option = document.createElement('option');
      option.value = date;
      option.textContent = date;
      select.appendChild(option);
    });
    if (previous && keys.indexOf(previous) >= 0) focusDate = previous;
    else focusDate = (latest && latest.scheduling && latest.scheduling.schedule && latest.scheduling.schedule.focus) || keys[0] || '';
    if (focusDate) select.value = focusDate;
  }

  function mount(details) {
    if (!details) return;
    if (!Core) Core = global.OFK3IdDiag;
    var existing = details.querySelector('#ofk3-id-diag');
    if (existing && existing._ofk3Ready) {
      mounted = true;
      return;
    }
    if (!Core) return;
    mounted = true;
    var box = existing || document.createElement('div');
    if (!existing) {
      box.id = 'ofk3-id-diag';
      box.style.marginBottom = '10px';
      box.style.paddingBottom = '8px';
      box.style.borderBottom = '1px solid rgba(255,255,255,.2)';
      if (details.firstChild) details.insertBefore(box, details.firstChild);
      else details.appendChild(box);
    }
    var title = box.querySelector('b') || document.createElement('b');
    title.id = 'ofk3-id-detail-heading';
    title.textContent = 'ID照合診断（調査用）';
    if (!title.parentNode) box.appendChild(title);
    var ops = document.createElement('div');
    ops.id = 'ofk3-ops';
    ops.style.overflowWrap = 'anywhere';
    var opsTitle = document.createElement('div');
    opsTitle.id = 'ofk3-ops-title';
    opsTitle.textContent = 'Mentor稼働確認';
    opsTitle.style.fontSize = '18px';
    opsTitle.style.fontWeight = '700';
    opsTitle.style.marginBottom = '8px';
    var alert = document.createElement('div');
    alert.id = 'ofk3-ops-alert';
    alert.hidden = true;
    alert.style.margin = '0 0 8px';
    alert.style.padding = '8px';
    alert.style.borderRadius = '6px';
    alert.style.background = '#3f1212';
    alert.style.border = '1px solid #f87171';
    alert.style.fontSize = '12px';
    alert.style.lineHeight = '1.45';
    var alertText = document.createElement('div');
    alertText.id = 'ofk3-ops-alert-text';
    var alertClose = document.createElement('button');
    alertClose.type = 'button';
    alertClose.id = 'ofk3-ops-alert-close';
    alertClose.textContent = '閉じる';
    alertClose.style.marginTop = '6px';
    alertClose.style.padding = '2px 8px';
    alertClose.addEventListener('click', function () {
      alertDismissed = alertSignature(latestSuspect);
      alert.hidden = true;
    });
    alert.appendChild(alertText);
    alert.appendChild(alertClose);
    var meta = document.createElement('div');
    meta.id = 'ofk3-ops-meta';
    var dateLabel = document.createElement('div');
    dateLabel.textContent = '対象日';
    dateLabel.style.marginTop = '4px';
    var select = document.createElement('select');
    select.id = 'ofk3-id-diag-date';
    select.style.margin = '4px 0 0';
    select.style.maxWidth = '100%';
    var updated = document.createElement('div');
    updated.id = 'ofk3-ops-updated';
    updated.style.marginTop = '6px';
    var statusLine = document.createElement('div');
    statusLine.id = 'ofk3-ops-status';
    statusLine.style.marginTop = '2px';
    var actions = document.createElement('div');
    actions.id = 'ofk3-ops-actions';
    var refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.textContent = '診断を更新';
    var cards = document.createElement('div');
    cards.id = 'ofk3-ops-cards';
    cards.style.display = 'grid';
    cards.style.gridTemplateColumns = '1fr 1fr';
    cards.style.gap = '8px';
    cards.style.margin = '10px 0';
    COUNT_CARDS.forEach(function (card) {
      var cell = document.createElement('div');
      cell.style.padding = '8px';
      cell.style.borderRadius = '8px';
      cell.style.background = card.warn ? '#3f1212' : '#1c1c1c';
      cell.style.border = card.warn ? '2px solid #f87171' : '1px solid rgba(255,255,255,.22)';
      var label = document.createElement('div');
      label.textContent = card.label;
      label.style.fontSize = '12px';
      var num = document.createElement('div');
      num.id = card.id;
      num.textContent = '—';
      num.style.fontSize = '28px';
      num.style.fontWeight = '700';
      num.style.lineHeight = '1.15';
      cell.appendChild(label);
      cell.appendChild(num);
      cards.appendChild(cell);
    });
    var caution = document.createElement('div');
    caution.id = 'ofk3-ops-caution';
    caution.style.margin = '8px 0';
    caution.style.fontSize = '12px';
    caution.style.lineHeight = '1.5';
    caution.textContent = ACTIVE_NOTE + '。' + SUSPECT_PLAIN + '。' + SUSPECT_NOTE;
    var people = document.createElement('div');
    people.id = 'ofk3-ops-people';
    var copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = '診断結果をコピー';
    var note = document.createElement('div');
    note.id = 'ofk3-id-diag-note';
    note.className = 'note';
    var pre = box.querySelector('#ofk3-id-diag-body') || document.createElement('pre');
    pre.id = 'ofk3-id-diag-body';
    pre.style.whiteSpace = 'pre-wrap';
    pre.style.overflowWrap = 'anywhere';
    pre.style.margin = '8px 0 0';
    select.addEventListener('change', function () {
      focusDate = select.value;
      latestSuspect = null;
      render(pre);
      paintOps();
      requestConfirmation();
      requestRollCall();
      requestSuspect();
    });
    refresh.addEventListener('click', requestRefresh);
    copy.addEventListener('click', function () {
      var text = Core.copyPayload(latest, focusDate);
      if (global.navigator && global.navigator.clipboard && typeof global.navigator.clipboard.writeText === 'function') {
        global.navigator.clipboard.writeText(text).then(function () {
          note.textContent = 'コピーしました';
        }).catch(function () {
          note.textContent = 'コピーできませんでした';
        });
        return;
      }
      note.textContent = 'コピーできませんでした';
    });
    var confirmButton = document.createElement('button');
    confirmButton.type = 'button';
    confirmButton.id = 'ofk3-id-confirm-toggle';
    confirmButton.textContent = '本人対応を確認する';
    confirmButton.style.display = 'inline-block';
    confirmButton.style.margin = '8px 0 0';
    confirmButton.style.padding = '6px 10px';
    confirmButton.style.background = '#1d4ed8';
    confirmButton.style.color = '#fff';
    confirmButton.style.border = '1px solid #93c5fd';
    confirmButton.style.borderRadius = '6px';
    confirmButton.style.cursor = 'pointer';
    var confirmPanel = document.createElement('div');
    confirmPanel.id = 'ofk3-id-confirm';
    confirmPanel.hidden = true;
    confirmPanel.style.marginTop = '8px';
    var confirmBody = document.createElement('div');
    confirmBody.id = 'ofk3-id-confirm-body';
    confirmPanel.appendChild(confirmBody);
    confirmButton.addEventListener('click', function () {
      confirmPanel.hidden = !confirmPanel.hidden;
      confirmButton.textContent = confirmPanel.hidden ? '本人対応を確認する' : '本人対応確認を閉じる';
      if (confirmPanel.hidden) {
        confirmBody.textContent = '';
        confirmRetry = false;
        return;
      }
      revealConfirmation(confirmPanel);
      requestConfirmation();
    });
    var detailRow = document.createElement('div');
    detailRow.id = 'ofk3-id-detail-actions';
    detailRow.appendChild(copy);
    detailRow.appendChild(confirmButton);
    var detailToggle = document.createElement('button');
    detailToggle.type = 'button';
    detailToggle.id = 'ofk3-detail-toggle';
    detailToggle.textContent = '詳細診断・取得ログを表示';
    detailToggle.style.display = 'inline-block';
    detailToggle.style.margin = '8px 0 0';
    detailToggle.style.padding = '6px 10px';
    detailToggle.style.background = '#334155';
    detailToggle.style.color = '#fff';
    detailToggle.style.border = '1px solid #94a3b8';
    detailToggle.style.borderRadius = '6px';
    detailToggle.style.cursor = 'pointer';
    var legend = document.createElement('div');
    legend.id = 'ofk3-detail-legend';
    legend.style.marginTop = '8px';
    legend.style.overflowWrap = 'anywhere';
    legend.textContent = 'ID照合診断 / Scheduling取得情報 / Mentor取得情報 / OFK3マスタ照合情報 / Mentor終了履歴の技術診断 / API取得ログ / hook installed / fetch intercepted';
    detailToggle.addEventListener('click', function () {
      var body = box.querySelector('#ofk3-id-diag-body');
      setDetailOpen(!(body && body.hidden === false));
      if (body && body.hidden === false) revealConfirmation(body);
    });
    meta.appendChild(dateLabel);
    meta.appendChild(select);
    actions.appendChild(refresh);
    ops.appendChild(opsTitle);
    ops.appendChild(alert);
    ops.appendChild(meta);
    ops.appendChild(updated);
    ops.appendChild(statusLine);
    ops.appendChild(actions);
    ops.appendChild(cards);
    var identityNote = document.createElement('div');
    identityNote.id = 'ofk3-identity-note';
    identityNote.className = 'note';
    ops.appendChild(caution);
    ops.appendChild(identityNote);
    ops.appendChild(people);
    if (title.parentNode === box) box.insertBefore(ops, title);
    else if (pre.parentNode === box) box.insertBefore(ops, pre);
    else box.appendChild(ops);
    if (title.parentNode === box) box.insertBefore(detailToggle, title);
    else box.appendChild(detailToggle);
    if (title.parentNode === box) box.insertBefore(legend, title);
    else box.appendChild(legend);
    if (pre.parentNode) box.insertBefore(detailRow, pre);
    else box.appendChild(detailRow);
    if (pre.parentNode) box.insertBefore(confirmPanel, pre);
    else box.appendChild(confirmPanel);
    var rollButton = document.createElement('button');
    rollButton.type = 'button';
    rollButton.id = 'ofk3-rollcall-toggle';
    rollButton.textContent = '点呼要確認一覧';
    rollButton.style.display = 'inline-block';
    rollButton.style.margin = '8px 0 0 8px';
    rollButton.style.padding = '6px 10px';
    rollButton.style.background = '#1d4ed8';
    rollButton.style.color = '#fff';
    rollButton.style.border = '1px solid #93c5fd';
    rollButton.style.borderRadius = '6px';
    rollButton.style.cursor = 'pointer';
    var rollPanel = document.createElement('div');
    rollPanel.id = 'ofk3-rollcall';
    rollPanel.hidden = true;
    rollPanel.style.marginTop = '8px';
    var rollSummary = document.createElement('div');
    rollSummary.id = 'ofk3-rollcall-summary';
    var rollFilters = document.createElement('div');
    rollFilters.id = 'ofk3-rollcall-filters';
    rollFilters.hidden = true;
    rollFilters.style.margin = '8px 0';
    var rollDept = document.createElement('select');
    rollDept.id = 'ofk3-rollcall-dept';
    rollDept.style.marginRight = '8px';
    var rollStatus = document.createElement('select');
    rollStatus.id = 'ofk3-rollcall-status';
    rollStatus.style.marginRight = '8px';
    var rollRefresh = document.createElement('button');
    rollRefresh.type = 'button';
    rollRefresh.id = 'ofk3-rollcall-refresh';
    rollRefresh.textContent = '一覧を更新';
    rollRefresh.style.margin = '0';
    rollRefresh.style.padding = '4px 8px';
    rollFilters.appendChild(rollDept);
    rollFilters.appendChild(rollStatus);
    var rollBody = document.createElement('div');
    rollBody.id = 'ofk3-rollcall-body';
    rollPanel.appendChild(rollSummary);
    rollPanel.appendChild(rollRefresh);
    rollPanel.appendChild(rollFilters);
    rollPanel.appendChild(rollBody);
    function applyRoll(view, allowNames) {
      renderRoll(rollSummary, rollFilters, rollBody, rollDept, rollStatus, view, allowNames);
    }
    rollDept.addEventListener('change', function () {
      if (rollOpen()) paintRollRows(rollBody, rollDept, rollStatus);
    });
    rollStatus.addEventListener('change', function () {
      if (rollOpen()) paintRollRows(rollBody, rollDept, rollStatus);
    });
    rollRefresh.addEventListener('click', function () {
      requestRefresh();
      requestRollCall();
    });
    rollButton.addEventListener('click', function () {
      rollPanel.hidden = !rollPanel.hidden;
      rollButton.textContent = rollPanel.hidden ? '点呼要確認一覧' : '点呼要確認一覧を閉じる';
      if (rollPanel.hidden) {
        rollBody.textContent = '';
        rollRows = [];
        rollFilters.hidden = true;
        return;
      }
      revealConfirmation(rollPanel);
      requestRollCall();
    });
    actions.appendChild(rollButton);
    ops.appendChild(rollPanel);
    box._ofk3Roll = applyRoll;
    var suspectButton = document.createElement('button');
    suspectButton.type = 'button';
    suspectButton.id = 'ofk3-suspect-toggle';
    suspectButton.textContent = 'Mentor未起動疑い一覧';
    suspectButton.style.display = 'inline-block';
    suspectButton.style.margin = '8px 0 0 8px';
    suspectButton.style.padding = '6px 10px';
    suspectButton.style.background = '#1d4ed8';
    suspectButton.style.color = '#fff';
    suspectButton.style.border = '1px solid #93c5fd';
    suspectButton.style.borderRadius = '6px';
    suspectButton.style.cursor = 'pointer';
    var suspectPanel = document.createElement('div');
    suspectPanel.id = 'ofk3-suspect';
    suspectPanel.hidden = true;
    suspectPanel.style.marginTop = '8px';
    var suspectSummary = document.createElement('div');
    suspectSummary.id = 'ofk3-suspect-summary';
    var suspectBody = document.createElement('div');
    suspectBody.id = 'ofk3-suspect-body';
    suspectPanel.appendChild(suspectSummary);
    suspectPanel.appendChild(suspectBody);
    function paintSuspect(view, allowNames) {
      var counts = view && view.counts ? view.counts : {};
      var causes = view && view.causes ? view.causes : {};
      var causeText = '';
      Object.keys(causes).forEach(function (name) {
        causeText += ' / ' + name + ' ' + causes[name];
      });
      if (suspectSummary) {
        if (!view || !view.enabled) {
          suspectSummary.textContent = 'Mentor未起動疑い一覧。データ未取得。氏名は表示しません。未起動疑いは表示しません。' + SUSPECT_NOTE;
        } else if (!allowNames) {
          suspectSummary.textContent = 'Mentor未起動疑い一覧 ' + (view.date || '')
            + ' / 対象人数 ' + (counts.total || 0)
            + ' / 現在Active確認候補 ' + (counts.active || 0)
            + ' / 当日終了履歴あり ' + (counts.ended || 0)
            + ' / 未起動疑い ' + (counts.suspect || 0)
            + ' / 判定不能 ' + (counts.undetermined || 0)
            + (view.reason ? ' / ' + view.reason + (causeText || '') : causeText)
            + '。氏名は表示しません。' + SUSPECT_NOTE;
        } else {
          suspectSummary.textContent = 'Mentor未起動疑い一覧 ' + (view.date || '')
            + ' / 対象人数 ' + (counts.total || 0)
            + ' / 現在Active確認候補 ' + (counts.active || 0)
            + ' / 当日終了履歴あり ' + (counts.ended || 0)
            + ' / 未起動疑い ' + (counts.suspect || 0)
            + ' / 判定不能 ' + (counts.undetermined || 0)
            + (causeText ? '。判定不能の原因' + causeText : '')
            + '。' + SUSPECT_NOTE;
        }
      }
      suspectRows = allowNames && view && view.enabled ? (view.rows || []) : [];
      if (!suspectBody) return;
      suspectBody.textContent = '';
      if (!suspectRows.length) return;
      suspectRows.forEach(function (row) {
        var line = document.createElement('div');
        line.style.margin = '8px 0';
        line.style.paddingTop = '6px';
        line.style.borderTop = '1px solid rgba(255,255,255,.15)';
        if (row.status === 'Mentor未起動疑い（要確認）') {
          var badge = document.createElement('span');
          badge.textContent = 'Mentor未起動疑い（要確認）';
          badge.style.fontWeight = '700';
          badge.style.display = 'inline-block';
          badge.style.border = '1px solid rgba(255,255,255,.7)';
          badge.style.padding = '1px 6px';
          badge.style.marginRight = '6px';
          line.appendChild(badge);
        }
        var text = document.createElement('span');
        text.textContent = row.status
          + ' / 氏名: ' + (row.schedulingName || '取得不可')
          + ' / 所属: ' + (row.department || '所属なし')
          + ' / ' + (row.startLabel || '時刻不明')
          + ' / ' + (row.elapsed || '経過不明')
          + ' / Mentor照合: ' + (row.mentorText || '判定不能')
          + (row.cause ? ' / 判定不能の原因: ' + row.cause : '');
        line.appendChild(text);
        suspectBody.appendChild(line);
      });
    }
    suspectButton.addEventListener('click', function () {
      suspectPanel.hidden = !suspectPanel.hidden;
      suspectButton.textContent = suspectPanel.hidden ? 'Mentor未起動疑い一覧' : 'Mentor未起動疑い一覧を閉じる';
      if (suspectPanel.hidden) {
        suspectBody.textContent = '';
        suspectRows = [];
        return;
      }
      revealConfirmation(suspectPanel);
      requestSuspect();
    });
    actions.appendChild(suspectButton);
    ops.appendChild(suspectPanel);
    box._ofk3Suspect = paintSuspect;
    box._ofk3Ops = paintOps;
    if (!pre.parentNode) box.appendChild(pre);
    if (!note.parentNode) box.appendChild(note);
    box._ofk3Confirm = confirmBody;
    box._ofk3Ready = true;
    box._ofk3Render = function () {
      var previous = focusDate;
      fillDates(select);
      render(pre);
      if (previous && focusDate !== previous) latestSuspect = null;
      paintOps();
    };
    render(pre);
    setDetailOpen(false);
    paintOps();
    requestConfirmation();
    requestRollCall();
    requestSuspect();
    requestRefresh();
  }

  function findDetails() {
    var host = document.getElementById('ofk3-mentor-capture-v0');
    if (!host || !host.shadowRoot) return null;
    return host.shadowRoot.getElementById('ofk3-mentor-details');
  }

  function tick() {
    var details = findDetails();
    if (!details) return;
    mount(details);
    var box = details.querySelector('#ofk3-id-diag');
    if (box && box._ofk3Render) box._ofk3Render();
  }

  global.addEventListener('message', function (ev) {
    if (ev.source !== global) return;
    var data = ev.data;
    if (!data || data.source !== 'OFK3_ID_DIAG') return;
    if (data.type === 'rollcall-view') {
      if (data.token !== rollToken) return;
      var rollDetails = findDetails();
      var rollBox = rollDetails && rollDetails.querySelector('#ofk3-id-diag');
      if (rollBox && rollBox._ofk3Roll) rollBox._ofk3Roll(data.rollCall || null, rollOpen());
      return;
    }
    if (data.type === 'identity-result') {
      if (data.token !== identityToken) return;
      if (data.suspect) latestSuspect = data.suspect;
      paintOps();
      var identityNote = findDetails();
      var noteBox = identityNote && identityNote.querySelector('#ofk3-identity-note');
      if (noteBox) noteBox.textContent = data.message || '';
      return;
    }
    if (data.type === 'suspect-view') {
      if (data.token !== suspectToken) return;
      latestSuspect = data.suspect || null;
      var suspectDetails = findDetails();
      var suspectBox = suspectDetails && suspectDetails.querySelector('#ofk3-id-diag');
      if (suspectBox && suspectBox._ofk3Suspect) suspectBox._ofk3Suspect(latestSuspect, suspectOpen());
      paintOps();
      return;
    }
    if (data.type === 'confirm-view') {
      if (!confirmOpen() || data.token !== confirmToken) return;
      var details = findDetails();
      var box = details && details.querySelector('#ofk3-id-diag');
      if (box && box._ofk3Confirm) renderConfirmation(box._ofk3Confirm, data.confirmation || null);
      if ((!data.confirmation || data.confirmation.reason === '取得不足') && !confirmRetry) {
        confirmRetry = true;
        requestRefresh();
      } else if (data.confirmation && data.confirmation.reason !== '取得不足') confirmRetry = false;
      return;
    }
    if (data.type !== 'diag-result') return;
    latest = data.diagnostic || null;
    tick();
    requestConfirmation();
    requestRollCall();
    requestSuspect();
  });

  tick();
  var timer = global.setInterval(function () {
    tick();
    if (mounted) global.clearInterval(timer);
  }, 300);
  global.setInterval(function () {
    var visible = opsVisible();
    if (visible === lastOpsVisible) return;
    lastOpsVisible = visible;
    paintOps();
    if (visible) requestSuspect();
  }, 300);
})(typeof window !== 'undefined' ? window : globalThis);
