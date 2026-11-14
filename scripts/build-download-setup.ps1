param(
 [Parameter(Mandatory=$true)][string]$Compiler,
 [string]$PayloadUrl
)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$version=(Get-Content -LiteralPath (Join-Path $root 'build-info.json') -Raw | ConvertFrom-Json).version
$release=Join-Path $root 'release'
$output=Join-Path $release 'download-setup'
$payloadDir=Join-Path $output 'payload'
$stem="Hololive-Dreams-Planner-${version}-Windows-x64-Setup"
$inner=Join-Path $release "$stem.exe"
$one="$stem-1.bin"
$two="$stem-2.bin"
$hashOne=(Get-FileHash -LiteralPath (Join-Path $release $one)).Hash.ToLowerInvariant()
$hashTwo=(Get-FileHash -LiteralPath (Join-Path $release $two)).Hash.ToLowerInvariant()
$iscc=(Resolve-Path -LiteralPath $Compiler).Path
if(!$PayloadUrl){$PayloadUrl="https://github.com/totallynottuco/holodori-planner/releases/download/installer-data-v$version"}
New-Item -ItemType Directory -Path $payloadDir -Force | Out-Null
$manifest=Join-Path $output 'installer-data.txt'
$hasher=[Security.Cryptography.SHA256]::Create()
$buffer=New-Object byte[] (24MB)
try {
 $entries=for($volume=1;$volume -le 2;$volume++){
  $volumePath=Join-Path $release "$stem-$volume.bin"
  $stream=[IO.File]::OpenRead($volumePath)
  try {
   $part=0
   while($stream.Position -lt $stream.Length){
    $length=[int][Math]::Min($buffer.Length,$stream.Length-$stream.Position)
    $read=0
    while($read -lt $length){
     $count=$stream.Read($buffer,$read,$length-$read)
     if(!$count){throw "Unexpected end of installer volume $volume"}
     $read+=$count
    }
    $name='installer-data-{0}-{1:D3}.bin' -f $volume,$part
    $file=[IO.File]::Create((Join-Path $payloadDir $name))
    try{$file.Write($buffer,0,$length)}finally{$file.Dispose()}
    $hash=[BitConverter]::ToString($hasher.ComputeHash($buffer,0,$length)).Replace('-','').ToLowerInvariant()
    "$name=$hash"
    $part++
   }
  } finally {$stream.Dispose()}
 }
 $entries | Set-Content -LiteralPath $manifest -Encoding Ascii
} finally {$hasher.Dispose()}
& $iscc '/Q' "/O$output" "/DProjectRoot=$root" "/DAppVersion=$version" "/DPayloadSetup=$inner" "/DPayloadUrl=$PayloadUrl" "/DPayloadManifest=$manifest" "/DHashOne=$hashOne" "/DHashTwo=$hashTwo" (Join-Path $PSScriptRoot 'holodori-download-setup.iss')
if($LASTEXITCODE){throw 'Download Setup compilation failed.'}
$setup=Get-Item -LiteralPath (Join-Path $output "$stem.exe")
'{0}  {1}' -f (Get-FileHash -LiteralPath $setup.FullName).Hash.ToLowerInvariant(),$setup.Name |
 Set-Content -LiteralPath (Join-Path $output 'SHA256SUMS.txt') -Encoding Ascii
