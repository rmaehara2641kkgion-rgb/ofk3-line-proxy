import { spawn, spawnSync } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

var __filename = fileURLToPath(import.meta.url);
var __dirname = path.dirname(__filename);
var REPO_ROOT = path.resolve(__dirname, '..');
var POWERSHELL = 'powershell.exe';
var SERVER_TOKEN = 'inoichi-prototype1-step8';

var passed = 0;
var failed = 0;
var cleanupServers = [];
var cleanupProcesses = [];

function ok(name, cond) {
  if (cond) { passed++; console.log('ok - ' + name); }
  else { failed++; console.error('FAIL - ' + name); }
}

function eq(name, a, b) {
  if (a === b) { passed++; console.log('ok - ' + name); }
  else { failed++; console.error('FAIL - ' + name + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }
}

function randomPort() {
  return 10000 + Math.floor(Math.random() * 50000);
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ino-launcher-'));
}

function runPs(scriptName, extraEnv, timeoutMs) {
  return new Promise(function (resolve) {
    var scriptPath = path.join(REPO_ROOT, scriptName);
    var env = Object.assign({}, process.env, extraEnv || {});
    var child = spawn(POWERSHELL, ['-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      cwd: REPO_ROOT,
      env: env,
      windowsHide: true
    });
    var stdout = '';
    var stderr = '';
    var timer = null;
    var resolved = false;
    child.stdout.on('data', function (d) { stdout += d.toString(); });
    child.stderr.on('data', function (d) { stderr += d.toString(); });
    function finish(code) {
      if (resolved) return;
      resolved = true;
      if (timer) clearTimeout(timer);
      resolve({ code: code, stdout: stdout, stderr: stderr });
    }
    child.on('exit', function (code) { finish(code); });
    child.on('error', function (err) {
      stderr += String(err);
      finish(-1);
    });
    timer = setTimeout(function () {
      child.kill('SIGTERM');
      setTimeout(function () { child.kill('SIGKILL'); }, 2000);
      finish(-2);
    }, timeoutMs || 60000);
  });
}

function request(port, p) {
  return new Promise(function (resolve, reject) {
    var req = http.request({ host: '127.0.0.1', port: port, path: p || '/', method: 'GET' }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() });
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, function () { req.destroy(new Error('timeout')); });
    req.end();
  });
}

function startFakeServer(port) {
  return new Promise(function (resolve, reject) {
    var server = http.createServer(function (req, res) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('not inoichi');
    });
    server.listen(port, '127.0.0.1', function () {
      cleanupServers.push(server);
      resolve(server);
    });
    server.on('error', reject);
  });
}

function readPidFile(pidDir) {
  var pidFile = path.join(pidDir, 'server.pid');
  if (!fs.existsSync(pidFile)) return null;
  var text = fs.readFileSync(pidFile, 'utf8');
  var pid = null;
  var started = null;
  text.split(/\r?\n/).forEach(function (line) {
    var m = line.match(/^PID=(\d+)/);
    if (m) pid = parseInt(m[1], 10);
    m = line.match(/^Started=(.+)/);
    if (m) started = m[1];
  });
  return { pid: pid, started: started };
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

function killByPidFile(pidDir) {
  var info = readPidFile(pidDir);
  if (info && info.pid && processExists(info.pid)) {
    try { process.kill(info.pid, 'SIGTERM'); } catch (e) {}
  }
  var pidFile = path.join(pidDir, 'server.pid');
  try { fs.unlinkSync(pidFile); } catch (e) {}
}

function logContains(pidDir, text) {
  var logFile = path.join(pidDir, 'launcher.log');
  if (!fs.existsSync(logFile)) return false;
  return fs.readFileSync(logFile, 'utf8').indexOf(text) !== -1;
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function envBase(tmp, port) {
  return {
    INO_PORT: String(port),
    INO_PID_DIR: tmp,
    INO_LOG_FILE: path.join(tmp, 'launcher.log'),
    INO_NO_BROWSER: '1',
    INO_START_TIMEOUT_SEC: '10',
    INO_TEST_NO_GUI: '1'
  };
}

(async function () {
  var firstEnv = null;
  var firstTmp = null;
  var firstPort = null;

  try {
    // (1) First start
    firstPort = randomPort();
    firstTmp = tmpDir();
    firstEnv = envBase(firstTmp, firstPort);
    var r1 = await runPs('inoichi-launch.ps1', firstEnv, 20000);
    if (r1.code !== 0) {
      console.error('r1 stdout:', r1.stdout);
      console.error('r1 stderr:', r1.stderr);
    }
    ok('(1) first launch exits 0', r1.code === 0);
    var info1 = readPidFile(firstTmp);
    ok('(1) PID file written', info1 !== null && info1.pid > 0);
    ok('(1) server process exists', info1 && processExists(info1.pid));
    var res1 = await request(firstPort, '/');
    eq('(1) / returns 200', res1.status, 200);
    ok('(1) X-INOICHI-Server header', res1.headers['x-inoichi-server'] === SERVER_TOKEN);
    ok('(1) body marker present', res1.body.indexOf('<title>INO-1</title>') !== -1);

    // (2) Reuse existing server / double-start prevention
    var r2 = await runPs('inoichi-launch.ps1', firstEnv, 15000);
    var info2 = readPidFile(firstTmp);
    ok('(2) reuse launch exits 0', r2.code === 0);
    eq('(2) same PID reused', info2 ? info2.pid : null, info1 ? info1.pid : null);
    ok('(2) server still running', info2 && processExists(info2.pid));
    ok('(2) log indicates reuse', logContains(firstTmp, 'already running'));

    // (3) Double start prevention (explicit second launch)
    var r3 = await runPs('inoichi-launch.ps1', firstEnv, 15000);
    ok('(3) third launch exits 0 without new server', r3.code === 0);

    // (4) Port 8765 occupied by a different app
    var conflictPort = randomPort();
    var conflictTmp = tmpDir();
    var conflictEnv = envBase(conflictTmp, conflictPort);
    var fakeServer = await startFakeServer(conflictPort);
    var r4 = await runPs('inoichi-launch.ps1', conflictEnv, 15000);
    ok('(4) conflict launch fails with non-zero exit', r4.code !== 0);
    ok('(4) log reports different application', logContains(conflictTmp, 'another application') || logContains(conflictTmp, 'different application'));
    ok('(4) no INO-1 PID file created', readPidFile(conflictTmp) === null);
    await new Promise(function (resolve) { fakeServer.close(resolve); });

    // (5) Node.js missing
    var missingPort = randomPort();
    var missingTmp = tmpDir();
    var fakeNodeDir = tmpDir();
    fs.writeFileSync(path.join(fakeNodeDir, 'node.cmd'), '@echo off\necho node: command not found\nexit 1\n');
    var missingEnv = Object.assign({}, envBase(missingTmp, missingPort), {
      PATH: fakeNodeDir + path.delimiter + process.env.PATH,
      INO_START_TIMEOUT_SEC: '3'
    });
    var r5 = await runPs('inoichi-launch.ps1', missingEnv, 15000);
    ok('(5) missing node fails with non-zero exit', r5.code !== 0);
    ok('(5) log reports Node.js unavailable', logContains(missingTmp, 'Node.js') || r5.stderr.indexOf('Node.js') !== -1);
    ok('(5) no server started on missing node', readPidFile(missingTmp) === null);

    // (6) Server start failure (invalid PORT env causes node to error)
    var failPort = randomPort();
    var failTmp = tmpDir();
    var failEnv = Object.assign({}, envBase(failTmp, failPort), { PORT: '99999', INO_START_TIMEOUT_SEC: '5' });
    var r6 = await runPs('inoichi-launch.ps1', failEnv, 15000);
    ok('(6) failed server start exits non-zero', r6.code !== 0);
    ok('(6) log reports not ready', logContains(failTmp, 'did not become ready') || logContains(failTmp, 'timed out'));

    // (7) Dashboard auto-display URL in script source
    var launchSrc = fs.readFileSync(path.join(REPO_ROOT, 'inoichi-launch.ps1'), 'utf8');
    ok('(7) launcher opens http://127.0.0.1:$Port/', /Start-Process\s+"http:\/\/127\.0\.0\.1:\$OpenPort\/"/.test(launchSrc));

    // (8) Normal stop
    var r7 = await runPs('inoichi-stop.ps1', firstEnv, 15000);
    ok('(8) stop exits 0', r7.code === 0);
    ok('(8) PID file removed', !fs.existsSync(path.join(firstTmp, 'server.pid')));
    ok('(8) server process terminated', !processExists(info1.pid));
    var reqAfterStopFailed = false;
    try { await request(firstPort, '/'); } catch (e) { reqAfterStopFailed = true; }
    ok('(8) server no longer responds', reqAfterStopFailed);

    // (9) PID file points to missing process
    var missingPidTmp = tmpDir();
    fs.writeFileSync(path.join(missingPidTmp, 'server.pid'), 'PID=999999\nStarted=2020-01-01T00:00:00.0000000Z\n');
    var r8 = await runPs('inoichi-stop.ps1', { INO_PID_DIR: missingPidTmp }, 15000);
    ok('(9) stop with missing PID exits 0 after cleanup', r8.code === 0);
    ok('(9) stale PID file removed', !fs.existsSync(path.join(missingPidTmp, 'server.pid')));

    // (10) PID reuse with different command line
    var otherProc = spawn('node', ['-e', 'setTimeout(()=>{}, 60000)'], { cwd: REPO_ROOT, windowsHide: true });
    cleanupProcesses.push(otherProc);
    await sleep(300);
    var reusedTmp = tmpDir();
    fs.writeFileSync(path.join(reusedTmp, 'server.pid'), 'PID=' + otherProc.pid + '\nStarted=' + new Date().toISOString() + '\n');
    var r9 = await runPs('inoichi-stop.ps1', { INO_PID_DIR: reusedTmp }, 15000);
    ok('(10) stop refuses to kill non-INO-1 process', r9.code !== 0);
    ok('(10) unrelated process still alive', processExists(otherProc.pid));
    otherProc.kill('SIGTERM');
    await sleep(200);

    // (11) Existing shortcut protection
    var desktopTmp = tmpDir();
    fs.writeFileSync(path.join(desktopTmp, 'INO-1 起動.lnk'), 'placeholder');
    var r10 = await runPs('inoichi-install-shortcut.ps1', { INO_DESKTOP_DIR: desktopTmp, INO_ASSUME_YES: '1' }, 15000);
    ok('(11) install exits 0', r10.code === 0);
    ok('(11) original start shortcut preserved', fs.existsSync(path.join(desktopTmp, 'INO-1 起動.lnk')));
    ok('(11) renamed start shortcut created', fs.existsSync(path.join(desktopTmp, 'INO-1 起動(1).lnk')));
    ok('(11) stop shortcut created', fs.existsSync(path.join(desktopTmp, 'INO-1 終了.lnk')));

    // (12) OneDrive-style desktop path support
    var oneDriveTmp = path.join(tmpDir(), 'OneDrive', 'Desktop');
    fs.mkdirSync(oneDriveTmp, { recursive: true });
    var r11 = await runPs('inoichi-install-shortcut.ps1', { INO_DESKTOP_DIR: oneDriveTmp, INO_ASSUME_YES: '1' }, 15000);
    ok('(12) install into OneDrive-style path exits 0', r11.code === 0);
    ok('(12) start shortcut in OneDrive Desktop', fs.existsSync(path.join(oneDriveTmp, 'INO-1 起動.lnk')));
    ok('(12) stop shortcut in OneDrive Desktop', fs.existsSync(path.join(oneDriveTmp, 'INO-1 終了.lnk')));
    var installSrc = fs.readFileSync(path.join(REPO_ROOT, 'inoichi-install-shortcut.ps1'), 'utf8');
    ok('(12) installer references OneDrive fallback', installSrc.indexOf('OneDrive') !== -1);

    function readShortcut(lnkPath) {
      var command = "$s = (New-Object -ComObject WScript.Shell).CreateShortcut('" + lnkPath.replace(/'/g, "''") + "'); Write-Output ('TARGET=' + $s.TargetPath); Write-Output ('ARGS=' + $s.Arguments); Write-Output ('ICON=' + $s.IconLocation)";
      var result = spawnSync(POWERSHELL, ['-NoProfile', '-Command', command], { encoding: 'utf8', windowsHide: true });
      return (result.stdout || '') + (result.stderr || '');
    }
    var officialIcon = path.join(REPO_ROOT, 'assets', 'inoichi.ico').toLowerCase();
    var startInfo = readShortcut(path.join(oneDriveTmp, 'INO-1 起動.lnk')).toLowerCase();
    var stopInfo = readShortcut(path.join(oneDriveTmp, 'INO-1 終了.lnk')).toLowerCase();
    ok('(12a) start shortcut uses official ico', startInfo.indexOf(officialIcon) !== -1);
    ok('(12a) stop shortcut uses official ico', stopInfo.indexOf(officialIcon) !== -1);
    ok('(12a) start shortcut still launches inoichi-launch.ps1', startInfo.indexOf('inoichi-launch.ps1') !== -1);
    ok('(12a) stop shortcut still launches inoichi-stop.ps1', stopInfo.indexOf('inoichi-stop.ps1') !== -1);

    var r11b = await runPs('inoichi-install-shortcut.ps1', { INO_DESKTOP_DIR: oneDriveTmp, INO_ASSUME_YES: '1' }, 15000);
    ok('(12b) reinstall exits 0', r11b.code === 0);
    ok('(12b) own start shortcut is updated in place', !fs.existsSync(path.join(oneDriveTmp, 'INO-1 起動(1).lnk')));
    ok('(12b) own stop shortcut is updated in place', !fs.existsSync(path.join(oneDriveTmp, 'INO-1 終了(1).lnk')));

    var foreignDir = tmpDir();
    var foreignPath = path.join(foreignDir, 'INO-1 起動.lnk');
    var foreignCommand = "$s = (New-Object -ComObject WScript.Shell).CreateShortcut('" + foreignPath.replace(/'/g, "''") + "'); $s.TargetPath = '$env:SystemRoot\\System32\\notepad.exe'; $s.Save()";
    spawnSync(POWERSHELL, ['-NoProfile', '-Command', foreignCommand], { encoding: 'utf8', windowsHide: true });
    var beforeForeign = readShortcut(foreignPath);
    var r11c = await runPs('inoichi-install-shortcut.ps1', { INO_DESKTOP_DIR: foreignDir, INO_ASSUME_YES: '1' }, 15000);
    var afterForeign = readShortcut(foreignPath);
    ok('(12c) unrelated shortcut install exits 0', r11c.code === 0);
    ok('(12c) unrelated shortcut target unchanged', beforeForeign.indexOf('TARGET=') !== -1 && beforeForeign.split('ARGS=')[0] === afterForeign.split('ARGS=')[0]);
    ok('(12c) new INO-1 shortcut created beside unrelated file', fs.existsSync(path.join(foreignDir, 'INO-1 起動(1).lnk')));
    ok('(12c) new shortcut uses official ico', readShortcut(path.join(foreignDir, 'INO-1 起動(1).lnk')).toLowerCase().indexOf(officialIcon) !== -1);

    // (13) No real notifications / external APIs in launcher scripts
    ['inoichi-launch.ps1', 'inoichi-stop.ps1', 'inoichi-install-shortcut.ps1'].forEach(function (script) {
      var src = fs.readFileSync(path.join(REPO_ROOT, script), 'utf8').toLowerCase();
      ok('(13) ' + script + ' has no line.me', src.indexOf('line.me') === -1);
      ok('(13) ' + script + ' has no friday', src.indexOf('friday') === -1);
      ok('(13) ' + script + ' has no harvest', src.indexOf('harvest') === -1);
      ok('(13) ' + script + ' has no fetch(', src.indexOf('fetch(') === -1);
    });

    // (14) Existing INO-1 tests still pass
    var existingTests = [
      'tests/inoichi-server.test.mjs',
      'tests/inoichi-dashboard.test.mjs',
      'tests/inoichi-detection.test.mjs',
      'tests/inoichi-fleet-adapter.test.mjs'
    ];
    for (var i = 0; i < existingTests.length; i++) {
      var testPath = path.join(REPO_ROOT, existingTests[i]);
      var result = spawnSync('node', [testPath], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60000, windowsHide: true });
      ok('(14) ' + existingTests[i] + ' passes', result.status === 0);
      if (result.status !== 0) {
        console.error(existingTests[i] + ' stdout:\n' + result.stdout);
        console.error(existingTests[i] + ' stderr:\n' + result.stderr);
      }
    }
    var npmResult = spawnSync('npm', ['run', 'test:inoichi'], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60000, windowsHide: true, shell: true });
    ok('(14) npm run test:inoichi passes', npmResult.status === 0);
    if (npmResult.status !== 0) {
      console.error('npm run test:inoichi stdout:\n' + npmResult.stdout);
      console.error('npm run test:inoichi stderr:\n' + npmResult.stderr);
    }

  } catch (e) {
    console.error('Test harness error:', e);
    failed++;
  } finally {
    // Cleanup any remaining INO-1 servers launched by tests
    if (firstTmp) killByPidFile(firstTmp);
    cleanupServers.forEach(function (s) { try { s.close(); } catch (e) {} });
    cleanupProcesses.forEach(function (p) { try { p.kill('SIGTERM'); } catch (e) {} });
  }

  if (failed === 0) {
    console.log('inoichi-launcher tests passed (' + passed + ' tests)');
    process.exit(0);
  } else {
    console.error('inoichi-launcher tests failed: ' + failed + ' failed, ' + passed + ' passed');
    process.exit(1);
  }
})();
