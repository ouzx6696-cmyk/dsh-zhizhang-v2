# 统一工作流、`zhizhang/3.0` 协议与 Agent 集成

Zhizhang 3.0 将此前分散的写作运行、局部改写与 AI 提案提取三条异步链路彻底融合为**单一统一作业内核（Unified Job Kernel）**，并在后端 HTTP API、Agent 工具注册与前端作业中心之间实现端到端对齐。

---

## 1. 统一作业内核（Unified Job Kernel）

### 三类统一作业（`LedgerJobKind`）

| 作业类型 | 触发场景 | 并发约束 | 输出去向 |
| --- | --- | --- | --- |
| `draft_generation` | 番茄章节生成、头条成稿 + 自动 QA 回改 | 同文档同类型仅允许 1 个活跃作业（SQLite 部分唯一索引 `ux_author_jobs_active_scope` 兜底） | `candidates` 候选表（待作者 Diff 采纳） |
| `selection_rewrite` | 编辑器划词润色 / 扩写 / 对话 / 续写 / 自定义改写 | 同文档同类型互斥 | 返回局部改写片段（作者确认替换，不直接改稿） |
| `proposal_extraction` | AI 拆书、设定提取、技法卡提取、审稿观察提取 | 同项目/文档同类型互斥 | `author_ai_proposals` 提案队列（作者逐条批准） |

### 持久化、精确结算与有界排空

- **`author_jobs`（STRICT 表）**：记录作业生命周期状态（`prepared` → `inflight` → `received` → `completed` / `failed` / `cancelled` / `uncertain` / `reconciled`）、冻结作用域键（`scope_key`）、预算预留（`reserved`）、已结算用量（`settled`）、取消后晚到回执累计（`late_usage`）、关联 `run_id` / `proposal_id` 与错误摘要。
- **`author_job_calls`（STRICT 表）**：记录每一次底层模型调用回执（`phase`、`input_reserve`、`max_output`、`usage`），支撑 `verifyUsageConsistency()` 四类用量恒等校验（账实一致）与崩溃重启自动对账（`reconcile`）。
- **三层分工**：
  1. `src/storage/job-ledger.ts`：原子建单、并发冲突拒绝、状态流转、回执记账与启动扫描。
  2. `src/application/job-service.ts`：预算预估、并发/对账门禁、候选采纳、头条自动 QA 回改次数预留与统一作业摘要查询。
  3. `src/host/job-engine.ts`：`HostJobEngine` 负责模型调用编排、取消信号（`AbortController`）与插件卸载排空（`shutdownDrain()`）——当在途任务超出排空预算时自动中止并采用有界宽限期收尾，防止失联的模型传输阻塞宿主卸载。

---

## 2. `zhizhang/3.0` Next-Gen HTTP 协议

插件默认挂载于 `/api/zhizhang`（本地预览服务 `scripts/dev-server.mjs` 直接暴露相同根路径），严格采用洁净 3.0 路由面（无历史兼容壳）：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/workbench` | 工作台 HTML 入口（`src/client/workbench.html`） |
| `GET` | `/workbench.css` | 工作台全量主题与统一组件样式表（纯 CSS，零外部依赖与 `data:` URL） |
| `GET` | `/workbench/*.js`、`/contracts/protected-rules.js` | 由 `src/client/manifest.ts`（`CLIENT_JS_MODULES`）精确枚举托管的编译后 ES 模块 |
| `GET` | `/state` | 读取完整工作台快照（支持 `?projectId=...&documentId=...&ifSequence=...` 增量序列比对） |
| `GET` | `/jobs` | 统一作业列表查询（支持 `?projectId=...&documentId=...&kind=...&limit=...`） |
| `GET` | `/diag` | 脱敏诊断端点（返回版本、Schema ID、作业/对账统计与安全摘要，绝不泄露密钥、目录路径或正文） |
| `POST` | `/command` | 同步命令执行入口（JSON 对象 `{ action, ...input }`，经 `AuthorWorkspace.mutation` 分发） |
| `POST` | `/jobs/preview` | 统一作业启动前零 Token 预算与冻结上下文装配预估 |
| `POST` | `/jobs/start` | 启动三类统一异步作业（`draft_generation` / `proposal_extraction` / `selection_rewrite`） |
| `POST` | `/jobs/cancel` | 取消运行中作业（支持 `runId` / `proposalId` / `jobId`），触发 `AbortController` 并保留晚到用量审计 |

### 统一响应安全策略与封闭错误信封

- **安全响应头**：静态页面与脚本统一附带 `Content-Security-Policy`（`default-src 'self'`）、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer` 与 `Cache-Control: no-store`；所有 `POST` 接口强制校验 `Content-Type: application/json` 并限制单请求体 `<= 2 MiB`。
- **封闭错误信封**：所有预期业务失败均返回 `{ ok: false, code, details, diagnosticId }`，由 `src/contracts/errors.ts` 封闭限定为 11 个标准错误码：
  `version.conflict`、`auth.denied`、`gate.denied`、`budget.exhausted`、`idempotency.mismatch`、`stage.output_invalid`、`usage.uncertain`、`storage.format_unsupported`、`input.invalid`、`input.not_found`、`dependency.unavailable`。
- **未预期异常脱敏**：服务端及本地预览服务遇到非预期异常时均只返回 `{ ok: false, code: "internal.error", diagnosticId }`，不向客户端暴露内部异常堆栈或敏感路径。

---

## 3. 声明式 Agent 工具体系（11 个严格受限工具）

`src/host/tools.ts` 通过 `ProductLineRegistry.collectAgentTools()` 自动向 DsH Agent 注册工具，宿主层本身零硬编码。所有工具均遵循**「只读检索 + 提案草拟，零直接写稿」**红线：

- **番茄产品线（10 个：`src/application/products/fanqie/tools.ts`）**
  - **7 个只读工具**：
    - `zhizhang_read_tree`（读取卷/幕/章结构树）
    - `zhizhang_read_chapter`（读取章节摘要与当前正文）
    - `zhizhang_read_known_facts`（读取指定锚点可见的世界观设定）
    - `zhizhang_read_controls`（读取节奏、挂载技法卡与控制参数）
    - `zhizhang_search_workspace`（FTS5 + 2 字中文双通道全文检索）
    - `zhizhang_check_conflicts`（检查设定区间与伏笔时序冲突）
    - `zhizhang_diagnose_chapter`（离线黄金三章与 AI 腔体检）
  - **3 个仅提案工具**：
    - `zhizhang_propose_setting`（提出待审世界观设定）
    - `zhizhang_propose_foreshadow`（提出待审伏笔条目）
    - `zhizhang_propose_technique`（提出待审写作技法卡）
- **头条产品线（1 个：`src/application/products/toutiao/tools.ts`）**
  - **1 个只读工具**：`zhizhang_read_article`（读取文章策划、标题、QA 与正文只读快照）

---

## 4. 前端工作台对齐（三区布局 + 统一组件 + 作业中心）

前端位于 `src/client/`，与 3.0 协议无缝对接：

1. **客户端 API 适配层（`src/client/workbench/api.ts`）**：按操作语义自动分流至 `./state`、`./jobs`、`./command`、`./jobs/preview`、`./jobs/start`、`./jobs/cancel`，配合 `renderGate` 与 `actionCoordinator` 防止重复点击与后台轮询覆盖用户输入。
2. **三区顶栏与六视图切换（`workbench.html` + `workbench.css` + `ui/primitives.ts`）**：左区品牌印章与当前作品面包屑、中区 **6 个核心工作视图**（写作 / 卷幕大纲 / 设定库 / 拆书库 / 技法卡 / 导入导出）、右区三纸面主题切换（墨纸 / 青简 / 夜航）与命令面板快捷入口。
3. **统一作业中心（`src/client/workbench/views/job-center.ts`）**：挂载于右侧栏「作业」页签（`#job-center`），统一展示写作生成、局部改写与 AI 提案提取三类作业的实时进度、Token 消耗、失败恢复建议（`recoveryHints`）、取消按钮与 Diff/结果快速查看入口；存在活跃作业时按 `1.5s` 自动轻量轮询，全部结束后自动停轮询。
4. **本地草稿保险箱与安全交互（`draft-vault.ts` + `modal.ts`）**：未保存正文按文档隔离暂存于浏览器存储，检测修订冲突并提供一键恢复；全部确认/输入弹窗均基于无障碍 `<dialog>` 与统一基础组件渲染，全前端零 `innerHTML` 与零原生阻塞弹窗。
