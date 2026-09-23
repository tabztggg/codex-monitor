# Standalone Windows deployment

[English README](../README.md) · [中文说明](#中文说明)

This page documents the per-user deployment configured on the maintainer's
Windows machine. The repository currently has no general one-click installer
for this deployment. Downloading the repository alone does not register its
scheduled task, configured installed copy, or shortcuts. The management scripts
under `scripts/` must be copied into a configured installation before use.

## Installed files and dependencies

The installed copy lives in `%LOCALAPPDATA%\Programs\CodexMonitor`. It contains
its own `dist`, production dependencies, `.cache`, `logs`, `standalone.json`,
`Run-StandaloneMonitor.ps1`, and `Manage-StandaloneMonitor.ps1`.

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
| Service exit recovery | The installed launcher waits one minute and retries, up to three times per launch. |

This is a **logon startup task**. Running before a user signs in or continuing
after sign-out is outside this installation's guarantees; it is not registered
as a Windows service. Closing the Codex GUI does not request a monitor stop.

Recovery is implemented by the installed launcher, not Task Scheduler's
`RestartOnFailure` setting. Each attempt owns a Windows process group; exiting
cleans up its remaining children before the next attempt. Stopping the task also
ends any pending retry. If all three retries fail, start it again after resolving
the error. Terminating the outer launcher itself requires a manual start or a
new logon.

Use the desktop shortcut to start the monitor. The Start menu also contains
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

## Logs and troubleshooting

Look under `%LOCALAPPDATA%\Programs\CodexMonitor\logs`:

| File | Contents |
| --- | --- |
| `stdout.log` | Current backend standard output. |
| `stderr.log` | Current backend errors and diagnostics. |
| `stdout.1.log`–`stdout.3.log`, `stderr.1.log`–`stderr.3.log` | Output from previous launches, rotated at startup. |
| `lifecycle.jsonl` | Startup, process exits, retry attempts, and runner errors. |

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
这是**登录自启**，不承诺未登录或注销后继续运行，也没有注册为 Windows 服务。

Node.js 和已登录、支持 `codex app-server` 的 Codex CLI 仍然必需；Monitor 自己启动
所需的 CLI 进程。当前安装保持关机模拟模式。通过桌面快捷方式启动，开始菜单还提供
Stop / Restart 快捷方式，或使用上面的 PowerShell 命令。旧 Startup 快捷方式和源码中的
Windows 启动器都会转到同一个已安装任务，避免重复启动。Stop 只停止当前实例，
不会取消下次登录自启。

日志在安装目录的 `logs` 下：`stdout.log`、`stderr.log` 记录当前输出，`.1` 到 `.3`
保留之前启动的输出，`lifecycle.jsonl` 记录启动、退出和运行器错误。也可查看计划任务
的上次运行结果；HTTP 健康检查成功不代表 CLI 登录和账号数据一定可用。

**安装目录不会自动跟随源码更新。** 更新后需在源码目录重新构建，停止已安装实例，
备份并重新部署 `dist`、匹配的依赖清单和所需生产依赖，再启动验证。保留本地配置、
`.cache`、日志及管理脚本，除非更新明确要求更换。仅修改源码、执行 `git pull`、
重新构建或重启，都不会自动替换已安装的应用文件。
