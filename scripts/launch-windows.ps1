param([ValidateSet('web','agent','exit')][string]$Mode='web',[string]$Workspace)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
# Neither the launcher nor the ejection supervisor keeps a USB working directory.
Set-Location -LiteralPath $env:TEMP
if($Mode -eq 'exit'){
  $folder=Join-Path $env:TEMP ('PortableAI-exit-'+[guid]::NewGuid().ToString())
  New-Item -ItemType Directory -Path $folder | Out-Null
  foreach($name in @('windows-native.ps1','safe-exit-windows.ps1','start-exit-helper.ps1','usb-disk-info.ps1')){Copy-Item -LiteralPath (Join-Path $root ('scripts\'+$name)) -Destination (Join-Path $folder $name)}
  $manifest=Join-Path $folder 'request.json';@{root=$root;eject=$true;checkOnly=$false;quiet=$false}|ConvertTo-Json|Set-Content -LiteralPath $manifest -Encoding UTF8
  & (Join-Path $folder 'start-exit-helper.ps1') -Manifest $manifest
  exit $LASTEXITCODE
}
. (Join-Path $root 'scripts\windows-native.ps1')
$node=Join-Path $root 'runtime\node\node.exe'
if(-not(Test-Path -LiteralPath $node)){throw 'Portable Node is missing. Use the complete Windows package.'}
$entry=if($Mode -eq 'web'){'server.mjs'}else{'cli.mjs'}
$command=[PortableNative]::Quote($node)+' '+[PortableNative]::Quote((Join-Path $root $entry))
if($Mode -eq 'web'){$command+=' --open'}else{$command+=' --connect';if($Workspace){$command+=' --workspace '+[PortableNative]::Quote($Workspace)}}
$env:PORTABLE_AI_JOB='1'
exit ([PortableNative]::Guard($node,$command,$env:TEMP))
