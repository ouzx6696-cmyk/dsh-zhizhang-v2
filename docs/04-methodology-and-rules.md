# 04 · 内置创作方法论与受保护领域规则（Zhizhang 3.0）

本文档系统化归档织章 3.0 内置的**受保护业务不变式**、**番茄长篇四位一体创作方法论**、**头条场景与标题方法论**，以及向作者开放的**可调上下文参数边界**。

---

## 1. 作者受保护核心常量（不可擅自更改）

唯一权威定义点：`src/contracts/protected-rules.ts`（浏览器侧逐字镜像：`src/client/contracts/protected-rules.ts`）。

| 常量 | 冻结值 | 业务语义 |
| --- | --- | --- |
| `TITLE_MAX` | `34` | 头条长/短图文标题最大 Unicode 字符数（按码点计）；微头条禁止设标题 |
| `QA_PASS_SCORE` | `84` | 头条质检（QA）通过分数线（`score >= 84` 且无硬门禁失败项才可进入 `待验收`） |
| `EDITORIAL_REJECTION_LIMIT` | `2` | 番茄单章审稿最多打回 2 次，第 3 次返回 `gate.denied` |
| `QA_REFINEMENT_LIMIT` | `2` | 头条自动回改最多 2 轮，第 3 轮硬熔断 |
| `DELIVERY_ENDING` | `——AI 到此止步。是否采用、何时发布由你决定。` | 头条交付正文末尾固定附带的作者主权声明 |

### 双产品线状态机

- **番茄章节（`CHAPTER_STATES`）**：`planned` → `drafting` → `drafted` → `reviewed` → `final`（终态锁定，拒绝所有写入与回退）。
- **头条文章（`ARTICLE_STATES`）**：`初稿待改` → `待验收`（或 `验收退回`）→ `已验收` → `已交稿`（`已验收`/`已交稿` 严禁改稿或改标题；交付前强制完成 `approval.decide`）。

---

## 2. 番茄长篇内置创作方法论（四位一体质量闭环）

### 2.1 叙事写作纪律（`src/workflow/prompts/index.ts`）

所有长篇生成、续写、精修与 Agent 共创遵循五条核心写作纪律：

1. **节拍先行（Beat-First）**：每章推进明确拆解为「开场切入 → 冲突升级 → 转折/信息差 → 情绪落点 → 章末钩子」，拒绝流水账平推。
2. **展示而非告知（Show, Don't Tell）**：通过具体器物、五感物理反馈、微动作停顿与潜台词对话承载情绪与战力压迫，避免“五味杂陈”“恐怖如斯”式抽象总结。
3. **POV 严格知情边界**：依托 `StoryPoint = { chapterId, point }`、设定半开区间 `[effectiveFrom, effectiveTo)` 与角色知情点 `knownFrom`，严禁当前视角人物在正文或心理活动中泄露其尚未获知的信息。
4. **反 AI 腔硬禁用与句长节律**：内置 4 大类（总结连接词、套话情绪、套话动作、空泛垫词）80+ 中文网文高频机械表达扫描与项目级自定义禁用/白名单，同时监测句长变异系数（`CV >= 0.25`）防止机械等长句。
5. **1-based 段落级外科手术精修（`applyParagraphPatches`）**：局部打磨只替换问题段落，未改动段落逐字保留，避免整章重写冲掉作者原本的文气与节奏。

### 2.2 离线双轨质量体检（零 Token，`src/domain/fanqie/diagnostics.ts`）

| 诊断模块 | 检测维度 | 说明 |
| --- | --- | --- |
| **黄金三章诊断（`diagnoseGoldenThree`）** | 前 3 章 6 维：开场钩子、前 300 字冲突触发、设定灌输连续段、对话占比、段落呼吸感、字数达标带；第 4 章起切换为段落呼吸感 + 字数达标带 | 按本书 `pacingTier`（快爽 / 稳推 / 慢燃）与 `genreTags` 动态加载对应题材关键词包 |
| **AI 腔与节律扫描（`scanAiSlop`）** | 非重叠最长匹配扫描、分类加权每千字密度、句长 CV、连续单调句段 | 支持排除对话内口头禅（`excludeDialogue`）与项目白名单 |
| **Quality v2 综合评估（`diagnoseQualityV2`）** | 章末钩子评分（`endingHookScore`）、连续/高频 2 字段首复读、跨近期章节 4-gram 旁白回声、POV 越权启发式预警 | 输出 0–100 `compositeScore`，在 Agent 提交草稿与自治流水线中即时反馈 |

### 2.3 渐进披露 Skill 技法体系与 7 套题材起步包

- **技法卡结构（Quality v2）**：每张技法卡/Skill 均支持 `assetKind`（`technique` / `skill`）、`triggerWhen`（触发场景）、`executionSteps`（可执行步骤）、`constraints`（约束）、`antiPatterns`（反模式）、`positiveExample`（正例示范）、`negativeExample`（反例避坑）、`conflictGroup`（互斥组：同组仅生效最高优先级 1 张，防止技法打架）、`stageBindings`（绑定阶段：`plan`/`write`/`review`/`refine`/`deslop`）与 `referenceDocs`（参考附件）。
- **级联挂载与零成本排序（`rankTechniquesForChapter`）**：作用域优先级 `chapter > act > volume > project`，支持 `pin`（置顶）、`include`、`exclude`，结合历史采用效果分与当前章纲关键词自动排序。
- **7 套内置题材起步包（`src/client/workbench/seed-packs.ts`）**：
  - 番茄（5 套）：都市逆袭·高燃打脸、玄幻升级·宗门暗流、悬疑刑侦·线索闭环、古言权谋·朝堂博弈、科幻末世·生存推演（共 9 张 Quality v2 正反例技法卡）。
  - 头条（2 套）：头条深度·观点锐评、头条人物·深度特写（共 3 张 Quality v2 正反例技法卡）。
  - **示例书（`示例书 · 灰塔长夜`）**：一键导入完整卷/幕/2 章正文与摘要、1 条已埋设伏笔、2 张互补 Quality v2 技法卡与 `慢燃` 悬疑节奏配置。
- **纯提示词 Skill 沙箱导入（`skill.import`）**：支持标准 `SKILL.md`（≤ 128 KiB），自动剥离脚本、Hook 与外部工具声明，预览确认后入库。

### 2.4 三阶段非标准材料重写入与分级自治流水线

- **非标准材料重写入（`src/application/products/fanqie/material-ingest.ts`）**：
  1. **阶段 1（本地预处理）**：本地正则按章回/标题切片、去除乱码噪声并自动识别材料类型（设定笔记 / 正文草稿 / 混合大纲），支持手工调整或合并切片。
  2. **阶段 2（AI / DsH 提炼）**：交给 DsH Agent（`zhizhang_ingest_preview` → `zhizhang_propose_material_bundle`）或兜底 `material_normalize` 作业提炼标准化章节、设定、伏笔与全书指南针，自动标注与现有库的冲突。
  3. **阶段 3（四栏预览原子入库）**：作者审阅后一键原子写入（自动跳过 `final` 终稿章与 `locked` 设定）并触发 L1 全书圣经重建。
- **分级自治五步流水线（`src/application/products/fanqie/autopilot.ts`）**：
  - 单章/多章连跑依次执行：`节拍规划（beatPlan）→ 候选生成（draft）→ 双轨体检（diagnose）→ 段落级外科精修（最多 2 轮）→ 记忆同步提案（factSync）`。
  - 支持 `step_gate`（逐章人工放行）、`redline_pause`（红线异常即停）与 `batch_auto` 三档自治，并保留每章批次前快照支持一键回滚。

---

## 3. 今日头条内置创作方法论（`src/domain/toutiao/`）

- **场景矩阵（`resolveScenario`）**：按体裁（`short` 短图文 / `long` 长图文 / `micro` 微头条）× 条线（`资讯线` / `故事线`）自动匹配推荐驱动方式、开篇抓手与收束策略，并通过 `ctx.systemPrompt` 注入给 DsH Agent。
- **标题矩阵规范**：非微头条文章需提供 5 组「标题\|母题」候选，至少覆盖 **3 个不同母题**，且每条严格 `<= 34` Unicode 字符；微头条强制不设标题。
- **质检与交稿闭环**：QA 分数 `>= 84` 且无硬门禁失败才允许进入 `待验收`；自动回改最多 `2` 轮；作者验收并显式审批后事务内提交交付并附带固定主权尾句，事务外执行原子文件导出。

---

## 4. 可开放给作者调试的上下文参数（`ContextTuningConfig`）

定义于 `src/domain/fanqie/context-tuning.ts`，按书持久化于 `author_project_controls.context_config_json`，所有参数均带安全默认值、上下界钳制与一键恢复默认（`controls.reset_context`）：

| 分组 | 参数 | 默认值 | 安全范围 | 作用 |
| --- | --- | --- | --- | --- |
| **长度与分层配额** | `defaultTokenLimit` / `inputBudgetRatio` | `16000` / `0.72` | `4000–128000` / `0.50–0.90` | 单轮默认上下文总预算与输入占比 |
| | `l1BudgetTokens` / `l1DirtyThreshold` | `8192` / `10` | `1024–32768` / `1–50` | L1 圣经快照配额与脏变更重建阈值 |
| | `l2MilestoneChunkSize` | `10` | `5–30` | L2 里程碑归档步长（每 N 章固化一块） |
| **前文与历史读取** | `prevTailChars` / `rollingSummaryCount` | `1200` / `9` | `0–6000` / `0–30` | 上章末尾读取字数与近期窗口摘要章数 |
| | `relatedHistoryTopK` / `relatedHistoryRecentExclude` | `4` / `5` | `0–12` / `1–20` | 远期相关章 4D 召回条数与排除的最近章数 |
| | `antiEchoWindow` / `staleForeshadowGap` | `3` / `20` | `0–10` / `5–100` | 防复读回看章数与超期未呼应伏笔预警间隔 |
| **槽位组合开关** | `includeL1BookBible` / `includeL2VolumeMilestones` / `includePovBoundary` / `includeDueForeshadows` / `includeAntiEchoGuard` / `includeTechniques` / `includeDeconstructions` / `includeCurrentFocus` / `includeRelatedHistory` / `includeRollingSummaries` / `includePrevTail` | 全部 `true` | `boolean` | 细粒度启停可选上下文槽位（关闭后预览显式标注「已关闭」） |
| **技法与范本上限** | `maxActiveTechniques` / `maxActiveDeconstructions` | `3` / `2` | `0–10` / `0–6` | 单章最多生效的互斥技法卡与拆书范本数 |
| | `techniqueExampleChars` / `deconstructionExcerptChars` | `400` / `600` | `100–1200` / `150–2000` | 技法正反例与拆书片段的单条截断字数 |

**不可关闭的底线护栏**：受保护业务常量、L0 系统内核字节一致性、本章核心写入槽位（章纲 / 工作稿 / 本轮指令）以及 `final` / `locked` / `已验收` / `已交稿` 只读保护始终锁定开启。
