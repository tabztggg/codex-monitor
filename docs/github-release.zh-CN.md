# v0.4.6 — Windows 启动修复

- 根入口与桌面快捷方式支持 Codex 自带的 PowerShell 7，无需重复安装。
- 后台子进程复用启动器的 PowerShell，修复登录自启动环境中 PATH 不同导致的失败。
- 沿用已通过预览验收的三页界面，更新中英文首页说明；统计逻辑不变。

**升级：** 保留缓存和本地配置，更新源码后运行 `wscript.exe "Codex Monitor.vbs" deploy`。[部署说明](https://github.com/tabztggg/codex-monitor/blob/v0.4.6/docs/standalone-windows.md#updating-the-installed-copy)

**验证：** 336 项测试通过、2 项跳过，类型检查与构建通过；本机部署和网页访问已验证，未实测 Windows 重启。

**English:** Fix Windows startup when only Codex-bundled PowerShell 7 is available, and reuse the same executable for background runners. UI and statistics are unchanged. Preserve caches and configuration when updating.

原项目：[manuelsh/codex-monitor](https://github.com/manuelsh/codex-monitor)。
