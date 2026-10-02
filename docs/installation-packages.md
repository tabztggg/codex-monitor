# 安装包 / Installation packages

安装包保留原来的浏览器界面，后台运行，不附带另一套浏览器。Node.js、Codex CLI 和运行依赖已包含在包内，使用者不需要安装 Git、npm 或编译工具。仍需先在自己的 Codex 中登录。

## 选择下载

从 [Releases](https://github.com/tabztggg/codex-monitor/releases) 下载对应系统的文件。安装包从 v0.5.0 开始提供；若该版本尚未发布，可继续使用 README 中的源码安装方式。

| 系统 | 文件 | 使用方式 |
| --- | --- | --- |
| Windows 10/11 x64 | `windows-x64-setup.exe` | 双击安装，自动创建桌面和开始菜单快捷方式；可选择登录自启动。 |
| macOS 14+，Apple Silicon | `macos-arm64.pkg` | 安装后在“应用程序”打开 Codex Monitor，首次打开配置当前用户的登录自启动。 |
| macOS 14+，Intel | `macos-x64.pkg` | 同上。 |
| Ubuntu/Debian x64 | `linux-x64.deb` | `sudo apt install ./codex-monitor-版本-linux-x64.deb`，从应用菜单打开。 |
| Ubuntu/Debian ARM64 | `linux-arm64.deb` | 同上，选 ARM64 包。 |
| Linux 便携版 | `linux-x64.tar.gz` / `linux-arm64.tar.gz` | 解压后运行 `./codex-monitor`；需要菜单入口和自启动时执行 `./install.sh`。 |

Linux 便携版需要 glibc 2.28+；不支持 Alpine/musl。Windows ARM 可使用系统的 x64 兼容方式，本版没有原生 ARM64 安装器。`.tar.gz` 也用于网页更新，不能混用其他系统或架构的文件。

**本版未签名、未做 Apple 公证。** Windows/macOS 可能提示来源未验证。请核对下载来源与 `SHA256SUMS.txt`；不需要关闭安全软件。需要签名分发时，由发布者提供自己的代码签名证书。

## 启动、关闭与更新

- 打开快捷方式会启动后台服务并打开网页；再次打开会复用已运行的服务。
- 网页“重启服务”只重启 Monitor；“关闭服务”关闭后保持停止，直到再次启动或下次登录。没有命令行常驻窗口。
- 安装包的更新按钮检查 **最新稳定 Release**，不跟随 `main` 的每次文档提交。下载并验证完整包的 SHA256、系统和版本后才停旧服务；新版本健康检查失败会恢复旧版本。
- Windows 登录自启动可在“任务管理器 → 启动应用”关闭；macOS 对应 `~/Library/LaunchAgents/cn.codexmonitor.package.plist`；Linux 对应 `~/.config/autostart/codex-monitor.desktop`。这些是当前用户的后台启动项，不是开机前运行的系统服务。

## 配置和数据

| 系统 | 数据目录 |
| --- | --- |
| Windows | `%LOCALAPPDATA%\CodexMonitorData` |
| macOS | `~/Library/Application Support/CodexMonitor` |
| Linux | `${XDG_STATE_HOME:-~/.local/state}/codex-monitor` |

其中 `config.json` 为连接配置，`.cache/` 保存用量和校准记录，`logs/` 保存有大小限制的运行日志，`runtimes/` 保存网页更新的程序版本。不会将 Codex 的登录凭据复制到安装包。

默认地址 `http://127.0.0.1:4201`。如需局域网访问，先关闭 Monitor，将 `config.json` 中 `host` 改为 `0.0.0.0`，再启动。`port` 可修改，`codexHome` 可指定已有 Codex 数据目录；隧道来源可加入逗号分隔的 `allowedOrigins`。保留既有的无口令管理方式，开放的网页也包含重启和关闭操作。

```json
{"host":"127.0.0.1","port":4201,"allowedOrigins":""}
```

`CODEX_MONITOR_DATA_HOME` 可覆盖数据目录，用于隔离安装或测试。环境变量只影响读取它的进程，自启动入口应使用相同配置。

## 从旧版源码安装迁移

先用旧版的“关闭服务”和 `Uninstall Codex Monitor.vbs` 移除旧启动项，避免两份程序争用 4201。旧卸载器保留配置和缓存。然后安装新包；不要同时保留旧计划任务和新登录启动项。

需要保留旧统计时，首次启动新包前，将旧安装目录 `.cache/` 中的 `account-usage.json`、`quota-attribution.json`、`quota-calibration.json`、存在时的 `quota-calibration.json.manual.json`、`archived-history.json` 和 `official-usage/` 复制到新数据目录的 `.cache/`。这些文件保留账号快照、归属观测、校准基准及归档缓存。不要复制旧的进程锁或更新状态文件。自定义监听地址、端口、Codex 路径需要对应写入新 `config.json`。

## 卸载

- Windows：在“设置 → 应用”卸载 Codex Monitor，移除程序和所属快捷方式、自启动。
- macOS：执行应用目录内 `Contents/Resources/app/uninstall.sh`，关闭后台并移除所属自启动项，再将 Codex Monitor.app 移到废纸篓。
- Debian/Ubuntu：`sudo apt remove codex-monitor`。
- Linux 便携安装：运行安装目录内 `./uninstall.sh`，然后删除该程序目录。

默认保留数据目录。确定不再需要统计后可自行删除；这与 `~/.codex` 是不同目录，不要删除 Codex 的登录和聊天数据。

## 构建与发布

在目标系统执行 `npm ci && npm run package`，成品输出到 `release/`。Windows 需要 Inno Setup（可通过 `INNO_COMPILER` 指定 `ISCC.exe`），macOS 使用系统 `pkgbuild`，Linux 使用 `dpkg-deb`。构建工具只在开发/CI 机器上需要。

`npm run package:smoke` 用临时数据目录和随机端口测试成品的启动、三个页面、单实例、重启、关闭和缓存保留。Windows 还可执行 `scripts/package/Test-WindowsPackage.ps1`，检查实际安装、桌面链接、自启动、重装和卸载；已有原生安装时该测试会拒绝运行。

GitHub Actions 的 **Build installation packages** 支持手动构建五个平台组合并下载 artifacts；推送与 `package.json` 一致的 `v*` 标签时，所有构建和验证通过后汇总校验清单，并发布完整 Release。普通提交不会发布 Release。标签发布前必须已有 `docs/releases/v版本.md`。没有在目标系统完成的验证，不应记为已通过。

## English

These packages run the existing dashboard in your browser, with a background server and bundled Node.js/Codex CLI. Git, npm and build tools are not required on the user's machine. Sign in to Codex first. Download the matching installer from Releases; packages begin with v0.5.0.

Windows creates Desktop/Start menu shortcuts and offers login startup. macOS installs an app; first launch registers a per-user LaunchAgent. Linux provides DEB packages and portable archives, with menu/autostart integration. Web updates use stable Releases, verify SHA256 and platform identity, and restore the previous runtime if startup fails. Configuration and usage caches live outside the application directory and are retained on uninstall.

The first packages are unsigned and not notarized. macOS and Linux builds must pass their native CI checks before being advertised as verified. For source-install migration, stop and uninstall the old launcher first, copy account usage, quota attribution/calibration, optional manual calibration, archived history and official-usage caches, and recreate listener settings in the new data directory's `config.json`. Do not copy process locks or update state.
