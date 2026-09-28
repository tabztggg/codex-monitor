param([string]$Package)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if (-not $Package) { $version = (Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json).version; $Package = Join-Path $repoRoot "release/codex-monitor-$version-windows-x64-setup.exe" }
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{3C3B55DF-920B-4BC2-B82E-6B9660B85318}_is1'
if (Test-Path -LiteralPath $uninstallKey) { throw 'A native Monitor installation already exists. Run this test in a clean Windows account.' }
if ((Get-ItemProperty -LiteralPath $runKey -Name CodexMonitorPackage -ErrorAction SilentlyContinue).CodexMonitorPackage) { throw 'Existing packaged startup entry must not be replaced by a test.' }
$testRoot = Join-Path $repoRoot ('.cache/installer-smoke/' + [Guid]::NewGuid().ToString())
$installRoot = Join-Path $testRoot 'app'
$testData = Join-Path $testRoot 'data'
$shortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Codex Monitor Package Smoke.lnk'
if (Test-Path -LiteralPath $shortcut) { throw 'Test shortcut already exists.' }
$savedData = $env:CODEX_MONITOR_DATA_HOME
$env:CODEX_MONITOR_DATA_HOME = $testData
New-Item -ItemType Directory -Path $testData -Force | Out-Null
Set-Content -LiteralPath (Join-Path $testData 'preserved.txt') -Value 'keep'
function Run-Installer {
    $arguments = '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /DIR="' + $installRoot + '" /GROUP="Codex Monitor Package Smoke" /ShortcutName="Codex Monitor Package Smoke" /TASKS=autostart'
    $process = Start-Process -FilePath $Package -ArgumentList $arguments -WindowStyle Hidden -PassThru -Wait
    if ($process.ExitCode -ne 0) { throw "Installer exit $($process.ExitCode)" }
}
try {
    Run-Installer
    if (-not (Test-Path -LiteralPath $shortcut)) { throw 'Desktop shortcut missing' }
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($shortcut)
    if ($link.TargetPath -ne (Join-Path $installRoot 'CodexMonitor.exe')) { throw 'Desktop shortcut target mismatch' }
    $startup = (Get-ItemProperty -LiteralPath $runKey -Name CodexMonitorPackage).CodexMonitorPackage
    if ($startup -ne ('"' + (Join-Path $installRoot 'CodexMonitor.exe') + '" start')) { throw 'Startup entry mismatch' }
    Push-Location $repoRoot
    try { & node scripts/package/smoke.mjs $installRoot; if ($LASTEXITCODE -ne 0) { throw 'Installed runtime smoke failed' } } finally { Pop-Location }
    Run-Installer
    if ((Get-Content -LiteralPath (Join-Path $testData 'preserved.txt')).Trim() -ne 'keep') { throw 'Installer overwrote data' }
} finally {
    $uninstaller = Join-Path $installRoot 'unins000.exe'
    if (Test-Path -LiteralPath $uninstaller) {
        $process = Start-Process -FilePath $uninstaller -ArgumentList '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART' -WindowStyle Hidden -PassThru -Wait
        if ($process.ExitCode -ne 0) { throw "Uninstaller exit $($process.ExitCode)" }
    }
    $env:CODEX_MONITOR_DATA_HOME = $savedData
}
if (Test-Path -LiteralPath $shortcut) { throw 'Shortcut remained after uninstall' }
if ((Get-ItemProperty -LiteralPath $runKey -Name CodexMonitorPackage -ErrorAction SilentlyContinue).CodexMonitorPackage) { throw 'Startup entry remained after uninstall' }
if (-not (Test-Path -LiteralPath (Join-Path $testData 'preserved.txt'))) { throw 'Uninstaller removed user data' }
Write-Host 'Windows installer verified: install, Desktop target, logon startup, runtime, reinstall, uninstall, retained data.'
