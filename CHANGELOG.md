# Changelog / 更新日志

Version numbers here belong to the [tabztggg customization](https://github.com/tabztggg/codex-monitor),
based on [manuelsh/codex-monitor](https://github.com/manuelsh/codex-monitor). They do not describe upstream releases.

这里的版本号用于基于上游项目改进的 tabztggg 版本，不代表上游项目的发布版本。

## v0.3.0 — 2026-09-23

### 简体中文

本版本改进用量数据的连续显示、跨账号校准和表格易用性，并加入 Windows 独立运行脚本与说明。

#### 本次更新

- **账号与数据保留**：显示总体额度所属账号和更新时间。接口短暂失败或 CLI 断连时继续显示明确标注的旧快照与本周期统计；旧额度不参与新的消耗分摊，确认换号或退出后不混用前一账号额度。
- **校准持续可用**：有效等效消耗校准跨周期和重启保留，后台累积至少 5 个百分点的有效新样本后更新；修复较早周起点账号无法更新、缩小归档范围改变基准以及保存失败不重试的问题。
- **套餐对比**：支持 Pro 20x、Pro 5x、Plus 标称周额度对比，联动任务、项目、范围合计与趋势，并记住选择。时间范围明确标明影响的指标。
- **表格与排版**：默认完整表格，提供可记忆的精简视图与指标选择；隐藏列只在完整视图出现。缩短英文表头，重排统计设置、合计、筛选、任务表与说明，改进零值和校准提示。
- **启动与独立运行**：额度窗口就绪后立即刷新任务数据。Windows 已配置安装可由登录计划任务独立运行，关闭 Codex GUI 不影响 Monitor；支持进程组清理、有限重试及启停管理。

#### 升级说明

1. 停止 Monitor，备份本地配置及 `.cache/`，取得本版本源码后运行 `npm ci`、`npm run build`。
2. 从源码运行者使用原启动方式。独立安装者还需把新 `dist`、匹配的依赖清单和生产依赖部署到安装目录；仅 `git pull` 或重启不会更新已安装副本。详见 [Windows 独立安装说明](docs/standalone-windows.md)。
3. 保留 `.cache/quota-calibration.json`、额度归因账本和本地 `standalone.json`。旧校准文件继续兼容；保存失败会在后续正常刷新重试。
4. 默认仍只读取最近 30 个归档主任务，已观察的校准样本单独保留最多 30 天；这不会触发额外的全归档扫描。

独立运行脚本不是通用一键安装器，需要预先配置安装目录和 Windows 登录计划任务。本次不提供二进制安装包。
记录中的 Pro 账号仍按 20x 处理，对比套餐只改变标称参考比例；费用和额度均为本地估算，不是官方账单。

#### 验证

- Windows：210 项测试通过、2 项平台相关测试跳过；类型检查与生产构建通过。
- 中英文、宽窄屏、列开关、视图记忆与实际重启已验证。GitHub Actions 按仓库配置检查 Windows、macOS、Linux；CI 不等于三平台桌面流程全部人工实测。

### English

This release improves continuity of usage data, calibration across accounts, and table usability, and adds Windows standalone runtime helpers and documentation.

#### Changes

- **Account identity and retained data:** show the quota account and update time. Temporary read failures or CLI disconnects keep an explicitly labeled previous snapshot and current-period metrics. Stale quota does not generate new attribution, and confirmed account changes or logout never inherit another account's quota.
- **Persistent calibration:** keep valid equivalent-usage calibration through resets and restarts while collecting replacement samples. Update after at least five valid percentage points. Fix earlier account-window dates blocking updates, reduced archive scope changing calibration, and failed saves never retrying.
- **Plan comparisons:** select nominal Pro 20x, Pro 5x, or Plus weekly references across tasks, projects, totals, and trends. The selection is remembered; time-range controls explain which metrics they affect.
- **Table and layout:** Full table is the default; explicit Simple view and its metric are remembered. Column visibility controls appear only in Full table. Shorter English headers, clearer section order, and improved zero/calibration states make statistics easier to scan.
- **Startup and standalone runtime:** refresh task statistics when the initial quota window becomes ready. Configured Windows installations run independently through a logon task, with process-group cleanup, bounded retries, and start/stop management.

#### Upgrading

1. Stop Monitor and back up local configuration and `.cache/`. Obtain this version, then run `npm ci` and `npm run build`.
2. Source users can use their existing launcher. Standalone installations must also receive the new `dist`, matching manifests and production dependencies; pulling or restarting alone does not update the installed copy. See [Windows standalone deployment](docs/standalone-windows.md).
3. Preserve `.cache/quota-calibration.json`, the attribution ledger, and local `standalone.json`. Existing calibration files remain compatible; failed persistence retries during later refreshes.
4. The default still reads only the 30 most recently archived principal tasks. Already-observed calibration metadata is retained separately for up to 30 days, without an extra full-archive scan.

The Windows helpers require an already configured installation and logon task; they are not a universal one-click installer. No binary installer is attached.
Recorded Pro accounts are still assumed to be 20x. Plan selection changes the nominal comparison reference only. Costs and quotas remain local estimates, not official billing.

#### Validation

- Windows: 210 tests passed, 2 platform-specific tests skipped; type checking and production build passed.
- Chinese/English, wide/narrow layouts, column controls, saved views, and actual restart behavior were checked. Repository CI covers Windows, macOS, and Linux; this is not manual verification of every desktop workflow on all platforms.

## v0.2.0 — 2026-09-22

### 简体中文

本版本重点修复任务漏统计，并减少刷新时反复读取大日志造成的卡顿。
这是本仓库首次带版本标签的发布，也包含此前已提供的易用性改进。

#### 本次更新

- **修复任务漏统计**：子代理日志中的继承元数据不再覆盖主任务身份；子任务用量正确归入对应主任务。
- **增量刷新**：启动时加载当前统计范围，后续只读取日志追加内容。未变化的已结束及归档任务不再重复读取正文，任务结束后的最终用量仍会更新。
- **手动重新统计**：新增“重新统计”按钮；“立即刷新”和定时刷新继续使用增量读取。重算保持当前归档范围，默认仍为最近 30 个归档主任务。
- **缓存与读取恢复**：兼容旧缓存，处理半行写入、UTF-8 跨块、日志截断或替换，以及临时读取失败；时间范围变化从紧凑统计记录重算。
- **稳定性修复**：改进额度响应格式兼容、请求超时与重连、取消关机时序、任务预览，以及 Linux 启动器的递归发现问题。
- **依赖更新**：更新受影响依赖并修补已发现的依赖安全问题。

#### 本版本包含的易用性功能

- 中英文切换，首次打开默认英语，记住上次语言。
- 最近 30 个归档任务默认参与统计，可隐藏归档行或按需统计全部归档。
- 可选项目分组、项目汇总、各列排序、搜索、列显隐及显示密度设置。
- 今日、近 7 天、当前额度周期和任务累计分析，以及每日趋势、项目排行。
- 跨账号 20x 等效消耗估算，支持超过 100%；刷新间隔可选 30 秒及 1 / 2 / 5 / 10 分钟。

#### 升级说明

1. 停止运行中的 Monitor，按需备份本地 `.cache/`，然后取得本版本源码。
2. 在项目目录运行 `npm ci` 和 `npm run build`，再使用原有启动方式启动。
3. 首次启动或点击“重新统计”仍需要加载所选范围；普通刷新随后使用增量数据。

从旧解析器版本升级时，受影响的“当前账号额度占比”账本由 v1 升级到 v2，在下一次成功观测时重新建立基线。
此前已消耗但无法可靠分配到任务的额度保留为**未归因**，相关任务可能暂时显示 `--`。
原始 Codex 日志不会被修改；Token、费用和 20x 等效消耗继续根据日志估算。
日常点击“重新统计”不会再次重置额度分配记录。
隐藏归档只影响列表；“统计所有归档”才扩大读取范围。

#### 验证与性能

- Windows 本地测试：182 项通过，2 项平台相关测试跳过；类型检查和生产构建通过。
- 功能提交 `80e20c7` 已通过 Windows、macOS、Linux 的 GitHub Actions 检查；这不等于三平台所有桌面操作均已人工实测。
- 同一台 Windows 电脑、大量本地日志下，普通统计刷新观测值由约 7 秒降至约 0.22–0.26 秒。实际耗时取决于日志规模、硬件和新增内容，首次加载不适用这一数值。
- 所有费用及额度分摊均为本地估算，不是官方账单；缺失日志无法补回。

### English

This release fixes missing task statistics and reduces repeated reads of large logs during refresh.
It is the first tagged release of this customization and also includes its existing usability features.

#### Changes

- **Missing tasks:** inherited metadata in subagent logs no longer overwrites the owning task identity; child usage is attributed to the appropriate principal task.
- **Incremental refresh:** load the selected scope on startup, then consume appended log records. Unchanged finished and archived transcripts are not reread; final usage after completion is still collected.
- **Manual rebuild:** a new **Rebuild statistics** button reconstructs the selected scope. **Refresh now** and scheduled refreshes remain incremental. The default scope still includes only the 30 most recently archived principal tasks.
- **Cache and reader recovery:** handle older caches, partial lines, UTF-8 boundaries, truncation, replacement, and transient read failures. Time-range changes use compact statistics records.
- **Reliability:** improve quota-response compatibility, request timeouts and reconnection, shutdown cancellation ordering, task previews, and Linux launcher discovery.
- **Dependencies:** update affected dependencies and address the identified dependency security issues.

#### Included usability features

- Chinese and English UI, English for new visitors, and a remembered language preference.
- Archived tasks included by default within the recent-30 scope, with archive visibility and explicit full-archive loading controls.
- Optional project grouping and totals, column sorting, search, column visibility, and display density.
- Today, Last 7 days, Current quota period, and Task lifetime analysis, daily trends, and project rankings.
- Cross-account 20x-equivalent estimates that can exceed 100%, plus refresh intervals of 30 seconds and 1, 2, 5, or 10 minutes.

#### Upgrading

1. Stop the running Monitor, optionally back up the local `.cache/` directory, and obtain this version's source.
2. Run `npm ci` and `npm run build` in the project directory, then start it with your existing launcher.
3. The first startup or an explicit rebuild still loads the selected scope; subsequent ordinary refreshes use incremental data.

When upgrading from the older parser, the affected current-account quota-attribution ledger migrates from v1 to v2 and establishes a new baseline on the next successful observation.
Previous consumption that cannot be reliably assigned to tasks remains **unattributed**, so some task shares may temporarily show `--`.
Original Codex logs are not modified. Tokens, API-equivalent costs, and 20x equivalents remain log-based estimates.
Ordinary use of **Rebuild statistics** does not reset the quota-attribution ledger again.
Hiding archive rows affects the list only; loading all archives explicitly expands the read scope.

#### Validation and performance

- Local Windows validation: 182 tests passed, 2 platform-specific tests skipped; type checking and production build passed.
- Implementation commit `80e20c7` passed GitHub Actions on Windows, macOS, and Linux. This does not establish manual verification of every desktop workflow on all three platforms.
- On one Windows machine with a large local history, ordinary statistics refresh was observed to improve from about 7 seconds to 0.22–0.26 seconds. Results depend on hardware, log size, and appended data; these figures exclude the initial load.
- Costs and quota allocation are local estimates, not official billing records. Missing logs cannot be reconstructed.

[v0.2.0 release](https://github.com/tabztggg/codex-monitor/releases/tag/v0.2.0)
