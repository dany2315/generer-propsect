Write-Output "Workers actifs pour ce projet:"

Get-CimInstance Win32_Process -Filter "name = 'node.exe'" |
  Where-Object {
    $_.CommandLine -like '*collect-sci*' -or
    $_.CommandLine -like '*enrich-sci*' -or
    $_.CommandLine -like '*extract-establishments*'
  } |
  Select-Object ProcessId, CommandLine
