# 织章工作台（Zhizhang 3.1）

面向 **DeepSeek Harness（DsH）Web 端** 的 Agent-First 创作协同与作者主权写作插件（`@zhizhang/dsh-workbench`）。  
**AI 管创作 · 代码管流程 · 作者管把关** · **Node.js 24.9+ `node:sqlite` 本地单库** · **番茄长篇 & 头条双产品线隔离**。

---

## 核心定位

- **Agent-First DsH 共创引擎**：以 **DsH 对话 Agent** 为主创作引擎，通过 `ctx.systemPrompt` 渐进披露当前焦点作品/章节、协作模式与挂载技法索引（约 200–380 tokens）；完整四层长篇上下文（L1/L2/L3）与技法卡执行细则由 Agent 按需调用 **23 个确定性排序工具**拉取，内置直连批处理引擎收拢在折叠兜底区。
- **按书切换作者主权模式**：每本书可在 **审慎模式（`cautious`，默认）**（草稿、局部精修与章纲全落候选区/提案箱，作者 Diff 审批入库）与 **共创模式（`co_create`）**（未定稿草稿与章纲支持直写并记录写入前版本，顶部横幅随时 Diff 对比与一键无损回滚）间切换；已定稿章节（`final`）、锁定设定和头条验收交付保留原有门禁。
- **内置创作方法论闭环**：
  - **番茄长篇**：L0–L3 四层缓存与可调上下文参数（支持一键恢复默认）、7 套题材起步包（12 张 Quality v2 正反例互斥技法卡）、黄金三章 + AI 腔加权密度 + 句长节律 + 章末钩子 + 跨章回声 + 视角越权双轨体检、1-based 段落级外科手术精修、三阶段非标准材料重写入与分级自治流水线。
  - **今日头条**：`资讯线` / `故事线` × `短图文` / `长图文` / `微头条` 场景矩阵、5 选 ≥3 母题标题矩阵、34 字标题上限、84 分 QA 通过线、最多 2 轮自动回改与固定交付尾句。
- **「素纸朱印」伴生工作台**：原生 TypeScript ES 模块、零框架开销、全前端零 `innerHTML` 与零原生弹窗；支持 `main` 全宽书房与 `?view=conversation` 对话伴生窄栏双形态、三套护眼纸面主题（墨纸 / 青简 / 夜航）、本地草稿保险箱、段落/字级 Diff 审阅与毫秒级 FTS5 全文检索。

---

## 安装到 DsH Web

当前验收版本为 DsH `0.2.2-rc.5`，使用 Node.js 24.9+。从 GitHub Release 下载 `zhizhang-dsh-workbench-3.2.0.tgz`，在终端执行：

```bash
dsh --profile web --dump-config
dsh plugin --profile web add ./zhizhang-dsh-workbench-3.2.0.tgz
dsh --profile web --host 127.0.0.1 --port 3080
```

已有 Web profile 可以直接安装或升级。安装完成后重启 DsH，点击侧栏「织章」进入书房。在一个 DsH 对话中切换到「织章」视图，选择作品和文档，然后绑定会话或直接交办。交办填入当前对话的输入框，确认后发送。

插件配置支持 `dataDirectory`、`defaultProvider`、`defaultModel` 和 `enableAgentTools`。默认数据目录为 `$DSH_HOME/zhizhang-v3`，沿用现有 3.0 工作区。停止 profile 后可用安装包中的 `scripts/workspace-data.mjs` 备份与恢复。

## 开发

环境要求为 Node.js 24.9+ 与 npm 10+。

```bash
# 按锁文件安装
npm ci

# 一键只读类型检查 + 14 套件精简测试（~4 秒）
npm run verify

# 编译服务端与前端并启动本地工作台（http://localhost:3000/workbench）
npm run dev
```

`npm pack` 先构建 Host 入口、DsH 普通脚本入口与工作台 ESM，再输出可安装包。用 `npm run bench:strict` 运行长篇性能门槛。

常用研发脚本：

| 命令 | 用途 |
| --- | --- |
| `npm run check` | 只读 TypeScript 类型检查（服务端 + 前端，不产出文件） |
| `npm run build` | 编译服务端至 `dist/server/`，前端 ES 模块至 `dist/client/` |
| `npm test` | 运行 `test/` 下全部 14 个 `node:test` 套件（确定性、纯本地） |
| `npm run verify` | 提交前一键门禁：`npm run check && npm test` |
| `npm run docs:schema` | 从 `zhizhang/3.0` 真实 SQLite DDL 重新生成 `docs/schema.md` |
| `npm run preflight` | 发布前环境自检（Node 版本、`node:sqlite`、零运行时依赖） |
| `npm run bench` | 运行工作台与 SQLite/FTS5 性能基准 |

---

## 目录结构速览

```text
src/
├── contracts/       受保护常量单一定义点、11 个封闭 ContractError、审批门禁、零运行时纯类型 DTO
├── domain/          无 I/O 纯函数领域规则（shared / fanqie / toutiao，三者严格隔离）
├── storage/         zhizhang/3.0 SQLite DDL、协作焦点与快照台账、统一作业台账、FTS5、热冷备份与路径约束
├── workflow/        运行态状态机、L0–L3 缓存装配、提示词方法论目录、预算核算与事件投影读模型
├── application/     AuthorWorkspace、协作引擎（collaboration.ts）、JobService、ProductLineRegistry 与双产品线实现
├── host/            DsH 适配边界、HTTP 路由、HostJobEngine、产品无关 tools.ts 与 system-prompt.ts、原子交付写入
├── client/          原生 TypeScript 浏览器工作台（Agent 共创伴生面板、素纸朱印三主题、ui/primitives、Diff）
└── bundle/          DsH 插件清单与多语言资源
test/                14 个高信噪比 node:test 套件（含架构边界、WorkspaceAction 100% 对齐与共创全链路测试）
support/             测试共用夹具（harness.mjs）
docs/                6 篇结构化文档 + 自动生成的 schema.md
```

---

## 文档体系

| 编号 | 文档 | 核心内容 |
| --- | --- | --- |
| 01 | [产品全景与共创理念](./docs/01-overview.md) | Agent-First 定位、审慎/共创双模式、渐进披露与双产品线工作流 |
| 02 | [六层架构与模块边界](./docs/02-architecture.md) | 单向依赖架构、跨层隔离红线、`ProductLineModule` 扩展缝与契约零漂移守卫 |
| 03 | [DsH 共创协议、工具目录与统一作业内核](./docs/03-workflow-and-protocol.md) | `ctx.systemPrompt` 注入、23 个 Agent 工具、HTTP 协议、统一作业台账与 L0–L3 前缀缓存 |
| 04 | [内置创作方法论与受保护领域规则](./docs/04-methodology-and-rules.md) | 受保护常量、双产品线状态机、番茄质量闭环/技法体系/非标重写入、头条场景矩阵与可调上下文参数 |
| 05 | [前端「素纸朱印」设计体系与交互规范](./docs/05-ui-and-design-system.md) | 三套纸面主题、四类统一 UI 原语、六视图与窄栏伴生分屏、快捷键、无障碍与零 `innerHTML` 安全规范 |
| 06 | [开发指南、14 套件测试与安全运维](./docs/06-development-and-ops.md) | 研发命令、测试矩阵、安全防护边界、热冷备份恢复与 `/diag` 脱敏诊断 |
| 07 | [数据库表结构参考（自动生成）](./docs/schema.md) | 由 `zhizhang/3.0` 真实 SQLite DDL 经 `npm run docs:schema` 生成 |
