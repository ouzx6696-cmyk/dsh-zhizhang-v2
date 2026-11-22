# 02 · 六层单向架构与模块边界（Zhizhang 3.0）

织章 3.0 采用严格的**六层单向依赖架构**、**声明式产品线插槽（`ProductLineModule`）**与**零运行时依赖策略**，并由 `test/12-architecture-guards.test.mjs` 与 `test/01-contracts-protected.test.mjs` 在每次构建与测试中自动化锁定。

---

## 1. 六层单向依赖图

```text
  client/          原生 TypeScript 浏览器工作台（零 Node / 后端依赖、零 innerHTML）
     │  HTTP (zhizhang/3.0)
     ▼
  host/            DsH 适配边界、HTTP 路由、HostJobEngine、产品无关 tools.ts / system-prompt.ts、原子交付写入
     │
     ▼
  application/     AuthorWorkspace、collaboration.ts 协作快照引擎、JobService、ProductLineRegistry
     ├── products/fanqie/   番茄产品线（DDL + Actions + L1–L3 上下文 + 自治/重写入 + 18 Agent 工具）
     └── products/toutiao/  头条产品线（DDL + Actions + 场景/QA + 2 Agent 工具）
     │               （+ 核心工作区 3 个跨产品线工具 = 23 个确定性排序 Agent 工具）
     ├───────────────┬───────────────┐
     ▼               ▼               ▼
  workflow/       domain/         storage/
  运行态/缓存/     纯函数业务规则   SQLite 持久化（zhizhang/3.0）、协作与快照台账、
  提示词/读模型    ├── shared/     统一作业台账、External Content FTS5、热冷备份
                  ├── fanqie/
                  └── toutiao/
     │               │               │
     └───────────────┴───────────────┘
                     ▼
                 contracts/        单一受保护常量源、11 封闭 ContractError、审批门禁、零运行时 DTO
```

---

## 2. 各层职责与依赖禁令

| 层级 | 目录 | 核心职责 | 禁止导入 |
| --- | --- | --- | --- |
| **契约层** | `src/contracts/` | `protected-rules.ts`、`ContractError`（11 封闭错误码）、`ApprovalGate`、纯类型 `dto/*`（编译产物仅空 `export {}`） | 任何业务、存储、宿主或前端模块 |
| **领域层** | `src/domain/` | 确定性纯函数（状态机、锚点坐标、设定区间与角色知情边界、重排冲突、AI 腔/黄金三章/Quality v2、上下文调参、头条标题与 QA） | `storage/`、`application/`、`host/`、`client/`、`node:sqlite` |
| **存储层** | `src/storage/` | `zhizhang/3.0`（`user_version = 30`）SQLite DDL、事务与命令幂等日志、事件日志、统一作业台账 `job-ledger.ts`、External Content FTS5 + 2 字 CJK 索引、热冷备份与路径约束导出 | `domain/`、`application/`、`host/`、`client/` |
| **工作流层** | `src/workflow/` | 运行状态机、L0–L3 前缀缓存装配（`cache-layer.ts`）、内置提示词目录（`prompts/index.ts`）、Token 预算核算与事件投影读模型（`AuthorReadUnit`） | `host/`、`client/` |
| **应用层** | `src/application/` | `AuthorWorkspace` 命令总线、`collaboration.ts`（焦点/协作模式/Agent 直写快照与回滚/渐进提示词）、`JobService`、`ProductLineRegistry` 及双产品线模块 | `host/`、`client/` |
| **宿主层** | `src/host/` | DsH 宿主适配（`dsh-adapter.ts` / `dsh-tools-adapter.ts`）、HTTP 路由与静态清单托管、`HostJobEngine`（含 `AbortController` 与有界卸载排空）、产品无关 `tools.ts` 与 `system-prompt.ts`、原子交付写入、脱敏 `/diag` | 任何具体产品线工具名、领域规则或提示词文本 |
| **前端层** | `src/client/` | 零构建框架原生 TypeScript ES 模块、统一 UI 原语（`ui/primitives.ts`）、Agent 伴生面板（`agent-companion.ts`）、草稿保险箱、段落/字级 Diff、六视图与双产品线插件 | `storage/`、`application/`、`host/`、`node:*` |

---

## 3. 自动化架构与契约守卫

以下边界均由自动化测试实时强制执行（任何破坏会直接导致 `npm test` 失败）：

1. **双产品线零交叉**：`domain/fanqie/` 与 `domain/toutiao/` 互相不可导入；各自应用层目录独立持有专属表结构、命令处理器与 Agent 工具。
2. **宿主层完全产品无关**：`src/host/tools.ts` 与 `src/host/system-prompt.ts` 禁止出现 `fanqie`、`toutiao` 或任何产品线工具名；所有工具与渐进披露片段均由 `ProductLineModule` 声明式注册。
3. **`WorkspaceAction` 100% 契约零漂移**：`src/contracts/dto/core.ts` 中的 `WorkspaceAction` 联合类型与后端 `src/application/`、`src/host/` 及 `api.ts` 路由端点严格一一对应——**零幻影 Action、零未类型化处理器**。
4. **契约层纯类型零排放**：`src/contracts/workspace-dto.ts` 及 `src/contracts/dto/*.ts` 不允许出现任何运行时导出。
5. **受保护常量单一真相源**：`src/contracts/protected-rules.ts` 为唯一定义点，浏览器侧 `src/client/contracts/protected-rules.ts` 保持逐字一致镜像。
6. **零第三方运行时依赖 & 测试目录洁净**：`package.json` 不得包含运行时 `dependencies`；`test/` 仅允许存放 `*.test.mjs` 套件文件，共用夹具必须位于 `support/`。
7. **DsH 宿主边界隔离**：上游宿主接口与工具注册形状仅允许声明于 `src/host/dsh-adapter.ts` 与 `src/host/dsh-tools-adapter.ts`（在经授权隔离环境实测验证前显式标注为基于公开文档推导）。

---

## 4. 产品线扩展协议：`ProductLineModule`

新增写作产品线仅需实现 `src/application/product-line.ts` 定义的 `ProductLineModule` 接口并注册至 `ProductLineRegistry`：

- **基础元信息**：`id`、`initialState`、`lockedStates`、`supportsAutoQa`。
- **持久化与命令**：`initSchema(db)`、`actions`（按 `global` / `project` / `document` 作用域路由）、`readModels`。
- **DsH Agent 共创钩子**：
  - `agentTools(facade)`：声明产品线专属 Agent 工具（宿主层自动按字母序与规范 JSON 键序注册）。
  - `contributeSystemPrompt(ctx, projectId, active)`：向 `ctx.systemPrompt` 注入轻量产品线摘要、方法论提示与推荐 Skill 目录索引。
  - `diagnoseForAgent(ctx, row, body)` / `onAgentDraftRecorded(...)`：在 Agent 提交草稿后即时返回零 Token 诊断摘要并回写技法效果遥测。
- **兜底流水线与生命周期**：`buildFrozenContext`、`runGeneration`、`contributeSnapshot`、`onStartupRecover`、`onJobCacheHit`。
