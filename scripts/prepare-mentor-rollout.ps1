# Prints the mentor rollout plan. Does not stop processes, copy files, or reload Chrome.
# Re-run with -Apply only after the operator has approved each step.
param([switch]$Apply)

$ErrorActionPreference = 'Stop'
Write-Output 'Mentor rollout plan. This script does not apply changes unless -Apply is set.'
Write-Output 'OFK3 files: mentor-startup-notice.js, mentor-startup-route.js, mentor-startup-schedule.js, friday/mentor-startup-alerts.js, cortex-capture-extension/*'
Write-Output 'FRIDAY file: public/mentor-startup-alerts.js only. Do not replace public/app.js.'
Write-Output 'FRIDAY app.js change: insert __FRIDAY_SPEECH_BUSY around the current speakText. Use scripts/check-live-speech-busy.mjs as the check.'
Write-Output 'Extension: reload only after approval. Do not set a mentor speech time.'
Write-Output 'Processes that need a later restart after approval: OFK3 port 3000. FRIDAY port 3200 does not need a restart for static files.'
Write-Output 'Rollback: restore the previous files from git on each branch and restart only the process that was approved.'
if (-not $Apply) {
  Write-Output 'No files were copied and no process was stopped.'
  exit 0
}
Write-Output 'Apply is disabled in this preparation script.'
exit 1
