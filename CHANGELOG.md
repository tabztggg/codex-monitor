# 更新日志 / Changelog

[tabztggg 改进版](https://github.com/tabztggg/codex-monitor)的版本记录，上游为 [manuelsh/codex-monitor](https://github.com/manuelsh/codex-monitor)。

## 升级 / Upgrade

停止 Monitor，备份并保留 `.cache/` 和本地配置。更新源码后运行 `npm ci`、`npm run build`，再启动。
Windows 独立安装运行 `wscript.exe "Codex Monitor.vbs" deploy` 更新已安装副本。见[独立安装说明](docs/standalone-windows.md#updating-the-installed-copy)。

Stop Monitor, preserve caches and configuration, update source, run `npm ci` and `npm run build`, then restart.
For standalone Windows installations, run `wscript.exe "Codex Monitor.vbs" deploy` to update the installed copy.

## v0.5.1 — 2026-09-28

- 新增 5 项分析功能：所选范围的跨账号模型对比、按模型堆叠的日趋势与当天任务下钻、历史缓存效率、价格依据与定价覆盖率、默认脱敏的 HTML／CSV／JSON 报告导出。
- 实时 Token 增加“1 秒”均值：最近 1 分钟输入／输出总量除以 60；缓存命中率和任务数仍按该分钟统计，不增加采集频率。
- 提供 Windows EXE、macOS Intel／Apple Silicon PKG、Linux x64／ARM64 DEB 及便携包，内置 Node.js 和 Codex CLI，支持快捷启动、登录自启动和独立数据目录。
- 安装包从稳定 Release 更新，校验后切换，启动失败回退；源码安装入口继续保留。安装包未签名、未做 Apple 公证。
- 修复隐藏路径的页面路由，完善退出时的子进程清理。
- 修复原生安装包验证的启动／重启时序校验，等待服务和管理状态均就绪后再继续。

缓存输入不重复计入总 Token；未知模型、未定价和缺失数据保留明确标记。费用是 API 等价估算，不是订阅账单或官方额度扣减。详见 [v0.5.1 发布说明](docs/releases/v0.5.1.md)。

已有本地测试记录：682 项通过，2 项跳过。

English: Add cross-account model comparison, stacked daily trends with task drilldown, weighted cache efficiency, pricing coverage and on-demand HTML/CSV/JSON exports. The new 1-second view is the last minute's input/output divided by 60. Bundled-runtime installers add shortcuts, login startup, persistent data and stable-release updates with rollback; source installs remain supported. Package smoke checks wait for service and manager readiness during startup/restart. Packages are unsigned and not notarized. Costs are estimates, not subscription charges.

## v0.4.12 — 2026-09-28

- 修复切换登录后仍显示旧账号额度；每分钟检测本地身份变化，“立即刷新”同步读取账号，旧通知不会覆盖新额度。
- 版本检查保留上次确认结果，显示具体原因与重试时间，遵守 GitHub 限流；减少重复请求，隐藏页面暂停检查。
- 更新中英文首页说明与实际界面截图，使用虚构演示数据。

验证：624 项测试通过、2 项跳过；类型检查、构建及本机部署通过。

English: Refresh account identity after login switches and discard stale notifications. Make version checks clearer and less repetitive, preserve confirmed results, and honor retry deadlines. Refresh the bilingual README and screenshots.

## v0.4.11 — 2026-09-27

- 首页新增实时 Token：1／5／20 分钟和 1 小时切换，仅保留内存数据；统一总览卡片与排行布局。
- 修复分叉重复计量、读取失败丢失统计、Token 缺项及累计缺口；历史请求超时保留旧值。
- Windows 安装先暂存、失败回滚，与网页更新互斥；完善依赖下载诊断和代理支持，修复 ZIP 版本检测。
- 限制超长日志内存开销，活动状态未知时阻止空闲关机；修复过期更新提示和辅助说明。

验证：592 项测试通过、2 项跳过；类型检查、构建与本机部署通过。首页截图使用虚构数据。

English: Add memory-only live token windows and refresh the overview. Fix fork accounting, incomplete reports and failed-read recovery. Harden Windows installs with staging, rollback and download diagnostics; handle oversized logs and unknown activity safely.

## v0.4.10 — 2026-09-27

- Windows 一键安装自动补齐 Node.js/npm、Git、PowerShell 7 和 Codex CLI；复用已有环境，缺失时安装官方工具到用户目录，开机启动与网页更新沿用同一路径。

验证：423 项测试通过、2 项跳过；官方依赖下载、校验和运行通过隔离实测，本机部署通过。

English: Automatically prepare missing Windows dependencies in a private user directory; reuse compatible tools and persist their paths for logon startup and web updates.

## v0.4.9 — 2026-09-27

- 根目录提供一键安装／修复、更新和卸载入口，无命令行窗口；卸载保留配置与用量数据，重装自动复用。

验证：410 项测试通过、2 项跳过；入口与卸载流程通过隔离测试，本机卸载预演通过，未卸载实际服务。

English: Add root-level install/repair, update and uninstall entries without console windows. Uninstall preserves settings and usage data for reinstallation.

## v0.4.8 — 2026-09-27

- 更新检测单次仓库请求超时从 4 秒延长至 10 秒；网页等待上限同步调整为 35 秒，容纳最多三次依次请求。
- 自动与手动检查间隔保持不变。

English: Increase the per-request update-check timeout from 4 to 10 seconds and the browser wait to 35 seconds for up to three sequential requests. Polling intervals are unchanged.

## v0.4.7 — 2026-09-27

- 网页增加“更新”：从本仓库 `main` 下载构建后，自动停止、安装并重启；保留配置与缓存，失败回滚。
- 页头显示当前／仓库版本，状态与更新合为单个按钮，支持重新检查与失败重试；用量总览恢复剩余额度与剩余时间双进度条。
- 降低后台开销：任务默认 10 分钟、账号额度 5 分钟、活动检测 1 分钟；支持 30／60 分钟刷新，隐藏页面暂停统计轮询，自动关机保留快速活动检测。

验证：391 项测试通过、2 项跳过；类型检查、构建及本机部署通过。更新中英文首页截图，均使用演示数据。

English: Add an on-demand repository update button with staged builds, restart and rollback; show installed/repository versions and update alerts. Restore paired quota/time remaining bars. Slow ordinary polling, pause hidden-page statistics, and retain fast activity checks for shutdown automation.

## v0.4.6 — 2026-09-27

- Windows 根入口和桌面快捷启动支持 Codex 自带的 PowerShell 7，修复未单独安装 PowerShell 7 时无法启动。
- 后台子进程复用当前 PowerShell 路径，避免登录自启动因 PATH 不同而失败；界面与统计逻辑不变。

验证：336 项测试通过、2 项跳过，类型检查与构建通过；本机部署和网页访问已验证，未实测 Windows 重启。

English: Windows launchers now fall back to Codex-bundled PowerShell 7. Background runners reuse the same executable instead of depending on Task Scheduler's PATH. UI and statistics are unchanged.

## v0.4.5 — 2026-09-27

- 总览、任务、趋势改为独立页面，更新中英文排版及首页截图；总览增加 Token 拆分、范围内消耗前 3 名与当前活动。
- 总览只显示当前登录账号、完整额度周期及更新时间；任务页保留历史账号选择，不切换 Codex 登录。
- 任务额度明确为“所选账号·本周期 / 跨账号·任务累计”，两侧独立排序；汇总与趋势按所选日期估算，缺失数据不再当作零。
- 补齐 GPT-6 Sol／Luna 计价与缓存重算，修复重复事件、漏统计子任务和时间范围偏差；校准不足时保留已有基准。
- Windows 启动脚本统一使用 PowerShell 7，保留桌面快捷方式与独立登录自启动。

验证：336 项测试通过、2 项跳过；类型检查与构建通过。网页截图使用实际构建和虚构数据。

English: Add dedicated overview, task and trends pages; clarify account/period scopes and quota sorting; fix model pricing, missing/duplicate usage and range handling; use PowerShell 7 launchers. Verified with 336 passing tests, 2 skips, type checking and production build.

## v0.4.4 — 2026-09-26

- 多账号用量下拉选择、左右切换，保留各账号最近记录并标注时间，不改变登录账号。
- 语言按钮左侧新增重启、关闭服务按钮；本机及公网均无需口令，可访问页面的人都能操作。
- Windows 改为独立登录自启动，取消跟随 Codex；部署自动创建并校验桌面快捷方式。
- 根目录统一为 `Codex Monitor.vbs`，首次自动部署，旧入口移到 `scripts/legacy/`。
- 验证：297 项测试通过、2 项跳过；类型检查、构建及本机重启／关闭／快捷启动通过。Windows 重启后自启动尚未实测。

English: Add recorded-account switching and password-free service controls; simplify Windows deployment with a single root launcher, verified desktop shortcut and independent logon startup. Historical accounts show saved snapshots, not live readings.

## v0.4.3 — 2026-09-26

- 当前账号与跨账号等效消耗合并为一列，保留分别排序和项目汇总；统一估算基准。
- 展开任务可查看官方累计用量及模型、推理强度、速度分布；按账号缓存，读取失败保留旧值。
- 增加 Windows 无窗口启动器和跟随 Codex 退出的运行方式。自动启动需在 Codex 中信任 SessionStart Hook；仅打开首页不会触发。
- 验证：293 项测试通过、2 项跳过；类型检查与构建通过。

English: Combine current/cross-account estimates, add cached official lifetime usage details, and support windowless launch with the Codex desktop lifecycle. SessionStart hooks require user trust and a task start/resume.

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
