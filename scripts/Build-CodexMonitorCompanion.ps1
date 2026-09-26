param([string]$OutputPath = (Join-Path $PSScriptRoot '..\.cache\desktop-companion\CodexMonitorCompanion.exe'))
$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'The Windows .NET Framework compiler is required.' }
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
New-Item -ItemType Directory -Path (Split-Path -Parent $OutputPath) -Force | Out-Null
& $compiler /nologo /target:winexe /optimize+ /reference:System.Management.dll ("/out:" + $OutputPath) `
  (Join-Path $PSScriptRoot 'CodexMonitorCompanion.cs') (Join-Path $PSScriptRoot 'StandaloneMonitorRuntime.cs')
if ($LASTEXITCODE -ne 0) { throw 'Monitor companion compilation failed.' }
Write-Output $OutputPath
