# v0.4.7 — 网页更新与低频刷新

- 网页显示当前／仓库版本，合并更新按钮与状态；下载构建后自动停止、安装、重启，失败回滚，保留配置和缓存。
- 任务统计默认 10 分钟刷新，可选 30／60 分钟；账号额度 5 分钟、活动检测 1 分钟，隐藏页面暂停统计轮询，自动关机保留快速检测。
- 恢复剩余额度与剩余时间双进度条，更新中英文首页截图。

**升级：** 旧版首次升级仍需更新源码，再运行 `wscript.exe "Codex Monitor.vbs" deploy`；本版 Windows 独立安装之后可在网页更新。[部署说明](https://github.com/tabztggg/codex-monitor/blob/v0.4.7/docs/standalone-windows.md#updating-the-installed-copy)

**验证：** 391 项测试通过、2 项跳过，类型检查、构建及本机部署通过；未实测 Windows 重启。

**English:** Add in-app Windows updates with version status and rollback; reduce polling and pause hidden-page statistics; restore paired remaining-quota/time bars. Update bilingual homepage screenshots. Older installations need one manual deployment to enable web updates.

原项目：[manuelsh/codex-monitor](https://github.com/manuelsh/codex-monitor)。
