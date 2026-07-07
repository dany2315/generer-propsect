$existing = Get-CimInstance Win32_Process -Filter "name = 'node.exe'" |
  Where-Object { $_.CommandLine -like '*collect-sci*' }

if ($existing) {
  Write-Output "Collecteur SCI deja actif."
  $existing | Select-Object ProcessId, CommandLine
  exit 0
}

$logDir = Join-Path (Get-Location) "data"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$command = 'npm run collect -- --sleep 250 --cycle-sleep 3600000 --max-prospects 10000 *> .\data\collector.log'
$process = Start-Process `
  -FilePath "powershell.exe" `
  -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $command) `
  -WorkingDirectory (Get-Location) `
  -WindowStyle Hidden `
  -PassThru

Write-Output "Collecteur SCI relance: PID $($process.Id)"
Write-Output "Reprise depuis les checkpoints en base."
