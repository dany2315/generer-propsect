$processes = Get-CimInstance Win32_Process -Filter "name = 'node.exe'" |
  Where-Object { $_.CommandLine -like '*collect-sci*' }

if (-not $processes) {
  Write-Output "Aucun collecteur SCI actif."
  exit 0
}

foreach ($process in $processes) {
  Stop-Process -Id $process.ProcessId -Force
  Write-Output "Collecteur SCI arrete: PID $($process.ProcessId)"
}
