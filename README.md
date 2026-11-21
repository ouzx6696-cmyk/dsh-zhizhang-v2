# 织章工作台（Zhizhang 3.0）

面向 **DeepSeek Harness（DsH）Web 端** 的作者主权长短文写作工作台插件（`@zhizhang/dsh-workbench`）。  
**零第三方运行时依赖** · **Node.js 22+ `node:sqlite` 本地单库** · **番茄长篇 & 头条双产品线深度隔离** · **统一作业内核与「素纸朱印」编辑美学**。

---

## 核心特性

- **作者主权不变式**：AI 仅输出候选稿、局部改写片段与待审提案，绝不静默篡改正文；严格守护番茄审稿 2 次打回上限、头条 34 字标题上限、84 分 QA 线、2 轮自动回改上限及固定交付尾句（唯一定义于 `src/contracts/protected-rules.ts`）。
- **统一作业内核（`zhizhang/3.0`）**：将写作生成（`draft_generation`）、局部改写（`selection_rewrite`）与 AI 提案提取（`proposal_extraction`）统一收拢至 `author_jobs` + `author_job_calls` STRICT 台账，统一并发锁、预算熔断、取消晚到回执结算、有界卸载排空与前端作业中心。
- **模块化产品线架构**：六层单向依赖（`contracts → domain / storage / workflow → application → host → client`），番茄与头条通过 `ProductLineModule` 插件化注册，互不依赖，自动暴露 11 个只读/仅提案 DsH Agent 工具。
- **「素纸朱印」工作台与统一基础组件套件**：零前端框架开销，全量原生 TypeScript ES 模块与零 `innerHTML` 安全 DOM 构建；提供三区顶栏、三套护眼纸面主题（墨纸 / 青简 / 夜航）、统一基础组件（`Button` / `Input` / `Card` / `Navbar`）、本地草稿保险箱、Web Worker 段落/字级 Diff 审阅与毫秒级 FTS5 全文检索。

---

## 快速开始

需要 **Node.js >= 22.0.0**（内置 `node:sqlite` 与 `node:test`）和 `npm >= 10.0.0`。

```bash
# 安装开发依赖（仅 typescript 5.8.3）
npm install

# 一键类型检查 + 12 套件精简测试（~3 秒）
npm run verify

# 编译服务端与前端并启动本地工作台（http://localhost:3000/workbench）
npm run dev
```

更多常用脚本：

- `npm run check` — 只读 TypeScript 检查（服务端 + 前端）
- `npm run build` — 输出编译产物至 `dist/server/` 与 `dist/client/`
- `npm run docs:schema` — 从 `zhizhang/3.0` 真实 SQLite DDL 重新生成 `docs/schema.md`
- `npm run preflight` — 检查 Node 版本、`node:sqlite` 与零运行时依赖约束
- `npm run bench` — 运行工作台与数据库基准测试

---

## 架构目录速览

```text
src/
├── contracts/       受保护常量、11 个封闭 ContractError、审批门禁、零运行时纯类型 DTO
├── domain/          纯函数业务规则（shared / fanqie / toutiao，三者严格隔离）
├── storage/         zhizhang/3.0 SQLite DDL、统一作业台账、FTS5、命令/事件日志、热冷备份与路径约束
├── workflow/        运行态状态机、预算计算、事件投影读模型
├── application/     AuthorWorkspace、JobService、ProductLineRegistry 与双产品线模块
├── host/            DsH 适配边界、Next-Gen HTTP 路由、HostJobEngine、声明式 Agent 工具桥接、原子交付写入
├── client/          原生 TypeScript 浏览器工作台（素纸朱印三主题、ui/primitives 统一组件、Diff、作业中心）
└── bundle/          DsH 打包清单与本地化资源
test/                12 个高信噪比 node:test 套件（覆盖契约、领域、作业内核、安全守卫与架构边界）
support/             测试公共夹具（harness.mjs）
docs/                5 篇活文档 + 自动生成的 schema.md
```

---

## 活文档索引

1. [产品全景、双产品线工作流与「素纸朱印」体验设计](./docs/01-overview.md)
2. [六层架构、产品线扩展规范与统一基础组件体系](./docs/02-architecture.md)
3. [统一作业内核、`zhizhang/3.0` 协议与 Agent 工具](./docs/03-workflow-and-protocol.md)
4. [受保护业务规则与领域不变量](./docs/04-domain-rules.md)
5. [开发指南、12 套件测试体系与安全运维](./docs/05-development-and-ops.md)
6. [数据库表结构参考（自动生成）](./docs/schema.md)
