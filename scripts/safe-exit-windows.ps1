param([Parameter(Mandatory=$true)][string]$Manifest)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$request=Get-Content -LiteralPath $Manifest -Raw -Encoding UTF8|ConvertFrom-Json
$root=[IO.Path]::GetFullPath([string]$request.root).TrimEnd('\')
if($root -eq [IO.Path]::GetPathRoot($root).TrimEnd('\')){throw '应用目录不能直接是盘符根目录'}
Set-Location -LiteralPath $PSScriptRoot
$resultFile=Join-Path $PSScriptRoot 'result.json'
$result=[ordered]@{status='blocked';message='';processes=@();drive=[IO.Path]::GetPathRoot($root);systemEjectConfirmed=$false}
$lock=Join-Path $root 'data\run\exit.lock';$lockId=[guid]::NewGuid().ToString();$ownsLock=$false
function Get-OwnedInstances {
  $items=@()
  foreach($file in @(Get-ChildItem -LiteralPath (Join-Path $root 'data\run') -Filter '*.json' -ErrorAction SilentlyContinue)){
    try{$record=Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8|ConvertFrom-Json}catch{continue}
    if([string]$record.root -ne $root -or $record.controlUrl -notmatch '^http://127\.0\.0\.1:\d+$' -or [string]$record.secret -notmatch '^[0-9a-f]{64}$'){continue}
    $process=Get-Process -Id ([int]$record.pid) -ErrorAction SilentlyContinue
    if(-not $process){continue}
    try{
      $health=Invoke-RestMethod -Uri ($record.controlUrl+'/health') -Headers @{'x-portable-control'=$record.secret} -TimeoutSec 2
      if($health.id -ne $record.id -or $health.pid -ne $record.pid -or $health.root -ne $root){throw '实例身份不匹配'}
      $items+=@{record=$record;startTicks=$process.StartTime.ToUniversalTime().Ticks}
    }catch{if(-not(Get-Process -Id ([int]$record.pid) -ErrorAction SilentlyContinue) -or -not(Test-Path -LiteralPath $file.FullName)){continue};throw '无法验证一个已登记实例。请关闭其窗口后重试；没有结束其他程序。'}
  }
  return $items
}
try{
  if(-not $request.checkOnly){
    New-Item -ItemType Directory -Path (Split-Path -Parent $lock) -Force|Out-Null
    if(Test-Path -LiteralPath $lock){
      $previous=Get-Content -LiteralPath $lock -Raw -Encoding UTF8|ConvertFrom-Json
      if([int]$previous.pid -gt 0 -and -not(Get-Process -Id ([int]$previous.pid) -ErrorAction SilentlyContinue)){
        $current=Get-Content -LiteralPath $lock -Raw -Encoding UTF8|ConvertFrom-Json
        if($current.id -eq $previous.id){Remove-Item -LiteralPath $lock -Force}
      }
    }
    try{$stream=[IO.File]::Open($lock,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read);$text=@{pid=$PID;id=$lockId}|ConvertTo-Json -Compress;$bytes=[Text.Encoding]::UTF8.GetBytes($text);$stream.Write($bytes,0,$bytes.Length);$stream.Dispose();$ownsLock=$true}
    catch{throw '另一项安全退出正在进行，请等待结果。'}
  }
  $instances=@(Get-OwnedInstances)
  $result.processes=@($instances|ForEach-Object{$_.record.pid})
  if($request.checkOnly){$result.status='checked';$result.message='只读检查完成，未结束进程，未弹出设备。'}
  else{
    foreach($item in $instances){$r=$item.record;try{Invoke-RestMethod -Method Post -Uri ($r.controlUrl+'/stop') -Headers @{'x-portable-control'=$r.secret} -TimeoutSec 3|Out-Null}catch{$p=Get-Process -Id ([int]$r.pid) -ErrorAction SilentlyContinue;if($p -and $p.StartTime.ToUniversalTime().Ticks -eq $item.startTicks -and (Test-Path -LiteralPath (Join-Path $root ('data\run\'+$r.id+'.json')))){throw}}}
    $deadline=(Get-Date).AddSeconds(45)
    do{
      $remaining=@($instances|Where-Object{$p=Get-Process -Id ([int]$_.record.pid) -ErrorAction SilentlyContinue;$p -and $p.StartTime.ToUniversalTime().Ticks -eq $_.startTicks})
      if($remaining.Count -eq 0){break};Start-Sleep -Milliseconds 200
    }while((Get-Date) -lt $deadline)
    if($remaining.Count){throw '程序尚未完成保存或清理，本次弹出已取消。请等待任务停止后重试。'}
    # Refuse to declare success if an older/unregistered app or orphan remains.
    $releaseDeadline=(Get-Date).AddSeconds(5)
    do{$portable=@(Get-CimInstance Win32_Process|Where-Object{$_.ExecutablePath -and ([string]$_.ExecutablePath).StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)});if(-not $portable.Count){break};Start-Sleep -Milliseconds 200}while((Get-Date) -lt $releaseDeadline)
    if($portable.Count){throw '仍有旧版本或未登记的便携程序运行。请关闭其窗口后重试；没有强制结束该程序。'}
    if(-not $request.eject){$result.status='closed';$result.message='PortableAI 已退出，设备尚未弹出。'}
    else{
      . (Join-Path $PSScriptRoot 'windows-native.ps1')
      $drive=[IO.Path]::GetPathRoot($root).TrimEnd('\')
      $ps=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
      $diskText=& $ps -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'usb-disk-info.ps1') -Drive $drive
      if($LASTEXITCODE -ne 0){throw '无法确认应用所在磁盘是可弹出的 USB 设备，未执行强制卸载。'}
      $diskInfo=($diskText -join "`n")|ConvertFrom-Json
      [uint32]$node=0;if([PortableNative]::CM_Locate_DevNodeW([ref]$node,$diskInfo.pnpDeviceId,0) -ne 0){throw '无法定位 USB 设备。'}
      $found=$false
      for($i=0;$i -lt 8;$i++){
        $deviceId=New-Object Text.StringBuilder 1024
        if([PortableNative]::CM_Get_Device_IDW($node,$deviceId,1024,0) -ne 0){break}
        if($deviceId.ToString() -match '^USB\\VID_'){$found=$true;break}
        [uint32]$parent=0;if([PortableNative]::CM_Get_Parent([ref]$parent,$node,0) -ne 0){break};$node=$parent
      }
      if(-not $found){throw '无法安全识别 USB 设备，未执行强制卸载。'}
      for($attempt=1;$attempt -le 3;$attempt++){
        [int]$veto=0;$vetoName=New-Object Text.StringBuilder 1024
        [void]$vetoName.Append([char]0,1024)
        $code=[PortableNative]::CM_Request_Device_EjectW($node,[ref]$veto,$vetoName,1024,0)
        if($code -eq 0 -or $veto -notin @(2,5,6)){break}
        if($attempt -lt 3){Start-Sleep -Milliseconds 600}
      }
      if($code -ne 0){
        $result.errorCode=$code;$result.vetoType=$veto;$result.deviceSource=$vetoName.ToString().Split([char]0)[0];$result.attempts=[Math]::Min($attempt,3)
        $reason=switch($veto){
          2 {'设备还在关闭文件，请稍后重试。'}
          3 {'Windows 报告有应用阻止弹出，请关闭使用此 U 盘的文件或窗口后重试。'}
          4 {'Windows 报告有系统服务阻止弹出。'}
          5 {'磁盘仍有未释放的文件句柄，Windows 未提供具体程序名称。'}
          6 {'设备或磁盘卷拒绝移除，Windows 未提供具体程序名称。'}
          7 {'设备驱动拒绝移除。'}
          12 {'当前用户权限不足，Windows 未允许弹出。'}
          default {'Windows 尚未允许安全移除该设备。'}
        }
        throw ('PortableAI 后台已停止，但 U 盘尚未安全弹出。'+"`n"+$reason+"`n"+'请使用 Windows 的“安全删除硬件”再次确认；确认成功前请勿拔出。')
      }
      $result.status='ejected';$result.systemEjectConfirmed=$true;$result.message='Windows 已确认安全弹出，现在可以拔出 U 盘。'
    }
  }
}catch{$result.message=$_.Exception.Message}
finally{
  if($ownsLock -and (Test-Path -LiteralPath $lock)){try{$owner=Get-Content -LiteralPath $lock -Raw -Encoding UTF8|ConvertFrom-Json;if($owner.id -eq $lockId){Remove-Item -LiteralPath $lock -Force}}catch{}}
  $result|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $resultFile -Encoding UTF8
}
if(-not $request.quiet){
  Add-Type -AssemblyName System.Windows.Forms
  $label=switch($result.status){'ejected'{'已安全弹出，可以拔出 U 盘'}'closed'{'PortableAI 已退出，尚未弹出设备'}'checked'{'检查完成'}default{'尚未安全弹出'}}
  [System.Windows.Forms.MessageBox]::Show($label+"`n`n"+$result.message,'PortableAI · 安全退出')|Out-Null
}
