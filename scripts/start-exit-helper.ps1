param([Parameter(Mandatory=$true)][string]$Manifest)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'windows-native.ps1')
$exe=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$command=[PortableNative]::Quote($exe)+' -NoProfile -ExecutionPolicy Bypass -File '+[PortableNative]::Quote((Join-Path $PSScriptRoot 'safe-exit-windows.ps1'))+' -Manifest '+[PortableNative]::Quote($Manifest)
[PortableNative]::Detached($exe,$command,$PSScriptRoot,($env:PORTABLE_AI_JOB -eq '1')) | Out-Null
exit 0
