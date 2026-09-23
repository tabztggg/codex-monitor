# GitHub 发布文案

本文件对应 **v0.4.0**，用于仓库介绍和本次 Release 正文；文件存在不表示发布已经完成。
版本标签、提交与验证状态以发布时的核验结果为准。

## 仓库展示名称与简介

**Codex Monitor — 任务与项目用量仪表盘**

中文主页与 About 为主要入口，保留 [manuelsh/codex-monitor](https://github.com/manuelsh/codex-monitor) 的上游署名。
本仓库是易用性扩展版本，不代表上游官方发布。

中文 About：

```text
Codex 本地用量仪表盘：支持任务与项目统计、归档分析、趋势、中英文界面，以及 Pro 20x / 5x / Plus 等效额度估算。
```

English About:

```text
Local Codex usage dashboard with task and project statistics, archives, trends, bilingual UI, and estimated Pro 20x / 5x / Plus quota equivalents.
```

## Release 标题

**v0.4.0 — 全新仪表盘与清晰的跨账号统计**

## Release 正文

### 简体中文

本版本重新设计仪表盘，让当前账号额度、跨账号用量估算和任务明细更容易区分，并明确显示统计周期的起止时间。

#### 本次更新

- **新版界面**：按账号额度、跨账号指标卡、任务明细分区，增加顶部跳转导航，统一按钮、间距、数字层级和状态颜色；适配中英文及窄屏布局。
- **账号额度卡**：集中显示额度所属账号、剩余额度、已用比例、周期经过比例，以及下一次重置的倒计时和具体时间；保留 CLI 账号来源和旧快照说明。
- **跨账号范围更明确**：等效消耗卡和表头标注“跨账号”，注明本地记录、可超过 100% 及一份所选套餐周额度的参考口径。周期选择和 Pro 20x / Pro 5x / Plus 对比入口放在指标上方。
- **周期起止不再混淆**：分别显示额度周期开始、结束／重置和数据截至时间，并标注时区。过期周期会提示等待新周期；缺失或无效的周期信息不会补造日期。
- **任务与刷新更易查看**：任务名下显示所属项目，调整表头宽度与滚动布局；自动刷新间隔直接可见，重算及刷新详情收在更多操作中。新增校准状态条和直达“估算依据”的入口。
- **仓库预览**：更新中英文主页的新版真实 UI 截图，使用虚构账号、项目与用量展示。

#### 升级说明

1. 停止 Monitor，备份本地配置及 `.cache/`，取得本版本源码后运行 `npm ci`、`npm run build`，再使用原启动方式启动。
2. Windows 独立安装者还需把构建输出、匹配的依赖清单及生产依赖部署到安装目录；仅更新源码或重启不会更新已安装副本。详见 [Windows 独立安装说明](https://github.com/tabztggg/codex-monitor/blob/v0.4.0/docs/standalone-windows.md)。
3. 本次不迁移统计数据或重置校准。保留 `.cache/quota-calibration.json`、额度归因账本和本地 `standalone.json`，浏览器中已有语言和视图偏好继续生效。
4. 默认仍只读取最近 30 个归档主任务；隐藏归档只改变列表，点击“统计所有归档”才扩大读取范围。后台校准与刷新仍保留已有可用数据。

本次不提供二进制安装包。费用与等效消耗仍为本地估算，不是官方账单；记录中的 Pro 账号继续按 20x 假设处理，套餐选项只调整对比参考。

#### 验证

- Windows：217 项测试通过、2 项平台相关测试跳过；TypeScript 检查与生产构建通过。
- 已检查中英文、宽窄屏布局、周期切换、排序、项目分组、归档隐藏、套餐对比和数据保留。
- 周期显示测试覆盖截至时间与重置时间的区别、时区、过期周期、缺失及无效周期。本地检查不代替发布提交的 GitHub Actions 结果，也不等于三平台全部桌面流程人工实测。

### English

This release redesigns the dashboard to distinguish current-account quota, cross-account usage estimates, and task details, with explicit statistics-window boundaries.

#### Changes

- **Redesigned dashboard:** separate account quota, cross-account metric cards, and task details. Add section navigation and consistent controls, spacing, numeric hierarchy, and state colors, with bilingual and narrow-screen layouts.
- **Account quota card:** bring the quota account, remaining allowance, used percentage, elapsed-period percentage, reset countdown, and exact reset time together. Keep CLI account-source details and retained-snapshot notices.
- **Clearer cross-account scope:** label equivalent-usage cards and columns as across accounts, explain local-record scope and values above 100%, and show the selected plan's weekly reference. Place period controls and Pro 20x / Pro 5x / Plus comparison above the metrics.
- **Explicit period boundaries:** distinguish quota start, end/reset, and data cutoff with time zones. Expired periods indicate that a new window is pending; missing or invalid windows do not invent dates.
- **More readable tasks and refresh controls:** show project subtitles, improve column widths and scrolling, and expose refresh intervals directly. Keep rebuild and refresh details in More actions, with a calibration status strip and a shortcut to the estimation basis.
- **Repository previews:** refresh the Chinese and English homepages with screenshots of the actual redesigned UI using fictional accounts, projects, and usage.

#### Upgrading

1. Stop Monitor and back up local configuration and `.cache/`. Obtain this version, run `npm ci` and `npm run build`, then use your existing launcher.
2. Windows standalone installations must also receive the build output, matching manifests, and production dependencies; updating source or restarting alone does not update an installed copy. See [Windows standalone deployment](https://github.com/tabztggg/codex-monitor/blob/v0.4.0/docs/standalone-windows.md).
3. This release does not migrate statistics or reset calibration. Preserve `.cache/quota-calibration.json`, the attribution ledger, and local `standalone.json`. Existing browser language and view preferences continue to apply.
4. The default still reads only the 30 most recently archived principal tasks. Hiding archives affects the list; Calculate all archives explicitly expands the read scope. Background calibration and refresh continue to retain available data.

No binary installer is attached. Costs and equivalent usage remain local estimates, not official billing. Recorded Pro accounts are still assumed to be 20x; the plan selector changes only the comparison reference.

#### Validation

- Windows: 217 tests passed, 2 platform-specific tests skipped; TypeScript checking and production build passed.
- Checked Chinese/English, wide/narrow layouts, period selection, sorting, project grouping, archive visibility, plan comparisons, and retained data.
- Period tests cover cutoff versus reset times, time zones, expired periods, and missing or invalid windows. Local checks do not replace GitHub Actions results for the release commit or establish manual verification of every desktop workflow on all platforms.

## 发布操作备注

- Release 正文使用上方“简体中文”和“English”两部分，保留升级说明和估算边界。
- 首页截图须来自新版真实应用，使用虚构账号、项目和用量；不上传真实日志、缓存、配置、私人对话或账号截图。
- 目标个人仓库为 `tabztggg/codex-monitor`；上游 `manuelsh/codex-monitor` 仅用于来源标注，不向上游推送。
- 本次验证及截图应在推送前复核。发布后另行核对远端提交、版本标签、Release 正文和 CI 状态；本文件不是发布回执。
