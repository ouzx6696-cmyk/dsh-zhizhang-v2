# 织章 V2 全量优化计划（v2.3 规划稿）

> **范围**：`D:\dsh-zhizhangv2` 全部源码（`src/` 约 2.6 万行，核对时为 15,037 行 TS）、`test/` 58 个测试文件（核对时基线；Wave 1 后为 61 个）、`scripts/`、`support/`、`docs/`
> **实施状态**：本计划是 2026-11-20 的方案快照，**不是进度真源**。逐条落地情况见 [V2.3 实现状态对照表](zhizhang_v2_3_status.md)
> **方法**：分 4 个视角并行全量阅读，再统一去重、排序、合并。视角为前端 UI 工作台、DsH 插件逻辑、后端数据库逻辑、番茄小说工作线，必要的外部事实已联网核对
> **约束**：遵守 `AGENTS.md`。头条 34 / 84 / 2 / 2 / 交稿尾句、两条线的状态词表与转换约束等**受保护规则一律不改数值**；凡是涉及这些规则的条目都标注"需作者授权"
> **日期**：2026-11-20

---

## 0. 一页结论

**总体判断**：项目的底座设计水平高于同类工具。具体体现在：
- 分层清晰，两条产品线零交叉；
- 写操作统一经过"幂等 → 基准版本 → 业务"的命令账本；
- 事件溯源支持冷恢复；
- 设定建模用了半开区间加逐角色 `knownFrom`；
- 前端防丢字做得扎实。

V2.2 计划里的功能基本都已落地。**主要风险已不在"功能有没有"，而在三处：**

1. **连续性数据的正确性**：知情史被覆盖、"第 N 段"有 4 套口径、提案不绑定基准版本、章序有两个真源、选段替换用的是过期偏移。这类问题会**静默地写坏作者的书**，优先级最高。
2. **与真实 DsH 宿主的契约**：宿主 API 全部是自拟接口，用自造的 mock 验证。Agent 工具在真实宿主上大概率注册失败，还可能拖垮整个插件。身份边界目前只靠约定。
3. **规模与运维**：读模型冷启动是 O(N²)、command_journal 写放大、FTS 排序成本高、备份没有接入生产、同步 SQLite 阻塞宿主事件循环。这些问题在 5000 章规模下会集中暴露。

**统计**：一共 **123 条**发现，其中严重 3、高 30、中 63、低 27。粗估总工作量约 **135 人日**（S=0.5、M=1.5、L=4）。

| 视角 | 读取文件 | 读取行数 | 发现 | 严重/高 |
| --- | --- | --- | --- | --- |
| 前端 UI 工作台 | 46 | 11,150 | 34 | 1 / 7 |
| DsH 插件逻辑 | 44 | 3,900 | 28 | 1 / 8 |
| 后端数据库逻辑 | 15 | 9,600 | 27 | 0 / 6 |
| 番茄小说工作线 | 48 | 11,097 | 34 | 1 / 9 |

**最该先修的 10 项**（全部排在 P0）：

| # | 编号 | 问题 | 为什么急 |
| --- | --- | --- | --- |
| 1 | FQ-01 | fact_sync 和设定提案会覆盖已有事实的 `knownFrom` 知情史 | 角色"早已知情"被静默推迟，连续性检查和上下文装配都会出错 |
| 2 | FE-01 | 选段微改写在过期偏移上替换，切章后甚至会写进**别的章节** | 直接写坏正文 |
| 3 | DSH-01 | 10 个 Agent 工具缺少 `output{schema,render}`，在真实宿主上注册会抛错 | 抛错会走启动 catch，导致整个工作台不可用 |
| 4 | FQ-03 | AI 提案不绑定 `base_revision_id`，正文改动后再确认会把章节误标为 clean | 新写的设定永远进不了记忆同步 |
| 5 | FQ-02 | "段落 point"在证据、增量同步、诊断、UI 四处口径不同 | 段间空一行的排版下，同一段在证据里是 P7、在增量同步里是 P4 |
| 6 | DSH-03 | thinking 块的增量文本会混进候选正文，测试也把这个错误当成了期望值 | 推理内容可能直接出现在候选稿里 |
| 7 | FQ-06 | 库条目和伏笔可以按 id 跨项目覆写，AI 提案的 payload 可以携带 `id`/`projectId` | 作者主权和项目隔离被绕过 |
| 8 | DB-01 | `cache_read` 被重复计入已结算用量和预算 | 预算提前耗尽，账单显示不一致 |
| 9 | DSH-08 / DSH-10 | 卸载排空期间丢弃真实用量回执；`selection.rewrite` 完全不记账 | 账本失真，违背"绝不静默"的原则 |
| 10 | FE-07 | 请求没有超时、没有幂等键 | 后端一卡住就锁死全部操作；超时后重试保存会被误报为版本冲突 |

---

## 1. 现状与优点（保留并加固）

| 层 | 现状亮点 |
| --- | --- |
| 前端 | 零依赖原生 ESM，`ProductLineUiModule` 与后端模块对称；DraftVault 双存储 + owner 隔离 + `editSequence` + 输入法组字保护；`loadSequence`/epoch 丢弃过期响应；5000 章虚拟目录；DOM 只有 2 处静态 `innerHTML` |
| DsH 宿主 | `writing.ts` 不依赖领域层，单轮调用、零工具；缺少回执就标 `usage.uncertain` 并阻断后续生成，不静默重发；启动失败时逆序注销路由；2 MiB 流式读体；交稿用 `wx` + 硬链接原子发布；`/diag` 脱敏 |
| 数据库 | 驱动只有一个入口；命令写入顺序冻结；`appendEvent` 用单条 SQL 原子分配 seq；SAVEPOINT 嵌套，读事务内禁止写；FTS 外部内容表不重复存正文；交付与写文件分离；有 schema 窗口 |
| 番茄线 | 领域层是纯函数、零 IO；锚点 + 半开区间 + 逐角色 knownFrom 的建模领先同类工具；AI 输出只进 pending；章序走"预览 → 水位 → 确认"三段协议；槽位报告可视化；导入有多重防护 |

---

## 2. 十个跨视角主题

123 条发现可以归成 10 个主题。很多问题需要两三层一起改，下面按主题列出涉及的条目和统一的解决方向。

### T1 · 连续性真源与数据正确性（番茄线 × 数据库 × 前端）
- **涉及**：FQ-01、02、03、06、07、08、09、10、22、24；FE-33；DB-11
- **统一方向**：
  1. 在 `domain/shared/anchors.ts` 建立**唯一的段落切分函数** `splitChapterParagraphs()` 和 `pointAtOffset()`，证据、增量同步、诊断、UI、`resolveAnchor` 全部改用它，并给出一次性回填旧数据的迁移；
  2. 新增纯函数 `mergeFactVersion()`：`knownFrom` 逐角色取更早的锚点，`effectiveFrom` 默认继承上一版本；
  3. 提案表新增 `base_revision_id` 和 `source_sha256`，正文漂移时拒绝或保持 dirty；
  4. `factId` 由服务端生成，提示词把输出拆成 `newFacts` 和 `updates` 两类；
  5. **章序只留一个真源，以树为准**，平铺序由树派生；`author_chapter_order` 降级为派生缓存，或改为组内 `sort_key`（DB-11）；
  6. 伏笔改为有转换表的状态机，接口拆成 `create` 和 `patch`。

### T2 · 与真实 DsH 宿主的契约（DsH × 测试基建）
- **涉及**：DSH-01、02、09、14、03、25、27；FE-23
- **统一方向**：
  1. 新建 `src/host/dsh-adapter.ts`，作为**唯一引用宿主 API 的地方**；
  2. 固定一份上游类型（vendor `.d.ts`），在 `package.json` 声明 `peerDependencies`；
  3. 经作者授权后，在**隔离 profile** 录制一次真实的 route、llm、tools 交互，存为 `support/fixtures/dsh-contract-0.2.x.json`，契约测试回放这份录制；
  4. 可选服务一律用 `ctx.get()` 或嵌套 `ctx.inject` 获取，工具注册放进独立的子作用域，失败不影响工作台；
  5. 严格版 registrar mock 要复刻上游对 `output`、`timeoutMs`、`exec.signal` 的校验。

### T3 · 作者主权与身份边界（DsH × 应用层 × 番茄线）
- **涉及**：DSH-04、05、06、21、22；FQ-05、06；FE-25
- **统一方向**：
  1. 路由接收宿主 Peer。定义 `Actor = {kind:'author', peerId} | {kind:'agent', toolCallId}`，透传到 `commandInput` 和 `command_journal.actor_id`；
  2. 在 `contracts/commands.ts` 声明"仅作者可执行"的命令集，Agent 调用一律返回 `auth.denied`（403）；
  3. 只读工具在 `withReadTx` 中执行，并限定动作白名单；新增精简的 `chapter.read` DTO，不返回候选稿和其他项目；
  4. 提案增加 `origin` 来源标记和 pending 配额；
  5. 未挂载的技法卡不再自动注入（如需保留，加一个默认关闭的开关）；
  6. Agent 工具是否默认关闭，由作者决定。

### T4 · 用量账本与预算口径（数据库 × DsH × 前端 × 番茄线）
- **涉及**：DB-01、13、14、26；DSH-08、10、11、12；FQ-29；前端两套 token 估算
- **统一方向**：
  1. 在宿主边界把用量规范为**互斥的四类**：未命中输入 / 缓存命中 / 缓存写入 / 输出（`normalizeUsage`）。B.4"对四类求和"的契约不变；
  2. `selection.rewrite` 纳入账本；
  3. 排空期间拆成 `accepting` 和 `dbOpen` 两个开关，继续写回执；
  4. 提案互斥下沉到数据库，用部分唯一索引实现；内存锁只用来快速失败；
  5. **token 估算只留一份实现**放进 `contracts/`，前端直接用 `run.preview` 的结果；按 DeepSeek 实测校准（FQ-29 测得当前估算偏高约 2.3 倍）。

### T5 · 前端状态同步模型（前端 × 数据库 × DsH）
- **涉及**：FE-03、04、05、20、21、28；DB-15；DSH-17
- **统一方向**：
  1. 页面可见时每 15 秒做一次带 `ifSequence` 的常驻轮询；页面切回可见或获得焦点时立即拉取；
  2. 快照新增 `pendingJobs`，有待完成的作业时切到 2 秒快轮询；
  3. 用 `BroadcastChannel('zhizhang')` 在标签页之间广播，并选出一个负责轮询的主标签页；
  4. `tree.get` 支持目录水位 `treeSeq` 和 `unchanged` 响应，`docSig` 去掉 `asOfSeq`。目标是一次保存最多 3 个请求，不触发 `tree.get`；
  5. 大纲板和设定库维护本地草稿，焦点在输入框时推迟重绘；
  6. 后端提供轻量快照。

### T6 · 5000 章规模化性能（数据库 × DsH × 番茄线 × 前端）
- **涉及**：DB-03、05、06、11、12、16、17、24；DSH-07；FQ-18；FE-06
- **统一方向**：
  1. 读模型改为**每个项目一个 ProjectionStore**，共用一遍折叠；导航 reducer 改为增量更新；检查点节流写入，并按 LRU 淘汰；
  2. FTS 改成两段式查询：先取 rowid、排序、LIMIT，再对前 K 条做 snippet；
  3. 2 字中文查询走实体倒排表（可选：二元组影子 FTS 表）；
  4. 补齐热点索引，用 query-plan 测试守住；
  5. 导入、导出、FTS 重建、热备移到 `worker_threads`（仍然零第三方依赖），`/diag` 的深度检查改为按需触发；
  6. 修正虚拟列表行高，并加 `ResizeObserver`；
  7. **统一基准**：见 §5。

### T7 · 写入放大与运维（数据库 × DsH）
- **涉及**：DB-02、04、18、19、20；DSH-16、18、19、23、15；FE-22
- **统一方向**：
  1. 非幂等命令只记审计元数据，大字段只存哈希；在宿主生命周期中定时调用 `pruneCommandJournal`；
  2. 备份改用 `node:sqlite` 的 `backup()` 或 `VACUUM INTO`，在三个时机自动热备：迁移前、每天首次打开、交稿后；
  3. 修订版本和事件日志的保留、归档策略交给作者决定（P3）；
  4. 静态资源改为内容哈希 ETag + `no-cache` + `modulepreload` + `?v=hash`，**同时**解决 tgz 安装后的 1985 mtime 缓存问题（`deploy:touch` 对 tgz 无效）；
  5. 交稿写文件在 `linkSync` 失败时回退，启动时清理残留的 `.tmp`；
  6. 处理 Windows 保留文件名。

### T8 · 编辑器与合稿正确性（前端）
- **涉及**：FE-01、02、12、13、14、27、31
- **统一方向**：
  1. 选段改写时同时记下 `{documentId, revisionId, start, end, text}`，应用前校验，校验失败就按原文唯一匹配重新定位，仍失败则拒绝；切章时隐藏预览卡；
  2. 替换优先用 `execCommand('insertText')`，让 Ctrl+Z 能撤销；另加一个"撤销 AI 替换"栈；
  3. 切换到 raw 模式时保留已勾选的部分采纳；合稿保留空行分隔；
  4. Diff 换成 Myers 算法，或先按标点切句再做字级比对；段落层面先用哈希锚点（patience）再配对，可选放进 Worker。

### T9 · 架构收口（全栈）
- **涉及**：FE-15、16、17、18；DB-09、10、22、27；DSH-13；DB-23；`writing-budget.ts` 命名问题；`toutiao.ts` / `fanqie.ts` 目录不对称
- **统一方向**：
  1. **前端 M4.1 收尾**：
     - `shell.ts` 从 971 行拆到 300 行以内，拆出 `state.ts` 和 `run-panel.ts`；
     - 外壳里不再出现 fanqie、toutiao、"微头条"等产品线字样；
     - 新增 `contracts/protected-rules.ts` 纯常量模块（**数值不变**），前后端共用；
     - 动作 API 改为类型化的 `ActionMap`，`candidateQa` 改为结构化下发。
  2. **数据层**：
     - schema 按 platform、fanqie、toutiao 命名空间拆分迁移；
     - 补齐外键和 CHECK 约束，新表用 STRICT；
     - `meta.schema` 与 `user_version` 保持一致。
  3. **命名**：`writing-budget.ts` 中的提示词移到 `workflow/prompts/`，`products/fanqie.ts` 移进 `fanqie/index.ts`，与头条目录对称。
  4. **错误码**：错误码到 HTTP 状态码的映射细化，前端解析同步更新。

### T10 · 番茄写作质量与作者体验（番茄线 × 前端）
- **涉及**：FQ-13、14、15、16、17、19、20、21、23、26、27、28、30、31；FE-09、19、33
- **统一方向**：
  1. **提示词**：番茄专用提示词分成续写、重写、定向修稿三种模式（不改头条和两条线共用的常量）；Prompt/Skill 保持**轻量**，以提示词为主，配少量检查脚本；
  2. **节奏档与题材**：在项目层接通节奏档和题材标签，诊断、推荐、上下文三处读取同一个设置；
  3. **离线诊断**：修正黄金三章的计分缺陷，AI 味扫描去掉重叠计数，增加句长变异系数；
  4. **审稿观察**：摘句不匹配时标为 unverified，正文修订后旧观察显示为过期；
  5. **实体与伏笔**：实体支持别名；伏笔增加"预定回收章"的入口，超期按预定章判断；
  6. **作者体验**：
     - 新增"创作过程报告"，记录 AI 参与度和采纳后的编辑量，供作者面对平台审核时自证；
     - 可选的日更目标和字数里程碑；
     - 新增 `project.bootstrap` 复合动作，向导一次事务完成建书；
     - 工程包 format v2 做到真正无损往返。

---

## 3. 统一路线图

沿用 `docs/framework/03-migration-roadmap.md` 的门禁方式：**每个阶段全绿才算完成，可以独立验收**。建议把这次计划记为 **M5（正确性与契约）→ M6（规模化）→ M7（写作质量）**。123 条全部分配到下列阶段，每条只出现一次。

### P0 · 正确性止血与宿主契约（约 20 人日，24 条，建议 1.5–2 周）
**目标**：不再静默写坏数据，不再静默丢账，插件在真实宿主上能启动。

- **包含**：`FE-01`、`FE-02`、`FE-07`、`FE-12`、`FE-06`、`FE-27`、`DSH-01`、`DSH-02`、`DSH-03`、`DSH-08`、`DSH-10`、`DB-01`、`DB-02`、`DB-07`、`DB-08`、`DB-14`、`DB-21`、`FQ-01`、`FQ-02`、`FQ-03`、`FQ-06`、`FQ-07`、`FQ-08`、`FQ-10`
- **按顺序做**：
  1. 先修纯函数：`splitChapterParagraphs`、`mergeFactVersion`、伏笔转换表；
  2. 再做迁移：提案加 `base_revision_id`、证据 point 回填；
  3. 然后改应用层校验：跨项目 id 校验、payload 字段白名单、拒绝缺少 documentId 的提案；
  4. 宿主侧：适配工具形状，工具放进子作用域注册，修复 thinking 过滤和排空期双开关，`selection.rewrite` 入账；
  5. 数据库：`normalizeUsage`、journal 瘦身并定时修剪、调整 PRAGMA 顺序、stmt 缓存设上限；
  6. 前端：选段校验、撤销、超时与幂等键、行高、candidateQa 容错。
- **退出标准**：
  - 跨模块的 point 一致性测试通过，样章包含"段间空行"排版；
  - 回归通过：第 3 章已知情 → 第 10 章更新 → 在第 5 章查询仍然可见；
  - 生成提案后改稿再确认，返回 `proposal-stale` 或保持 dirty；
  - 跨项目 id 覆写和 AI payload 注入的攻击用例全部被拒绝；
  - 严格版 registrar 下 10 个工具全部注册成功，注册失败时 `/workbench` 仍可用；
  - thinking 增量不出现在候选正文中；`generation-v2` 首个用例的期望已更正；
  - 用量回归：input=1000、cache_read=800 时，`settled=1000+output`，runs、proposals、run-inspector 三处一致；
  - 100 次 `draft.save` 后 `command_journal` 总大小 < 100KB；
  - 选段改写期间改稿或切章后，"应用"被拒绝；`/mutate` 挂起 35 秒时 UI 在 30 秒内复位，重试复用同一个 key。

### P1 · 身份边界、同步模型与读写热点（约 36 人日，35 条，建议 2–3 周）
**目标**：作者主权有机制保证；多入口（标签页、Agent、异步提案）的变化能自动出现；5000 章规模下的热点不再阻塞。

- **包含**：`DSH-04`、`DSH-05`、`DSH-06`、`DSH-20`、`DSH-21`、`DSH-22`、`DSH-13`、`DSH-23`、`DB-23`、`DB-13`、`FE-03`、`FE-04`、`FE-05`、`FE-21`、`FE-20`、`FE-17`、`FE-08`、`FE-09`、`FE-13`、`FE-10`、`DB-03`、`DB-04`、`DB-05`、`DB-12`、`DB-15`、`DB-16`、`DB-17`、`DB-24`、`FQ-04`、`FQ-05`、`FQ-09`、`FQ-11`、`FQ-22`、`FQ-24`、`FQ-34`
- **关键依赖**：
  - DSH-04（Actor 透传）要和 DB-13（数据库互斥）、DSH-22 一起做；
  - FE-03、04 依赖后端提供 `pendingJobs`、`treeSeq` 和 DB-15 的轻量快照；
  - FE-08 的分批导入需要和宿主约定协议（`importId/part/commit`）；
  - FQ-09 的唯一真源要和 DB-11 的 sort_key 一起设计（DB-11 在 P2 落地，P1 先定好 schema）。
- **退出标准**：
  - Agent actor 调用"仅作者"命令全部返回 403，有表驱动测试；
  - 只读工具内部出现写操作时报 `write-inside-read-tx`；
  - 提交提案后 3 秒内自动出现在面板中（用 FakeLlmTransport 跑通）；
  - 其他标签页保存后，本页 15 秒内（或切回可见时立即）显示变化；
  - 一次 Ctrl+S 最多 3 个请求，不触发 `tree.get`；
  - db-bench（5000 章、5 万事件）：navigation 冷读 < 300ms、热读 < 5ms，三字搜索 < 50ms；
  - 没有新事件时，读请求不开写事务；
  - 迁移前和每天首次打开时自动热备并校验通过；
  - stablePrefix 在不同指令、第 3/4 章、500 字与 6000 字正文下逐字节相等；
  - 1200 章往返后章序不变。

### P2 · 结构治理、宿主性能与写作质量（约 50 人日，39 条，建议 3–4 周）
**目标**：架构收口；宿主事件循环不被阻塞；交付体验和番茄写作质量提升。

- **包含**：`DSH-14`、`DSH-07`、`DSH-11`、`DSH-15`、`FE-22`、`DSH-16`、`DSH-17`、`FE-23`、`DSH-18`、`DSH-19`、`DSH-09`、`FE-24`、`DB-06`、`DB-09`、`DB-10`、`DB-11`、`DB-20`、`DB-22`、`DB-25`、`DB-27`、`FE-14`、`FE-15`、`FE-16`、`FE-18`、`FE-29`、`FE-33`、`FE-32`、`FQ-18`、`FQ-29`、`FQ-13`、`FQ-14`、`FQ-15`、`FQ-16`、`FQ-17`、`FQ-19`、`FQ-20`、`FQ-21`、`FQ-23`、`FQ-28`
- **退出标准**：
  - 隔离 profile 契约回放全部通过；
  - 事件循环阻塞 p95 < 20ms；
  - 导入、导出、FTS 重建、热备在 worker 中执行，期间 `/state` 响应 < 50ms；
  - 静态资源二次加载全部返回 304，tgz 升级后前端立即生效；
  - `shell.ts` < 300 行，架构守卫确认外壳不含产品线字样，前端没有裸阈值数字；
  - Diff 基准：30 段 × 200 字的改写 < 30ms，字级精确率 ≥ 95%，中间插入一段不会把后续段落标为 changed；
  - 迁移按命名空间拆分，`foreign_key_check` 结果为空，拖动一章只更新 1 行；
  - 番茄三种写作模式有独立模板，定向修稿中未提及段落的保留率 ≥ 90%（model-check 回放）；
  - AI 味误报 ≤ 1 次/千字；节奏档在诊断、推荐、上下文三处都生效。

### P3 · 体验、生态与长期治理（约 28.5 人日，25 条，持续进行）
- **包含**：`DB-18`、`DB-19`、`DB-26`、`FQ-25`、`FQ-12`、`FQ-26`、`FQ-27`、`FQ-30`、`FQ-31`、`FQ-32`、`FQ-33`、`FE-19`、`FE-11`、`FE-25`、`FE-26`、`FE-28`、`FE-30`、`FE-31`、`FE-34`、`DSH-12`、`DSH-24`、`DSH-25`、`DSH-26`、`DSH-27`、`DSH-28`
- **说明**：
  - FQ-25（番茄章节显式转换表）触及受保护语义，**已获作者授权**（2026-11-20，决议 #1）：只按 docs/02 原样编码，不增不减转换，可以随时提前实施；
  - DB-18 已按决议 #10 确定保留策略（定稿/采纳/手动保存全部保留，超过 7 天的自动保存按天合并）；DB-19 只做 concern 缺失容错，**不归档**。执行前先备份。
- **退出标准**：
  - 纯键盘完成主要流程，axe 检查没有 serious 级别问题；
  - 工程包 v2 往返语义等价，v1 包仍可读取；
  - 每章可查看创作过程报告；
  - `project.bootstrap` 在故障注入下不留下半成品项目；
  - 文档与测试用例数同步。

---

## 4. 关键依赖与协作顺序

| 先做 | 再做 | 原因 |
| --- | --- | --- |
| FQ-02 段落真源 | FQ-01、03、10、FE-33、FQ-24 | 所有锚点都以 point 为准 |
| DSH-14 适配层（P0 先建骨架） | DSH-01、02、09、04 | 宿主 API 只能出现在一个地方 |
| DB-01 用量口径 | DSH-10、FQ-29、前端估算统一 | 账本先要有统一口径 |
| DB-15 轻量快照 + `treeSeq` | FE-03、04、05 | 前端常驻轮询依赖它保持低成本 |
| DB-11 sort_key（schema） | FQ-09 唯一真源 | 章序存储决定真源能否落地 |
| DSH-04 Actor | DSH-05、06、21、DB-13 | 身份是所有边界的前提 |
| DB-04 热备 | DB-18、19 及一切破坏性迁移 | 先有可靠备份再动数据 |
| T9 `protected-rules.ts` | FE-16、头条 UI | 数值只在一处定义 |

**多视角重复的条目已合并处理**（编号各自保留以便追溯）：
- FE-22 = DSH-15（静态资源缓存）
- FE-23 ≈ DSH-17（双 iframe 实例）
- FE-24 ≈ DSH-09（模型默认值和配置链路）
- FE-08 ↔ 宿主 2 MiB 上限
- DB-13 ≈ DSH-22（提案互斥）
- DB-23 ≈ DSH-13（状态码映射）

---

## 5. 度量与门禁（建议加入 `npm run test:bench` 和 CI）

| 指标 | 目标 | 测量方式 |
| --- | --- | --- |
| navigation 读模型冷读 / 热读 | < 300ms / < 5ms | db-bench：5000 章、5 万事件 |
| FTS 三字检索 | < 50ms | 5000 章中命中 1000 章 |
| 轻量快照 `/state` | < 20ms，p95 事件循环阻塞 < 20ms | workspace-bench |
| `draft.save` | p95 < 80ms；一次保存 ≤ 3 个请求 | bench + 前端请求计数 |
| `context.preview` | p95 < 300ms | 5000 章、3000 事实 |
| command_journal 增长 | 100 次保存 < 100KB | 单测 |
| Diff | 30 段 × 200 字 < 30ms，精确率 ≥ 95% | 单测基准 |
| 大书导入 | 200 万字、3000 章 < 30 秒，不触发 too-large | 夹具 |
| Prefix 稳定性 | 逐字节相等（性质测试） | 单测 |
| 缓存命中率 | 在 run-inspector 中展示 `cache_read / input` | 实测（需授权调用模型） |

---

## 6. 需作者决策的事项（汇总去重）

### 6.0 决议记录

| # | 决议 | 日期 | 落地条目 |
| --- | --- | --- | --- |
| 12 | ✅ **非空行算一段**，作为 point 的唯一口径。允许按 `quote_start` 回填已有证据，回填前必须先热备，并输出 point 变化报告供作者核对 | 2026-11-20 | FQ-02、FQ-24、FE-33；迁移：`author_evidence.point` 回填 |
| 13 | ✅ knownFrom **逐角色取更早的锚点**；需要"推迟知情"（如失忆）时用显式的"撤销知情"操作，不靠合并完成；known-before-effective 从 error **降为 warning** | 2026-11-20 | FQ-01（`mergeFactVersion`）、FQ-20、`detectLoreConflicts` 级别调整 |
| 14 | ✅ 未挂载的推荐卡**不注入**生成上下文，只在上下文预览中展示，并提供"一键挂载到本章"。漂移提案**默认拒绝**（`proposal-stale`）并提供"按当前正文重新生成"；作者看过 diff 后可以强制应用，此时章节**保持 dirty** | 2026-11-20 | FQ-03、FQ-04、FQ-05 |
| 1 | ✅ **授权** FQ-25，但只把 docs/02 现有的番茄章节状态图**原样**写成 `CHAPTER_TRANSITIONS`，用表驱动测试锁定，**不增不减**任何转换。审稿打回计数在定稿前不清零（只确认，不改） | 2026-11-20 | FQ-25（由 P3 提前到可随时实施） |
| 2 | ✅ 新建 `contracts/protected-rules.ts`，**数值不变**，只是集中定义，视为不触及语义，不需要另行授权。要求：守卫测试断言数值等于原值；在 AGENTS.md 的 Protected business rules 一节补一行说明"唯一定义位置" | 2026-11-20 | FE-16、T9 |
| 4 | ✅ 正式冻结使用 `node:sqlite`（与 `engines: node >=24.15` 一致），可以使用 `backup()` 等 API | 2026-11-20 | DB-04、DB-27、DSH-19 |
| 6 | ✅ Agent 工具**默认关闭**，按项目开启。Agent **可以读**已定稿的正文和已批准的设定，**不能读**候选稿、未批准的提案和其他项目 | 2026-11-20 | DSH-05、DSH-21；`chapter.read` 精简 DTO |
| 7 | ✅ `selection.rewrite` 的用量单独记入"微改写"账户，不占写作任务的预算；运行检查器里与写作任务合并显示 | 2026-11-20 | DSH-10、DB-01 |
| 8 | ✅ 接受用 `worker_threads` 承载重操作（导入、导出、FTS 重建、热备），仍然零第三方依赖；卸载排空上限从 5 秒放宽到 **15 秒** | 2026-11-20 | DSH-07、DSH-08 |
| 9 | ✅ 备份放在 `dataDirectory/backups`，保留 **7 份**；**迁移前强制备份**，每天首次打开和交稿后自动备份 | 2026-11-20 | DB-04、DSH-19 |
| 10 | ✅ 修订：定稿、采纳和手动保存的修订**全部保留**；超过 7 天的自动保存**按天合并为一份**。event_log **暂不归档**，P3 再议 | 2026-11-20 | DB-18（按此策略实施）、DB-19（只做 concern 容错，不归档） |
| 11 | ✅ 非幂等命令只保留一条**轻量审计行**（命令 id、文档 id、请求哈希、时间、actor，不含正文）；按月或按项目的累计预算做成**可选功能、默认关闭** | 2026-11-20 | DB-02、DB-26 |
| 15 | ✅ 工程包 format v2 导出**完整的设定版本史和证据**；已定稿的章节导入后**仍保持锁定**，作者可以手动解锁 | 2026-11-20 | FQ-12（注意：替代原建议中"final 只作提示"） |
| 16 | ✅ 日更目标做成**可选、默认关闭**，数值由作者设定，不硬编码平台条款；token 校准**按提供方配置**，先做 DeepSeek，其他提供方继续用保守系数；**接受**新增 `project.bootstrap` 复合动作 | 2026-11-20 | FQ-27、FQ-29、FQ-31、FE-09 |
| 17 | ✅ 先实测 DsH 是否会同时渲染 main 和 conversation.view 两个工作台；如果会，会话视图改为**只读预览 + 跳转按钮** | 2026-11-20 | FE-23、DSH-17 |
| 18 | ✅ 接受页面可见时**每 15 秒**常驻轮询（带 `ifSequence`，没有变化时几乎零成本）；等宿主提供 SSE 推送后再切换 | 2026-11-20 | FE-03 |
| 19 | ✅ 大文件导入以浏览器端"**分批上传 + 最终提交**"为主，本地和远程部署都能用；宿主直接读取本地目录作为可选项 | 2026-11-20 | FE-08 |
| 20 | ✅ 编辑器侧边显示**轻量段号**，仍用纯 textarea；**接受**用 Worker 计算 Diff（会多一个静态模块，需同步更新 `manifest.ts`）；`atmosphere` **加入**正式技法分类表 | 2026-11-20 | FE-33、FE-14、FE-32 |

> **未决（2 项）**：#3（`inputTokens` 是否已包含缓存命中）需要实测；#5（目标 DsH 版本，以及是否授权在隔离 profile 录制）需要作者提供。在这两项确定前：DB-01 的 `normalizeUsage` 先带开关实现，默认按"已包含"处理；DSH-01 的工具适配先按公开文档实现，等录制到真实契约后再校正。
>
> **决议带来的计划调整**：FQ-25 从 P3 提前，可以随时做；FQ-12 改为导入后保持锁定；DB-18 按 #10 的保留策略实施；DB-19 只做 concern 缺失容错，不做归档；DSH-08 的排空上限改为 15 秒；AGENTS.md 需要补一行说明 `protected-rules.ts` 是唯一定义位置（实施 FE-16 时一并提交）。

**受保护语义与契约**
1. ~~FQ-25：是否授权把番茄章节状态按 docs/02 冻结为显式转换表？~~ → 已决，见 6.0
2. ~~受保护阈值改为由 `contracts/protected-rules.ts` 统一提供、数值不变，是否需要另行书面授权？~~ → 已决，见 6.0
3. DB-01：DsH 的 `inputTokens` 是否包含缓存命中？B.4 是否按"四类互斥"的口径执行？
4. ~~是否正式冻结使用 `node:sqlite`？~~ → 已决，见 6.0

**宿主与 Agent**
5. 目标 DsH 版本是 0.2.2 正式版还是 rc.4？是否授权在**隔离 profile** 安装并录制一次真实交互作为契约基线？
6. ~~Agent 工具是否默认关闭、按项目开启？~~ → 已决，见 6.0
7. ~~`selection.rewrite` 的用量计入哪个账户？~~ → 已决，见 6.0
8. ~~是否接受 `worker_threads`？排空上限能否放宽？~~ → 已决，见 6.0

**数据与保留**
9. ~~备份位置、份数与触发时机~~ → 已决，见 6.0
10. ~~自动保存合并与 event_log 归档~~ → 已决，见 6.0
11. ~~journal 审计行与累计预算~~ → 已决，见 6.0

**番茄线语义**
12. ~~point 是否统一为"非空行算一段"？是否允许按 `quote_start` 自动回填已有证据？~~ → 已决，见 6.0
13. ~~合并设定时，knownFrom 是否一律取更早者？失忆这类需要"推迟知情"的场景是否改为显式操作？known-before-effective 是否从 error 降级为 warning？~~ → 已决，见 6.0
14. ~~未挂载的推荐卡：完全不注入，还是提供默认关闭的开关？提案漂移时：一律拒绝，还是允许看过 diff 后强制应用（保持 dirty）？~~ → 已决，见 6.0
15. ~~工程包 v2 的导出范围与定稿锁定~~ → 已决，见 6.0
16. ~~日更目标、token 校准、`project.bootstrap`~~ → 已决，见 6.0

**前端**
17. ~~两个 iframe 同时渲染时的处理~~ → 已决，见 6.0
18. ~~常驻轮询~~ → 已决，见 6.0
19. ~~大文件导入方式~~ → 已决，见 6.0
20. ~~段号、Diff Worker、atmosphere 分类~~ → 已决，见 6.0

---

## 7. 与既有计划的关系

- **V2.2 优化计划（已归档，见 git 历史 `5a7f921`）**：其中的指南针和滚动幕规划、5000 章虚拟化、SKILL.md 沙箱、离线体检与 Observation、fact_sync / CHAPTER_COMMIT、4 维召回、keyset 分页、热备与修剪、FTS 外部内容表 + RRF、字级 Diff、书斋、向导、主题、卸载排空、7+3 工具、`/diag`、`deploy:touch` 等**已全部落地**。本计划不重复这些功能，指出的是落地后的问题：
  - 有几项承诺实际没有兑现："禁止本章变动信息混入 Prefix"、"无损幂等工程包"、Ctrl+Z 撤销、mtime 刷新能解决缓存问题；
  - 有些问题出在边界条件：选段偏移、知情覆盖、行高；
  - 有些维护能力写好了但从未接入生产：热备、修剪、FTS 校验；
  - 有一个新引入的问题：`cache_read` 被重复计算。
- **`docs/framework/03-migration-roadmap.md`**：M0–M4 已经完成。建议新增三个里程碑：
  - **M4.1** 前端外壳收尾：FE-15、16、17、18、30；
  - **M5** 正确性与宿主契约：对应本计划 P0 + P1 前半；
  - **M6** 数据层规模化：DB 的 P1/P2，加上 DSH-07。
- **不改变 `ProductLineModule` 的边界**：番茄线的改动集中在番茄模块内部，加上一个共享纯函数（段落切分）。头条线只在共享常量、提示词拆分和状态码上被动受影响。

## 8. 非目标与风险

- **非目标**：
  - 不修改任何受保护的数值或状态词；
  - 不引入第三方运行时依赖，`worker_threads` 是 Node 内置模块；
  - 不把 Skill 做成重型流程软件：坚持"提示词 + 少量脚本"，知识内容和流程脚手架分开放；
  - 不迁移 v1.x，也不引入 Electron 或 Pi SDK。
- **风险**：
  1. DSH 类结论部分基于公开文档和推断，**必须用隔离 profile 的录制来证实**；DSH-01 的"注册即抛错"要以实测为准；
  2. point 回填、knownFrom 合并会改变已存数据，要先热备再迁移，并提供预览；
  3. 常驻轮询和 worker 会提高资源占用，用 §5 的门禁约束；
  4. 本计划的证据来自静态阅读，没有运行 `npm` 和真实模型；每条在实施前应先写失败测试复现。

---

## 附录 A · 全量发现清单（123 条）

单视角的完整报告（包含证据原文、完整修改方案和参考链接）：
- [前端 UI 工作台](optimization/frontend_review.md)
- [DsH 插件逻辑](optimization/dsh_plugin_review.md)
- [后端数据库逻辑](optimization/database_review.md)
- [番茄小说工作线](optimization/fanqie_review.md)


### A.1 前端 UI 工作台（34 条）

| 编号 | 阶段 | 严重度 | 类别 | 工作量 | 问题 | 主要位置 | 建议要点 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| FE-01 | P0 | 🔴 严重 | 缺陷 | S | 选段微改写在过期偏移上替换：切章或请求期间继续输入会把 AI 文本写进错误位置甚至错误章节 | `src/client/workbench/views/selection-microbar.ts:87-141`<br>`src/client/workbench/shell.ts:235-245` | 1) 捕获 {documentId, revisionId: editorBase.revisionId, start, end, text}；2) 应用前校验 host.getState().documentId===captured.documentId，且 editor.value.slice(start,end)===text；不一致时在全文中查找 text 的唯一出现位置并重定位，0 次或多次命中则拒绝并提示『原选段已变化，请… |
| FE-02 | P0 | 🟠 高 | 正确性 | S | 『可用 Ctrl+Z 撤销』承诺不成立：setRangeText 与 editor.value 赋值不进入原生撤销栈 | `src/client/workbench/views/selection-microbar.ts:15-33`<br>`src/client/workbench/views/selection-microbar.ts:135` | 1) 替换优先走 editor.focus(); editor.setSelectionRange(start,end); document.execCommand('insertText', false, text)，返回 false 时再回退 setRangeText；2) 另加轻量『撤销上次 AI 替换』按钮：替换前把 {start, before, after} 压入内存栈（最多 10 步），一键还原，不依赖浏览器撤销；3) 文… |
| FE-03 | P1 | 🟠 高 | 缺陷 | M | 状态同步只在『正文生成 running』时轮询：异步提案、Agent 工具提案、其他标签页保存都不会自动出现 | `src/client/workbench/shell.ts:646-656`<br>`src/client/workbench/views/diagnostics-panel.ts:104-118` | 1) 常驻低频同步：页面可见时每 15s 带 ifSequence 拉 /state（unchanged 时几乎零成本），visibilitychange→visible 与 window focus 时立即拉一次；2) 快照新增 pendingJobs: {kind, documentId, startedAt}[]（需后端配合），存在待完成作业时切换到 2s 快轮询，完成后自动刷新对应视图并提示『AI 审稿提案已生成』；3) 轮询统… |
| FE-04 | P1 | 🟠 高 | 性能 | M | 每次保存都会触发目录树全量重拉与多视图刷新：一次 Ctrl+S 约 6 个请求，5000 章时目录树载荷达 MB 级 | `src/client/workbench/shell.ts:503-515`<br>`src/client/workbench/plugins/fanqie.ts:353-389` | 1) docSig 去掉 asOfSeq，只用 `${projectId}:${documents.map(id:title)}`；2) 后端 tree.get 支持 ifSequence/treeSeq（目录相关事件的水位），未变返回 {unchanged:true}；前端缓存 lastTree；3) context.preview 仅在『候选』标签可见时，且 instruction/tokenLimit/point 变化或保存后 8… |
| FE-05 | P1 | 🟠 高 | 缺陷 | S | 大纲板/设定库整块重绘会吞掉正在编辑的摘要与指南针文本 | `src/client/workbench/views/outline-board.ts:101-106`<br>`src/client/workbench/views/outline-board.ts:168-194` | 1) 组件内维护 drafts: Map<key, string>（key=chapterId/'compass'），input 事件写入，paint 时优先使用 drafts，保存成功后清除；2) container.contains(document.activeElement) 且焦点在 textarea 时推迟重绘（设置 pendingRepaint，在 blur 后执行）；3) 修好 FE-04 后，这类刷新本身也会大幅减少；… |
| FE-06 | P0 | 🟠 高 | 缺陷 | S | 虚拟列表行高与 CSS 实际高度不一致：滚动时跳行、末尾截断、scrollToIndex 定位不准 | `src/client/workbench/views/tree-sidebar.ts:244-250`<br>`src/client/workbench/views/virtual-list.ts:49-68` | 1) CSS：.vlist-window{gap:0} .vlist-window>*{height:var(--vrow-h,36px);min-height:0;box-sizing:border-box;padding-block:0;}，章节行改为单行 flex 并 align-items:center；2) virtual-list 通过 container.style.setProperty('--vrow-h', rowH… |
| FE-07 | P0 | 🟠 高 | 正确性 | S | 请求没有超时、也没有幂等键：后端卡住会锁死全部操作，加超时后重试保存会被误报成版本冲突 | `src/client/workbench/api.ts:32-73`<br>`src/client/workbench/store.ts:39-57` | 1) apiRequest 增加 options.timeoutMs（读 15s，写 30s，导入导出 120s），signal=AbortSignal.any([AbortSignal.timeout(ms), userAbort])；2) shell.change() 每次用户动作生成一次 key=crypto.randomUUID()，同一动作的自动/手动重试复用该 key（后端已支持 idempotencyKey 重放）；3) … |
| FE-08 | P1 | 🟠 高 | 功能缺口 | M | 长篇导入走单个 JSON 请求，会撞上宿主 2 MiB 请求体上限：百万字作品无法导入 | `src/client/workbench/views/io-view.ts:109-131`<br>`src/client/workbench/views/io-view.ts:139-155` | 1) 前端预检：用 TextEncoder 计算字节数，超过 1.5 MiB 时自动分批（按卷目录或每批 ≤1 MiB）；2) 协议（需后端配合）：project.import_bundle 支持 {importId, part, totalParts, files}，最后一批 commit，服务端在单个写事务中落库，或每批幂等合并（io.ts 已有内容哈希幂等）；3) 进度 UI：『已上传 3/12 批』，可取消；4) 导出同理：大 … |
| FE-09 | P1 | 🟡 中 | 体验 | M | 开新书向导和示例书导入：中途失败会留下半成品项目，错误提示被模态框挡住看不见 | `src/client/workbench/views/new-book-wizard.ts:52-127`<br>`src/client/workbench/views/new-book-wizard.ts:278-281` | 1) 向导内放一个错误区和进度（step i/n），提交期间禁用按钮；2) 失败时提供『继续完成剩余步骤』（记录已创建的 projectId，后续步骤从断点继续），而不是重新创建；3) 更彻底的做法（需后端配合）：新增 project.bootstrap 复合动作，在一个写事务里完成项目+卷+章+技法+挂载，同时把番茄专属的种子数据移出 shell（见 FE-15）；4) 对 modal.prompt/confirm 流程统一：dial… |
| FE-10 | P1 | 🟡 中 | 缺陷 | S | 主题色板不完整：系统深色模式下浅色纸面会混入深色语义色，字级 Diff 颜色写死、引用未定义变量 | `src/client/workbench.css:29-47`<br>`src/client/workbench.css:69-94` | 1) 每个主题（ink-paper/bamboo/night）定义完整 token 集（含 success/warning/destructive/diff-add/del/chg、diff-char-ins/del 的前景与背景）；2) 删除 :root:not([data-theme="light"]) 媒体查询分支，auto 模式由 JS 写 data-theme，CSS 只认 data-theme；3) 把 --danger/-… |
| FE-12 | P0 | 🟡 中 | 正确性 | S | 切到『候选原文』模式会把部分勾选悄悄变成整篇采纳 | `src/client/workbench/views/diff-view.ts:340-350`<br>`src/client/workbench/shell.ts:807-841` | 1) 采纳计划只由 adopted 集合决定，与显示模式无关；2) raw 模式顶部显示『当前勾选 x/y 处，采纳将按勾选合稿』，并可一键切回并排；3) 单测：取消勾选→切 raw→getAdoptionPayload 仍为 partial。 |
| FE-13 | P1 | 🟡 中 | 正确性 | S | 部分合稿丢失空行分隔、格式不一致 | `src/client/workbench/diff.ts:106-128`<br>`src/client/workbench/views/diff-view.ts:36-38` | 1) 把空行行并入相邻非空 hunk：只要相邻 hunk 被采纳，就跟随候选稿的空行，否则跟随原稿；2) 记录原稿的换行风格（\r\n 或 \n）并在合并时还原；3) 单测：候选稿只把单换行改成双换行、全选与全不选时，输出分别等于候选稿与原稿。 |
| FE-14 | P2 | 🟡 中 | 性能 | M | 字级 Diff 降级阈值过低：中文长段很容易退化成整段替换；段落级降级按位置配对 | `src/client/workbench/diff.ts:44-61`<br>`src/client/workbench/diff.ts:63-69` | 1) 字级改用 Myers O(ND) 算法（加编辑距离上限 D≤2000，超限再降级），内存 O(N)；2) 先按句末标点（。！？…；和引号闭合）把段落切成句子，做句级 LCS，再对 changed 句做字级 diff，长段落也能精确；3) 段落级先用 patience 锚点（只出现一次的相同段落）切块，块内再做 LCS/Myers，替代按位置配对；4) 超过 2,000 段或 20 万字时放到 requestIdleCallback… |
| FE-15 | P2 | 🟡 中 | 架构 | S | 外壳里残留产品线专属逻辑：『微头条』兜底、示例书导入写死番茄动作 | `src/client/workbench/shell.ts:24`<br>`src/client/workbench/shell.ts:414-470` | 1) ProductLineUiModule 新增 documentTitle(doc: {title, mode}) 钩子，头条返回『微头条』，番茄返回『未命名章节』；外壳/目录/命令面板统一调用；2) 把 importDemoBook 移到 fanqieUiModule，新增可选的 bootstrapDemo(host) / seedPresets 钩子，study-home 按模块列出『导入示例』；3) refactor-v2 增… |
| FE-16 | P2 | 🟡 中 | 可维护性 | S | 受保护阈值在前端重复硬编码（34 / 84 / 2 / 2），存在漂移风险（不改数值） | `src/client/workbench/plugins/toutiao.ts:6`<br>`src/client/workbench/plugins/toutiao.ts:211` | 不改任何数值：1) 新增浏览器安全的纯常量模块 src/contracts/protected-rules.ts（零 import，只导出 as const），domain/toutiao/rules.ts 与 domain/fanqie/editorial.ts 改为从这里取值，客户端 tsconfig 与 manifest 也纳入该模块；或者由快照下发只读的 rules: {titleMax, qaPass, qaRefineLim… |
| FE-17 | P1 | 🟡 中 | 可维护性 | M | 动作 API 没有类型约束：action 是任意字符串，候选稿 QA 以字符串 JSON 下发、在 render 中裸解析 | `src/client/workbench/api.ts:32-37`<br>`src/client/workbench/plugins/types.ts:27-32` | 1) 在 workspace-dto.ts 增加 interface ActionMap { 'draft.save': {input: DraftSaveInput; output: {revisionId: string}}; ... }，request<A extends WorkspaceAction>(action: A, input: ActionMap[A]['input']): Promise<ActionMap[A][… |
| FE-18 | P2 | 🟡 中 | 可维护性 | M | shell.ts 971 行单闭包，职责过多 | `src/client/workbench/shell.ts:61-971` | 按职责拆分为（不引入框架）：shell/state.ts（snapshot/loadState/change/轮询，纯逻辑可单测）、shell/editor.ts（编辑器、DraftVault、IME、定位）、shell/run-panel.ts（start/generate/adopt/discard/cancel/inspector/history/reconcile）、shell/navigation.ts（项目、稿件、目录、侧栏… |
| FE-19 | P3 | 🟡 中 | 体验 | L | 可访问性缺口：标签页、目录树、命令面板、Diff 都缺少语义与键盘操作 | `src/client/workbench.html:16-23`<br>`src/client/workbench.html:193-198` | 1) 按 APG Tabs 模式：role=tab/aria-controls/tabpanel + roving tabindex + 左右/Home/End；2) 目录树按 APG Tree View：role=tree/treeitem、aria-level/aria-expanded、上下键移动、左右键折叠展开、Enter 打开；虚拟列表记住 focusedKey，重绘后恢复焦点；3) 命令面板：input aria-contr… |
| FE-20 | P1 | 🟡 中 | 体验 | S | 忙碌期间的点击被静默丢弃，没有任何反馈 | `src/client/workbench/store.ts:39-46`<br>`src/client/workbench/shell.ts:229-233` | 1) 全局忙碌指示：document.body.dataset.busy + aria-busy，顶栏显示细进度条；2) 导航类动作（selectDocument）改为『最后一次生效』排队：忙碌时记下 pendingDocId，当前动作结束后执行；3) 普通按钮在忙碌时显示 disabled 样式；4) 被丢弃的点击给出轻提示『上一操作进行中』。 |
| FE-21 | P1 | 🟡 中 | 缺陷 | S | 上下文预览与诊断面板没有『以最后一次为准』：刷新被丢弃或乱序，显示过期数据 | `src/client/workbench/views/context-preview.ts:21-52`<br>`src/client/workbench/views/diagnostics-panel.ts:235-274` | 统一用 seq 计数 + AbortController：每次 refresh 先 abort 上一次请求、seq++，回包时校验 seq；loading 期间的新调用标记 dirty，结束后补跑一次。抽成通用工具 createLatestTask() 放进 store.ts 供各视图复用。 |
| FE-22 | P2 | 🟡 中 | 性能 | M | 静态资源全部 no-store，也没有 modulepreload：每次打开 iframe 都要瀑布式下载 26 个模块 | `src/host/plugin.ts:83-92`<br>`src/client/manifest.ts:7-34` | 1) 构建期从 manifest 生成 <link rel="modulepreload"> 列表注入 HTML（或由 plugin.ts 在返回 HTML 时注入），把瀑布压成一轮并行请求；2) 静态资源改为 Cache-Control: no-cache + ETag（基于内容 SHA-256，而不是 mtime，同时规避 npm pack 的 1985 时间戳问题），HTML 中的模块 URL 带 ?v=<hash>；3) 需要 … |
| FE-23 | P2 | 🟡 中 | 架构 | S | 同一工作台可能同时存在两个 iframe 实例（main 与 conversation.view），会产生自我冲突 | `src/client/slot.ts:29-63`<br>`src/client/workbench/draft-vault.ts:22-24` | 1) 先确认 DsH 是否会同时挂载这两个槽位（待作者/宿主确认）；2) 若会：conversation.view 改为轻量『只读预览 + 跳转到主区』，或者通过 BroadcastChannel 让后挂载的实例进入只读模式；3) iframe 增加 title 区分，并按需加 allow="clipboard-write"，同时提供 execCommand('copy') 回退。 |
| FE-29 | P2 | 🟡 中 | 测试 | L | 前端测试覆盖集中在纯函数，关键交互路径与真实布局没有回归保护 | `test/client-v2.test.mjs`<br>`test/client-views-v2.test.mjs` | 1) 在 dev-server 与 browser-check 中增加确定性的 FakeLlmTransport（本地固定文本、可配置延迟/失败/中途中断，不联网、不调用真实模型），覆盖生成→轮询→候选→部分采纳全链路；2) Playwright 新增旅程：选段改写期间切章（必须拒绝）、部分采纳+raw 模式、5000 章目录滚动几何、大纲编辑中刷新不丢字、深浅主题 token 检查；3) 把 FE-18 拆出的 shell/state… |
| FE-33 | P2 | 🟡 中 | 功能缺口 | M | 编辑器看不到段落编号，但知情点、证据、Diff 定位都以『第 N 段』为单位 | `src/client/workbench.html:145-151`<br>`src/client/workbench.html:262` | 保持 textarea（不引入重型编辑器）：1) 页脚实时显示『光标在第 N 段 / 共 M 段』（根据 selectionStart 计算，O(n) 且防抖）；2) 所有 point 输入框旁加『用当前光标段』按钮；3) 定位改用镜像 div 测量（与 textarea 同字体同宽度，计算目标段落的 offsetTop），代替行数比例；4) 可选：左侧段号槽（对镜像 div 做绝对定位），只在宽屏开启。 |
| FE-11 | P3 | ⚪ 低 | 体验 | S | 『跟随宿主』主题不会随系统或宿主切换而更新；外观弹层不能用 Esc 或点击外部关闭 | `src/client/workbench/appearance.ts:93-209`<br>`src/client/workbench.html:28` | 1) mql.addEventListener('change', () => theme==='auto' && sync())；2) 如果 DsH 能通过 postMessage 下发宿主主题，优先采用宿主主题（需与 DsH 侧确认）；3) 弹层支持 Esc/外部点击关闭，打开时聚焦当前选中项，关闭时把焦点还给按钮；4) HTML 初始文案改为『外观』。 |
| FE-24 | P2 | ⚪ 低 | 体验 | S | 模型提供方/模型默认值有 3 处且互不一致，没有持久化 | `src/client/workbench.html:353-354`<br>`src/client/workbench/plugins/fanqie.ts:56-62` | 1) 快照下发 llmDefaults {provider, model, options?}（来自 settings.ts 的配置表单）；2) 前端集中管理 getProviderModel()，表单值存入 localStorage；3) 若 DsH 能列出可用 provider/model，改为下拉框。 |
| FE-25 | P3 | ⚪ 低 | 体验 | M | 提案和设定展示偏『开发者视角』：直接显示原始 JSON、章节 UUID | `src/client/workbench/views/worldbook-view.ts:162`<br>`src/client/workbench/views/worldbook-view.ts:232` | 1) 为每类提案写一个轻量渲染器（设定条目卡片：实体/内容/生效点/知情人；伏笔：标题/状态/埋设章；技法：标题/触发条件/步骤）；原始 JSON 放进可折叠的『详情』；2) 章节 ID 一律经 chapterTitles 映射为『第 N 章·标题』；3) 逐条勾选机制从 fact_sync 推广到 setting/technique 提案（需后端支持 selectedIds）。 |
| FE-26 | P3 | ⚪ 低 | 体验 | S | 部分破坏性操作没有确认；SKILL.md 只能粘贴导入 | `src/client/workbench/views/outline-board.ts:440-446`<br>`src/client/workbench/views/worldbook-view.ts:257-276` | 1) 删除卷、回收伏笔使用 modal.confirm，并显示目标章节名；2) SKILL.md 导入增加 <input type=file accept=.md> 与 webkitdirectory 文件夹选择，读取 SKILL.md + references/**/*.md\|txt 后调用现有 skill.import（保持纯提示词沙箱、≤128 KiB，不做成重型流程）。 |
| FE-27 | P0 | ⚪ 低 | 缺陷 | S | 全局快捷键的细节问题：保存禁用时 Ctrl+S 会打开浏览器『另存为』，且没有处理输入法组字 | `src/client/workbench/shell.ts:715-742` | 1) Ctrl/Cmd+S 始终 preventDefault，不可保存时显示提示原因（已定稿/版本冲突）；2) 处理器首行 if (event.isComposing \|\| event.keyCode===229) return；3) 在命令面板中列出全部快捷键（可发现性）。 |
| FE-28 | P3 | ⚪ 低 | 性能 | S | 渲染路径上的小浪费：每次轮询都重建 Blob URL、写 localStorage、序列化全文签名 | `src/client/workbench/plugins/toutiao.ts:224-230`<br>`src/client/workbench/shell.ts:543-548` | Blob URL 以 exportStatus.hash 为键，变化时才重建；lastActive 只在 active.id 变化时写入；diff 签名改为 candidateId + baseRevisionId + revisionId；预算估算只在 body 或 instruction 变化时重算。 |
| FE-30 | P3 | ⚪ 低 | 文档 | S | 文档与实现不一致：UI 槽位契约和客户端描述已经过时 | `docs/framework/02-contracts-and-extensions.md:201-247`<br>`docs/03-architecture.md:113-123` | 1) 用 plugins/types.ts 作为唯一来源：文档只链接类型文件并附简要说明；2) 补全 03 文档客户端表格（14 个视图模块）；3) refactor-v2 增加静态守卫：文档中出现的 Session 方法名必须存在于 types.ts。 |
| FE-31 | P3 | ⚪ 低 | 体验 | S | 本地存储不可用且有未保存修改时，关闭页面没有拦截 | `src/client/workbench/draft-vault.ts:92-95`<br>`src/client/workbench/shell.ts:711-714` | 1) 仅当 dirty() && vault.isUnavailable() 时注册 beforeunload，调用 preventDefault；2) 草稿记录写入 savedAt，启动时清理 30 天以上且服务器已有更新修订的条目。 |
| FE-32 | P2 | ⚪ 低 | 正确性 | S | 种子技法包分类与技法卡分类表不一致（atmosphere） | `src/client/workbench/seed-packs.ts:75`<br>`src/domain/fanqie/library.ts:4-12` | 1) 要么把 atmosphere 加入分类表（需番茄线确认），要么把种子改为已有分类；2) 后端校验分类（跨视角）；3) 前端分类选项改为由快照或常量模块下发，避免再出现三处不一致。 |
| FE-34 | P3 | ⚪ 低 | 体验 | M | 窄屏与会话侧栏场景：960px 断点按视口宽度判断，不按 iframe 容器宽度 | `src/client/workbench.css:1035-1089`<br>`src/client/workbench.css:207-213` | 1) 在窄宽度下把流程栏改为可切换的抽屉或底部标签，而不是堆叠；2) 两侧栏 position:sticky; top:52px; max-height:calc(100dvh - 52px); overflow:auto，正文独立滚动；3) browser-check 的视口列表增加 480px 宽。 |

### A.2 DsH 插件逻辑（28 条）

| 编号 | 阶段 | 严重度 | 类别 | 工作量 | 问题 | 主要位置 | 建议要点 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DSH-01 | P0 | 🔴 严重 | 缺陷 | M | Agent 7+3 工具定义与真实 DsH ToolRuntime 契约不兼容：缺 output{schema,render}，注册即抛错并会拖垮整个插件启动 | `src/host/tools.ts:3-10`<br>`src/host/tools.ts:230-241` | 1) 新建 src/host/dsh-tools-adapter.ts，把每个工具映射为上游形状：{ name, description, parameters(JSON Schema, additionalProperties:false), output:{ schema, render:(args,value)=>[{type:'text',text:JSON.stringify(value)}] }, execute:async… |
| DSH-02 | P0 | 🟠 高 | 架构 | S | 可选服务 tools/configForms 未声明 inject、也未用 ctx.get()，与 Cordis 依赖语义不符 | `src/host/plugin.ts:39-58`<br>`src/host/plugin.ts:193-195` | 可选服务一律 `const tools = ctx.get('tools')` 判空，或用 `ctx.inject(['tools'], (sub)=>sub.effect(()=>registerTools(sub), 'zhizhang: agent tools'))` 嵌套作用域；同理 settings。为每个服务写一行“必需/可选/来源版本”的契约表（docs/03 宿主章节）。 |
| DSH-03 | P0 | 🟠 高 | 正确性 | S | 思考块（thinking）增量文本可能混入候选正文 | `src/host/writing.ts:189-206`<br>`src/host/writing.ts:231-234` | 维护 blockTypes: Map<number,string>；block-end.type==='thinking' 时 blocks.delete(index)；最终只拼接 blockTypes.get(i)==='text' 或未声明类型但从未被标记 thinking 的块。改正 generation-v2 第一个用例的期望（应为 "第二段落" 或拆两个用例），并新增“thinking delta 不入正文”回归用例。同时在契… |
| DSH-04 | P1 | 🟠 高 | 安全 | M | 插件内无身份：忽略宿主 Peer，actor 写死 'author'，浏览器与 Agent 工具调用不可区分 | `src/host/plugin.ts:168-181`<br>`src/host/plugin.ts:226-403` | 1) 路由注册显式声明 auth:'required'，处理器签名改为 (request, peer)；2) 定义 Actor = {kind:'author', peerId} \| {kind:'agent', toolCallId, agentId}；mutation(action, input, actor) 透传至 commandInput；3) 在 contracts/commands.ts 的 7 个权威命令及 approv… |
| DSH-05 | P1 | 🟠 高 | 安全 | M | “只读”工具未被机制保证只读，且 read_chapter 过度暴露（全部项目列表 + 未采纳候选稿） | `src/host/tools.ts:23-125`<br>`src/application/snapshot-service.ts:8-97` | 新增 host/agent-facade.ts：①只读工具在 withReadTx 中执行（tx.ts 已拒绝读事务内写）；②固定动作白名单 READ_TOOL_ACTIONS = ['tree.get','settings.read','workspace.search','lore.conflicts','chapter.diagnose','controls.get','chapter.read']；③新增精简 DTO chapt… |
| DSH-07 | P2 | 🟠 高 | 性能 | L | 同步 node:sqlite 在 DsH 主事件循环执行重操作，/diag 每次全量 FTS integrity-check | `src/host/settings.ts:104-116`<br>`src/host/plugin.ts:197-224` | ①/diag 默认只返回计数与迁移，`?deep=1` 才做 integrity-check，并缓存结果 10 分钟；②为 /state、/mutate 加耗时埋点，>50ms 记 warn（含 action 名，不含正文）；③导入/导出/FTS 重建/热备迁入 worker_threads（独立 DatabaseSync 连接，WAL 下可并发读），对外返回 202 + jobId；④在 workspace-bench 增加“事件循环… |
| DSH-08 | P0 | 🟠 高 | 正确性 | S | 卸载/重载时排空窗口内丢弃真实用量回执与已完成结果 | `src/host/plugin.ts:254-262`<br>`src/host/plugin.ts:307-333` | 把 closing 拆成 accepting=false（拒绝新请求，返回 503）与 dbOpen=true（排空期间继续写回执/收尾）；仅在 Promise.allSettled 结束或超时后 dbOpen=false 再 recover+close；selection.rewrite 也纳入 inFlight 集合。新增测试：dispose 期间 gate 放行、usage 到达 → 重开后 attempt 为 completed… |
| DSH-10 | P0 | 🟠 高 | 正确性 | M | selection.rewrite 绕过账本：用量不落库、无并发锁、不随卸载中止 | `src/host/plugin.ts:363-390` | 复用提案账本：beginSelectionRewrite() 在 author_ai_proposals 插入 kind='selection_rewrite', status='inflight' 行（或新建 author_micro_calls 表），receive 写入 4 元组用量，完成/失败收尾；按 documentId 加锁；登记到 inFlight 以便 dispose abort+drain；前端运行检查器展示累计微改写… |
| DSH-14 | P2 | 🟠 高 | 架构 | L | 宿主 API 全靠自拟接口与自造 mock，违背 AGENTS.md“不得假设 DsH API” | `src/host/plugin.ts:32-52`<br>`src/host/writing.ts:18-41` | ①集中到 src/host/dsh-adapter.ts：唯一处引用宿主 API，其余 host 代码只依赖本地窄接口；②以 devDependency 方式固定上游类型（或 vendor 对应版本 .d.ts 至 src/host/vendor/dsh-0.2.x.d.ts），tsc 校验适配层；③在隔离 profile 录制一次真实 route/llm/tools 交互样本，存为 support/fixtures/dsh-contr… |
| DSH-06 | P1 | 🟡 中 | 安全 | M | Agent 提案无来源标记、无数量上限，作者无法区分“我提的”与“AI 对话提的” | `src/host/tools.ts:126-226`<br>`src/application/products/fanqie/proposal-decide.ts:61-97` | author_ai_proposals 与 author_settings(pending) 增加 origin TEXT CHECK(origin IN ('author-ui','ai-generate','agent-tool')) 与 origin_ref（toolCallId）；agent-tool 来源每项目 pending ≤ 20，超出返回 gate.denied/proposal-quota；前端收件箱显示“对话提议”… |
| DSH-09 | P2 | 🟡 中 | 架构 | M | 配置链路断裂：无 Cordis Config schema；defaultProvider/defaultModel 从未被使用；configForms 为自拟 API | `src/host/plugin.ts:25-30`<br>`src/host/settings.ts:36-90` | ①导出 `Config`（Schema 对象：dataDirectory 必填、defaultProvider/defaultModel/enableAgentTools 可选带默认）；②新增 GET /api/zhizhang/bootstrap 返回 {defaults:{provider,model}, agentToolsEnabled, version}，前端三处改读它；③用 ctx.get('settings')?.regi… |
| DSH-11 | P2 | 🟡 中 | 正确性 | S | LLM 单次调用只有 180s 总超时，无空闲超时，超时不给恢复建议 | `src/host/writing.ts:164`<br>`src/host/plugin.ts:263-275` | 改为“空闲超时 60s（每收到 chunk 重置）+ 总上限按阶段可配（write 600s / qa 180s / proposal 120s）”；TimeoutError 附加 recoveryKind='timeout'，提示“可关闭深度思考或分段生成后原地重试”。在 Config 暴露 timeouts。 |
| DSH-13 | P1 | 🟡 中 | 可维护性 | S | HTTP 状态码映射过粗，500 日志只记 error.name 无法排障 | `src/host/plugin.ts:94-103`<br>`src/contracts/errors.ts:16-28` | 映射表：auth.denied→403，dependency.unavailable→503(+Retry-After)，storage.format_unsupported→503，budget.exhausted/usage.uncertain/stage.output_invalid→422，gate.denied/version.conflict/idempotency.mismatch→409；500 日志记录 name+me… |
| DSH-15 | P2 | 🟡 中 | 性能 | S | 静态资源全部 no-store，每次打开 iframe 重拉 26 个模块 + 1541 行 CSS | `src/host/plugin.ts:83-92`<br>`src/host/plugin.ts:183-191` | 启动时对每个资产计算 sha256 前 16 位作为强 ETag；响应 `Cache-Control: no-cache` + ETag，处理 If-None-Match→304；workbench.html 中模块 URL 附 `?v=<buildHash>`，或在 manifest 生成 import map。JSON API 维持 no-store。 |
| DSH-16 | P2 | 🟡 中 | 可维护性 | S | deploy:touch 刷新 mtime 对 tgz 安装无效，且测试会改写源码树 mtime | `scripts/deploy.mjs:14-62`<br>`test/sprint4-v2.test.mjs:206-222` | 以内容哈希替代 mtime（见 DSH-15）；若 DsH artifactRevision 确为 mtime 驱动，向上游提 issue 并在文档写明 tgz 安装后的处理步骤；把 touch 从测试中移除，改为纯函数 planTouch() 单测；dist 加载测试改为显式 `npm run test:dist` 专项。 |
| DSH-17 | P2 | 🟡 中 | 安全 | S | Slot iframe 地址依赖 document.baseURI，缺 sandbox，双实例各自轮询 | `src/client/slot.ts:29-36`<br>`src/client/slot.ts:48-63` | 以宿主提供的 API base（client metadata）或 `new URL('/api/zhizhang/workbench', location.origin)` 拼接；iframe 增加 sandbox='allow-scripts allow-same-origin allow-forms allow-modals allow-downloads' 与 referrerpolicy='same-origin'；工作台内用… |
| DSH-18 | P2 | 🟡 中 | 缺陷 | S | 交稿原子写依赖硬链接，exFAT/FAT/部分网络盘必失败；崩溃残留 .tmp 不清理 | `src/host/delivery-io.ts:9-28` | linkSync 失败且 code∈{EPERM,ENOTSUP,EXDEV,EINVAL} 时回退 copyFileSync(pending, path, COPYFILE_EXCL)+fsync；EEXIST 语义保持。启动 resumeExports 前清理 mtime 超过 10 分钟的 `.*.tmp`。新增用例：模拟 linkSync 抛 ENOTSUP。 |
| DSH-19 | P2 | 🟡 中 | 功能缺口 | M | 插件未提供任何备份入口；备份清单不含 exports/ 工程包 | `src/host/plugin.ts（无 backup 引用）`<br>`src/storage/backup.ts` | 新增 action backup.create（VACUUM INTO 热备，写入 dataDirectory/backups/<ISO>/，保留 7 份，复用 pruneBackups）与 backup.list；启动发现待执行迁移时先自动热备；manifest 可选纳入 exports/；前端设置页加“立即备份/打开备份目录”。热备放 worker（见 DSH-07）。 |
| DSH-20 | P1 | 🟡 中 | 可维护性 | S | 工具参数 Schema 松散，错误未转为宿主可识别的带码异常 | `src/host/tools.ts:27-30,57-64,79-84,132-142,162-171,199-209` | 为每个工具写完整 JSON Schema（additionalProperties:false、字符串 1..4000、limit 1..20、point 整数 ≥1、people items:{type:'object',required:['character'],properties:{character:{type:'string'},point:{type:'integer',minimum:1}}}）；适配层把 Contra… |
| DSH-21 | P1 | 🟡 中 | 安全 | S | Agent 工具默认开启，正文会被送入对话所用的任意模型提供方 | `src/host/plugin.ts:193`<br>`src/host/settings.ts:43` | 默认 false；首次开启在工作台弹出说明（会把章节内容发送给对话模型）；按项目粒度开关（author_project_controls.agent_tools_enabled）；已定稿/锁定章节可配置为不对 Agent 可见。 |
| DSH-22 | P1 | 🟡 中 | 正确性 | S | 并发控制：提案锁仅在内存且键基于未解析输入，无全局生成并发上限 | `src/host/plugin.ts:147-149`<br>`src/host/plugin.ts:284-297` | DB 增加部分唯一索引 `CREATE UNIQUE INDEX ux_proposal_inflight ON author_ai_proposals(kind, COALESCE(document_id, project_id, 'global')) WHERE status='inflight'`，锁以 DB 为准、内存 Set 仅做快速拒绝；锁键在解析后计算；引入全局信号量 MAX_CONCURRENT_LLM=3（Config… |
| DSH-23 | P1 | 🟡 中 | 正确性 | S | 启动健壮性：createStore 竞态与启动恢复异常导致整插件不可用 | `src/host/plugin.ts:140-166`<br>`src/storage/store.ts:createStore` | createStore 写入 `workspace.sqlite.tmp-<uuid>` 后 renameSync；recoverStartup 分项 try/catch，失败记日志并在 /diag 与工作台横幅提示，不阻断路由注册；数据库无法打开时仍注册 /workbench 降级页 + /diag 显示 storage.format_unsupported 与恢复指引。 |
| DSH-27 | P3 | 🟡 中 | 测试 | M | 宿主测试缺口 | `test/host-plugin-v2.test.mjs`<br>`test/generation-v2.test.mjs` | 新增 test/host-contract-v2.test.mjs（严格 registrar、Peer 注入、状态码表）、test/host-lifecycle-v2.test.mjs（排空、重载、启动降级）、test/transport-v2.test.mjs（thinking、超时、长度上限）；sprint4 #3 拆出到 test:dist；保持 AGENTS.md 的计数规则同步更新 README/05 文档中的用例数。 |
| DSH-12 | P3 | ⚪ 低 | 可维护性 | S | 超长输出抛裸 Error 且按 UTF-16 计数，100 万字符上限与预算脱节 | `src/host/writing.ts:190-192`<br>`src/workflow/writing-stages.ts:49` | 改为 ContractError('stage.output_invalid',{stage, missing:'length-cap'}) 并 attachRecoveryKind('output_truncated')；上限取 min(MAX_CANDIDATE_LENGTH, maxTokens*4) 字符；用 [...text].length 或累计 code point。 |
| DSH-24 | P3 | ⚪ 低 | 安全 | S | 请求处理细节：读体无超时、closing 检查滞后、CSP 未显式收紧 | `src/host/plugin.ts:63`<br>`src/host/plugin.ts:105-128` | 先判 closing 再读体；读体加 AbortSignal.timeout(10_000)；json() 统一加 nosniff；CSP 改为 "default-src 'self'; script-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self' data: blob:; form-action 'none'; frame-ancestors 'self… |
| DSH-25 | P3 | ⚪ 低 | 可维护性 | S | 包元数据：未声明宿主兼容区间、未导出 name、files 打入全部 docs | `package.json:1-59`<br>`src/host/plugin.ts:58` | peerDependencies 声明 DsH/cordis 支持区间；`export const name = 'zhizhang-workbench'`；files 仅保留 docs/01-overview.md 与 README；构建时由 package.json 生成 src/host/version.ts，diag 读取之。 |
| DSH-26 | P3 | ⚪ 低 | 体验 | S | 提案 JSON 解析过于宽松/脆弱，失败时作者看不到原始输出 | `src/host/plugin.ts:320-334` | 提取首个平衡的 {...} 片段再 JSON.parse；失败时把 raw 前 2000 字存入 proposal.error_detail，收件箱提供“查看原始输出/手动修正后入队”。 |
| DSH-28 | P3 | ⚪ 低 | 文档 | S | 文档与代码漂移 | `docs/03-architecture.md（宿主章节）`<br>`docs/05-development-and-ops.md（安装章节）` | 修正上述条目；在 docs/03 增加“宿主契约表”（服务名/必需性/验证版本/验证日期/证据位置）；文档守卫测试增加版本号一致性断言。 |

### A.3 后端数据库逻辑（27 条）

| 编号 | 阶段 | 严重度 | 类别 | 工作量 | 问题 | 主要位置 | 建议要点 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DB-01 | P0 | 🟠 高 | 正确性 | M | 令牌用量口径冲突：cache_read 被重复计入已结算用量与预算 | `src/workflow/budget.ts:96-98`<br>`src/workflow/writing-budget.ts:81-96,122` | 1) 在 host 边界把 LlmUsage 统一规范为互斥的四类：input 只含未命中输入，cache_read 为命中输入，另加 cache_write 和 output；在 contracts 中写明语义并补单测；2) 集中实现 normalizeUsage(raw, {inputIncludesCache})，该参数默认值以 DsH 实测为准；3) computeRunBilling 和 run-inspector 去掉 `c… |
| DB-02 | P0 | 🟠 高 | 性能 | M | command_journal 写放大：非幂等命令也把完整请求体（含整章正文）写入日志，而修剪函数从未被调用 | `src/application/context.ts:178-193`<br>`src/storage/command.ts:200-255,269-306,550-553` | 1) executeCommand 遇到 idempotent=false 时只写审计元数据（command_id、document_id、request_hash、created_at、结果小摘要），或干脆不写；2) 可重放命令的 request_payload 去掉大字段（body、mergedBody、sourceText），只保存它们的 sha256，重放时比对哈希；3) 宿主启动时以及每 24 小时调用一次 pruneComm… |
| DB-03 | P1 | 🟠 高 | 性能 | L | 读模型冷启动：每个缓存键都独立回放整个项目日志，导航 reducer 为 O(N²)，读请求还会触发写检查点 | `src/workflow/author-reads.ts:51-175,339-429`<br>`src/workflow/readserve.ts:108-171` | 1) 每个项目只建一个 ProjectionStore，已用到的 unit 一次注册，共用一遍折叠（与 B.7 的共享水位设计一致）；新 unit 先从自己的检查点恢复，否则单独补折叠；2) navigation reducer 内部改用 Map 加有序 id 数组做增量更新，到 view 时再物化；3) 检查点按事件数（每 200 条）或空闲时间（5 秒）节流后批量写入；4) author_read_checkpoints 增加 la… |
| DB-04 | P1 | 🟠 高 | 正确性 | M | 备份链路未接入生产；离线备份可能丢失 WAL 内容；哈希计算和清单写入不安全 | `src/storage/backup.ts:56-59,92-132,135-187,220-244,284-300`<br>`src/host/plugin.ts（未调用任何备份 API）` | 1) 改用 node:sqlite 的 backup(sourceDb, path) 做在线分页备份，或用 VACUUM INTO；createBackup 发现 -wal 存在时，先执行 wal_checkpoint(TRUNCATE)，做不到就拒绝备份；2) 哈希改为流式计算；3) manifest 先写 .tmp 文件，再 rename 成正式文件；4) listBackups 缓存校验结果；5) 宿主在三个时机自动备份：迁移前、… |
| DB-05 | P1 | 🟠 高 | 性能 | M | FTS 检索先对所有命中行计算 snippet 并 JOIN，再排序截断；项目过滤发生在 MATCH 之后 | `src/storage/fts.ts:497-550,552-597,599-665,747-802` | 1) 改成两段式查询：内层只选 rowid，按 rank 排序后 LIMIT（rank 通过 'rank' 配置项设为 bm25(6,3,1)），外层只对前 K 条做 JOIN 和 snippet；2) 项目过滤：在外部内容视图里加一个 project_id UNINDEXED 列，或者内层多取 4 倍再在外层过滤；3) 基准：5000 章中命中 1000 章时，搜索 < 50ms。 |
| DB-06 | P2 | 🟠 高 | 性能 | M | 1–2 个字的中文查询退化为全表 LIKE 扫描，相关章召回直接丢弃短词 | `src/storage/fts.ts:681-689,523-542,572-589,756-765` | 1) 2 字以内的查询先查 author_chapter_entities（实体倒排表）和标题、摘要；正文 LIKE 只作兜底，并加 LIMIT；2) 可选方案（P2，需要先做基准）：建一张影子 FTS5 表，用 unicode61 分词，存入预先切好的重叠二元组，让 2 字查询也能走索引；3) 相关章召回中，2 字实体改用 entities 表打分。 |
| DB-07 | P0 | 🟡 中 | 正确性 | S | PRAGMA 与连接配置不完整：busy_timeout 设得比切换 WAL 晚，缺少 journal_size_limit 和 optimize，Windows 上 mmap 设为 256MB | `src/storage/stmt-pool.ts:27-36`<br>`src/storage/driver.ts:36-38` | 1) openDatabase 统一传入 {timeout:5000, enableForeignKeyConstraints:true, defensive:true}；2) 先设 busy_timeout，再切换 WAL，并设置 journal_size_limit=64MB；3) 关闭连接前执行 PRAGMA optimize，导入后执行 ANALYZE，正常卸载时执行 wal_checkpoint(TRUNCATE)；4) Wi… |
| DB-08 | P0 | 🟡 中 | 性能 | S | 预编译语句缓存没有上限，而且连动态拼接的 SQL 也被缓存 | `src/storage/stmt-pool.ts:3-21`<br>`src/application/products/fanqie/context.ts:174-179` | 1) 改为 LRU 缓存，上限 256 条，淘汰时调用 close()；也可以直接用 node:sqlite 的 createTagStore(maxSize)；2) 可变长度的 IN 统一写成 `IN (SELECT value FROM json_each(?))`；3) 可选筛选条件写成固定 SQL：`(? IS NULL OR col = ?)`。 |
| DB-09 | P2 | 🟡 中 | 架构 | L | Schema 归属分散：平台层的 author-schema 里包含两条产品线的表，产品模块重复执行 DDL，部分 DDL 绕过了迁移体系 | `src/storage/author-schema.ts:59-265,453-514`<br>`src/application/products/fanqie.ts（initSchema）` | 1) 迁移按命名空间拆分为 platform:*、fanqie:*、toutiao:* 三组，由 ProductLineModule.migrations 提供各自迁移，统一由 runMigrations 执行；2) 所有 DDL 都通过迁移创建；3) 将 meta.schema 更新为 'zhizhang/2.2'，同时设置 user_version，并在备份清单中记录已应用的迁移；4) 增加静态守卫：storage/ 目录中不允许出… |
| DB-10 | P2 | 🟡 中 | 正确性 | L | 外键与约束覆盖不全：ALTER 新增的列没有外键，没有 STRICT/CHECK，JSON 列不校验，时间戳类型不统一 | `src/storage/author-schema.ts:126-131,183-195,248-264,269-273`<br>`src/storage/export.ts:49-59` | 1) 在 2.3 迁移中按 SQLite 官方的十二步改表法重建相关表：补齐外键，状态列加 CHECK（取值与 TS 常量同源），JSON 列加 json_valid 校验，新表采用 STRICT；2) event_log 新增 created_at 列，不修改 payload，因此不影响 B.7；3) /diag 中执行 foreign_key_check 和 quick_check。 |
| DB-11 | P2 | 🟡 中 | 性能 | M | 章序用整本书的 JSON 数组存储（author_chapter_order），每次移动都要整体重写和解析 | `src/storage/author-schema.ts:132-135`<br>`src/application/context.ts:248-256` | 在 author_documents 增加 sort_key 列（分数索引）并建 (project_id, volume_id, act_id, sort_key) 索引，迁移时从现有 JSON 回填；移动一章只更新一行；两步重排协议的语义保持不变。 |
| DB-12 | P1 | 🟡 中 | 性能 | S | 热点查询缺少索引 | `src/storage/command.ts:68-83`<br>`src/storage/author-generation.ts:45,126-130` | 新增以下索引（多为部分索引）：revisions(document_id, created_at)、candidates(document_id)、attempts(state) WHERE 状态为未完成、proposals(status) WHERE status='inflight'、proposals(document_id)、runs(document_id, state)、settings(project_id, fact_i… |
| DB-13 | P1 | 🟡 中 | 正确性 | M | AI 提案账本没有数据库级互斥，也没有『用量不确定』这一语义 | `src/application/proposal-service.ts:50-123,176-184`<br>`src/host/plugin.ts:284-297` | 1) 建部分唯一索引：同一 kind 和作用域在 status='inflight' 时只能有一条，冲突时返回 gate.denied；2) 提案复用 generation 的调用级账本，中断时标为 uncertain，可走 reconcile；3) 开始生成时写一条 proposal.started 事件。 |
| DB-14 | P0 | 🟡 中 | 正确性 | S | 生成回执可能被静默丢弃；同一份用量存了两处 | `src/application/run-service.ts:390-394`<br>`src/storage/author-generation.ts:96-112,121-124` | 迟到回执写入 late_usage 列或一条事件，供 reconcile 页面展示；attempt 的用量改为从 calls 求和得出，或在 /diag 中做一致性比对。 |
| DB-15 | P1 | 🟡 中 | 性能 | M | snapshot/readState 每次都返回很重的全量快照，ifSequence 只覆盖当前项目 | `src/application/snapshot-service.ts:8-109` | 拆成轻量快照（带 ETag）和按需获取的重型内容（按 revisionId 缓存）；ifSequence 改为全局 seq 加项目 seq 的组合；章序结果按 seq 缓存。 |
| DB-16 | P1 | 🟡 中 | 性能 | S | rebuildProjectFts 实际上会重建全库，而且在导入后的写事务里同步执行 | `src/storage/fts.ts:412-470`<br>`src/application/products/fanqie/io.ts:828` | 改为只按本项目的映射行删除后重新插入；全库重建单独命名为 rebuildAllFts，只用于维护；导入完成后执行一次 'optimize'。 |
| DB-18 | P3 | 🟡 中 | 性能 | M | 保存正文的整体写放大：修订永久保留，记忆同步还另存一份正文 | `src/application/context.ts:210-246`<br>`src/storage/command.ts:347-365` | 1) memory_sync 改为只记录 synced_revision_id，删除 synced_body；2) 修订保留策略需作者决定：定稿、被采纳候选的基准版本、交稿版本和每日最后一版永久保留，更早的自动保存版本合并为每日快照，作为需作者确认的维护命令；3) /diag 中显示各表体积。 |
| DB-19 | P3 | 🟡 中 | 正确性 | M | 事件日志无限增长，且只要有一条历史事件缺少 concern，整个项目的读模型都会失效 | `src/storage/eventlog.ts:69-127`<br>`src/workflow/readserve.ts:78-97,137-144` | 1) 写一个迁移，按 kind 推断并回填缺失的 concern，无法推断的事件放入隔离表；2) 启动时只读自检，结果在 /diag 中报告；3) 日志归档涉及 B.7，列为需作者授权的 P3 选项。 |
| DB-20 | P2 | 🟡 中 | 缺陷 | S | 本地导出没有处理 Windows 保留文件名，目录替换缺少重试 | `src/storage/local-io.ts:26-34,135-192` | 1) 保留名加后缀，并附加短哈希避免同名冲突；2) rename 遇到 EPERM/EBUSY 时退避重试 3 次，仍失败则返回 dependency.unavailable；3) 增加 Windows 专项单测。 |
| DB-21 | P0 | 🟡 中 | 文档 | S | docs/04 与代码实现不一致 | `docs/04-data-and-workflow.md`<br>`src/workflow/writing-budget.ts:41-67` | 新增 scripts/schema-doc.mjs，从 sqlite_master 自动生成 schema 文档；docs/04 只保留设计意图，并加一项守卫测试检查生成文档与实际 schema 是否一致。 |
| DB-24 | P1 | 🟡 中 | 测试 | M | 缺少规模化测试和故障注入测试 | `test/workspace-v2.test.mjs:286-308,392-422`<br>`test/sprint1-v2.test.mjs` | 1) 新增 scripts/db-bench.mjs：构造 5000 章 × 2500 字、5 万条事件，输出 JSON 并设门限；2) 新增 query-plan 测试；3) 新增 usage-ledger 测试；4) 用 child_process 起一个持有写锁的进程，测试 BUSY 场景。 |
| DB-17 | P1 | ⚪ 低 | 性能 | S | 拆书和技法的 FTS 触发器在任意列更新时都会整条重建索引 | `src/storage/fts.ts:180-199,213-232` | 改为 UPDATE OF 文本列加 status；补充测试：只改 updated_at 时，fts_library 不应发生变化。 |
| DB-22 | P2 | ⚪ 低 | 可维护性 | S | 死代码和仅供测试使用的 API 混在 storage 的公共出口中 | `src/storage/projection.ts:58-67,222-256`<br>`src/storage/index.ts` | 示例命令和 rowCount 移到 support/ 目录；修剪、热备、FTS 校验接入宿主的维护任务和 /diag；projection_rows 要么作为 DB-03 中共享 Store 的检查点表启用，要么删除。 |
| DB-23 | P1 | ⚪ 低 | 可维护性 | S | 错误码到 HTTP 状态码的映射太粗 | `docs/02-domain-rules.md（错误码表）`<br>`src/host/plugin.ts（handleRouteError）` | auth.denied 映射为 403，storage.format_unsupported 为 500，dependency.unavailable 为 503；错误码集合和信封格式不变（B.1）；需与 DsH、前端两个视角一起修改。 |
| DB-25 | P2 | ⚪ 低 | 正确性 | S | 读模型内存缓存与恢复的边界情况 | `src/workflow/author-reads.ts:344-429` | 缓存键中加入数据库标识（在 meta 里存一个 uuid）；大视图改为返回冻结对象，避免每次 clone。 |
| DB-26 | P3 | ⚪ 低 | 功能缺口 | M | 缺少项目级和月度累计预算账本 | `src/workflow/budget.ts:122-191`<br>`src/application/proposal-service.ts:56` | 需作者决策：新增按项目和日期汇总的账本视图，默认只做软提醒，硬上限沿用 budget.exhausted。 |
| DB-27 | P2 | ⚪ 低 | 可维护性 | S | 事务封装没有和驱动层的实际事务状态做交叉校验 | `src/storage/tx.ts:10-100` | 进入事务前断言 `!db.isTransaction \|\| txStates.has(db)`，否则拒绝并报 foreign-transaction。 |

### A.4 番茄小说工作线（34 条）

| 编号 | 阶段 | 严重度 | 类别 | 工作量 | 问题 | 主要位置 | 建议要点 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| FQ-01 | P0 | 🔴 严重 | 正确性 | M | 记忆同步/设定提案会覆盖已有事实的 knownFrom 知情史 | `src/application/products/fanqie/fact-sync.ts:101-150`<br>`src/application/products/fanqie/fact-sync.ts:248-270` | 1) 新增纯函数 domain/fanqie/lore.ts `mergeFactVersion(prev, incoming, order)`：knownFrom 逐角色取更早锚点（precedes 比较），effectiveFrom 默认继承 prev（仅当作者显式勾选『设定变更自本章起生效』才改为本章）；2) commitFactBatch / knownFromUpdates 统一走 mergeFactVersion；3) 提案… |
| FQ-02 | P0 | 🟠 高 | 正确性 | M | 『段落 point』在证据、增量同步、诊断、UI 四处语义不一致 | `src/application/products/fanqie.ts:115`<br>`src/application/products/fanqie/fact-sync.ts:81` | 1) 在 domain/shared/anchors.ts 新增唯一真源 `splitChapterParagraphs(body)`（非空行=段）与 `pointAtOffset(body, offset)`；2) recordEvidence、bindExactEvidence、diagnostics、computeParagraphDelta、resolveAnchor 全部改用它；3) fact_sync 无论有无基线都以 `[… |
| FQ-03 | P0 | 🟠 高 | 正确性 | M | AI 提案不绑定基准修订：正文漂移后确认会写错证据并把未同步改动标为 clean | `src/application/proposal-service.ts:58-120`<br>`src/application/products/fanqie/proposal-decide.ts:135-258` | 1) author_ai_proposals 增加 base_revision_id、source_sha256 列（迁移）；2) beginProposalGeneration 写入；3) decideProposal 对 fact_sync/chapter_review/summary 校验当前 revisionId，漂移时 refuse('proposal.decide','proposal-stale')，UI 提供『按当前正文… |
| FQ-04 | P1 | 🟠 高 | 性能 | M | Prefix 稳定区并不稳定：自动推荐卡片与按动态尾长度裁剪混入 Prefix | `src/application/products/fanqie/library-mount.ts:184-221`<br>`src/application/products/fanqie/context.ts:200-203,312-344` | 1) Prefix 只放显式挂载（pin/include）且按稳定 id 排序；推荐卡移入 dynamic 槽『本章推荐技法（未挂载，仅参考）』或只在 context-preview 中展示；2) context-slots 把预算拆成 prefixBudget=f(tokenLimit)（与动态内容无关）和 dynamicBudget；第二阶段只裁剪 dynamic 组；prefix 超额时报告 overBudget，不静默截断；3)… |
| FQ-05 | P1 | 🟠 高 | 架构 | S | 未经挂载的技法卡被自动注入写作上下文，偏离作者主权 | `src/domain/fanqie/library.ts:205-237`<br>`src/application/products/fanqie/library-crud.ts:205` | 移除 resolveMountedLibraryForChapter 中的 recommended 自动注入；保留 context-preview 的推荐列表和『一键挂载到本章』。如作者希望保留，再加项目开关 controls.autoRecommend（默认关），开启时只注入 dynamic 槽。 |
| FQ-06 | P0 | 🟠 高 | 安全 | S | 库条目与伏笔可被跨项目/跨作用域按 id 覆写；AI 提案 payload 可携带 id 与 projectId | `src/application/products/fanqie/library-crud.ts:148-171,210-236`<br>`src/application/products/fanqie/lore.ts:387-420` | 1) 写库前若 id 已存在，要求 existing.scope/project_id 与本次一致，否则 invalid('id','scope-mismatch')；2) AI 来源 payload 白名单字段（删除 id/scope/projectId/priority/status）；3) decideProposal 的 projectId 固定为 row.projectId；4) upsertForeshadow 在 ON C… |
| FQ-07 | P0 | 🟠 高 | 正确性 | S | setting 提案缺 documentId 时回落到第一章生效，导致早期章节人物『提前知情』 | `src/application/products/fanqie/proposal-decide.ts:206-229` | 没有 documentId 时拒绝（invalid('documentId','chapter-required')），或要求作者在确认 UI 中选择生效章；测试覆盖。 |
| FQ-08 | P0 | 🟠 高 | 缺陷 | S | 『标记已在当前章回收』会清空伏笔预定回收章与埋设段；伏笔状态无转换约束 | `src/client/workbench/views/worldbook-view.ts:257-273`<br>`src/application/products/fanqie/lore.ts:387-420` | 1) 拆成 foreshadow.create 与 foreshadow.patch（只更新传入字段）；2) domain/fanqie/lore.ts 新增 FORESHADOW_TRANSITIONS（proposed→planted→hinted→resolved，任意→abandoned，resolved/abandoned→planted 需 reopen:true），upsert 前校验；3) fact_sync 的 for… |
| FQ-09 | P1 | 🟠 高 | 正确性 | M | 平铺章序与卷/幕树是两套真源，上移/下移、挂树、拖动会互相覆盖并绕过影响门 | `src/client/workbench/plugins/fanqie.ts:275-305`<br>`src/application/products/fanqie/lore.ts:167-185` | 1) 规定唯一真源：树（卷 sort/幕 sort/组内 rank），平铺序始终由 flattenNovelOrder 派生；2) reorder.commit 拒绝跨组移动（或同时更新归属），上移/下移改用 chapter.move{beforeChapterId}；3) attachChapterToTree 走 applyHierarchyOrderChecked，并在顺序变化时发 chapter.reordered；4) 测试：… |
| FQ-10 | P0 | 🟠 高 | 正确性 | M | fact_sync 新事实的 factId 由模型自取，与已有事实同名时会静默变成新版本 | `src/workflow/writing-budget.ts:22-23`<br>`src/application/products/fanqie/fact-sync.ts:116-136` | 1) 提示词改为 newFacts（不带 id，由服务端生成 `fq-<短 uuid>`）与 updates（必须引用 existingLoreHints 中的 factId）两类；2) decide 时 updates 的 factId 必须已存在，newFacts 的 id 必须不存在；3) UI 分区展示『新增』与『更新（含 diff）』。 |
| FQ-11 | P1 | 🟡 中 | 缺陷 | S | 工程包超过 999 章后排序错乱；导入忽略 manifest 中的章序 | `src/application/products/fanqie/io.ts:28-30,83`<br>`src/application/products/fanqie/io.ts:388-395,492-501` | 宽度改为 max(4, String(total).length)；导入时有 manifest 就按 manifest.chapters 顺序，没有才按自然排序（数字前缀按 parseInt 比较）；加 1200 章往返测试。 |
| FQ-12 | P3 | 🟡 中 | 功能缺口 | L | Markdown 工程包号称无损，实际丢失设定版本史、Skill 元数据与写作控制面 | `src/application/products/fanqie/io.ts:40-161`<br>`src/application/products/fanqie/io.ts:503-553,715-766` | 引入 format v2：导出 author_settings 中 approved 的全部版本（按 decided_seq）、controls、slop、chapter state（导入时 final 只作为提示，不自动锁定）、evidence（按 quote 重定位）；导入保留 assetKind/stageBindings/references 并校验 pacing/category；v1 包继续兼容读取；补齐往返等价测试（导出→… |
| FQ-13 | P2 | 🟡 中 | 功能缺口 | M | 番茄写作只有一个通用 WRITER_SYSTEM，缺少任务模式与番茄方法论 | `src/workflow/writing-budget.ts:4-5`<br>`src/application/products/fanqie/context.ts:471-499` | 保持轻量：新增 3 段模板常量（FANQIE_SYSTEM_CONTINUE / REWRITE / TARGETED），由 stage 和是否有 observationIds 选择；在 dynamic 槽加入『本书节奏档说明』（来自 PACING）与『禁用套话 Top10』（scanAiSlop 默认库+项目自定义）；定向修稿要求逐段保留未提及段落，并在 diff 视图默认只勾选变化段。这些都是纯提示词，不新增流程引擎。 |
| FQ-14 | P2 | 🟡 中 | 功能缺口 | M | 节奏档/题材在 UI 与项目层完全缺失，相关逻辑实际不生效 | `src/domain/fanqie/editorial.ts:10-14`<br>`src/client/workbench.html` | author_project_controls 增加 pacing_tier（快爽/稳推/慢燃）与 genre_tags；新书向导第 1 步选择；context 构建、推荐、诊断都从 controls 读取；诊断的钩子与冲突关键词按节奏档切换词表（悬疑用『异常/尸/失踪/门锁』之类，言情用『婚/离/误会/重逢』之类）。节奏档本身是已有的软建议词表，只是接通，不改语义。 |
| FQ-15 | P2 | 🟡 中 | 正确性 | S | 黄金三章离线诊断的几处计分缺陷 | `src/domain/fanqie/diagnostics.ts:198-346`<br>`src/application/products/fanqie/diagnostics.ts:81-96` | 字数维度改为以章纲 target 为中心 ±25%（无 target 时回退 2000–2500 建议带，1500–6000 只作提醒）；单字关键词改为词边界的双字词表并支持项目自定义；补全引号；长段只按更严重的一项扣分；非黄金三章只输出节奏与字数两项。全部保持零 Token 纯函数并补表驱动测试。 |
| FQ-16 | P2 | 🟡 中 | 正确性 | S | AI 味扫描：短语重叠重复计数，中性词误报 | `src/domain/fanqie/diagnostics.ts:23-196` | 1) 先按长度降序做非重叠最长匹配（标记已占用区间）；2) 给类别加权（summary_connector 0.5、cliche 1.0、custom 1.0），提供『排除对白』选项；3) 新增零 Token 指标 sentenceLengthCV（句长变异系数）和连续同长度句计数，作为『节奏单调』提示；4) 阈值按加权密度重新标定，并用 3 份人工样章做基线测试。 |
| FQ-17 | P2 | 🟡 中 | 正确性 | S | 审稿 Observation 的摘句不校验，修订后不会失效；UI 只能整包确认 | `src/application/products/fanqie/diagnostics.ts:98-141`<br>`src/application/products/fanqie/proposal-decide.ts:232-245` | 确认时对 quote 做精确唯一匹配（复用 recordEvidence 逻辑），匹配不到的标 verified=false 并在 UI 灰显；observation 记录 revision_id，渲染时如果 quote 已不在当前正文则显示『已过期』且不默认勾选；审稿提案 UI 逐条勾选后再提交。 |
| FQ-18 | P2 | 🟡 中 | 性能 | M | 5000 章规模下上下文构建与连续性检查的复杂度 | `src/application/products/fanqie/context.ts:206-250`<br>`src/domain/fanqie/related-chapters.ts:115-169` | 1) 先构建一次 Map：chapterId→相关事实，position Map 替代 indexOf；2) lockedFacts 先按 [A-Za-z0-9_-]+ 切词再查 Set，代替逐个 new RegExp；3) refreshEntityMentionsForFact 先用 fts_chapters trigram 查出候选章，只扫描命中的章；4) chapterOrder 与 approvedFacts 一样按 curr… |
| FQ-19 | P2 | 🟡 中 | 正确性 | S | 实体提及按纯子串计数且不支持别名 | `src/application/products/fanqie/memory-sync.ts:16-27,166-187` | lore 条目增加 aliases（字符串数组，存在 value JSON 中，无需新表）；计数时把所有名字和别名合并，按长度降序做非重叠最长匹配；UI 在设定编辑中提供别名输入。 |
| FQ-20 | P2 | 🟡 中 | 功能缺口 | S | 设定无法通过记忆同步失效或撤回 | `src/workflow/writing-budget.ts:22-23`<br>`src/workflow/writing-stages.ts:117-165` | schema 增加 retiredFacts: [{factId, point, reason}]，确认后生成带 effectiveTo=本章@point 的新版本（复用 mergeFactVersion）；validator 与 UI 同步更新。 |
| FQ-21 | P2 | 🟡 中 | 功能缺口 | M | 伏笔生命周期建模不足：无预定回收章入口，超期判断参照全书总章数 | `src/client/workbench/views/worldbook-view.ts:92-110`<br>`src/domain/fanqie/lore.ts:163-190` | UI 增加预定回收章与预计回收区间；stale 改为相对『当前章』与『最后有正文的章』计算，阈值进项目 controls；context 增加高优先级行『本章预定回收：X（埋于第 N 章）』；hinted 时追加 hinted_chapter_ids（JSON 列）。 |
| FQ-22 | P1 | 🟡 中 | 正确性 | S | 章序影响分析不包含伏笔与章纲锁定事实 | `src/application/products/fanqie/shared.ts:42-54`<br>`src/application/products/fanqie/lore.ts:73-78` | reorderRelations 增加伏笔关系（planted→resolved/target，标签『伏笔「标题」回收』）；章纲 lockedFacts 引用的事实，如果在新顺序下未生效，作为 warning 一并展示；补测试。 |
| FQ-23 | P2 | 🟡 中 | 缺陷 | S | 滚动幕规划的上下文与提交逻辑问题 | `src/application/products/fanqie.ts:393-435`<br>`src/workflow/writing-budget.ts:28-29` | 改用 chapterOrder 取当前幕或目标幕之前的 12 章；system 中写明 JSON 字段（actSummary/nextActTitle/nextActGoal/nextActSummary/pacingTemplate/currentFocus）；删除 chapterBeats 或落地为章纲草案提案；新幕插入到目标幕之后；UI 接受前允许编辑。 |
| FQ-24 | P1 | 🟡 中 | 正确性 | S | 审稿与选段改写的知情查询固定在章首（point=1） | `src/application/products/fanqie.ts:369,464`<br>`src/application/products/fanqie/context.ts:137-143` | 审稿使用章末锚点（段数+1）并在 extra 中给出『本章内新知情』列表；选段改写用选区所在段号（pointAtOffset(selectionStart)）。 |
| FQ-25 | P3 | 🟡 中 | 可维护性 | S | 番茄章节状态机没有显式的转换表 ⚠️需作者授权 | `src/domain/fanqie/editorial.ts:4-23`<br>`src/application/products/fanqie.ts:160-198,308-313` | 只做编码，不改语义：在 domain/fanqie/editorial.ts 新增 CHAPTER_TRANSITIONS（逐条照抄 docs/02 的状态图）与 assertChapterTransition；各处改为调用它；io 导入复用 onDraftSaved；加表驱动测试。转换表需要作者逐条确认后冻结。 |
| FQ-26 | P3 | 🟡 中 | 功能缺口 | M | 缺少『AI 参与度/创作过程』存证，作者面对平台审核难以自证 | `src/application/run-service.ts:176-208`<br>`src/storage/command.ts` | 零 Token 计算每章指标：首次出现于采纳候选稿的字符占比、采纳后作者再编辑的字符量、手写保存次数、章纲/设定是否由作者确认；在章节头部和导出包中输出《创作过程报告》（只做统计，不做判定）。数据全部来自现有表，不新增流程。 |
| FQ-28 | P2 | 🟡 中 | 功能缺口 | S | SKILL.md 导入的兼容性与注入方式 | `src/application/products/fanqie/skill-importer.ts:33-43,282-305`<br>`src/application/products/fanqie/context.ts:27-46` | 保持轻量：1) 支持 \| 和 > 块标量；2) 未知 pacing/category 降级为警告并置空；3) 注入时只放 description 加正文前 N 字（N 由作者在卡片上设置，默认 1500），全文留在预览里；4) 导入 UI 用文件夹选择器复用 io-view 的 webkitdirectory 读取 SKILL.md 与 references/。 |
| FQ-29 | P2 | 🟡 中 | 性能 | M | CJK token 估算比 DeepSeek 实际高约 2.3 倍，导致上下文被过度裁剪 | `src/workflow/writing-budget.ts:41-59`<br>`src/application/products/fanqie/context.ts:146-149` | 保留保守估算作为冷启动默认值，在 recordGenerationReceipt 时按 provider/model 记录『实际 input ÷ 估算』的指数移动平均（例如存入 author_project_controls 或新的 kv 表），之后乘以校准系数（下限 0.35，并留 15% 安全余量）。需要和 DsH/数据库视角配合。 |
| FQ-27 | P3 | ⚪ 低 | 功能缺口 | S | 没有日更与字数里程碑追踪 | `src/application/products/fanqie/tree.ts:151-199`<br>`src/client/workbench/views/outline-board.ts:108-113` | 用 revisions.created_at 加正文字数增量做零 Token 的日产出统计（今日/近 7 日），项目 controls 中设置日目标；里程碑做成可配置提醒，不硬编码平台条款（遵守 01-overview『不固化易变的平台条款』）。 |
| FQ-30 | P3 | ⚪ 低 | 体验 | M | 番茄 UI 的若干可用性问题 | `src/client/workbench/views/outline-board.ts:297`<br>`src/client/workbench/views/worldbook-view.ts:162,232` | 统一 stateLabels 与章节标题映射；提案改为结构化卡片加逐项勾选和编辑；EDITORIAL_REJECTION_LIMIT 从 snapshot 下发；provider/model 读取 settings；大纲板展开项内嵌四段式章纲编辑。 |
| FQ-31 | P3 | ⚪ 低 | 体验 | S | 三步开新书不是原子操作，题材种子包也偏少 | `src/client/workbench/views/new-book-wizard.ts:52-127`<br>`src/client/workbench/seed-packs.ts:27-142` | 新增服务端动作 project.bootstrap，一个事务完成全部创建；种子包新增 2 到 3 套（技法内容仍是纯数据，作者可编辑）。 |
| FQ-32 | P3 | ⚪ 低 | 测试 | M | 番茄相关测试集中在少数按 Sprint 命名的大用例中 | `test/sprint1-v2.test.mjs`<br>`test/sprint2-v2.test.mjs` | 按行为拆分为 test/fanqie-{memory,anchors,library,io,context,tree}-v2.test.mjs；每个 P0/P1 修复都配一个最小复现用例；新增性质测试（Prefix 字节稳定、导出导入往返等价、point 一致性）。注意 AGENTS.md 要求报告的用例总数与实际一致。 |
| FQ-33 | P3 | ⚪ 低 | 文档 | S | 文档与注释漂移 | `src/domain/fanqie/index.ts:1-6`<br>`src/application/products/fanqie/io.ts:829-831` | 修复完成后同步 README、docs/02、docs/04 与计划文档的状态列，删除死代码，更新头注释。 |
| FQ-34 | P1 | ⚪ 低 | 正确性 | S | 全局库变更不产生项目事件，导致其他项目快照不刷新 | `src/application/products/fanqie/library-crud.ts:178,247,298,345` | 全局变更时对挂载了该条目的所有项目写 library.global.changed 事件（查 author_library_mounts 去重 project_id）；或在 snapshot 中增加 library 版本水位。 |
