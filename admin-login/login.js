(function () {
  'use strict';
  var msg = document.getElementById('msg');
  document.getElementById('f').addEventListener('submit', function (e) {
    e.preventDefault();
    var pw = document.getElementById('pw');
    fetch('/admin/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw.value }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) { pw.value = ''; if (x.ok) { msg.textContent = 'ログインしました。'; location.href = '/'; } else { msg.textContent = x.j.message || 'ログインできません。'; } })
      .catch(function () { msg.textContent = '通信に失敗しました。'; });
  });
})();
