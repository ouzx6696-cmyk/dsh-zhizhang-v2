# 织章 V2（`@zhizhang/dsh-workbench`）

**织章 V2**（已发布基线 `v2.2.0`，当前分支开发 `v2.3`）是运行在 **DeepSeek Harness（DsH Web `0.2.2+`）** 上的**作者主权创作工作台插件**。项目采用零运行时依赖的 TypeScript + `node:sqlite` 架构，把长篇连载与短中篇图文创作中的「控制面与滚动规划、标准 `SKILL.md` 方法论沙箱、离线体检与定性观察审稿、正文修订、SHA-256 记忆同步与四维历史召回、逐段字级合稿与选段微改写、QA 自动回改、版本审批与原子交稿」收拢到同一套事件溯源与版本账本之下。

> 核心定位：**作者写作者的正文，模型只产隔离候选，一切采纳、定稿、设定确认与交稿批准皆由作者主权决定。**

---

## 一、项目是什么 & 解决什么问题

| 维度 | 说明 |
| --- | --- |
| **产品形态** | DsH Web 插件（Cordis 后端插件 + React UI Slot 注入 + 独立 iframe 模块化作者工作台） |
| **两条业务线** | **番茄连载**（长篇章节规划与设定连续性）与 **头条创作**（场景矩阵、QA 质检与交稿），在领域层与服务层严格零交叉引用 |
| **三态文本隔离** | **工作稿修订（`revisions`）**、**模型候选稿（`candidates`）**、**定稿 / 获批交稿版本（`final_revision_id` / `deliveries`）** 物理分离，互不静默覆盖 |
| **安全与信任边界** | 一次性无工具 LLM 流式传输（不传 Agent 会话或写库工具）、owner-only Connection HTTP 路由、浏览器本地双存储防丢字、全离线 SQLite 持久化 |
| **独立 V2 基线** | 完全独立于 v1.x Electron 应用，不集成 Pi SDK，不提供 v1.x 磁盘格式或 API 迁移 |

---

## 二、能做什么（核心能力一览）

### 1. 番茄连载与长篇小说工作流
- **卷 → 幕 → 章与指南针控制面（5000 章流畅虚拟化）**：支持 `author_project_controls`（全书 `authorIntent` 指南针注入 Prefix 稳定区 + 近 1–3 章 `currentFocus` 注入动态区）与滚动幕规划提案（`arc_plan`）；`tree-sidebar.ts` 与 `outline-board.ts` 全虚拟化与惰性挂载，5000 章规模保持极低恒定 DOM 节点，并提供书斋冷启动页、三步开新书向导、题材种子包及墨纸/青简/夜航三套纸面主题与正文排版控制。
- **标准 `SKILL.md` 沙箱、离线体检与外科手术式合稿**：支持 `skill.import` 安全沙箱导入（剥离脚本/Hook/工具声明、≤ 128 KiB）与分阶段 Prefix 绑定（`plan`/`write`/`review`/`refine`/`deslop`）；提供零 Token 黄金三章 6 维体检与可配置 AI 味扫描（`chapter.diagnose`）、带原文摘句举证的定性 `Observation` 审稿与定向修稿、逐段字级 Diff（`📍 定位`/顶部实时预览/30 步撤销/`partial` 部分采纳）与选段浮动微操作条（`selection.rewrite`）。
- **记忆闭环与 FTS5 检索**：支持 SHA-256 改稿漂移感知 + `fact_sync` 增量提案 + `CHAPTER_COMMIT` 原子同步、4 维相关远期历史章召回、External Content FTS5 + BM25/RRF 多 Scope 防饿死检索与 DsH 双入口（7 只读 + 3 提案工具 + `settings.plugins.tab` 配置与脱敏 `/api/zhizhang/diag`）。
- **构建与缓存防呆**：`npm run build` 分离服务端产物（`dist/server/host/plugin.js`）与浏览器产物（`dist/client/slot.js`），配套 `node scripts/preflight.mjs` 与 `node scripts/deploy.mjs --touch-only`（刷新产物 `mtime`，避免 `npm pack` 1985 时间戳触发 DsH 缓存僵死）。
- **结构化章纲与篇幅提醒**：固定四段式章纲（剧情梗概、核心冲突与看点、情节推进节点、章末落点）与四项头注（视角人物、目标篇幅、锁定事实、人物知识边界）；默认建议 2,000–2,500 非空白字符，1,500–6,000 为提醒带。
- **动态设定库、伏笔追踪与叙事锚点**：以 `(chapterId, point)` 为锚点、半开区间 `[effectiveFrom, effectiveTo)` 记录设定，支持单条提案为多人物分别设定知情时点、伏笔生命周期追踪与设定冲突检测；已锁定设定拒绝后续覆盖；按作者批准序号 `decided_seq` 统一裁决查询、事件回放与生成冻结输入。
- **拆书库与技法卡片（全局共享 + 工程覆盖）**：支持全局拆书样章与技法卡片库，以及面向单本长篇的挂载与局部覆盖（`overrideOfId`），并可按章节意图与标签进行确定性推荐。
- **Prefix-First 上下文装配与 CJK Token 校准**：按稳定前缀优先原则（项目概览、锁定设定、已挂载技法、拆书锚点置前）装配生成上下文，结合中英文混合 Token 估算裁剪动态摘要与伏笔提醒，支持写作前实时预览各槽位占用。
- **AI 提议收件箱（作者主权门）**：支持单次无工具 LLM 抽取拆书、技法、设定与章纲摘要，但产物仅落入 `pending` 待审队列，必须由作者显式决定后方可入库。
- **本地 Markdown 工程包与 FTS5 全局检索**：支持导出/导入包含 `zhizhang-project.json` 与卷/幕/章 Markdown（YAML frontmatter）的本地工程目录，自动保护已定稿章节与锁定设定；内置 SQLite FTS5 (`trigram`) 全文索引与全局命令面板（`Ctrl/Cmd+K`）。
- **正文证据锚点、重排安全门与定稿门**：摘句在已保存正文中唯一匹配记录位置；调整章节顺序前强制只读预览时序翻转影响（`reorder.impact`），确认后带基准水位提交（`reorder.commit`）；最多 2 次审稿打回，审稿通过后由作者显式定稿并锁定正文。

### 2. 头条创作工作流
- **六格场景矩阵**：长图文（2,600–3,400 字）、短图文（1,100–2,200 字）、微头条（300–1,000 字） × 资讯线 / 故事线，分别约束驱动、开头、结尾与延伸方式。
- **标题规范与矩阵校验**：有标题体裁上限 34 Unicode 码点；标题候选矩阵要求 ≥5 个不重复合规标题且覆盖 ≥3 种母题；微头条强制无标题且禁 Markdown 小标题；支持原地改题并保留原修订质检记录。
- **QA 门与双轮自动回改**：84 分通过线 + 零未通过项 + 零硬门；`autoQa` 开启时执行 `write → qa → (refine → qa)` 闭环，跨失败与重启严格限制最多 2 轮回改。
- **版本绑定批准与原子交稿**：批准记录绑定特定修订 ID；交稿在事务内落库 `deliveries` 后，事务外原子写入本地 Markdown 并仅附一次固定尾句，支持失败重试与同名冲突识别（`export.conflict`）。

### 3. 运行预算、断电恢复与慢保存保护
- **4 类令牌账本**：`input`、`output`、`cache_read`、`cache_write` 完整记账；保守估算防长中文稿误触预算，中断于 `inflight` 时标为 `uncertain` 并阻断新生成直至作者核对账单（`run.reconcile`），绝不静默重发。
- **浏览器防丢字协议**：`DraftVault`（`sessionStorage` + owner 标记 `localStorage`）+ `editSequence` 序列保护，确保慢保存响应期间继续键入零丢字、跨标签冲突完整留存本地稿。

---

## 三、文档体系导航

本项目文档按 **「是什么 → 做什么 → 怎么做」** 分层组织，全部基于当前源码核对编写：

| 文档 | 核心主题 | 你能从中了解 |
| --- | --- | --- |
| [01 · 产品全景与业务工作流](docs/01-overview.md) | **是什么 & 做什么** | 解决的痛点、三大产品原则、番茄/头条端到端流程图、非目标与安全边界 |
| [02 · 领域规则与共享契约](docs/02-domain-rules.md) | **做什么的精确规范** | 两条线状态机、受保护阈值（34/84/2/2/尾句）、11 个错误码、6 字段批准门、§2 七大权威命令表 |
| [03 · 系统架构与接口手册](docs/03-architecture.md) | **怎么做（架构与端到端链路）** | 分层依赖边界、垂直应用服务、DsH Cordis 宿主与 LLM 桥接、客户端模块、`GET /state` 与 `/mutate` 动作手册、架构演进说明 |
| [04 · 数据存储与工作流内核](docs/04-data-and-workflow.md) | **怎么做（数据与内核机制）** | SQLite 表结构与 ER 图、幂等命令账本、事件日志与 6 大持久化读模型冷恢复、运行状态机、预算守卫与生成账本 |
| [05 · 开发、验收与运维指南](docs/05-development-and-ops.md) | **怎么做（工程实操与运维）** | 环境安装、双管线 TS 构建（`dist/server` + `dist/client`）、本地预览服务器、63 文件 / 460 项分层离线测试与浏览器/性能基准、打包与 `mtime` 刷新、SHA-256 备份恢复与故障排查 |
| [V2.3 全量优化计划](docs/zhizhang_v2_3_full_optimization_plan.md) | **下一阶段路线图** | 123 条发现的完整证据、十个跨视角主题、P0–P3 路线图与作者决议记录 |
| [V2.3 实现状态对照表](docs/zhizhang_v2_3_status.md) | **当前进度真源** | 123 条逐条状态（✅/⚠️/❌）、P0 退出标准达成情况、Batch 2 开发批次 |
| [Schema 参考（自动生成）](docs/schema.md) | **数据层只读真源** | 由 `npm run docs:schema` 从 `sqlite_master` 生成的全部表、列、索引与触发器 |

### 一体化框架设计规范（文档先行）

| 文档 | 主题 | 你能从中了解 |
| --- | --- | --- |
| [01 · 一体化框架总体蓝图](docs/framework/01-blueprint.md) | **蓝图与职责切分** | 当前 5 类耦合割裂诊断、「单底座 + 双隔离产品线模块」目标架构、12 项职责切分矩阵与反过度设计红线 |
| [02 · 核心接口与扩展点规范](docs/framework/02-contracts-and-extensions.md) | **接口契约与收口协议** | `workspace-dto.ts` 单一 DTO、`client/manifest.ts`、后端 `ProductLineModule` 7 大扩展点、纯 LLM 传输解耦、前端 4 大 UI 槽位与自动化守卫 |
| [03 · 分阶段落地路线图](docs/framework/03-migration-roadmap.md) | **M0–M4 演进与验收** | 死代码清零、契约收口、SQLite 并发加固、后端与前端一体化拆分步骤、每阶段门禁及新产品线接入清单 |

> 工作区规则与边界约束请同时参阅 [AGENTS.md](AGENTS.md)。

---

## 四、工具链与快速命令

### 环境要求
- **Node.js**：`>=24.15.0`（离线测试利用内置 TypeScript type stripping 直接执行 `.ts` 模块）
- **npm**：`>=11.0.0`
- **TypeScript**：`5.8.3`（仅开发期 `devDependencies`，零运行时依赖）

> **Windows 提示**：若 PowerShell 执行策略禁止运行 `npm.ps1`，请改用 `npm.cmd`（如 `npm.cmd run verify`）。

### 常用命令

```bash
# 1. 安装 pinned 开发期编译器（不执行包生命周期脚本）
npm ci --ignore-scripts

# 2. 日常验证：后端与客户端只读类型检查 + 核心离线测试（37 文件 / 287 用例）
npm run verify

# 3. 分层专项离线回归（契约 147 / V2 全栈 97 / V2.3 基础 43 / 宿主与灾备 16 / 客户端 6 / 架构 13）
npm run test:contracts
npm run test:v2
npm run test:v23
npm run test:host
npm run test:client
npm run test:arch

# 4. 历史规则取证夹具（173 用例）与全量离线测试（63 文件 / 460 用例）
npm run test:evidence
npm run test:all

# 5. 从 sqlite_master 重新生成 Schema 参考文档（写入 docs/schema.md）
npm run docs:schema

# 6. 构建服务端 ESM 与模块化浏览器客户端（输出至 dist/server/ 与 dist/client/）并刷新时间戳
npm run build
npm run deploy:touch

# 7. 启动本地零依赖预览工作台（需先执行 build，默认仅监听 127.0.0.1:3000/workbench）
npm run dev

# 8. 专项验证（模型回放 / 650 章性能基准 / Playwright 三旅程 + 4 视口浏览器验收）
npm run test:model
npm run test:bench
npm run test:browser

# 9. 生成 DsH 可安装的本地 tgz 安装包
npm pack --ignore-scripts
```

---

## 五、仓库结构总览

```text
dsh-zhizhangv2/
├── AGENTS.md                   # V2 独立工作区硬性规则与受保护语义声明
├── package.json                # @zhizhang/dsh-workbench v2.2.0、dsh 插件声明与脚本入口
├── tsconfig.json               # 后端只读类型检查配置（noEmit）
├── tsconfig.build.json         # 后端构建配置（输出 dist/server/）
├── tsconfig.client.json        # 浏览器端构建配置（输出 dist/client/）
├── docs/                       # 文档体系：01-overview ~ 05-development-and-ops、framework/ 框架设计、zhizhang_v2_3_* 计划与状态、optimization/ 四份视角评审、schema.md 自动生成
├── src/
│   ├── contracts/              # 冻结共享契约（错误信封、批准门、§2 命令表）、受保护常量 protected-rules.ts 与单一 DTO 真源 workspace-dto.ts
│   ├── domain/
│   │   ├── shared/             # 叙事锚点、章序比较与半开区间原语
│   │   ├── fanqie/             # 番茄领域规则（三层级/设定冲突/4维历史召回/离线体检/拆书与技法推荐/审稿/定稿/重排影响）
│   │   └── toutiao/            # 头条领域规则（6格矩阵/34字/84分QA/双轮回改/交稿格式）
│   ├── storage/                # SQLite 驱动缝、语句池化（stmt-pool）、事务/迁移、FTS5 外表、本地 Markdown 包 IO 与备份
│   ├── workflow/               # 运行状态机、阶段注册表、预算守卫、Prefix-First 上下文槽位引擎（context-slots）、读模型
│   ├── application/            # 一体化底座（context/run/snapshot/proposal-service）与隔离产品线（products/fanqie/*, toutiao/*）
│   ├── host/                   # DsH 宿主插件（plugin.ts）、单次 LLM 传输（writing.ts）、7+3 工具（tools.ts）、配置与诊断（settings.ts）
│   ├── client/                 # DsH UI Slot、唯一资产清单（manifest.ts）与多视图工作台（书斋/三步向导/主题/虚拟列表/字级 Diff/微改写）
│   └── bundle/                 # DsH Cordis 补丁声明与中英文元数据
├── scripts/                    # preflight、deploy、dev-server、browser-check、model-check、workspace-bench、workspace-data
├── support/                    # 共享离线测试底座（a01.mjs + v2-harness.mjs，独立于 test/ 以避免误计用例数）
└── test/                       # 63 个分层离线自动化测试文件（d02/w02 契约合规 + ?01 规则取证 + *-v2 全栈/宿主/客户端/架构 + *-v23 V2.3 基础）
```
