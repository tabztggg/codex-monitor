# v0.4.8 — 更新检测超时调整

- 更新检测单次请求超时：4 秒 → 10 秒。
- 网页等待上限调整为 35 秒，避免后端仍在检查时提前报错；检查频率不变。

**升级：** v0.4.7 Windows 独立安装可点击网页更新；也可更新源码后运行 `wscript.exe "Codex Monitor.vbs" deploy`。[部署说明](https://github.com/tabztggg/codex-monitor/blob/v0.4.8/docs/standalone-windows.md#updating-the-installed-copy)

**验证：** 超时修改已通过 391 项测试（2 项跳过）、构建和本机部署验证。

**English:** Allow 10 seconds per repository request and 35 seconds in the browser for update checks. Polling intervals are unchanged.

原项目：[manuelsh/codex-monitor](https://github.com/manuelsh/codex-monitor)。
