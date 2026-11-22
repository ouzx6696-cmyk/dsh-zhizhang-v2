# 03 · DsH 共创协议、23 个 Agent 工具与统一作业内核（Zhizhang 3.0）

本文档定义织章 3.0 与 **DeepSeek Harness（DsH）** 对话宿主、前端伴生工作台以及兜底异步作业内核之间的全部协议与接口。

---

## 1. DsH Agent 共创桥接

### 1.1 `ctx.systemPrompt` 渐进披露注入（`src/host/system-prompt.ts`）

插件通过 `runInServiceScope(ctx, ["systemPrompt"], ...)` 注册动态片段 `zhizhang.cocreation`（`weight: 40`；若宿主未提供 `systemPrompt` 服务则静默降级）。该片段始终控制在约 **200–380 tokens**，动态拼装：

1. **当前焦点**：由前端工作台切换书/章时自动同步的 `projectId`、`documentId`、文档状态与字数（`author_workspace_focus`）。
2. **本书作者主权模式**：明确告知 Agent 当前处于 `审慎模式（cautious）` 还是 `共创模式（co_create）` 及锁定红线。
3. **产品线方法论提示**：
   - 番茄：节奏档位、近期焦点、创作指南针、本章视角与目标字数，以及最多 8 条已挂载/推荐 Skill 的**目录索引**（`[id] 标题 ★置顶 — 触发条件 [互斥组]`，不展开步骤正文）。
   - 头条：34 字 / 84 分 / 2 轮受保护硬规则、当前体裁与条线对应的推荐驱动/开篇/收束方法论、以及非微头条 5 选 ≥3 母题标题矩阵指引。
4. **待审提示与协同准则**：待作者审阅的候选稿/提案数，以及「按需拉取上下文与技法全文、局部修改优先用段落补丁、设定伏笔仅提提案」准则。

### 1.2 23 个确定性排序 Agent 工具（`src/host/tools.ts`）

所有工具在注册前按 `name` 字典序排列，并通过 `canonicalizeJsonKeys` 递归排序 Schema 键名，确保宿主多轮对话前缀 KV 缓存 100% 稳定。

#### 核心工作区工具（3 个，`src/application/author-workspace.ts`）

| 工具名 | 权限 | 说明 |
| --- | --- | --- |
| `zhizhang_read_focus` | 只读 | 读取当前焦点作品/章节、协作模式、是否开启提示注入及作品列表 |
| `zhizhang_submit_draft` | 写入 | 提交整章/整篇草稿：审慎模式落候选区待 Diff 采纳；共创模式直写未定稿草稿并记录 `previousRevisionId` 快照供回滚；已定稿/已验收/已交稿严格拒绝；返回离线诊断摘要 |
| `zhizhang_patch_paragraphs` | 写入 | 按 1-based 段落序号外科手术式局部精修，保持未改段落逐字不变；同样遵循本书协作模式与锁定保护 |

#### 番茄长篇工具（18 个，`src/application/products/fanqie/tools.ts`）

| 分组 | 工具名 | 权限 | 说明 |
| --- | --- | --- | --- |
| **上下文与检索** | `zhizhang_read_tree` | 只读 | 读取卷 → 幕 → 章三级目录、字数与滚动摘要 |
| | `zhizhang_read_chapter` | 只读 | 读取章节当前正文、状态、章纲元数据与面包屑 |
| | `zhizhang_read_context` | 只读 | 按需装配并返回完整 L1/L2/L3 四层上下文与预算报告 |
| | `zhizhang_read_known_facts` | 只读 | 查询某角色在指定章/段锚点之前可见的已批准设定 |
| | `zhizhang_read_controls` | 只读 | 读取指南针（`authorIntent`）、近期焦点与可调上下文参数 |
| | `zhizhang_search_workspace` | 只读 | BM25+RRF 全文检索（覆盖章节、设定、拆书、技法） |
| **离线体检** | `zhizhang_check_conflicts` | 只读 | 扫描设定有效区间与角色知情时间线冲突 |
| | `zhizhang_diagnose_chapter` | 只读 | 零 Token 黄金三章、AI 腔、章末钩子、跨章回声与视角越权诊断 |
| **渐进 Skill 库** | `zhizhang_list_skills` | 只读 | 返回轻量技法目录索引（传 `documentId` 时按当前章推荐排序） |
| | `zhizhang_load_skill` | 只读 | 按 ID 加载单张技法卡或拆书的完整步骤、约束与正反例 |
| | `zhizhang_mount_skill` | 写入 | 将技法卡或拆书挂载（`include` / `pin` / `exclude`）或卸载到书/卷/幕/章 |
| **结构与章纲** | `zhizhang_create_structure` | 写入 | 创建新卷、新幕或新章节 |
| | `zhizhang_plan_chapter` | 写入 | 提交/更新章纲（视角、字数、节拍、锁定事实）；审慎模式生成 `outline` 提案，共创模式直写 |
| **提案入库** | `zhizhang_propose_setting` | 仅提案 | 向 `author_settings` 提交待审设定提案（绝不自动生效） |
| | `zhizhang_propose_foreshadow` | 仅提案 | 向提案箱提交伏笔埋设/推进/回收提案 |
| | `zhizhang_propose_technique` | 仅提案 | 向提案箱提交新技法卡提案 |
| **非标材料** | `zhizhang_ingest_preview` | 只读 | 读取本地切片清洗后的非标准材料会话与分块列表 |
| | `zhizhang_propose_material_bundle` | 仅提案 | 提交标准化提案包（章/设定/伏笔/指南针）供作者四栏预览后原子入库 |

#### 头条创作工具（2 个，`src/application/products/toutiao/tools.ts`）

| 工具名 | 权限 | 说明 |
| --- | --- | --- |
| `zhizhang_read_article` | 只读 | 读取文章正文、场景矩阵、最新 QA 报告与审批/交付状态 |
| `zhizhang_plan_toutiao_article` | 写入 | 保存驱动/开篇/收束与 5 选「标题\|母题」矩阵；代码强制校验 34 字上限、≥3 母题、微头条禁标题与 `已验收`/`已交稿` 锁 |

---

## 2. `zhizhang/3.0` HTTP 协议与安全信封

插件挂载于 `/api/zhizhang`（本地开发服务暴露同构路径），无历史兼容壳：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/workbench` | 工作台 HTML 入口（支持 `?view=conversation` 窄栏伴生分屏与 `?view=settings`） |
| `GET` | `/workbench.css` | 完整样式表（零外部 CDN、零 `data:` URL） |
| `GET` | `/workbench/*.js`、`/contracts/protected-rules.js` | 由 `CLIENT_JS_MODULES` 白名单精确托管的 ES 模块 |
| `GET` | `/state` | 读取工作台快照（支持 `?projectId=&documentId=&ifSequence=` 增量序列跳过） |
| `GET` | `/jobs` | 统一作业列表查询（支持 `?projectId=&documentId=&kind=&limit=`） |
| `GET` | `/diag` | 脱敏运行时诊断（版本、Schema、作业对账、工具与提示词注册状态） |
| `POST` | `/command` | 同步命令分发（`{ action, ...input }`，严格对应 `WorkspaceAction` 契约） |
| `POST` | `/jobs/preview` | 兜底作业启动前零 Token 预算与上下文装配预估 |
| `POST` | `/jobs/start` | 启动统一异步作业 |
| `POST` | `/jobs/cancel` | 取消在途作业并记录晚到用量审计 |

**封闭错误信封**：所有预期业务拒绝统一返回 `{ ok: false, code, details, diagnosticId }`，`code` 严格限定在 11 个标准码内：`version.conflict`、`auth.denied`、`gate.denied`、`budget.exhausted`、`idempotency.mismatch`、`stage.output_invalid`、`usage.uncertain`、`storage.format_unsupported`、`input.invalid`、`input.not_found`、`dependency.unavailable`。非预期异常仅返回 `internal.error` + `diagnosticId`，严禁泄露堆栈或本机路径。

---

## 3. 统一作业内核（兜底直连与批处理引擎）

当作者使用折叠兜底区发起直连生成、划词改写、AI 提案抽取、非标材料自动提炼或分级自治多章连跑时，全部收敛至单一 `author_jobs` + `author_job_calls` STRICT 台账：

| 作业类型（`UnifiedJobKind`） | 并发锁范围 | 产物落点 |
| --- | --- | --- |
| `draft_generation` | 同文档同类型互斥 | `candidates` 隔离候选区（待 Diff 采纳） |
| `selection_rewrite` | 同文档同类型互斥 | 返回局部改写片段（作者确认替换） |
| `proposal_extraction` | 同项目/文档同类型互斥 | `author_ai_proposals` 提案箱（逐条审批） |
| `autopilot_pipeline` | 同批次互斥 | `author_autopilot_batches` / `steps` + 每章批次前快照回滚 |
| `material_normalize` | 同导入会话互斥 | `author_material_ingests` 四栏预览后原子入库 |

### L0–L3 四层 Prompt Cache 架构（`src/workflow/cache-layer.ts`）

- **L0 共享系统内核（`SHARED_WORKBENCH_SYSTEM_KERNEL`）**：全书所有作业在 Token 0 逐字一致，具体任务角色与输出格式统一置于 L3 文末协议区。
- **L1 版本钉住全书圣经（`author_book_prefix_cache`）**：按独立配额（默认 `8192` tokens）固化指南针、全书约定、客观设定与全书挂载技法；零散设定修改（`< l1DirtyThreshold`）走 L3 增量补丁，不破坏 L1 前缀哈希。
- **L2 仅追加卷幕与里程碑**：归档已定稿卷幕摘要与每 N 章（默认 `10` 章）闭合里程碑，前缀中段只增不改。
- **L3 每次请求动态尾**：L1 增量补丁、POV 知情与严禁泄露边界、当前阶段技法、近期窗口摘要、远期 Top-K 召回、工作稿正文与任务协议。
- **供应商路由（`buildLayeredStreamPayload`）**：按 `(provider, model)` 自动选择 `deepseek-implicit`、`anthropic-breakpoints`（`cache_control: { type: "ephemeral" }`）、`openai-implicit`（`prompt_cache_key`）或 `compact-local`。
