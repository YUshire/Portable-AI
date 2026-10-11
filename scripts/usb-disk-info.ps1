param([Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z]:$')][string]$Drive)
$ErrorActionPreference='Stop'
# Run disk discovery in a short-lived process, separate from the eject caller.
$logical=Get-CimInstance Win32_LogicalDisk -Filter ("DeviceID='"+$Drive+"'")
if(-not $logical){throw 'Drive is not present'}
$partitions=@(Get-CimAssociatedInstance -InputObject $logical -Association Win32_LogicalDiskToPartition)
$disks=@($partitions|ForEach-Object{Get-CimAssociatedInstance -InputObject $_ -Association Win32_DiskDriveToDiskPartition}|Sort-Object DeviceID -Unique)
if($disks.Count -ne 1 -or $disks[0].InterfaceType -ne 'USB'){throw 'Drive does not map to one verified USB disk'}
@{pnpDeviceId=[string]$disks[0].PNPDeviceID}|ConvertTo-Json -Compress
