# INO-1 Prototype 1 Desktop Launcher
# Usage: powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File inoichi-launch.ps1
# This script is designed to run with a hidden window. Fatal errors are shown in a dialog.

param(
  [int]$Port = 0
)

$ErrorActionPreference = 'Stop'

# ---- Configuration ----
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$DefaultPort = 8765
$ServerToken = 'inoichi-prototype1-step8'
$StartTimeoutSec = if ($env:INO_START_TIMEOUT_SEC) { [int]$env:INO_START_TIMEOUT_SEC } else { 30 }

if ($Port -eq 0) {
  $Port = if ($env:INO_PORT) { [int]$env:INO_PORT } else { $DefaultPort }
}

$AppDataDir = if ($env:INO_PID_DIR) { $env:INO_PID_DIR } else { Join-Path $env:LOCALAPPDATA 'INO-1' }
$LogFile = if ($env:INO_LOG_FILE) { $env:INO_LOG_FILE } else { Join-Path $AppDataDir 'launcher.log' }
$PidFile = Join-Path $AppDataDir 'server.pid'

# ---- Helpers ----
function Write-Log($Message) {
  try {
    if (-not (Test-Path $AppDataDir)) {
      New-Item -ItemType Directory -Path $AppDataDir -Force | Out-Null
    }
    $line = '{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $Message
    Add-Content -Path $LogFile -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue
  } catch {}
}

function Show-ErrorDialog($Message) {
  Write-Log "ERROR: $Message"
  if ($env:INO_TEST_NO_GUI -eq '1') { return }
  try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop | Out-Null
    [System.Windows.Forms.MessageBox]::Show($Message, 'INO-1 Launcher', 'OK', 'Error') | Out-Null
  } catch {
    # Fallback: open a visible console so the user can see the error.
    $escaped = $Message -replace '"', '\"'
    Start-Process powershell.exe -ArgumentList '-NoExit','-Command',"Write-Host 'INO-1 Launcher Error' -ForegroundColor Red; Write-Host `"$escaped`"" -WindowStyle Normal
  }
}

function Exit-WithError($Message) {
  Show-ErrorDialog $Message
  exit 1
}

function Test-InoichiServer($TestPort) {
  $result = @{ reachable = $false; isInoichi = $false; response = '' }
  $client = $null
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $async = $client.BeginConnect('127.0.0.1', $TestPort, $null, $null)
    $connected = $async.AsyncWaitHandle.WaitOne(1500, $false)
    if (-not $connected) {
      $client.Close()
      return $result
    }
    $client.EndConnect($async)

    $stream = $client.GetStream()
    $writer = New-Object System.IO.StreamWriter($stream)
    $writer.NewLine = "`r`n"
    $writer.WriteLine('GET / HTTP/1.1')
    $writer.WriteLine('Host: 127.0.0.1')
    $writer.WriteLine('Connection: close')
    $writer.WriteLine()
    $writer.Flush()

    $reader = New-Object System.IO.StreamReader($stream)
    $response = $reader.ReadToEnd()
    $result.reachable = $true
    $result.response = $response

    $headerToken = "X-INOICHI-Server: $ServerToken"
    $marker1 = 'INO-1 Prototype 1'
    $marker2 = 'Prototype 1 / sample data / not connected to production / no real notifications'

    if (($response -like "*$headerToken*") -or ($response -like "*$marker1*") -or ($response -like "*$marker2*")) {
      $result.isInoichi = $true
    }
  } catch {
    # Port not reachable or request failed; return default false result.
  } finally {
    if ($client -ne $null) { $client.Close() }
  }
  return $result
}

function Open-Dashboard($OpenPort) {
  if ($env:INO_NO_BROWSER -eq '1') { return }
  Start-Process "http://127.0.0.1:$OpenPort/"
}

# ---- 1. Node.js check ----
Write-Log 'Checking Node.js...'
try {
  $nodeVersion = & node --version 2>&1
  if ($LASTEXITCODE -ne 0) { throw "node exited with code $LASTEXITCODE" }
  Write-Log "Node.js version: $nodeVersion"
} catch {
  Exit-WithError "Node.js is not available. Please install Node.js.`nDetails: launcher.log ($LogFile)"
}

# ---- 2. Port check / reuse ----
Write-Log "Checking 127.0.0.1:$Port..."
$existing = Test-InoichiServer $Port
if ($existing.reachable) {
  if ($existing.isInoichi) {
    Write-Log 'INO-1 server is already running; opening Dashboard.'
    Open-Dashboard $Port
    exit 0
  } else {
    Exit-WithError "Port $Port is already used by another application.`nPlease make sure no other server is running on this port."
  }
}

# ---- 3. Start INO-1 server ----
$serverJs = Join-Path $RepoRoot 'inoichi-server.js'
if (-not (Test-Path $serverJs)) {
  Exit-WithError "Server file not found: $serverJs"
}

# Pass the chosen port to the Node.js server unless caller already set PORT explicitly.
if (-not $env:PORT) {
  $env:PORT = $Port
}

Write-Log "Starting INO-1 server: node $serverJs"
$proc = Start-Process -FilePath 'node' -ArgumentList "`"$serverJs`"" -WorkingDirectory $RepoRoot -WindowStyle Hidden -PassThru

# Wait briefly so StartTime is populated.
Start-Sleep -Milliseconds 300
if ($proc.HasExited) {
  Exit-WithError "Server did not become ready (exited while waiting). See launcher.log for details."
}

# Write PID file with creation time (UTC) to detect PID reuse.
try {
  if (-not (Test-Path $AppDataDir)) {
    New-Item -ItemType Directory -Path $AppDataDir -Force | Out-Null
  }
  $startedUtc = $proc.StartTime.ToUniversalTime().ToString('o')
  $pidContent = "PID=$($proc.Id)`r`nStarted=$startedUtc"
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($PidFile, $pidContent, $utf8NoBom)
  Write-Log "Server PID=$($proc.Id) Started=$startedUtc"
} catch {
  # PID file is not critical for launching; log and continue.
  Write-Log "WARNING: Could not write PID file: $_"
}

# ---- 4. Wait for HTTP ready ----
$deadline = (Get-Date).AddSeconds($StartTimeoutSec)
$ready = $false
while ((Get-Date) -lt $deadline) {
  if ($proc.HasExited) {
    Exit-WithError "Server did not become ready (exited while waiting). See launcher.log for details."
  }
  $check = Test-InoichiServer $Port
  if ($check.reachable -and $check.isInoichi) {
    $ready = $true
    break
  }
  Start-Sleep -Milliseconds 500
}

if (-not $ready) {
  try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
  try { Remove-Item $PidFile -Force -ErrorAction SilentlyContinue } catch {}
  Exit-WithError "Server did not become ready within $StartTimeoutSec seconds. See launcher.log for details."
}

Write-Log 'INO-1 server is ready; opening Dashboard.'
Open-Dashboard $Port
exit 0
