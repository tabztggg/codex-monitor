# v0.4.9 — 一键安装、更新与卸载

- 根目录新增 **Install / Update / Uninstall Codex Monitor.vbs**，双击安装、更新或卸载，全程无命令行窗口。
- 安装自动创建桌面快捷方式和登录自启动；卸载保留配置、用量缓存及备份，重装自动复用。
- 更新复用现有部署与回滚流程；重复点击或回执丢失不会重复提交更新。

**使用：** 拉取／下载本版源码即可使用根目录入口。安装本地源码用 **Install**，升级已安装副本到仓库最新版用 **Update**。[部署说明](https://github.com/tabztggg/codex-monitor/blob/v0.4.9/docs/standalone-windows.md)

**验证：** 410 项测试通过、2 项跳过；入口与卸载流程通过隔离测试，本机卸载预演通过，未卸载实际服务。

**English:** Add console-free install/repair, update and uninstall entries in the root. Preserve settings and usage data on uninstall and reuse them on reinstall. Download or pull the source to get the new entries.

原项目：[manuelsh/codex-monitor](https://github.com/manuelsh/codex-monitor)。
