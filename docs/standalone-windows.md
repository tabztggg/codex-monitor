# Standalone Windows deployment

运行 `npm ci`、`npm run build` 后执行 `powershell -File scripts/Install-StandaloneMonitor.ps1`。自动部署、创建桌面快捷方式并启用 Windows 登录后无窗口自启动；保留配置与缓存，备份并移除旧 Monitor Hook。关闭 Codex 不影响 Monitor。

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

## Updating the installed copy

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

Deployment remains a deliberate local step. No automatic source synchronization
or update installation is configured by these launchers.

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

右上角「服务」提供重启／关闭 Monitor，不关闭 Windows 或 Codex。托管启动器使用退出码 42 请求立即重启，0 表示主动关闭、不重试；意外失败仍有限重试。

本机和公网操作均无需口令；所有可访问页面的人都能重启或关闭 Monitor。关闭后需要桌面快捷方式、远程桌面或下一次 Windows 登录重新启动，离线网页不能自行唤醒服务。

重复部署会备份旧程序，保留 `standalone.json` 与 `.cache`，更新计划任务及桌面快捷方式。`-SkipDependencies` 仅用于已有匹配依赖的安装；默认执行 `npm ci --omit=dev`。开机自启动指当前用户登录后启动，登录前不运行。