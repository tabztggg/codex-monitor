# 更新日志 / Changelog

[tabztggg 改进版](https://github.com/tabztggg/codex-monitor)的版本记录，上游为 [manuelsh/codex-monitor](https://github.com/manuelsh/codex-monitor)。

## 升级 / Upgrade

停止 Monitor，备份并保留 `.cache/` 和本地配置。更新源码后运行 `npm ci`、`npm run build`，再启动。
Windows 独立安装还需部署新构建与依赖；v0.4.2 还需更新启动器。见[独立安装说明](docs/standalone-windows.md#updating-the-installed-copy)。

Stop Monitor, preserve caches and configuration, update source, run `npm ci` and `npm run build`, then restart.
Standalone Windows installations also need the new build, dependencies and, for v0.4.2, the updated runner.

## v0.4.2 — 2026-09-23

- 修复 cpolar／反向代理白屏及实时连接被拒绝，支持配置精确的 HTTP／HTTPS 来源。
- 修复断线后的频繁重连和后台进程反复启动；增加超时与逐步退避，保留已显示的数据。
- 精简中英文首页、更新日志和 Release 说明。
- 验证：277 项测试通过、2 项平台相关测试跳过；类型检查、构建和公网 HTTP／HTTPS 实测通过。

反向代理需设置 `CODEX_MONITOR_ALLOWED_ORIGINS`；独立安装在 `standalone.json` 中配置 `allowedOrigins`，重启后生效。见[配置示例](docs/standalone-windows.md#reverse-proxy-or-tunnel)。

<details>
<summary>English</summary>

- Fix blank pages and rejected WebSockets behind cpolar/reverse proxies with an explicit HTTP/HTTPS origin allowlist.
- Back off failed connections and app-server restarts, time out stalled requests, and retain displayed data.
- Shorten both READMEs, the changelog and release notes.
- Validated locally: 277 tests passed, 2 platform skips; type check, build and public HTTP/HTTPS checks passed.

Set `CODEX_MONITOR_ALLOWED_ORIGINS`, or `allowedOrigins` in standalone `standalone.json`, then restart.

</details>

## v0.4.1 — 2026-09-23

- 修复并发聊天、切换账号窗口及重复日志造成的校准偏差。
- 后台更新校准时继续显示旧参考值；样本自动升级，无需清空缓存。
- 固定顶栏，修复任务、趋势和估算依据页面的返回导航及窄屏跳转。

English: Correct concurrent-chat calibration and duplicate samples, retain the previous reference during migration, and fix sticky-header navigation. Keep existing caches when upgrading.

## v0.4.0 — 2026-09-23

- 重新设计仪表盘，分开显示账号额度、跨账号估算和任务明细。
- 明确标注周期开始、结束／重置、数据截至时间和时区。
- 改进套餐对比、刷新入口、表格排版和校准提示，更新中英文截图。

English: Redesign the dashboard, clarify account versus cross-account usage and period boundaries, and improve controls, tables and screenshots.

## v0.3.0 — 2026-09-23

- 显示额度所属账号；读取失败时保留旧数据，换号后不混用额度。
- 校准跨周期和重启保留，支持 Pro 20x／5x／Plus 对比。
- 增加可记忆的精简视图，以及 Windows 独立运行、启停和重试脚本。

English: Show account identity, retain data and calibration, add plan comparisons and saved table views, and support configured Windows standalone installations.

## v0.2.0 — 2026-09-22

- 修复任务漏统计和子任务归属；普通刷新只处理新增日志，减少卡顿。
- 增加手动重算与读取恢复，修复额度兼容、关机取消及 Linux 启动问题，更新依赖。
- 首次版本发布，包含中英文、最近 30 个归档、项目汇总、排序、趋势及跨账号估算。

从旧解析器升级会重建额度归因基线；此前无法可靠分配的消耗保留为“未归因”。不修改原始 Codex 日志。

English: Fix missing tasks and child attribution, add incremental refresh and rebuild/recovery controls, and improve launchers and dependencies. The first tagged release includes bilingual views, archives, grouping and usage analysis. Upgrading the old parser resets the attribution baseline; earlier unassignable usage remains unattributed and source logs are preserved.
