param([string]$OutputPath = (Join-Path $PSScriptRoot '..\.cache\standalone-host\Run-StandaloneMonitor.exe'))
$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) {
  $compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (-not (Test-Path -LiteralPath $compiler)) { throw 'The Windows .NET Framework C# compiler is required.' }
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
New-Item -ItemType Directory -Path (Split-Path -Parent $OutputPath) -Force | Out-Null
& $compiler /nologo /target:winexe /optimize+ ("/out:" + $OutputPath) `
  (Join-Path $PSScriptRoot 'StandaloneMonitorHost.cs') `
  (Join-Path $PSScriptRoot 'StandaloneMonitorRuntime.cs')
if ($LASTEXITCODE -ne 0) { throw 'Monitor background host compilation failed.' }
Write-Output $OutputPath
