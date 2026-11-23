$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$outputRoot = Join-Path $projectRoot 'release-single'
$appRoot = Join-Path $outputRoot 'win-unpacked'
$exePath = Join-Path $appRoot 'Darkys.exe'
$asarPath = Join-Path $appRoot 'resources\app.asar'
$stageRoot = Join-Path $outputRoot 'sfx-staging'
$payloadPath = Join-Path $stageRoot 'Darkys-payload.zip'
$launchPath = Join-Path $stageRoot 'launch.cmd'
$sedPath = Join-Path $stageRoot 'Darkys.sed'
$targetPath = Join-Path $outputRoot 'Darkys.exe'

if (!(Test-Path -LiteralPath $exePath -PathType Leaf) -or !(Test-Path -LiteralPath $asarPath -PathType Leaf)) {
  throw 'Electron klasörü eksik. Önce electron-builder --win dir --x64 çalıştır.'
}

$metadataScript = Join-Path $PSScriptRoot 'set-windows-metadata.mjs'
& node $metadataScript $exePath
if ($LASTEXITCODE -ne 0) { throw 'Darkys.exe simgesi ve sürüm bilgileri ayarlanamadı.' }

New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
if (Test-Path -LiteralPath $payloadPath) { Remove-Item -LiteralPath $payloadPath -Force }
Compress-Archive -Path (Join-Path $appRoot '*') -DestinationPath $payloadPath -CompressionLevel Fastest

$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version
$installVersion = "app-$version"
$hashAlgorithm = [System.Security.Cryptography.SHA256]::Create()
$asarStream = [System.IO.File]::OpenRead($asarPath)
try { $buildId = [System.BitConverter]::ToString($hashAlgorithm.ComputeHash($asarStream)).Replace('-', '').ToLowerInvariant() }
finally { $asarStream.Dispose(); $hashAlgorithm.Dispose() }
$launchScript = @"
@echo off
setlocal
set "INSTALL=%LOCALAPPDATA%\Darkys\$installVersion"
set "BUILD_ID=$buildId"
set "BUILD_STAMP=%INSTALL%\darkys-build.txt"
set "INSTALLED_BUILD="
if exist "%BUILD_STAMP%" set /p "INSTALLED_BUILD="<"%BUILD_STAMP%"
if not exist "%INSTALL%\resources\app.asar" goto install
if not "%INSTALLED_BUILD%"=="%BUILD_ID%" goto install
goto run
:install
  if not exist "%INSTALL%" mkdir "%INSTALL%"
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Force -LiteralPath '%~dp0Darkys-payload.zip' -DestinationPath '%INSTALL%'"
  if errorlevel 1 exit /b 1
:verify
if not exist "%INSTALL%\resources\app.asar" exit /b 2
>"%BUILD_STAMP%" echo %BUILD_ID%
:run
start "" "%INSTALL%\Darkys.exe"
"@
Set-Content -LiteralPath $launchPath -Value $launchScript -Encoding ASCII

$sed = @"
[Version]
Class=IEXPRESS
SEDVersion=3

[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=0
HideExtractAnimation=1
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=
DisplayLicense=
FinishMessage=
TargetName=$targetPath
FriendlyName=Darkys
AppLaunched=cmd.exe /c launch.cmd
PostInstallCmd=<None>
AdminQuietInstCmd=
UserQuietInstCmd=
SourceFiles=SourceFiles

[Strings]
FILE0="Darkys-payload.zip"
FILE1="launch.cmd"

[SourceFiles]
SourceFiles0=$stageRoot\

[SourceFiles0]
%FILE0%=
%FILE1%=
"@
Set-Content -LiteralPath $sedPath -Value $sed -Encoding ASCII

$iexpressPath = Join-Path $env:WINDIR 'System32\iexpress.exe'
if (Test-Path -LiteralPath $targetPath) { Remove-Item -LiteralPath $targetPath -Force }
$build = Start-Process -FilePath $iexpressPath -ArgumentList @('/N', $sedPath) -WorkingDirectory $stageRoot -PassThru -Wait
if ($build.ExitCode -ne 0) { throw "IExpress tek dosya paketini oluşturamadı (kod $($build.ExitCode))." }

if (!(Test-Path -LiteralPath $targetPath -PathType Leaf)) { throw 'Tek dosyalı Darkys.exe oluşturulamadı.' }
# IExpress creates a new outer executable, so apply the launcher icon to this file too.
& node $metadataScript $targetPath
if ($LASTEXITCODE -ne 0) { throw 'Tek dosyalı Darkys.exe simgesi ve sürüm bilgileri ayarlanamadı.' }

$artifact = Get-Item -LiteralPath $targetPath
if ($artifact.Length -lt 100000000) { throw 'Oluşturulan Darkys.exe beklenenden küçük; paket eksik olabilir.' }
Write-Output "Single-file build ready: $($artifact.FullName) ($([math]::Round($artifact.Length / 1MB)) MB)"
