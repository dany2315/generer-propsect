$workerPatterns = @(
  '*collect-sci*',
  '*enrich-sci*',
  '*extract-establishments*',
  '*enrich-web-contacts*',
  '*discover-contact-leads*',
  '*enrich-sirene-complete*',
  '*enrich-rne-inpi*',
  '*index-rne-formalites*',
  '*extract-rne-profiles*'
)

$processes = Get-CimInstance Win32_Process -Filter "name = 'node.exe'" |
  Where-Object {
    $commandLine = $_.CommandLine
    $workerPatterns | Where-Object { $commandLine -like $_ }
  }

if (-not $processes) {
  Write-Output "Aucun worker actif."
  exit 0
}

foreach ($process in $processes) {
  Stop-Process -Id $process.ProcessId -Force
  Write-Output "Worker arrete: PID $($process.ProcessId)"
}
