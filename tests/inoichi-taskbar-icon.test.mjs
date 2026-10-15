import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

var __filename = fileURLToPath(import.meta.url);
var __dirname = path.dirname(__filename);
var REPO_ROOT = path.resolve(__dirname, '..');
var POWERSHELL = 'powershell.exe';

var passed = 0;
var failed = 0;

function ok(name, cond) {
  if (cond) { passed++; console.log('ok - ' + name); }
  else { failed++; console.error('FAIL - ' + name); }
}

function eq(name, a, b) {
  if (a === b) { passed++; console.log('ok - ' + name); }
  else { failed++; console.error('FAIL - ' + name + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }
}

function pngSize(filePath) {
  var buf = fs.readFileSync(filePath);
  ok(path.basename(filePath) + ' is PNG', buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function icoSizes(filePath) {
  var buf = fs.readFileSync(filePath);
  ok('ico signature', buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0);
  var count = buf.readUInt16LE(4);
  var sizes = [];
  for (var i = 0; i < count; i++) {
    var e = 6 + i * 16;
    var w = buf[e] || 256;
    var h = buf[e + 1] || 256;
    var off = buf.readUInt32LE(e + 12);
    ok('ico entry ' + w + ' is PNG', buf[off] === 0x89 && buf[off + 1] === 0x50);
    sizes.push(w + 'x' + h);
  }
  return sizes;
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ino-taskbar-'));
}

function runInstaller(extraArgs, extraEnv) {
  var args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(REPO_ROOT, 'inoichi-taskbar-shortcut.ps1')].concat(extraArgs || []);
  return spawnSync(POWERSHELL, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    windowsHide: true,
    env: Object.assign({}, process.env, extraEnv || {}, { INO_ASSUME_YES: '1' })
  });
}

function readShortcut(lnkPath) {
  var command = "$s = (New-Object -ComObject WScript.Shell).CreateShortcut('" + lnkPath.replace(/'/g, "''") + "'); Write-Output ('TARGET=' + $s.TargetPath); Write-Output ('ARGS=' + $s.Arguments); Write-Output ('ICON=' + $s.IconLocation)";
  var result = spawnSync(POWERSHELL, ['-NoProfile', '-Command', command], { encoding: 'utf8', windowsHide: true });
  return (result.stdout || '') + (result.stderr || '');
}

var source = pngSize(path.join(REPO_ROOT, 'assets', 'inoichi-taskbar-source.png'));
eq('source is square', source.width, source.height);
ok('source is at least 512', source.width >= 512);

var png192 = pngSize(path.join(REPO_ROOT, 'assets', 'inoichi-taskbar-192.png'));
eq('192 width', png192.width, 192);
eq('192 height', png192.height, 192);

var png512 = pngSize(path.join(REPO_ROOT, 'assets', 'inoichi-taskbar-512.png'));
eq('512 width', png512.width, 512);
eq('512 height', png512.height, 512);

var sizes = icoSizes(path.join(REPO_ROOT, 'assets', 'inoichi-taskbar.ico'));
eq('ico sizes', sizes.join(','), '16x16,24x24,32x32,48x48,64x64,128x128,256x256');

ok('main logo files were not replaced', !fs.existsSync(path.join(REPO_ROOT, 'assets', 'inoichi-logo.png')) && !fs.existsSync(path.join(REPO_ROOT, 'assets', 'inoichi.ico')));
ok('harvest icon unchanged path still exists', fs.existsSync(path.join(REPO_ROOT, 'assets', 'harvest.ico')));

var script = fs.readFileSync(path.join(REPO_ROOT, 'inoichi-taskbar-shortcut.ps1'), 'utf8').toLowerCase();
ok('installer does not start harvest server', script.indexOf('harvest-local-server') === -1);
ok('installer does not mention line.me', script.indexOf('line.me') === -1);
ok('installer does not pin the taskbar', script.indexOf('taskbarpin') === -1 && script.indexOf('shell:appsfolder') === -1);

var emptyDesktop = tmpDir();
var missing = runInstaller([], { INO_DESKTOP_DIR: emptyDesktop });
eq('missing launcher exits 0', missing.status, 0);
ok('missing launcher creates no shortcut', fs.readdirSync(emptyDesktop).length === 0);
ok('missing launcher explains there is no local launcher', (missing.stdout || '').indexOf('no local launcher') !== -1);

var fixture = tmpDir();
var launch = path.join(fixture, 'inoichi-launch.ps1');
var stop = path.join(fixture, 'inoichi-stop.ps1');
fs.writeFileSync(launch, 'exit 0\n');
fs.writeFileSync(stop, 'exit 0\n');
var desktop = tmpDir();
var created = runInstaller(['-LaunchScript', launch, '-StopScript', stop], { INO_DESKTOP_DIR: desktop });
if (created.status !== 0) {
  console.error('STDOUT ' + (created.stdout || ''));
  console.error('STDERR ' + (created.stderr || ''));
}
eq('launcher present exits 0', created.status, 0);
var startLnk = path.join(desktop, 'INO-1 起動.lnk');
var stopLnk = path.join(desktop, 'INO-1 終了.lnk');
ok('start shortcut created', fs.existsSync(startLnk));
ok('stop shortcut created', fs.existsSync(stopLnk));
var iconPath = path.join(REPO_ROOT, 'assets', 'inoichi-taskbar.ico').toLowerCase();
var startInfo = readShortcut(startLnk).toLowerCase();
var stopInfo = readShortcut(stopLnk).toLowerCase();
ok('start shortcut uses taskbar ico', startInfo.indexOf(iconPath) !== -1);
ok('stop shortcut uses taskbar ico', stopInfo.indexOf(iconPath) !== -1);
ok('start shortcut targets the given launcher', startInfo.indexOf(launch.toLowerCase()) !== -1);
ok('stop shortcut targets the given stop script', stopInfo.indexOf(stop.toLowerCase()) !== -1);

var again = runInstaller(['-LaunchScript', launch, '-StopScript', stop], { INO_DESKTOP_DIR: desktop });
eq('reinstall exits 0', again.status, 0);
ok('own start shortcut updated in place', !fs.existsSync(path.join(desktop, 'INO-1 起動(1).lnk')));
ok('own stop shortcut updated in place', !fs.existsSync(path.join(desktop, 'INO-1 終了(1).lnk')));

var foreignDir = tmpDir();
var foreignPath = path.join(foreignDir, 'INO-1 起動.lnk');
var foreignCommand = "$s = (New-Object -ComObject WScript.Shell).CreateShortcut('" + foreignPath.replace(/'/g, "''") + "'); $s.TargetPath = '$env:SystemRoot\\System32\\notepad.exe'; $s.Save()";
spawnSync(POWERSHELL, ['-NoProfile', '-Command', foreignCommand], { encoding: 'utf8', windowsHide: true });
var beforeForeign = readShortcut(foreignPath);
runInstaller(['-LaunchScript', launch], { INO_DESKTOP_DIR: foreignDir });
var afterForeign = readShortcut(foreignPath);
ok('unrelated shortcut target unchanged', beforeForeign.split('ARGS=')[0] === afterForeign.split('ARGS=')[0]);
ok('new shortcut created beside unrelated file', fs.existsSync(path.join(foreignDir, 'INO-1 起動(1).lnk')));

if (failed === 0) {
  console.log('inoichi-taskbar-icon tests passed (' + passed + ' tests)');
  process.exit(0);
}
console.error('inoichi-taskbar-icon tests failed: ' + failed + ' failed, ' + passed + ' passed');
process.exit(1);
