<# : batch part - runs the PowerShell part below, then waits so the result can be read
@echo off
set "QDP_SELF=%~f0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "iex ([IO.File]::ReadAllText($env:QDP_SELF))"
echo.
pause
exit /b
#>

# ============================================================================
#  Quick DICOM Planning - Windows helper ("open the whole series")
#
#  A web app only receives the single file that was double-clicked. This helper
#  registers itself for .dcm/.dicom/.dic/.ima files; on a double-click it packs
#  all files of that folder into one uncompressed bundle and opens the installed
#  Quick DICOM Planning app with it, so the whole scan opens without any prompt.
#
#  Installs for the current user only (no admin rights). Files go to
#  %LOCALAPPDATA%\QuickDICOMPlanning; uninstall with uninstall.cmd there. The temporary
#  series bundles go to %USERPROFILE%\QuickDICOMPlanning\bundles (deleted after 12 hours).
# ============================================================================

$ErrorActionPreference = 'Stop'
$AppName = 'Quick DICOM Planning'
$HelperName = 'Quick DICOM Planning (whole series)'
$ProgId = 'QuickDICOMPlanning.Series'
$Exts = @('.dcm', '.dicom', '.dic', '.ima')
$Base = Join-Path $env:LOCALAPPDATA 'QuickDICOMPlanning'
$Classes = 'HKCU:\Software\Classes'

function Get-Default([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  return (Get-Item -LiteralPath $Path).GetValue('')
}
function Ensure-Key([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { New-Item -Path $Path -Force | Out-Null }
}

Write-Host ''
Write-Host "  $AppName - Windows helper" -ForegroundColor Cyan
Write-Host ''

# --- 1. find how Windows starts the installed web app ------------------------------
$found = @()
$progIds = @()
foreach ($e in $Exts) {
  $k = "$Classes\$e\OpenWithProgids"
  if (Test-Path -LiteralPath $k) { $progIds += (Get-Item -LiteralPath $k).GetValueNames() }
}
foreach ($p in ($progIds | Where-Object { $_ -and $_ -ne $ProgId } | Select-Object -Unique)) {
  $cmd = Get-Default "$Classes\$p\shell\open\command"
  if ($cmd -and $cmd -match '--app-id=') {
    $name = $null
    if (Test-Path -LiteralPath "$Classes\$p\Application") { $name = (Get-Item -LiteralPath "$Classes\$p\Application").GetValue('ApplicationName') }
    $found += New-Object psobject -Property @{ ProgId = $p; Command = $cmd; Name = $name }
  }
}
$cands = @($found | Where-Object { "$($_.Name) $($_.Command)" -like '*DICOM*' })
# installed in Chrome and Edge: use the Edge copy (Edge can be given the NVIDIA card on its own)
$pick = $cands | Where-Object { $_.Command -match 'msedge' } | Select-Object -First 1
if (-not $pick) { $pick = $cands | Select-Object -First 1 }
if ($cands.Count -gt 1 -and $pick.Command -match 'msedge') { Write-Host '  The app is installed in more than one browser - using the Microsoft Edge copy.' }
if (-not $pick -and $found.Count -eq 1) { $pick = $found[0] }
if (-not $pick) {
  # slower fallback: look through all registered file types of this user
  foreach ($k in (Get-ChildItem -LiteralPath $Classes -ErrorAction SilentlyContinue)) {
    $a = $k.OpenSubKey('Application')
    if (-not $a) { continue }
    $n = $a.GetValue('ApplicationName'); $a.Close()
    if ("$n" -notlike "*$AppName*" -or "$n" -like '*whole series*') { continue }
    $c = $k.OpenSubKey('shell\open\command')
    if (-not $c) { continue }
    $cmd = $c.GetValue(''); $c.Close()
    if ($cmd -match '--app-id=') { $pick = New-Object psobject -Property @{ ProgId = $k.PSChildName; Command = $cmd; Name = $n }; break }
  }
}
if (-not $pick) {
  # the browser has not registered the app for DICOM files (Edge may do that only later): use the
  # app's Start menu / desktop shortcut instead - started with --app-id=<id> and a file, the
  # browser opens the file in the installed app exactly like a registered file handler
  $shortcuts = @()
  try {
    $wsh = New-Object -ComObject WScript.Shell
    $dirs = @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('CommonPrograms'), [Environment]::GetFolderPath('Desktop'))
    foreach ($d in ($dirs | Where-Object { $_ -and (Test-Path -LiteralPath $_) })) {
      foreach ($f in (Get-ChildItem -LiteralPath $d -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue)) {
        if ($f.BaseName -notlike "*$AppName*" -or $f.BaseName -like '*whole series*') { continue }
        $l = $wsh.CreateShortcut($f.FullName)
        $args0 = [string]$l.Arguments
        if (-not ($args0 -match '--app-id=([A-Za-z0-9_-]+)')) { continue }
        $appId = $Matches[1]
        $prof = ''
        if ($args0 -match '(--profile-directory=("[^"]*"|\S+))') { $prof = $Matches[1] + ' ' }
        $cmd = '"' + $l.TargetPath + '" ' + $prof + '--app-id=' + $appId + ' --single-argument %1'
        $shortcuts += New-Object psobject -Property @{ ProgId = ''; Command = $cmd; Name = $f.BaseName; Icon = [string]$l.IconLocation }
      }
    }
  } catch { Write-Host ('  (Could not read the Start menu shortcuts: ' + $_.Exception.Message + ')') }
  $pick = $shortcuts | Where-Object { $_.Command -match 'msedge' } | Select-Object -First 1
  if (-not $pick) { $pick = $shortcuts | Select-Object -First 1 }
}
if (-not $pick) {
  Write-Host '  The installed Quick DICOM Planning app was not found.' -ForegroundColor Yellow
  Write-Host ''
  Write-Host '  Programs registered for .dcm files:'
  if (-not $found.Count) { Write-Host '    (none from a browser)' }
  foreach ($x in $found) { Write-Host ('    ' + $x.Name + ' : ' + $x.Command) }
  Write-Host ''
  Write-Host '  1. Open https://quickdicom.app/ in Chrome or Edge'
  Write-Host '     and click "Install app".'
  Write-Host '  2. Run this helper again.'
  exit 1
}
Write-Host "  Found the installed app: $($pick.Name)"
Write-Host "  Start command: $($pick.Command)"

# --- 2. write the launcher ---------------------------------------------------------
New-Item -ItemType Directory -Force -Path $Base | Out-Null
[IO.File]::WriteAllText((Join-Path $Base 'launch.txt'), $pick.Command)
Add-Content -LiteralPath (Join-Path $Base 'log.txt') -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  installed; app ' + $pick.Name + ' (' + $pick.ProgId + '); command ' + $pick.Command)

$launcherPs1 = @'
# Quick DICOM Planning - opens the whole folder of a double-clicked DICOM file.
param([string]$File)
$ErrorActionPreference = 'Stop'
$Base = Join-Path $env:LOCALAPPDATA 'QuickDICOMPlanning'
$Log = Join-Path $Base 'log.txt'
function Log([string]$Msg) {
  try {
    if ((Test-Path -LiteralPath $Log) -and (Get-Item -LiteralPath $Log).Length -gt 200KB) { Remove-Item -LiteralPath $Log -Force }
    Add-Content -LiteralPath $Log -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $Msg)
  } catch { }
}
Log ('---- double-click: ' + $File)
if (-not $File) { Log 'no file argument'; exit 0 }
if ($File.StartsWith((Join-Path $Base 'example'), [StringComparison]::OrdinalIgnoreCase)) { Log 'example file, ignored'; exit 0 }
$template = ([IO.File]::ReadAllText((Join-Path $Base 'launch.txt'))).Trim()
Log ('app command template: ' + $template)

function Start-App([string]$Path) {
  $quoted = '"' + $Path + '"'
  $cmd = $template
  # Chrome/Edge register '--single-argument %1': everything after that switch is taken
  # literally as ONE argument, so the path must not be quoted (quotes would become part of it)
  if ($cmd -match '--single-argument') { $quoted = $Path }
  $done = $false
  foreach ($tok in @('"%1"', '"%L"', '%1', '%L')) {
    if (-not $done -and $cmd.Contains($tok)) { $cmd = $cmd.Replace($tok, $quoted); $done = $true }
  }
  $cmd = $cmd.Replace('"%*"', '').Replace('%*', '')
  if (-not $done) { $cmd = $cmd + ' ' + $quoted }
  if ($cmd -match '^\s*"([^"]+)"\s*(.*)$') { $exe = $Matches[1]; $rest = $Matches[2] }
  elseif ($cmd -match '^\s*(\S+)\s*(.*)$') { $exe = $Matches[1]; $rest = $Matches[2] }
  else { Log ('could not parse command: ' + $cmd); return }
  Log ('starting: [' + $exe + '] ' + $rest)
  if (-not (Test-Path -LiteralPath $exe)) { Log 'WARNING: that program does not exist (app reinstalled? run the helper installer again)' }
  try {
    $p = [Diagnostics.Process]::Start($exe, $rest)
    Log ('started, process id ' + $(if ($p) { $p.Id } else { '(handed to running browser)' }))
  } catch { Log ('START FAILED: ' + $_.Exception.Message) }
}

try {
  $dir = [IO.Path]::GetDirectoryName($File)
  $skip = '(?i)\.(txt|xml|ini|htm|html|pdf|jpg|jpeg|png|bmp|gif|tif|tiff|exe|dll|lnk|zip|rar|7z|db|log|json|csv|inf|bat|cmd|ps1|vbs|url|iso|stl|ply|obj|mp4|avi|doc|docx|xls|xlsx)$'
  $all = @(Get-ChildItem -LiteralPath $dir -File -Force | Where-Object {
      $_.Name -notmatch $skip -and -not $_.Name.StartsWith('._') -and $_.Length -gt 0 })
  $total = 0; foreach ($f in $all) { $total += $f.Length }
  Log ('folder: ' + $dir + '  -> ' + $all.Count + ' files, ' + [math]::Round($total / 1MB, 1) + ' MB')
  if ($all.Count -le 1) { Start-App $File; exit 0 }

  # one bundle (a ZIP named .dcm, which the app unpacks). Chrome / Edge refuse to let web apps read
  # files under AppData (temp folder included) and in hidden dot-folders of the user folder
  # (SecurityError), so it goes to a plain folder in the user folder: %USERPROFILE%\QuickDICOMPlanning
  $root = Join-Path $env:USERPROFILE 'QuickDICOMPlanning'
  $out = Join-Path $root 'bundles'
  New-Item -ItemType Directory -Force -Path $out | Out-Null
  $readme = Join-Path $root 'README.txt'
  if (-not (Test-Path -LiteralPath $readme)) {
    [IO.File]::WriteAllText($readme, "Quick DICOM Planning helper: temporary copies of the DICOM series opened by double-click`r`n(bundles\*.dcm, deleted after 12 hours). Safe to delete.`r`n")
  }
  Get-ChildItem -LiteralPath $out -File -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddHours(-12) } |
    Remove-Item -Force -ErrorAction SilentlyContinue
  $leaf = ([IO.Path]::GetFileName($dir)) -replace '[^\w\-\. ]', '_'
  if (-not $leaf) { $leaf = 'series' }
  $bundle = Join-Path $out ($leaf + '_' + (Get-Date -Format 'yyyyMMdd_HHmmss') + '.dcm')
  $sw = [Diagnostics.Stopwatch]::StartNew()
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::Open($bundle, [IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($f in $all) {
      [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, $f.Name, [IO.Compression.CompressionLevel]::NoCompression)
    }
  } finally { $zip.Dispose() }
  Log ('bundle: ' + $bundle + '  ' + [math]::Round((Get-Item -LiteralPath $bundle).Length / 1MB, 1) + ' MB in ' + $sw.ElapsedMilliseconds + ' ms')
  Start-App $bundle
} catch {
  Log ('ERROR: ' + $_.Exception.Message + ' -> opening only the clicked file')
  Start-App $File
}
'@

$launcherVbs = @'
' Quick DICOM Planning - starts open-series.ps1 without a console window
If WScript.Arguments.Count = 0 Then WScript.Quit
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
ps1 = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "open-series.ps1")
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """ """ & WScript.Arguments(0) & """", 0, False
'@

$uninstall = @'
@echo off
echo Removing the Quick DICOM Planning Windows helper...
reg delete "HKCU\Software\Classes\QuickDICOMPlanning.Series" /f >nul 2>&1
for %%e in (.dcm .dicom .dic .ima) do reg delete "HKCU\Software\Classes\%%e\OpenWithProgids" /v QuickDICOMPlanning.Series /f >nul 2>&1
echo Done. Double-clicked DICOM files now open with the app as before (Open with - Choose another app).
pause
cd /d "%TEMP%"
rmdir /s /q "%USERPROFILE%\QuickDICOMPlanning" >nul 2>&1
rmdir /s /q "%USERPROFILE%\.quick-dicom-planning" >nul 2>&1
rmdir /s /q "%LOCALAPPDATA%\QuickDICOMPlanning"
'@

$ps1Path = Join-Path $Base 'open-series.ps1'
$vbsPath = Join-Path $Base 'open-series.vbs'
[IO.File]::WriteAllText($ps1Path, $launcherPs1, (New-Object Text.UTF8Encoding $true))
[IO.File]::WriteAllText($vbsPath, $launcherVbs.Replace("`r`n", "`n").Replace("`n", "`r`n"), [Text.Encoding]::ASCII)
[IO.File]::WriteAllText((Join-Path $Base 'uninstall.cmd'), $uninstall.Replace("`r`n", "`n").Replace("`n", "`r`n"), [Text.Encoding]::ASCII)

# a tiny named launcher, so Windows lists "Quick DICOM Planning (whole series)" in Open with
$exePath = Join-Path $Base 'QuickDICOMPlanning-Series.exe'
$launcherCs = @"
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
[assembly: AssemblyTitle("$HelperName")]
[assembly: AssemblyProduct("$AppName")]
public static class QdpSeriesLauncher {
  public static void Main(string[] args) {
    if (args.Length == 0) return;
    string dir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
    string ps1 = Path.Combine(dir, "open-series.ps1");
    ProcessStartInfo psi = new ProcessStartInfo("powershell.exe",
      "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + ps1 + "\" \"" + args[0] + "\"");
    psi.UseShellExecute = false;
    psi.CreateNoWindow = true;
    Process.Start(psi);
  }
}
"@
$openCommand = $null
try {
  if (Test-Path -LiteralPath $exePath) { Remove-Item -LiteralPath $exePath -Force }
  Add-Type -TypeDefinition $launcherCs -OutputAssembly $exePath -OutputType WindowsApplication
  if (Test-Path -LiteralPath $exePath) { $openCommand = '"' + $exePath + '" "%1"' }
} catch {
  Write-Host '  (Could not build the launcher program; using Windows Script Host instead.)'
}
if (-not $openCommand) {
  $openCommand = '"' + (Join-Path $env:WINDIR 'System32\wscript.exe') + '" "' + $vbsPath + '" "%1"'
}

# --- 3. register "Quick DICOM Planning (whole series)" for DICOM files -------------
$pk = "$Classes\$ProgId"
foreach ($k in @($pk, "$pk\shell", "$pk\shell\open", "$pk\shell\open\command", "$pk\Application")) { Ensure-Key $k }
Set-Item -LiteralPath $pk -Value 'DICOM image'
Set-ItemProperty -LiteralPath $pk -Name 'FriendlyTypeName' -Value 'DICOM image'
Set-Item -LiteralPath "$pk\shell\open\command" -Value $openCommand
Set-ItemProperty -LiteralPath "$pk\shell\open" -Name 'FriendlyAppName' -Value $HelperName
Set-ItemProperty -LiteralPath "$pk\Application" -Name 'ApplicationName' -Value $HelperName
Set-ItemProperty -LiteralPath "$pk\Application" -Name 'ApplicationCompany' -Value $AppName
$icon = $null
if ($pick.ProgId) { $icon = Get-Default "$Classes\$($pick.ProgId)\DefaultIcon" }
elseif ($pick.Icon) { $icon = $pick.Icon }
if ($icon) {
  Ensure-Key "$pk\DefaultIcon"
  Set-Item -LiteralPath "$pk\DefaultIcon" -Value $icon
  Set-ItemProperty -LiteralPath "$pk\Application" -Name 'ApplicationIcon' -Value $icon
}
foreach ($e in $Exts) {
  Ensure-Key "$Classes\$e"
  Ensure-Key "$Classes\$e\OpenWithProgids"
  New-ItemProperty -LiteralPath "$Classes\$e\OpenWithProgids" -Name $ProgId -Value '' -PropertyType String -Force | Out-Null
}
try {
  Add-Type -Namespace QDP -Name Shell -MemberDefinition '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int e, int f, IntPtr a, IntPtr b);'
  [QDP.Shell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
} catch { }

Write-Host '  Installed.' -ForegroundColor Green
Write-Host ''
Write-Host '  LAST STEP: a window "How do you want to open this file?" opens now.' -ForegroundColor Cyan
Write-Host "  Choose  $HelperName  and tick  Always use this app."
Write-Host '  (If it does not open: right-click any .dcm file - Open with - Choose another app.)'
Write-Host ''
Write-Host '  From then on, double-clicking a DICOM file opens the whole series directly.'
Write-Host "  To remove the helper later, run uninstall.cmd in $Base"

# --- 4. let the user make it the default for .dcm ----------------------------------
# bundles of older helper versions (a hidden folder the browsers no longer allow)
Remove-Item -LiteralPath (Join-Path $env:USERPROFILE '.quick-dicom-planning') -Recurse -Force -ErrorAction SilentlyContinue
$exDir = Join-Path $Base 'example'
New-Item -ItemType Directory -Force -Path $exDir | Out-Null
$ex = Join-Path $exDir 'example.dcm'
if (-not (Test-Path -LiteralPath $ex)) { [IO.File]::WriteAllBytes($ex, [byte[]]@(0)) }
Start-Process -FilePath 'rundll32.exe' -ArgumentList ('shell32.dll,OpenAs_RunDLL ' + $ex)
