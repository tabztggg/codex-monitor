# v0.4.10 — 自动安装运行依赖

- 一键安装自动准备缺少的 **Node.js/npm、Git、PowerShell 7 和 Codex CLI**，已有可用版本直接复用。
- 工具安装到用户目录，无需管理员权限；下载 ZIP 校验 SHA256，开机自启动和网页更新复用已保存的工具路径。
- 没装 Git 也能使用：下载源码 ZIP、解压，双击 **Install Codex Monitor.vbs**。Codex 账号仍需自行登录。

**验证：** 423 项测试通过、2 项跳过；官方依赖下载、校验和运行通过隔离实测，本机部署通过。

[部署说明](https://github.com/tabztggg/codex-monitor/blob/v0.4.10/docs/standalone-windows.md) · [下载源码](https://github.com/tabztggg/codex-monitor/archive/refs/tags/v0.4.10.zip)

**English:** Automatically install missing Windows prerequisites into a private user directory. Reuse compatible tools and preserve their paths for logon startup and web updates. Download and extract the source ZIP, then run **Install Codex Monitor.vbs**; Git need not be installed beforehand.

原项目：[manuelsh/codex-monitor](https://github.com/manuelsh/codex-monitor)。
