# Compatible with Windows PowerShell 5.1 for the initial PowerShell 7 bootstrap.
# Private tools do not modify machine PATH, installed software, or Codex credentials.
$script:MonitorToolsRoot = Join-Path $env:LOCALAPPDATA 'Programs\CodexMonitorTools'

function Assert-MonitorToolPath([string]$Path) {
  $root = [IO.Path]::GetFullPath($script:MonitorToolsRoot).TrimEnd('\')
  $full = [IO.Path]::GetFullPath($Path)
  if ($full -ne $root -and -not $full.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Dependency path is outside the tools directory.' }
  $ancestor = $full
  while ($ancestor) {
    $item = Get-Item -LiteralPath $ancestor -Force -ErrorAction SilentlyContinue
    if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Dependency paths must not contain links.' }
    $parent = Split-Path -Parent $ancestor
    if ($parent -eq $ancestor) { break }; $ancestor = $parent
  }
}

function Invoke-MonitorDependencyLock([scriptblock]$Action) {
  Assert-MonitorToolPath $script:MonitorToolsRoot
  New-Item -ItemType Directory -Path $script:MonitorToolsRoot -Force | Out-Null
  $lockPath = Join-Path $script:MonitorToolsRoot 'install.lock'
  Assert-MonitorToolPath $lockPath
  try { $lock = [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None') }
  catch { throw 'Another dependency installation is running. Wait for it to finish before trying again.' }
  try { & $Action } finally { $lock.Dispose() }
}

function Get-MonitorArchitecture {
  $architecture = $env:PROCESSOR_ARCHITEW6432
  if (-not $architecture) { $architecture = $env:PROCESSOR_ARCHITECTURE }
  switch ($architecture) { 'AMD64' { 'x64' }; 'ARM64' { 'arm64' }; default { throw 'Codex Monitor requires 64-bit Windows (x64 or ARM64).' } }
}

function Get-MonitorToolVersion([string]$Executable) {
  if (-not $Executable -or -not (Test-Path -LiteralPath $Executable -PathType Leaf)) { return '' }
  $process = New-Object Diagnostics.Process
  $process.StartInfo = New-Object Diagnostics.ProcessStartInfo
  $process.StartInfo.FileName = $Executable
  $process.StartInfo.Arguments = '--version'
  $process.StartInfo.UseShellExecute = $false
  $process.StartInfo.CreateNoWindow = $true
  $process.StartInfo.RedirectStandardOutput = $true
  $process.StartInfo.RedirectStandardError = $true
  try {
    if (-not $process.Start()) { return '' }
    $output = $process.StandardOutput.ReadToEndAsync()
    $errors = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(10000)) { $process.Kill(); return '' }
    if ($process.ExitCode -eq 0) { return $output.GetAwaiter().GetResult().Trim() }
  } catch { return '' } finally { $process.Dispose() }
  return ''
}

function Test-MonitorTool([string]$Executable, [string]$Kind) {
  $version = Get-MonitorToolVersion $Executable
  switch ($Kind) {
    'node' {
      return ($version -match '^v(\d+\.\d+\.\d+)$' -and [version]$Matches[1] -ge [version]'22.13.0' -and
        (Test-Path -LiteralPath (Join-Path (Split-Path $Executable) 'node_modules/npm/bin/npm-cli.js')))
    }
    'git' { return $version -match '^git version 2\.' }
    'powershell' { return $version -match '^PowerShell 7\.' }
    'codex' { return $version -match '^codex(-cli)? ' }
  }
  return $false
}

function Protect-MonitorDownloadText([string]$Text) {
  # Exceptions can include redirect/proxy URLs. Keep their host/path, not userinfo
  # or query tokens. Do not include response bodies, headers or command arguments.
  return [regex]::Replace($Text, '(?i)https?://[^\s"''<>]+', {
    param($match)
    try {
      $url = [Uri]$match.Value
      return $url.GetLeftPart([UriPartial]::Authority).Replace($url.UserInfo + '@','') + $url.AbsolutePath
    } catch { return '[redacted URL]' }
  })
}

function Get-MonitorDownloadProxy {
  $value = $env:CODEX_MONITOR_DOWNLOAD_PROXY
  if ([string]::IsNullOrWhiteSpace($value)) { return '' }
  $proxy = $null
  if (-not [Uri]::TryCreate($value, [UriKind]::Absolute, [ref]$proxy) -or
      $proxy.Scheme -notin @('http','https') -or -not $proxy.Host -or $proxy.Port -le 0 -or
      $proxy.UserInfo -or $proxy.Query -or $proxy.Fragment -or $proxy.AbsolutePath -ne '/') {
    throw 'Invalid CODEX_MONITOR_DOWNLOAD_PROXY. Use an HTTP/HTTPS proxy address without credentials, a path, query or fragment.'
  }
  return $proxy.AbsoluteUri
}

function Get-MonitorDownload([string]$Uri, [string]$OutFile, [string]$Dependency = 'Windows dependency') {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $address = [Uri]$Uri
  # Do not print query strings or credentials in diagnostic URLs.
  $displayUrl = $address.GetLeftPart([UriPartial]::Authority).Replace($address.UserInfo + '@','') + $address.AbsolutePath
  Write-Host "Downloading $Dependency`: $displayUrl"
  $parameters = @{Uri=$Uri;UseBasicParsing=$true;TimeoutSec=300;ErrorAction='Stop';Headers=@{'User-Agent'='Codex-Monitor-Installer'}}
  if ($OutFile) { $parameters.OutFile = $OutFile; $parameters.PassThru = $true }
  $oldProgress = $ProgressPreference
  $proxy = ''
  try {
    $ProgressPreference = 'SilentlyContinue'
    $proxy = Get-MonitorDownloadProxy
    if ($proxy) { $parameters.Proxy = $proxy }
    $response = Invoke-WebRequest @parameters
    if ($OutFile) {
      # 5.1 can return successfully after a truncated response. For uncompressed
      # archives check the declared size before SHA256 verification/extraction.
      $expectedLength = [long]0
      $encoding = [string]$response.Headers['Content-Encoding']
      if ((-not $encoding -or $encoding -eq 'identity') -and
          [long]::TryParse([string]$response.Headers['Content-Length'], [ref]$expectedLength) -and
          (Get-Item -LiteralPath $OutFile).Length -ne $expectedLength) {
        throw 'Incomplete dependency download: file size differs from Content-Length. Rerun Install after restoring the connection.'
      }
      return
    }
    # Windows PowerShell returns bytes for application/octet-stream, even when
    # the payload is JSON or SHASUMS256.txt. Never stringify a byte array.
    $content = if ($response.Content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($response.Content) } else { [string]$response.Content }
    return [pscustomobject]@{Content=$content.TrimStart([char]0xFEFF);StatusCode=[int]$response.StatusCode}
  } catch {
    $record = $_
    $failure = $record.Exception
    $chain = @()
    $socketCode = $null
    $failureResponse = $null
    $exception = $failure
    while ($exception) {
      $chain += $exception.GetType().FullName + ': ' + (Protect-MonitorDownloadText $exception.Message)
      if ($exception -is [Net.Sockets.SocketException]) {
        $socketCode = $exception.NativeErrorCode
        $chain += "SocketErrorCode=$($exception.SocketErrorCode); NativeErrorCode=$socketCode"
      }
      if (-not $failureResponse -and $exception.Response) { $failureResponse = $exception.Response }
      $exception = $exception.InnerException
    }
    $status = if ($failureResponse -and $failureResponse.StatusCode) { [int]$failureResponse.StatusCode } else { 0 }
    $rateRemaining = ''
    if ($status -eq 403 -and $address.Host -eq 'api.github.com') {
      try { $rateRemaining = @($failureResponse.Headers.GetValues('X-RateLimit-Remaining'))[0] } catch { }
    }
    $hint = 'Check this URL from the failing machine and verify its network, proxy and trusted certificates.'
    if ($socketCode -eq 10013) {
      $hint = 'Socket access denied (WSAEACCES/10013). Check the failing machine''s outbound process rules, security-software logs and proxy configuration. This is not a folder-write error. The installer did not retry or change security settings.'
    } elseif ($status -eq 403 -and $address.Host -eq 'api.github.com' -and $rateRemaining -eq '0') {
      $hint = 'GitHub API rate limit reached. Wait for the limit to reset before rerunning Install.'
    } elseif ($status -eq 403) { $hint = 'The server or proxy denied the request (403). Check its access policy.' }
    elseif ($status -eq 407) { $hint = 'The configured proxy requires authentication (407).' }
    elseif ($status -eq 429) { $hint = 'The server is rate limiting requests (429). Wait before rerunning Install.' }
    $statusText = if ($status) { "HTTP $status" } else { $failure.GetType().Name }
    $proxyMode = if ($proxy) { 'CODEX_MONITOR_DOWNLOAD_PROXY' } else { 'PowerShell default (OS/inherited environment)' }
    $details = $chain -join "`n"
    $stack = Protect-MonitorDownloadText ([string]$record.ScriptStackTrace)
    throw "Dependency download failed: $displayUrl`nDependency: $Dependency`nPowerShell $($PSVersionTable.PSVersion); $statusText; Proxy: $proxyMode`n$details`n$hint`nScriptStackTrace:`n$stack"
  } finally { $ProgressPreference = $oldProgress }
}

function Get-MonitorArchive([ValidateSet('node','git','powershell')][string]$Kind, [ValidateSet('x64','arm64')][string]$Architecture) {
  if ($Kind -eq 'node') {
    $base = 'https://nodejs.org/download/release/latest-v24.x/'
    $sums = (Get-MonitorDownload ($base + 'SHASUMS256.txt') -Dependency 'Node.js checksum list').Content
    $match = [regex]::Match([string]$sums, '(?m)^([a-fA-F0-9]{64})\s+(node-v24\.\d+\.\d+-win-' + $Architecture + '\.zip)\s*$')
    if (-not $match.Success) { throw 'Official Node.js LTS checksum was not found.' }
    return @{Url=$base+$match.Groups[2].Value;Hash=$match.Groups[1].Value;Folder=([IO.Path]::GetFileNameWithoutExtension($match.Groups[2].Value));Executable='node.exe'}
  }
  $repository = if ($Kind -eq 'git') { 'git-for-windows/git' } else { 'PowerShell/PowerShell' }
  $release = (Get-MonitorDownload "https://api.github.com/repos/$repository/releases/latest" -Dependency "$Kind release metadata").Content | ConvertFrom-Json
  $suffix = if ($Architecture -eq 'x64') { '64-bit' } else { 'arm64' }
  $pattern = if ($Kind -eq 'git') { '^MinGit-[\d.]+-' + $suffix + '\.zip$' } else { '^PowerShell-7\.[\d.]+-win-' + $Architecture + '\.zip$' }
  $assets = @($release.assets | Where-Object { $_.name -match $pattern })
  if ($assets.Count -ne 1) { throw "Official $Kind package was not found for $Architecture." }
  $asset = $assets[0]
  if ($asset.digest -notmatch '^sha256:([a-fA-F0-9]{64})$') { throw "Official $Kind SHA256 checksum is missing." }
  $hash = $Matches[1]
  if (-not ([string]$asset.browser_download_url).StartsWith("https://github.com/$repository/releases/download/", [StringComparison]::Ordinal)) { throw 'Unexpected dependency download source.' }
  return @{Url=$asset.browser_download_url;Hash=$hash;Folder='';Executable=$(if ($Kind -eq 'git') { 'cmd/git.exe' } else { 'pwsh.exe' })}
}

function Get-MonitorSHA256([string]$Path) {
  # .NET works even when a parent PowerShell 7 process supplied its module path to 5.1.
  $stream = [IO.File]::OpenRead($Path)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-','').ToLowerInvariant() }
  finally { $stream.Dispose(); $algorithm.Dispose() }
}

function Expand-MonitorArchive([string]$Archive, [string]$Hash, [string]$Destination) {
  Assert-MonitorToolPath $Archive
  Assert-MonitorToolPath $Destination
  if ($Hash -notmatch '^[a-fA-F0-9]{64}$' -or (Get-MonitorSHA256 $Archive) -ne $Hash) { throw 'Dependency SHA256 checksum mismatch; nothing was installed.' }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
  try {
    # Validate every name before extracting anything. Reject links and Windows ADS.
    foreach ($entry in $zip.Entries) {
      $name = $entry.FullName.Replace('\','/')
      if ($name.StartsWith('/') -or $name.Contains(':') -or @($name.Split('/') | Where-Object { $_ -eq '..' }).Count -gt 0 -or
          (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw 'Unsafe dependency archive entry.' }
    }
  } finally { $zip.Dispose() }
  [IO.Compression.ZipFile]::ExtractToDirectory($Archive, $Destination)
}

function Set-MonitorToolDirectory([string]$Source, [string]$Name) {
  if ($Name -notin @('node','git','powershell','codex')) { throw 'Unknown dependency.' }
  $target = Join-Path $script:MonitorToolsRoot $Name
  $backup = Join-Path $script:MonitorToolsRoot ($Name + '-previous-' + [Guid]::NewGuid().ToString('N'))
  foreach ($path in @($Source,$target,$backup)) { Assert-MonitorToolPath $path }
  if (Test-Path -LiteralPath $target) { Move-Item -LiteralPath $target -Destination $backup }
  try { Move-Item -LiteralPath $Source -Destination $target }
  catch {
    if ((Test-Path -LiteralPath $backup) -and -not (Test-Path -LiteralPath $target)) { Move-Item -LiteralPath $backup -Destination $target }
    throw
  }
  return $target
}

function Install-MonitorArchive([string]$Kind) {
  $package = Get-MonitorArchive $Kind (Get-MonitorArchitecture)
  $stage = Join-Path $script:MonitorToolsRoot ('.download-' + [Guid]::NewGuid().ToString('N'))
  Assert-MonitorToolPath $stage
  New-Item -ItemType Directory -Path $stage | Out-Null
  Write-Host "Downloading official $Kind package..."
  $archive = Join-Path $stage 'package.zip'
  Get-MonitorDownload $package.Url $archive -Dependency "$Kind archive" | Out-Null
  $unpacked = Join-Path $stage 'unpacked'
  Expand-MonitorArchive $archive $package.Hash $unpacked
  $source = if ($package.Folder) { Join-Path $unpacked $package.Folder } else { $unpacked }
  if (-not (Test-MonitorTool (Join-Path $source $package.Executable) $Kind)) { throw "Downloaded $Kind did not pass validation. Existing tools were kept." }
  $target = Set-MonitorToolDirectory $source $Kind
  # Only our verified ZIP is removed; failed staging folders remain for diagnostics.
  Assert-MonitorToolPath $archive
  Remove-Item -LiteralPath $archive
  return (Join-Path $target $package.Executable)
}

function Get-MonitorCommandPath([string]$Name) {
  $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) { return $command.Source }; return ''
}

function Find-MonitorTool([string]$Kind, [string]$Configured) {
  $paths = @($Configured)
  switch ($Kind) {
    'node' { $paths += @((Get-MonitorCommandPath 'node.exe'), (Join-Path $env:ProgramFiles 'nodejs/node.exe'), (Join-Path $script:MonitorToolsRoot 'node/node.exe')) }
    'git' { $paths += @((Get-MonitorCommandPath 'git.exe'), (Join-Path $env:ProgramFiles 'Git/cmd/git.exe'), (Join-Path $script:MonitorToolsRoot 'git/cmd/git.exe')) }
    'codex' {
      $paths += @(Get-ChildItem -Path "$env:LOCALAPPDATA\OpenAI\Codex\bin\*\codex.exe" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | ForEach-Object { $_.FullName })
      $paths += (Get-MonitorCommandPath 'codex.exe')
      foreach ($prefix in @((Join-Path $env:APPDATA 'npm'), (Join-Path $script:MonitorToolsRoot 'codex'))) {
        $scope = Join-Path $prefix 'node_modules/@openai'
        if (Test-Path -LiteralPath $scope) { $paths += @(Get-ChildItem -LiteralPath $scope -Filter codex.exe -File -Recurse | ForEach-Object { $_.FullName }) }
      }
    }
  }
  foreach ($candidate in ($paths | Where-Object { $_ } | Select-Object -Unique)) {
    if (Test-MonitorTool $candidate $Kind) { return $candidate }
  }
  return ''
}

function Invoke-MonitorNpm([string]$NodePath, [string[]]$NpmArguments) {
  & $NodePath (Join-Path (Split-Path $NodePath) 'node_modules/npm/bin/npm-cli.js') @NpmArguments | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "npm failed (exit $LASTEXITCODE). See the installation log." }
}

function Install-MonitorCodex([string]$NodePath) {
  $stage = Join-Path $script:MonitorToolsRoot ('.codex-' + [Guid]::NewGuid().ToString('N'))
  Assert-MonitorToolPath $stage
  New-Item -ItemType Directory -Path $stage | Out-Null
  Write-Host 'Installing official @openai/codex CLI (no sign-in changes)...'
  Invoke-MonitorNpm $NodePath @('install','--prefix',$stage,'--registry=https://registry.npmjs.org','--no-audit','--no-fund','--include=optional','@openai/codex@latest')
  $executable = Get-ChildItem -LiteralPath (Join-Path $stage 'node_modules/@openai') -Filter codex.exe -File -Recurse |
    Where-Object { Test-MonitorTool $_.FullName 'codex' } | Select-Object -First 1
  if (-not $executable) { throw 'Codex CLI native executable was not found; existing tools were kept.' }
  & $executable.FullName app-server --help | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'Codex CLI app-server validation failed.' }
  $relative = $executable.FullName.Substring($stage.Length + 1)
  $target = Set-MonitorToolDirectory $stage 'codex'
  return (Join-Path $target $relative)
}

function Resolve-MonitorDependencies($Config) {
  Invoke-MonitorDependencyLock {
    $node = Find-MonitorTool 'node' $Config.nodePath
    if (-not $node) { $node = Install-MonitorArchive 'node' }
    $git = Find-MonitorTool 'git' $Config.gitPath
    if (-not $git) { $git = Install-MonitorArchive 'git' }
    # Process-local PATH reaches build scripts; the installed runner restores it at logon.
    $env:PATH = (Split-Path $node) + ';' + (Split-Path $git) + ';' + $env:PATH
    $codex = Find-MonitorTool 'codex' $Config.codexPath
    if (-not $codex) { $codex = Install-MonitorCodex $node }
    Write-Host "Dependencies ready: Node.js, npm, Git, Codex CLI."
    return [pscustomobject]@{nodePath=$node;gitPath=$git;codexPath=$codex}
  }
}
