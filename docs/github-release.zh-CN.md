# v0.4.5 — 三页界面与统计口径修正

- 用量总览、任务明细、趋势与依据分为独立页面，更新中英文 UI 和首页截图。
- 总览只显示当前登录账号，补充周期、更新时间、Token 拆分、范围内消耗前 3 名和当前活动。任务页可查看历史账号，不切换登录。
- 任务额度分为“所选账号·本周期 / 跨账号·任务累计”，两侧分别排序；日期筛选控制范围汇总、费用、Token 和趋势。
- 补齐 GPT-6 Sol／Luna 计价，修复重复事件、子任务漏统计和范围偏差；缺失值保留标记，校准时继续显示已有基准。
- Windows 启动脚本统一使用 PowerShell 7，保留桌面快捷方式与独立登录自启动。

**升级：** 保留 `.cache/` 和本地配置。更新源码后，Windows 运行 `wscript.exe "Codex Monitor.vbs" deploy`；手动部署运行 `npm ci`、`npm run build` 后重启。[部署说明](https://github.com/tabztggg/codex-monitor/blob/v0.4.5/docs/standalone-windows.md#updating-the-installed-copy)

**验证：** 336 项测试通过、2 项跳过；类型检查与构建通过。首页截图来自实际构建，使用虚构演示数据。

等效额度仍是基于本地记录的估算，不是官方账单。原项目：[manuelsh/codex-monitor](https://github.com/manuelsh/codex-monitor)。

**English:** Three dedicated dashboard pages, clearer account and time scopes, improved overview metrics, independent quota sorting, corrected model pricing and history aggregation, and PowerShell 7 launchers. Preserve caches/configuration when updating. Validation: 336 tests passed, 2 skipped; type checking and build passed.
