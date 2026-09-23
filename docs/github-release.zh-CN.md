# GitHub 发布文案

本文件对应 **v0.4.1**，用于仓库介绍和本次 Release 正文；文件存在不表示发布已经完成。
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

**v0.4.1 — 并发校准修复与固定顶栏导航**

## Release 正文

### 简体中文

本版本修复并发聊天的额度快照滞后被误判为回退、导致有效校准样本不足并长期沿用旧基准的问题，同时改进顶栏导航。

#### 本次更新

- **并发校准**：按聊天分别追踪额度读数，区分正常滞后与同一聊天内的回退；合并同刻读数，消除日志读取顺序影响，并在切换额度窗口后保留各窗口已见最高值，避免重复计算回升部分。费用未知或观察中断的区间继续排除。
- **分段与重复日志**：校准样本使用稳定的内容标识，避免同一任务多个日志片段相互覆盖；标识在刷新、重启和归档移动后保持一致。重叠日志中已证实重复的用量不会重复计入校准费用，精确重复事件也不会覆盖原始有效费用。
- **校准连续显示**：保留旧基准，直到兼容的新样本累积至少 5 个有效百分点后再更新；修复启动时先恢复参考值、随后账号周期就绪时，校准来源仍被误标为旧参考的问题。
- **导航与口径说明**：顶栏滚动时保持可见，任务、趋势和估算依据的跳转位置根据顶栏实际高度调整，适配窄屏换行；补充说明“当前账号额度占比”与“套餐等效消耗”的统计口径不同。

#### 升级说明

1. 停止 Monitor，备份并保留本地配置和 `.cache/`，取得本版本源码后运行 `npm ci`、`npm run build`，再使用原启动方式启动。**无需清空缓存或重置校准。**
2. 样本标识与持久样本格式升级为 v3，解析缓存中的校准数据惰性升级为 v4；不兼容的旧样本不会与新样本混算，旧参考值继续保留。升级使用既有统计范围和可用的紧凑缓存，不额外扩大归档扫描；默认仍实际只读取最近 30 个归档主任务。
3. Windows 独立安装还需部署新构建、匹配的依赖清单及生产依赖；仅更新源码或重启不会更新已安装副本。保留校准文件、额度归因账本和 `standalone.json`，详见 [Windows 独立安装说明](https://github.com/tabztggg/codex-monitor/blob/v0.4.1/docs/standalone-windows.md)。

本次不提供二进制安装包。费用与等效消耗仍是本地估算，不是官方账单；主页截图保留 v0.4.0 的真实 UI 示例并明确标注版本。

#### 验证

- Windows：235 项测试通过、2 项平台相关测试跳过；TypeScript 检查与生产构建通过。
- 中英文及窄屏顶栏导航已在浏览器验证；回归测试覆盖并发顺序、窗口切换、分段身份、重叠去重和保留旧参考的缓存升级。
- 以上为本地验证记录，发布提交的 GitHub Actions 结果需另行核验；不代表三平台全部桌面流程均已人工实测。

### English

This release fixes lagging quota snapshots from parallel chats being mistaken for regressions, which discarded valid samples and kept calibration on an older reference. It also improves header navigation.

#### Changes

- **Concurrent calibration:** track each chat separately to distinguish normal lag from a regression within that chat. Combine simultaneous readings independently of log order and retain each quota window's high-water mark across switches, so rebounds are not counted twice. Intervals with unknown costs or interrupted observations remain excluded.
- **Split and overlapping logs:** stable content-based sample identities prevent fragments of the same task from overwriting one another and survive refreshes, restarts, and archive moves. Proven duplicate usage in overlapping logs remains zero-cost; exact repeated events cannot replace the original valid cost.
- **Continuous calibration:** keep the previous reference until compatible new samples provide at least five valid percentage points. Correct the source label when a reference recovered at startup becomes current after the account window arrives.
- **Navigation and metric explanations:** keep the header visible while scrolling and adapt task, trend, and methodology anchors to its actual height, including narrow-screen wrapping. Clarify that current-account quota attribution and plan-equivalent usage measure different scopes.

#### Upgrading

1. Stop Monitor and back up and preserve local configuration and `.cache/`. Obtain this version, run `npm ci` and `npm run build`, then use your existing launcher. **Do not clear caches or reset calibration for this upgrade.**
2. Sample identities and persisted sample format move to v3; calibration data in parser caches upgrades lazily to v4. Incompatible old samples do not mix with new ones, while the previous reference remains available. Migration uses the existing statistics scope and available compact caches without expanding archive scans; the default still actually reads only the 30 most recently archived principal tasks.
3. Windows standalone installations also need the new build, matching manifests, and production dependencies; updating source or restarting alone does not update an installed copy. Preserve calibration files, the quota-attribution ledger, and `standalone.json`. See [Windows standalone deployment](https://github.com/tabztggg/codex-monitor/blob/v0.4.1/docs/standalone-windows.md).

No binary installer is attached. Costs and equivalent usage remain local estimates, not official billing. Homepage screenshots remain accurately labeled v0.4.0 examples of the actual UI.

#### Validation

- Windows: 235 tests passed, 2 platform-specific tests skipped; TypeScript checking and production build passed.
- Browser checks covered Chinese/English and narrow-screen header navigation. Regression tests cover concurrent ordering, window switching, fragment identities, overlap deduplication, and cache migration retaining the previous reference.
- These are local validation results. GitHub Actions results for the release commit require separate verification; this does not establish manual verification of every desktop workflow on all platforms.

## 发布操作备注

- Release 正文使用上方“简体中文”和“English”两部分，保留升级说明和估算边界。
- 首页继续使用已标注 v0.4.0 的真实 UI 示例截图，不改称 v0.4.1 截图；不上传真实日志、缓存、配置、私人对话或账号截图。
- 目标个人仓库为 `tabztggg/codex-monitor`；上游 `manuelsh/codex-monitor` 仅用于来源标注，不向上游推送。
- 本次文案及验证记录应在推送前复核。发布后另行核对远端提交、版本标签、Release 正文和 CI 状态；本文件不是发布回执。
