param(
    [Parameter(Mandatory=$true)][string]$Target,
    [Parameter(Mandatory=$true)][string]$NodeExe,
    [Parameter(Mandatory=$true)][string]$OllamaDirectory,
    [string]$ModelRoot,
    [string]$Manifest,
    [string]$ModelName,
    [switch]$DirectModel
)
$ErrorActionPreference = 'Stop'
$sourceRoot = Split-Path -Parent $PSScriptRoot
$targetPath = [IO.Path]::GetFullPath($Target)
if (Test-Path -LiteralPath $targetPath) { throw 'Use a new empty target directory to avoid overwriting existing data.' }
if ($targetPath -eq [IO.Path]::GetPathRoot($targetPath)) { throw 'Target must be a subdirectory, not a drive root.' }
New-Item -ItemType Directory -Path "$targetPath\runtime\node", "$targetPath\runtime\ollama", "$targetPath\data" -Force | Out-Null
foreach ($item in @('server.mjs','package.json','Start-Windows.cmd','README.md','LICENSE','lib','web','scripts','tests','docs')) {
    Copy-Item -LiteralPath (Join-Path $sourceRoot $item) -Destination $targetPath -Recurse
}
Copy-Item -LiteralPath $NodeExe -Destination "$targetPath\runtime\node\node.exe"
Copy-Item -LiteralPath (Join-Path $OllamaDirectory 'ollama.exe') -Destination "$targetPath\runtime\ollama\ollama.exe"
Copy-Item -LiteralPath (Join-Path $OllamaDirectory 'lib') -Destination "$targetPath\runtime\ollama\lib" -Recurse
if ($ModelRoot -and $Manifest -and $ModelName) {
    $importArgs = @((Join-Path $sourceRoot 'scripts\import-model.mjs'), $ModelRoot, $Manifest, "$targetPath\models", $ModelName)
    if ($DirectModel) { $importArgs += '--direct' }
    & $NodeExe @importArgs
    if ($LASTEXITCODE -ne 0) { throw 'Model import failed' }
}
Write-Output "Package ready: $targetPath. Include Node/Ollama/runtime licenses before distribution."
