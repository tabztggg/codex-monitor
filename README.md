# Codex Monitor

**看清 Codex 用量花在哪里：按任务、项目和时间范围分析。**

简体中文 | [English](README.en.md)

本地 Codex 用量仪表盘，基于 [manuelsh/codex-monitor](https://github.com/manuelsh/codex-monitor) 改进易用性与统计展示。
这是非官方社区项目，不是 OpenAI 官方产品或计费系统。

**[v0.4.2](https://github.com/tabztggg/codex-monitor/releases/tag/v0.4.2)** · 修复 cpolar 白屏，减少断线时的重复请求。查看[更新日志](CHANGELOG.md)。

![Codex Monitor 中文界面：账号额度、跨账号估算与任务明细](assets/screenshots/overview-zh.jpg)

截图为 v0.4.0 真实界面，使用虚构账号、任务和用量。

<details>
<summary>更多截图：项目汇总、每日趋势</summary>

![项目分组与用量合计](assets/screenshots/projects-zh.jpg)

![每日趋势与项目排行](assets/screenshots/trends-zh.jpg)

</details>

## 能做什么

- **任务统计**：查看 Token、估算费用；等效消耗在同一列按“当前账号 / 跨账号”显示，项目汇总同步合并，可分别按两侧数值排序。
- **官方明细**：展开任务，读取官方累计额度及模型、推理强度、速度分布（含子任务），显示查询账号和数据截至时间。与本周期估算分开展示。
- **跨账号对比**：把本地记录折算为 Pro 20x、Pro 5x 或 Plus 周额度；可超过 100%。
- **项目与趋势**：可选项目分组及合计、每日趋势、项目排行；支持今天、近 7 天、本周期、任务累计。
- **归档统计**：默认读取未归档任务和最近 30 个归档主任务，含可归属的子任务；点击“统计所有归档”才扩大读取。
- **表格与语言**：搜索、筛选、排序、列设置；中英文切换并记住选择，新访问者默认英语。
- **增量刷新**：复用未变化的日志，支持 30 秒、1 / 2 / 5 / 10 分钟刷新；断线保留旧数据，逐步延长重试间隔。

## 快速开始

本机可通过 Codex 的 `SessionStart` 钩子运行 `CodexMonitorCompanion.exe --hook`：进入或恢复任务时启动 Monitor，桌面主进程退出时关闭全部 Monitor 子进程。它无需 Windows 自启动、计划任务或服务；首次需在 Codex 中审阅并信任钩子。只打开首页不会触发，关闭到托盘也不等于退出应用。详见[运行方式](docs/standalone-windows.md)。

官方明细使用本机 Codex 的 ChatGPT 登录及桌面端同源查询接口，需要可读取线程索引的 Node.js（建议 22.13+）。这是非公开稳定接口，可能变更或延迟；仅展开时读取、缓存 5 分钟，失败保留同账号旧值，不覆盖本地校准参数。缓存位于 `.cache/official-usage`，不含登录凭据。

需要 **Node.js >=20（建议 22+）**、npm，以及已登录、支持 `codex app-server` 的 Codex 安装。

```bash
git clone https://github.com/tabztggg/codex-monitor.git
cd codex-monitor
npm ci
npm run build
```

Windows PowerShell：

```powershell
$env:CODEX_MONITOR_HOST = '127.0.0.1'
$env:CODEX_MONITOR_DRY_RUN = '1'
npm start
```

macOS / Linux：

```bash
CODEX_MONITOR_HOST=127.0.0.1 CODEX_MONITOR_DRY_RUN=1 npm start
```

打开 **[http://127.0.0.1:4201](http://127.0.0.1:4201)**。保持终端运行，`Ctrl+C` 停止。
上述命令启用关机模拟模式，不执行真实关机；仪表盘不需要单独提供 API Key。
找不到 Codex 时，设置 `CODEX_MONITOR_CODEX_PATH` 指向其可执行文件。

Windows 无命令窗口的后台运行、登录自启、桌面快捷方式和安装更新见[独立部署说明](docs/standalone-windows.md#中文说明)。

## 怎样理解数据

| 指标 | 含义 |
| --- | --- |
| 账号总体额度 | Monitor 的 Codex CLI 当前账号额度，可能与桌面应用登录的账号不同。 |
| 套餐等效消耗 · 当前账号 | 原“额度占比”列；仅统计本周期内周额度重置时间匹配的记录，与跨账号列使用相同的校准基准和显示格式。 |
| 套餐等效消耗 | 所选范围内跨账号本地记录的估算消耗，以一份所选套餐周额度为 100%。 |
| 估算费用 / Token | 本地记录的 Token 及按内置价格表折算的 API 等价美元，不是订阅账单。 |

等效估算假定记录中的 **Pro 账号均为 20x**；日志不能可靠区分 5x / 20x。
切换 Pro 20x、Pro 5x、Plus，两列分别按 1、4、20 倍显示同一估算值；选择器不核验或更改账号档位。
当前账号占比始终统计本周期，项目行按任务合计。日志没有可靠账号 ID，重置时间匹配（允许 60 秒误差）只是账号归属估算；不同账号重置时间相同无法区分。缺少匹配或价格时显示部分数据或不可用。
缺失日志、其他设备的使用和未定价模型会影响准确性。

`--` 表示暂不可用或未归因，不是零；`+` 表示部分数据。
首次校准需要至少 5 个百分点的有效周额度变化，之后保留已有值并在后台更新。
隐藏归档、搜索或筛选只改变显示行，不改变所选范围的合计。详见[统计口径](docs/setup-and-reference.md#metric-details)。

## 本地数据与远程访问

默认只监听本机，读取 Codex 日志和元数据，缓存写入 `.cache/`，不改写原始会话。
本机 Codex app-server 仍可能联网读取账号额度。任务详情可能包含提示词、命令、路径等私人内容。

**服务没有内置登录认证或 TLS；Origin 检查不是身份认证。** 远程访问需要另外配置访问控制。
cpolar / 反向代理需显式设置 `CODEX_MONITOR_ALLOWED_ORIGINS`；Windows 独立安装使用 `standalone.json` 的 `allowedOrigins`。
配置方法见[网络访问](docs/setup-and-reference.md#network-access)和[隧道部署](docs/standalone-windows.md#reverse-proxy-or-tunnel)。

## 文档与开发

[完整使用文档](docs/setup-and-reference.md) · [Windows 部署](docs/standalone-windows.md) · [更新日志](CHANGELOG.md)

技术栈：TypeScript、React、Vite、Express、WebSocket。
开发用 `npm run dev`；检查用 `npm test`、`npx tsc --noEmit`、`npm run build`。

## 致谢与许可

原项目由 [manuelsh](https://github.com/manuelsh/codex-monitor) 创建，本版本主要改进易用性和用量分析。
本仓库目前没有 `LICENSE` 文件，不声明 MIT / Apache 许可；使用和分发前请核对适用的上游许可。
