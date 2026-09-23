# v0.4.2 — 隧道访问与重连修复

- 修复 cpolar／反向代理白屏和实时连接失败，支持精确配置 HTTP／HTTPS 来源。
- 减少断线时的重复请求和进程重启，增加超时、逐步退避，并保留已有统计。
- 精简中英文首页、更新日志和历史 Release 说明。

**升级：** 保留 `.cache/` 和本地配置，更新后运行 `npm ci`、`npm run build`。Windows 独立安装还需部署新构建和启动器；隧道域名填入 `standalone.json` 的 `allowedOrigins`。[配置示例](https://github.com/tabztggg/codex-monitor/blob/v0.4.2/docs/standalone-windows.md#reverse-proxy-or-tunnel)

**验证：** 本地 277 项测试通过、2 项平台相关测试跳过；类型检查、构建及公网 HTTP／HTTPS 实测通过。

<details>
<summary>English</summary>

Fix cpolar/reverse-proxy origins and WebSocket access. Back off failed connections and child restarts, add timeouts, and retain displayed data. Shorten the READMEs, changelog and release notes.

Preserve caches and local configuration. Run `npm ci` and `npm run build`; standalone Windows installs also need the updated build and runner. Set `CODEX_MONITOR_ALLOWED_ORIGINS`, or `allowedOrigins` in standalone configuration, and restart.

Local validation: 277 tests passed, 2 platform skips; type checking, build and public HTTP/HTTPS checks passed.

</details>
