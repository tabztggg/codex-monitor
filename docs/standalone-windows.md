# Standalone Windows deployment

双击根目录 **Install Codex Monitor.vbs** 安装／修复当前源码版本，完成后自动打开网页；等同于 `Codex Monitor.vbs deploy`。日常启动仍用 **Codex Monitor.vbs**，获取仓库最新版用 **Update Codex Monitor.vbs**。

运行 `npm ci`、`npm run build` 后使用 PowerShell 7 执行 `pwsh -File scripts/Install-StandaloneMonitor.ps1`。自动部署、创建桌面快捷方式并启用 Windows 登录后无窗口自启动；保留配置与缓存，备份并移除旧 Monitor Hook。关闭 Codex 不影响 Monitor。

Windows 启动入口优先使用标准安装或 Codex 自带的 PowerShell 7，再使用 Monitor 私有工具目录内的版本。如果都没有，仅使用 Windows 内置 PowerShell 5.1 下载并校验 PowerShell 7，然后切换到 7 执行安装。正式后台仍只使用 PowerShell 7。

Windows launchers prefer standard, Codex-bundled, then Monitor-private PowerShell 7. On a fresh machine, built-in Windows PowerShell 5.1 is used only to download and verify PowerShell 7; installation and background operation then run under 7.

### Automatic prerequisites / 自动准备依赖

**Install Codex Monitor.vbs** works on Windows x64 and ARM64 without preinstalled Node.js, Git or PowerShell 7. Compatible tools are reused; missing tools are downloaded to `%LOCALAPPDATA%\Programs\CodexMonitorTools`. Node versions below 22.13 or missing npm are replaced only for Monitor by a private Node 24 LTS copy. Nothing changes the machine/user PATH or uninstalls other applications.

- Node.js ZIP and SHA256: [official LTS downloads](https://nodejs.org/download/release/latest-v24.x/).
- Git ZIP and SHA256: [official Git for Windows MinGit release](https://github.com/git-for-windows/git/releases/latest).
- PowerShell ZIP and SHA256: [official PowerShell release](https://github.com/PowerShell/PowerShell/releases/latest); [ZIP installation documentation](https://learn.microsoft.com/en-us/powershell/scripting/install/install-powershell-on-windows).
- Codex: reuse the installed native CLI, otherwise install `@openai/codex` from the official npm registry into the private tools directory. [Codex CLI and sign-in](https://learn.chatgpt.com/docs/codex/cli). Credentials are never imported or changed by the installer.

Dependencies are validated before activation. A network/checksum failure stops installation and records the error; double-click Install again after connectivity is restored. Concurrent dependency installation is blocked. Node, Git and Codex executable paths are saved in `standalone.json`; the scheduled runner restores Node/Git to its own process PATH so web updates work after logon. Private tools and any previous-tool backup remain on uninstall for reuse. Fresh Codex installations still require the user to sign in; installing a CLI does not create account credentials.

[English README](../README.en.md) · [中文说明](#中文说明)

This page documents the per-user deployment configured on the maintainer's
Windows machine. The deployment script is scripts/Install-StandaloneMonitor.ps1; the following describes
for this deployment. Downloading the repository alone does not register its
scheduled task, configured installed copy, or shortcuts. The management scripts
under `scripts/` must be copied into a configured installation before use.

## Installed files and dependencies

The installed copy lives in `%LOCALAPPDATA%\Programs\CodexMonitor`. It contains
its own `dist`, production dependencies, `.cache`, `logs`, `standalone.json`,
`Run-StandaloneMonitor.ps1`, `Manage-StandaloneMonitor.ps1`,
`StandaloneMonitorRuntime.cs`, and the compiled `Run-StandaloneMonitor.exe` host.

Node.js and an authenticated Codex CLI supporting `codex app-server` remain
required. Their executable paths and the Codex data directory are recorded in
the local installation configuration. The monitor starts its own CLI process;
the Codex desktop window and the terminal used to open the monitor can be closed
while the scheduled task continues running. Keep the installed CLI and Node.js
available; removing them can prevent startup or live account updates.

The installed runner enables shutdown simulation with
`CODEX_MONITOR_DRY_RUN=1`. Local addresses and executable paths belong in the
installation configuration; do not commit that file or its logs and caches.

If activity logs cannot be read, idle-shutdown monitoring pauses its countdown without disarming the rule. Recovery starts a fresh idle check; an unknown activity state is never treated as zero running tasks. Normal log records have an 8 MiB allocation limit. Larger, structurally verified tool outputs are streamed without retaining their bodies, preserving their timestamps; oversized statistics records or ambiguous types still report a failure and preserve the previous result. Unchanged rejected files are not rescanned repeatedly.

## Startup and management

Task Scheduler owns the process tree through the task named **Codex Monitor**.
The configured behavior is:

| Setting | Behavior |
| --- | --- |
| Startup | At the current user's Windows logon. |
| Account | Interactive user session, limited privileges. |
| Duplicate starts | Ignore a new start while the task is already running. |
| Runtime limit | No scheduled runtime limit. |
| Console windows | The task runs a GUI-subsystem host; all service children use no-console creation. |
| Service exit recovery | The installed launcher waits one minute and retries, up to three times per launch. |

This is a **logon startup task**. Running before a user signs in or continuing
after sign-out is outside this installation's guarantees; it is not registered
as a Windows service. Closing the Codex GUI does not request a monitor stop.

The task action is `Run-StandaloneMonitor.exe`, with the quoted full path to
`Run-StandaloneMonitor.ps1` as its only argument and the installation folder as
its working directory. The host and runner own nested Windows process groups,
so stopping the task also stops its children. A PowerShell task action with
`-WindowStyle Hidden` can still open Windows Terminal before the script runs.
Build the host from the checkout with `scripts/Build-StandaloneMonitorHost.ps1`;
it uses the Windows .NET Framework compiler and outputs the executable under
`.cache/standalone-host/`. Deploy it together with the runner and runtime source.

Recovery is implemented by the installed launcher, not Task Scheduler's
`RestartOnFailure` setting. Each attempt owns a Windows process group; exiting
cleans up its remaining children before the next attempt. Stopping the task also
ends any pending retry. If all three retries fail, start it again after resolving
the error. Terminating the outer launcher itself requires a manual start or a
new logon.

Separately, the Node backend limits restarts of its Codex app-server child with a
5/10/20/40/60-second cooldown. It resets after 30 seconds of stable initialization,
and writes each failure's delay to `stderr.log`. This applies while Node remains
running; it does not replace the launcher's three-retry limit for Node exits.

Use the desktop shortcut to start the monitor without a console window. The Start menu also contains
**Stop** and **Restart** shortcuts. The previous Startup shortcut and the source checkout's Windows
launcher both delegate to the same installed task, avoiding a second instance.
The source launcher detects the installation through `standalone.json`.

The installed management script also supports these PowerShell commands:

```powershell
$monitorManager = Join-Path $env:LOCALAPPDATA 'Programs\CodexMonitor\Manage-StandaloneMonitor.ps1'
& $monitorManager -Action Start
& $monitorManager -Action Status
& $monitorManager -Action Stop
& $monitorManager -Action Restart -NoBrowser
```

Run the command for the action you want. `Start` and `Restart` open the configured
dashboard unless `-NoBrowser` is supplied. `Status` reports the last scheduled
task result and checks the monitor's HTTP health endpoint. Stopping the current
instance does not remove the task's next-logon startup trigger. Use Task
Scheduler to disable that trigger when persistent automatic startup is unwanted.

Management requests bypass proxies and map wildcard listeners (`0.0.0.0` / `::`) to loopback addresses. The listening address itself is unchanged.

## Reverse proxy or tunnel

The optional `allowedOrigins` array in the installed `standalone.json` declares
external page origins. For example, add this property alongside the existing
host, port and executable settings (replace the example domain):

```json
"allowedOrigins": ["https://monitor.example.com"]
```

Include the HTTP origin separately only if you also use HTTP. The runner passes
this list as `CODEX_MONITOR_ALLOWED_ORIGINS`; a missing or empty list permits no
extra origins, even if the Windows environment contains an older setting.
Each entry must be one HTTP/HTTPS origin without paths, credentials, queries,
fragments or wildcards. Invalid settings prevent startup and appear in the logs.
Install the updated runner and backend, then restart using the management script.
Leave the tunnel target pointing to the configured LAN host and port; enable
WebSocket forwarding in the reverse proxy. This setting does not change the bind
address, firewall or tunnel, and does not provide authentication.

## Logs and troubleshooting

Look under `%LOCALAPPDATA%\Programs\CodexMonitor\logs`:

| File | Contents |
| --- | --- |
| `stdout.log` | Current backend standard output. |
| `stderr.log` | Current backend errors and diagnostics. |
| `stdout.1.log`–`stdout.3.log`, `stderr.1.log`–`stderr.3.log` | Output from previous launches, rotated at startup. |
| `lifecycle.jsonl` | Startup, process exits, retry attempts, and runner errors. |
| `host-*.log`, `instance-*.log` | Current startup host and PowerShell diagnostics. |

Also inspect **Codex Monitor** in Task Scheduler and its last run result. A
healthy HTTP endpoint confirms the monitor is reachable; account data still
requires a working, authenticated Codex CLI. Logs can contain local paths or
task information, so redact them before sharing.

## Download network troubleshooting

Download errors in `.cache/install-error.txt` include the dependency, original URL, HTTP status, nested exception types, socket error code and script call stack. Query strings and URL credentials are omitted. Socket access denied (`WSAEACCES / 10013`) does not identify a particular antivirus or firewall and is not a directory-write error; check the failing machine's outbound process rules, security-software records and proxy configuration. [Microsoft socket error definitions](https://learn.microsoft.com/en-us/windows/win32/winsock/windows-sockets-error-codes-2)

If that machine requires a known HTTP/HTTPS proxy, set it explicitly before starting the installer. Replace the example with your actual proxy address; no embedded username/password is accepted:

```powershell
$env:CODEX_MONITOR_DOWNLOAD_PROXY = 'http://127.0.0.1:7890'
wscript.exe "Install Codex Monitor.vbs"
```

This process-only override applies to the installer's Node/Git/PowerShell downloads. It does not change Windows settings, npm proxy settings or Monitor's runtime. Without it, PowerShell keeps its normal proxy selection. Socket permission errors stop immediately; the installer does not switch download clients or disable certificate checks.

中文：网络错误请提供 `.cache/install-error.txt`。若网络需要代理，可按上例指定真实地址后启动安装；变量只影响当前进程及本次启动，不永久改系统设置。该入口仅控制 Node、Git、PowerShell 下载，npm 仍使用自己的代理配置。`10013` 需在故障电脑上查明拦截来源，不能靠反复安装或强制管理员运行认定解决。

## Uninstall / 卸载

Double-click **Uninstall Codex Monitor.vbs** in the source root. It stops only this installation's host, removes its verified scheduled task and current-user Desktop/Startup/Start-menu links, then deletes known application files. Configuration (`standalone.json`), usage caches (`.cache`), logs, backups and unrecognized files remain in `%LOCALAPPDATA%\Programs\CodexMonitor`. Codex, Node.js, PowerShell and the source checkout are kept. Reinstall with **Install Codex Monitor.vbs** to reuse your data.

The entry targets the standard current-user installation only. It refuses a foreign task/application, linked application directories, or an active update. Failures are logged to the source checkout's `.cache/desktop-entry.log`; an incomplete uninstall can be rerun after resolving the error. It does not request administrator access. Preview without making changes:

```powershell
pwsh -File scripts/Uninstall-StandaloneMonitor.ps1 -WhatIf
```

双击根目录 **Uninstall Codex Monitor.vbs**，停止 Monitor 并清除应用文件、对应登录计划任务及桌面／启动文件夹／开始菜单内确认属于它的快捷方式。默认保留配置、用量缓存、日志、备份和未知文件；不卸载 Codex、Node.js、PowerShell，也不删除源码。重装自动复用保留的数据。卸载仅支持当前用户标准安装目录；若检测到更新正在进行、目录链接或同名外部任务，会停止并给出日志提示。上面的 `-WhatIf` 命令仅预演，不执行卸载。

## Updating the installed copy

Local source installation/repair also stages all runtime files and production dependencies before stopping the existing service. Replacement failures restore the old runtime, configuration and task registration, including the previous running state and a health check. A dependency download failure during preparation leaves the old service running. Local installation and web update preparation share a Windows file lock; the persisted update status protects the handoff to the updater. An incomplete rollback reports its backup path instead of claiming recovery.

For a source ZIP without a deployed Git SHA, web upgrade detection compares stable version numbers. A newer version enables Update; equal versions remain unverified because the commits are unknown. Use the root update entry to explicitly install the latest `main` in that case. Git-based installations retain commit comparison, including changes with the same version number.

Double-click **Update Codex Monitor.vbs** in the repository root for a console-free update. It starts the installed Monitor (deploying first if needed), submits one update request, and opens the dashboard to show progress. Repeated clicks reuse an active update; a lost response is checked without repeating the request. Startup/request errors appear in `.cache/desktop-entry.log` in the source checkout. Installations predating web updates need one manual source deployment first. To request an update without opening a browser, use `wscript.exe "Update Codex Monitor.vbs" nobrowser`.

Click **Update**, to the left of **Restart service**, to install the latest `main` commit from `tabztggg/codex-monitor`. Git, npm and PowerShell 7 must be available. The fixed repository is downloaded and built in a staging directory while Monitor remains online; only a complete build triggers an automatic stop, runtime replacement and restart. Configuration, caches, calibration, task registration and the desktop shortcut are preserved. Failed installation or health checks restore the previous runtime. The page reports progress and reconnects after success. If the installed commit is already current, nothing restarts.

The header checks version metadata on page load/focus and every 30 minutes while open. All clients share a 30-minute persistent cache; failed automatic checks retain the last result and wait at least 5 minutes before retrying. Click the combined **Up to date** / **Check failed · Retry** button to check manually, with a shared 5-minute minimum interval. **Update to…** opens the installation confirmation. Commit history is compared, so a patch with an unchanged version number is still visible. Health/status polling stays local. Update diagnostics are in `logs/service-update.log`, transaction backups in `backups/update-<operation-id>`. This does not pull or modify your development checkout. For manual updates:

The installation uses a **deployed copy** of the built application. Editing,
pulling, or building the source checkout does not update the installed `dist`.
Restarting alone starts the currently deployed files again.

1. Update the source checkout, install its locked dependencies with `npm ci`,
   and run `npm run build` and the relevant checks there.
2. Stop the installed monitor using its management script or shortcut. Preserve
   a copy of the current installed application and its local configuration.
3. Deploy the newly built `dist` and matching package manifests to the installation.
   If dependencies changed, install the matching production dependencies there.
   Preserve `standalone.json`, `.cache`, logs, the runner and management scripts,
   and the registered task unless the update explicitly changes them.
4. Start the installed task, check `Status` and its logs, then refresh the dashboard.

Updates require an explicit button click or manual deployment; these launchers do not schedule automatic updates.

## 中文说明

这是维护者 Windows 电脑上已配置的**当前用户独立安装**说明。安装位置为
`%LOCALAPPDATA%\Programs\CodexMonitor`，仓库目前没有适用于所有电脑的一键安装脚本；
单纯下载源码不会创建已配置的安装副本、计划任务或快捷方式；`scripts/` 中的管理脚本需复制到配置完成的安装目录后使用。

Monitor 由 Windows 计划任务 **Codex Monitor** 管理，在当前用户登录后自动启动，
使用普通用户权限，重复启动时复用已有任务，不设运行时长限制。服务退出后的恢复由
安装的启动器负责，每次间隔一分钟，每次启动最多重试三次；每轮先清理上一轮后台进程。
停止任务也会取消等待中的重试。最外层启动器被终止时，需要手动启动或下次登录。
它可以在关闭 Codex 桌面窗口和原启动终端后继续运行。

计划任务入口为不创建控制台的 `Run-StandaloneMonitor.exe`，参数是带引号的
`Run-StandaloneMonitor.ps1` 完整路径，工作目录为安装目录。后续 PowerShell、Node
和 Codex 子进程也禁用控制台窗口创建。仅设置 `-WindowStyle Hidden` 仍可能唤起
Windows Terminal。源码中运行 `scripts/Build-StandaloneMonitorHost.ps1` 可使用
Windows 自带的 .NET Framework 编译器构建入口程序；将输出的 EXE、启动脚本和
`StandaloneMonitorRuntime.cs` 一起部署。`host-*.log`、`instance-*.log` 保留启动诊断。

Node 后端内部的 Codex app-server 子进程另有 5/10/20/40/60 秒重启退避，初始化成功后
稳定运行 30 秒才恢复初始间隔，每次失败的等待时间写入 `stderr.log`。此机制适用于 Node
仍在运行时，不替代外层启动器对 Node 退出的三次重试限制。
这是**登录自启**，不承诺未登录或注销后继续运行，也没有注册为 Windows 服务。

Node.js 和已登录、支持 `codex app-server` 的 Codex CLI 仍然必需；Monitor 自己启动
所需的 CLI 进程。当前安装保持关机模拟模式。桌面快捷方式启动时不显示命令窗口，开始菜单还提供
Stop / Restart 快捷方式，或使用上面的 PowerShell 命令。旧 Startup 快捷方式和源码中的
Windows 启动器都会转到同一个已安装任务，避免重复启动。Stop 只停止当前实例，
不会取消下次登录自启。

日志在安装目录的 `logs` 下：`stdout.log`、`stderr.log` 记录当前输出，`.1` 到 `.3`
保留之前启动的输出，`lifecycle.jsonl` 记录启动、退出和运行器错误。也可查看计划任务
的上次运行结果；HTTP 健康检查成功不代表 CLI 登录和账号数据一定可用。

通过 cpolar／反向代理访问时，在已安装的 `standalone.json` 中增加 `allowedOrigins`
数组，例如上面的 HTTPS 来源；如果还使用 HTTP，也要单独列出 HTTP 来源。每项只写
协议、主机和可选端口，不包含路径、凭据、查询参数或通配符。更新启动器和后端后，
使用管理脚本重启才会生效；在其他终端设置环境变量不会修改独立安装的配置。
未配置或空数组不额外允许任何来源，也不会继承 Windows 中的旧环境变量。
隧道目标仍填本机局域网地址和端口，代理需转发 WebSocket；此设置不提供登录认证。

**安装目录不会自动跟随源码更新。** 更新后需在源码目录重新构建，停止已安装实例，
备份并重新部署 `dist`、匹配的依赖清单和所需生产依赖，再启动验证。保留本地配置、
`.cache`、日志及管理脚本，除非更新明确要求更换。仅修改源码、执行 `git pull`、
重新构建或重启，都不会自动替换已安装的应用文件。
## 网页服务管理

也可双击源码根目录的 **Update Codex Monitor.vbs** 一键更新：服务未启动时先启动，尚未安装时先部署，然后打开网页显示更新进度，全程无命令行窗口。复用网页更新的配置保留与失败回滚流程，不覆盖源码目录；重复点击遇到已有更新时只查看进度。入口错误见源码目录 `.cache/desktop-entry.log`。不支持网页更新的旧安装需先通过 `Codex Monitor.vbs deploy` 部署一次。

右上角显示当前版本与仓库版本，状态与更新合为一个按钮：「已是最新」点击重新检查，「更新至…」高亮并进入更新确认，「检查失败 · 重试」重新查询。版本号未变的新提交也能识别。页面打开、重新聚焦及每 30 分钟自动检查，所有页面共用 30 分钟持久缓存；自动检查失败保留上次结果，至少 5 分钟后再尝试。手动检查可跳过长缓存，但最短间隔为 5 分钟。单次仓库请求超时为 10 秒；一次检查最多依次请求三次，网页等待上限为 35 秒。服务状态轮询不访问 GitHub，也不自动安装。

「更新」「重启服务」「关闭服务」不关闭 Windows 或 Codex。「更新」固定从本仓库 `main` 获取最新版，需要 Git、npm 和 PowerShell 7；先下载构建，准备完成才自动停止、替换、启动并检查健康状态。失败恢复旧版，保留配置、缓存和校准记录。已是最新提交则不重启；安装仍须点击「更新」。

托管启动器使用退出码 43 请求应用已准备的更新，42 立即重启，0 主动关闭、不重试。更新诊断见 `logs/service-update.log`，旧程序保留在 `backups/update-<操作 ID>`；不会修改开发用源码仓库。

本机和公网操作均无需口令；所有可访问页面的人都能更新、重启或关闭 Monitor。关闭后需要桌面快捷方式、远程桌面或下一次 Windows 登录重新启动，离线网页不能自行唤醒服务。

重复部署会备份旧程序，保留 `standalone.json` 与 `.cache`，更新计划任务及桌面快捷方式。`-SkipDependencies` 仅用于已有匹配依赖的安装；默认执行 `npm ci --omit=dev`。开机自启动指当前用户登录后启动，登录前不运行。
