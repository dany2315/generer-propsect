Write-Output "Workers actifs pour ce projet:"

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

Get-CimInstance Win32_Process -Filter "name = 'node.exe'" |
  Where-Object {
    $commandLine = $_.CommandLine
    $workerPatterns | Where-Object { $commandLine -like $_ }
  } |
  Select-Object ProcessId, CommandLine
