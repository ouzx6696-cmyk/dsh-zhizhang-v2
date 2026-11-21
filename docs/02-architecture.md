# 系统架构与模块边界（Zhizhang 3.0）

织章 3.0 采用严格的**六层单向依赖架构**、**声明式产品线插槽（`ProductLineModule`）**以及**前端统一基础组件套件（`ui/primitives.ts`）**，通过自动化架构守卫测试（`test/12-architecture-guards.test.mjs`）在每次构建与测试中强制锁定模块边界。

---

## 六层单向依赖图

```text
  client/          浏览器端纯 ES 模块工作台（零 Node / 后端依赖、零 innerHTML）
     │  HTTP (zhizhang/3.0)
     ▼
  host/            DsH 适配边界、HTTP 路由、HostJobEngine、Agent 工具桥接、原子交付写入
     │
     ▼
  application/     AuthorWorkspace 编排、JobService 统一作业服务、ProductLineModule
     ├── products/fanqie/   番茄产品线（Schema + Actions + Context + 10 Agent 工具）
     └── products/toutiao/  头条产品线（Schema + Actions + Auto-QA + 1 Agent 工具）
     │
     ├───────────────┬───────────────┐
     ▼               ▼               ▼
  workflow/       domain/         storage/
  运行态/预算/     pure 纯规则     SQLite 持久化、作业台账、FTS5、
  读模型投影       ├── shared/     命令幂等日志、事件日志、备份导出
                  ├── fanqie/
                  └── toutiao/
     │               │               │
     └───────────────┴───────────────┘
                     ▼
                 contracts/        零运行时 DTO 类型、受保护业务常量、11 封闭 ContractError
```

---

## 各层职责与硬性边界

| 层级 | 目录 | 唯一职责 | 禁止导入 |
| --- | --- | --- | --- |
| **契约层** | `src/contracts/` | `protected-rules.ts` 单一常量源、11 封闭 `ContractError`、`ApprovalGate`、纯类型 `dto/*`（零运行时 JS 产物） | 任何业务/存储/宿主层 |
| **领域层** | `src/domain/` | 无 I/O、无 SQLite、确定性纯函数（状态机、连续性区间、锚点、冲突检测、AI 腔/黄金三章诊断、标题/QA 规则） | `storage/`、`application/`、`host/`、`client/`、`node:sqlite` |
| **存储层** | `src/storage/` | `zhizhang/3.0` 洁净 DDL、事务封装、命令幂等日志、事件日志、统一作业台账 `job-ledger.ts`、External Content FTS5、热/冷备份与路径约束导出 | `domain/`、`application/`、`host/`、`client/` |
| **工作流层** | `src/workflow/` | 生成运行态机、Token 预算校验、事件投影读模型（`AuthorReadUnit`） | `host/`、`client/` |
| **应用层** | `src/application/` | `AuthorWorkspace` 命令调度、`JobService` 统一作业状态机、`ProductLineRegistry` 注册表及双产品线实现 | `host/`、`client/` |
| **宿主层** | `src/host/` | Cordis / DsH 路由与生命周期、`HostJobEngine` 异步作业执行器（含有界卸载排空）、产品无关 `tools.ts` 桥接、原子交付写入与脱敏 `/diag` | 直接内嵌产品线领域规则 |
| **前端层** | `src/client/` | 零构建框架原生 TypeScript（编译为浏览器 ES 模块），统一 UI 基础组件套件、三区顶栏、草稿保险箱、段落/字级 Diff、统一作业中心 | `storage/`、`application/`、`host/`、`node:*` |

### 强制隔离红线（由 `test/12-architecture-guards.test.mjs` 与 `test/10-client-workbench.test.mjs` 守护）

1. **双产品线零交叉**：`domain/fanqie/` 与 `domain/toutiao/` 严禁互相导入；`application/products/fanqie/` 与 `application/products/toutiao/` 各自独立持有专属 DDL、Action 与 Agent 工具。
2. **宿主层产品无关**：`src/host/tools.ts` 与 `src/host/job-engine.ts` 不得硬编码任何具体产品线工具名或业务提示词；所有工具由 `ProductLineModule.agentTools()` 声明式注册。
3. **契约层纯类型零排放**：`src/contracts/workspace-dto.ts` 及 `src/contracts/dto/*.ts` 编译后只输出空 `export {};`，不产生任何运行时代码。
4. **受保护常量单一真相源**：`src/contracts/protected-rules.ts` 是所有受保护业务常量的唯一定义点；浏览器侧仅允许 `src/client/contracts/protected-rules.ts` 作为逐字镜像（由 `test/01-contracts-protected.test.mjs` 校验完全一致）。
5. **前端零原生弹窗与零原始 HTML 注入**：所有 `src/client/**/*.ts` 模块均禁止调用 `window.alert/confirm/prompt` 及 `innerHTML`/`outerHTML`/`insertAdjacentHTML`/`document.write`，全部使用统一安全 DOM 原语与 `<dialog>` 模态控制器。
6. **DsH 宿主契约显式标注**：`src/host/dsh-adapter.ts` 与 `src/host/dsh-tools-adapter.ts` 是 DsH 宿主与工具接口的唯一声明边界；在未经授权隔离环境实测验证前，均显式标注为基于公开文档推导（inferred from public docs）。

---

## 产品线扩展模型：`ProductLineModule`

新增一条写作产品线只需实现 `src/application/product-line.ts` 定义的 `ProductLineModule` 接口并注册到 `ProductLineRegistry`：

- `id` / `initialState` / `lockedStates` / `supportsAutoQa`：声明产品线基础契约。
- `initSchema(db)`：初始化该产品线专属的 SQLite 表与索引。
- `actions`：按 `global` / `project` / `document` 作用域声明命令处理器。
- `readModels`：向事件投影引擎注册专属读模型。
- `buildFrozenContext` / `runGeneration`：构建带 Prefix-Caching 友好的冻结上下文与模型执行器。
- `agentTools(facade)`：声明暴露给 DsH Agent 的只读/提案工具列表（严禁直接修改正文）。
- `contributeSnapshot` / `onStartupRecover`：向统一工作台快照注入扩展字段与启动恢复钩子。

---

## 前端统一基础组件体系（`src/client/workbench/ui/primitives.ts`）

所有交互视图（书房首页、新建向导、作业中心、拆书/技法库、全局模态框与顶栏）共享一套零依赖 DOM 原语与 CSS Token（`workbench.css` §16）：

| 原语 | 导出函数 | 核心规范 |
| --- | --- | --- |
| **Button** | `createButton` | 四档语义（`primary` / `secondary` / `ghost` / `danger`）、三档尺寸（`sm` / `md` / `lg`），统一 `8px` 控件圆角与指针 + 键盘（`Enter`/`Space` → `data-pressing`）微压缩按压反馈 |
| **Input** | `createInput` | 覆盖单行输入、多行文本域与下拉选择，统一 `8px` 圆角、内嵌微阴影、聚焦光环与无障碍校验态（`aria-invalid` / `setError`） |
| **Card** | `createCard` | 四档容器层次（`default` / `elevated` / `interactive` / `subtle`），统一 `12px` 卡片圆角、抬头操作区右对齐与悬停/按压阴影阶梯 |
| **Navbar** | `createNavbar` / `enhanceNavbar` | 三区编辑顶栏（品牌印章与面包屑 · 居中分段导航 · 右侧外观与快捷动作），支持滚动抬升阴影（`data-scrolled="true"`）与键盘按压态 |
