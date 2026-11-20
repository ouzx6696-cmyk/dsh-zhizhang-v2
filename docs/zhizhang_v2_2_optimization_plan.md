# 织章 `dsh-zhizhang-v2` V2.2 全面优化计划

> **文档定位**：以 `dsh-zhizhang-v2`（v2.1.0）为骨干、汲取 9 个头部开源小说写作项目精华的 **V2.2 实战演进与落地计划**  
> **基准基线**：`@zhizhang/dsh-workbench` v2.1.0（168 文件 / 35,179 行 / 34 张 SQLite 表 / 63 个 `WorkspaceAction` / 53 个测试文件）  
> **核心原则**：**骨干不动摇、零依赖不破戒、作者主权不退让、精华精准嫁接**

---

## 一、顶层认知：我们到底在做什么产品？骨干与边界在哪里？

在谈任何优化之前，必须先看清 `dsh-zhizhang-v2` 在整个开源 AI 写作生态里的真实身位。2026 年的开源小说工具已经分化出两条截然不同的路线：一条是“全自动印钞机/重型全家桶”（如多 Agent 无人值守跑完整本书，或 Electron + Prisma + Qdrant 重栈）；另一条是“服务真实创作者的本地可控工作台”。

**织章 V2 属于后者，而且已经建成了全生态最克制、最严谨的工程骨干**：

1. **第一根骨干：作者主权与三态物理隔离**  
   工作稿（`revisions`）、模型候选稿（`candidates`，强绑定 `base_revision_id`）、定稿/交稿（`final_revision_id` / `deliveries`）物理分表隔离；`src/host/writing.ts` 走**零工具单轮流式 LLM**；`src/contracts/commands.ts` 冻结 7 个仅限作者执行的权威写命令。模型永远只是起草者与提议者，绝不静默洗稿。
2. **第二根骨干：人物视角时间线知情（`knownFrom`）+ 重排翻转门禁**  
   绝大多数竞品只做“全局世界观账本”（某件宝物存在与否），而织章在 `src/domain/shared/anchors.ts`、`src/domain/fanqie/editorial.ts` 与 `reorder.ts` 中建模了**叙事视角边界**（角色 A 在第 5 章知道的秘密，角色 B 在第 12 章前绝不能提前知情；调换章序若导致知情因果翻转，必须两步预览并经作者确认）。这是长篇网文防写崩的真正核心壁垒。
3. **第三根骨干：零运行时依赖 + 事件溯源 SQLite 底座**  
   仅依赖 Node `>=24.15.0` 原生能力（`node:sqlite`、原生 `.ts`、原生 DOM + `<dialog>`），不绑死任何第三方框架或外置向量服务；通过事件日志 + 物化投影 + `DraftVault` 防丢字，在 DsH（DeepSeek Harness）中轻装稳定运行。
4. **第四根骨干：单底座 + 双隔离产品线（番茄连载 / 头条图文）**  
   `ProductLineModule` 与前端 UI 插件槽位把长篇网文和图文创作隔离在同一套可靠底座之上，代码边界清晰、零交叉污染。

**那么，为什么 v2.1.0 还不够好用？**  
对标 [Narcooo/inkos](https://github.com/Narcooo/inkos)、[lingfengQAQ/webnovel-writer](https://github.com/lingfengQAQ/webnovel-writer)、[voocel/ainovel-cli](https://github.com/voocel/ainovel-cli)、[EthanYoQ/Pagekin](https://github.com/EthanYoQ/Pagekin)、[swjybky/deepwrite](https://github.com/swjybky/deepwrite)、[ExplosiveCoderflome/AI-Novel-Writing-Assistant](https://github.com/ExplosiveCoderflome/AI-Novel-Writing-Assistant)（Biz Novel Studio）、[PenglongHuang/chinese-novelist-skill](https://github.com/PenglongHuang/chinese-novelist-skill)、[akira399/dsh-novel-writer](https://github.com/akira399/dsh-novel-writer) 与 [peterwangze/dsh-novel-writing](https://github.com/peterwangze/dsh-novel-writing) 后，我们发现 v2.1.0 的短板集中在**五个直接影响作者日常写作体感的核心命题**上：

- **成本与缓存**：虽有 Prefix-First 雏形，但头条未接入缓存、槽位开销估算失真、缺少缓存命中计费透视与失败卡原地恢复；
- **长篇项目管理**：缺少“指南针 + 卷弧滚动规划”，5000 章级树目录与大纲板会 DOM 爆炸，冷启动面对空白工程表单；
- **写作方法论与成文质量**：技法卡与社区海量的标准 `SKILL.md` 生态割裂，番茄缺离线规则体检与去 AI 味，候选稿只能整章盲采而不能逐段字级合稿、也不能选段微改写；
- **长篇连贯性闭环**：作者手改正文或定稿后，设定/伏笔不会自动感知漂移并生成更新提案；缺少远期相关历史章自动召回；FTS5 删除有全表扫描与多 scope 截断问题；
- **底座隐患与 DsH 交付**：存在事务缺失、WAL 热备漏洞、插件卸载竞态、前端轮询锁吞点击、DsH `mtime` 缓存僵死坑等必须立刻兜底的工程风险。

**V2.2 的核心目标**：**不做推倒重来的大重写，而是以 v2.1.0 为骨干，用 4 个紧凑 Sprint，把上述 5 大命题一次性打通，让织章成为 DsH 生态里“最省钱、最稳、最不崩设定、改稿最顺手”的作者主权长篇工作台。**

---

## 二、核心命题一：如何最大化缓存命中，系统性降低 Token 使用成本？

长篇网文动辄百万字，每章反复起草、审稿、精修，如果上下文和调用策略设计不好，Token 账单会比灵感先耗尽。V2.2 围绕 **“最大化 Prefix Cache 命中 + 零 Token 本地前置计算 + 防盲目重试浪费”** 三条主线做系统降本。

| 降本维度 | 织章 v2.1.0 现有骨干 | 汲取的竞品精华 | V2.2 具体落地改造 |
| :--- | :--- | :--- | :--- |
| **1. 严格稳定的 Prefix 缓存区** | `src/workflow/context-slots.ts` 已分 `prefix` 与 `dynamic` 两组并透传 `cachePrefix` | [Biz Novel Studio](https://github.com/ExplosiveCoderflome/AI-Novel-Writing-Assistant) 与 [InkOS](https://github.com/Narcooo/inkos) 严格隔离稳定规则与动态剧情，持久化 `context.json` / `trace.json` | 固化番茄 4 个纯静态 Prefix 槽位（`agreements` + `authorIntent` + 阶段绑定 `skillsAndTechniques` + `deconstructions`），**禁止时间戳、随机 ID 或本章变动信息混入 Prefix**；按稳定 ID 排序，确保连写多章与同章多次修稿字节级一致，命中厂商 Prompt Cache。 |
| **2. 头条多轮管线接入 Prefix Cache** | `src/application/products/toutiao.ts` 目前直接拼 JSON 给 LLM，未启用 `cachePrefix` | 复用织章自身 `context-slots.ts` 能力 | 将头条的体裁/赛道规范、反 AI 规则与绑定 Skill 抽入稳定 `cachePrefix`，正文与篇纲入 `dynamicTail`，让 `write → qa → refine（≤2轮）` 多轮调用共享首轮缓存前缀，直接压低第 2–3 轮 50%+ 输入成本。 |
| **3. 零 Token 本地前置计算** | `domain/fanqie/library.ts` 已有零 Token 技法推荐；`writing-budget.ts` 已有 CJK 1.4 权重校准 | [ainovel-cli](https://github.com/voocel/ainovel-cli) 的零 LLM `StoreSummaryCompact` 与 4 维相关章检索；[dsh-novel-writer](https://github.com/akira399/dsh-novel-writer) 的离线规则体检 | 将**4 维相关历史章推荐**、**实体出现倒排扫描**、**黄金三章 6 维体检**、**AI 味高频词/句式密度检测**全部做成 SQLite + 纯函数零 Token 引擎；手改同步（`fact_sync`）仅传**变更段落 Diff** 而非重扫整章。 |
| **4. 精准预算防线与计费透视** | `budget.ts` 已记 4 类 Token；但 `writing-budget.ts` 把 `inputBudget` 设为 `runBudget` 导致双层防线退化，`context-slots.ts` 静态 `framingOverhead = 32` 低估真实开销 | [Biz Novel Studio](https://github.com/ExplosiveCoderflome/AI-Novel-Writing-Assistant) 明确 `有效计费 = (输入 - 缓存命中) + 输出`，不把未知缓存当 0 | ① 修正 `context-slots.ts` 按槽位动态累加真实标题 `### label\n` 与分隔符开销，新增 `overBudget` 告警并落盘 `context_trace`；② 恢复 `writing-budget.ts` 独立的 `inputBudget` 上限；③ `host/writing.ts` 计算剩余额度时扣除 `inflightTokens`；④ 在 `run-inspector.ts` 展示 `effectiveBilledTokens` 与 `cacheHitRate`。 |
| **5. 失败卡原地恢复，拒绝整链重烧** | 失败后只能重新发起完整 Run，缺少针对性恢复策略 | [Biz Novel Studio](https://github.com/ExplosiveCoderflome/AI-Novel-Writing-Assistant) 的失败卡一键恢复（提输出上限 / 关深度思考重试）；[dsh-novel-craft](https://github.com/shiyan688/dsh-novel-craft/blob/main/docs/README.en.md) 指出压缩/提取类任务必须关闭深度思考防空耗 | 在失败运行记录结构化 `recoveryHints`（`output_truncated` → 建议提高输出上限；`thinking_exhausted` → 建议关闭思考；`budget_exhausted` → 建议追加额度）；同时对 `summary`、`fact_sync`、`deconstruct` 等结构化提取提案默认关闭深度思考，避免模型把 Token 全花在思维链上。 |

---

## 三、核心命题二：如何高效管理几十万到数百万字的长篇网文项目？

长篇网文真正的难点不是写出第 1 章，而是写到第 200 章、第 800 章时，**大纲不空洞、目录不卡顿、改稿不丢字、随时可迁移**。

### 1. 指南针（Compass）+ 卷/弧双层滚动规划
- **借鉴来源**：[voocel/ainovel-cli](https://github.com/voocel/ainovel-cli) 的 Compass 滚动规划 + [Narcooo/inkos](https://github.com/Narcooo/inkos) 的 `author_intent.md` / `current_focus.md`。
- **嫁接到织章骨干**：
  - 在现有 `author_volumes`（卷）→ `author_acts`（幕/弧）→ `author_documents`（章）三级树之上，新增轻量表 `author_project_controls`，承载两份长期可编辑控制文档：
    - **`authorIntent`（全书指南针）**：终局方向、核心卖点、活跃长线、明确禁区（注入 Prefix 稳定区）；
    - **`currentFocus`（近 1–3 章焦点）**：当前阶段必须推进的主矛盾与情绪节奏（注入 Dynamic 尾区）。
  - 为 `author_acts` 补充 `arc_goal`、`arc_summary` 与节奏模板标签；作者无需开书就硬编 500 章细纲，每写完一幕/一卷时，可一键触发生成“本幕摘要 + 下一幕展开草案”提案，经确认后渐进细化。

### 2. 5000 章级流畅前端：树目录全虚拟化 + 大纲板惰性编辑
- **解决现有瓶颈**：v2.1.0 在有分卷时 `tree-sidebar.ts` 绕过虚拟列表全量渲染，且 `outline-board.ts` 为每一章同时挂载 `<textarea>` 和含全书卷幕的 `<select>`（5000 章会产生 460,000+ DOM 节点）；同时 `#tree-filter` 绕过了 `treeSidebar.setFilter`。
- **V2.2 落地**：
  - `tree-sidebar.ts` 将卷/幕/章三级树在内存中 $O(N)$ 展平为可见节点数组 `FlatTreeNode[]`，统一交由 `createVirtualList`（固定行高 36px + 单点事件委托），**5000 章左侧目录 DOM 恒定 ≤ 45 个节点**，并打通 `#tree-filter` 实时按章名与摘要筛选、自动展开命中卷。
  - `outline-board.ts` 改为默认轻量只读行 + 单点 `expandedChapterId` 惰性挂载编辑表单 + 共享缓存 `<option>` 模板 + 默认仅展开当前卷，**5000 章大纲板首屏 DOM 从 460,000+ 降至 < 120 个**。

### 3. 书斋冷启动、三步开书与护眼排版
- **借鉴来源**：[peterwangze/dsh-novel-writing](https://github.com/peterwangze/dsh-novel-writing) 的“书斋 → 写作台”递进入口与三套纸面主题 + [PenglongHuang/chinese-novelist-skill](https://github.com/PenglongHuang/chinese-novelist-skill) 的三层引导开书。
- **V2.2 落地**：
  - 新增 `views/study-home.ts` 取代空白 `#empty`：展示“上次写作一键续写 Hero 卡”、按产品线筛选的书架网格、以及“三步开新书”与“一键导入示例书”入口；
  - 新增 `views/new-book-wizard.ts`（`<dialog>` 三步向导：定产品线与题材 → 选起步骨架 → 勾选预装题材种子技法包）与 `seed-packs.ts`（4 套零依赖题材种子包）；
  - 顶栏升级 `#appearance-toggle`：提供**墨纸 / 青简 / 夜航**三套纸面主题（支持 `auto` 跟随宿主明暗），以及仅作用于正文画布的 **宋体 / 黑体 / 楷体**、**15–18px 字号**、**720/820/960px 行宽**。

### 4. 无损、幂等的本地 Markdown 工程包
- 补齐 `src/application/products/fanqie/io.ts` 对 `foreshadows` 与 `author_library_mounts` 的导入还原，引入基于稳定业务键/内容哈希的幂等合并逻辑，消除重复导入堆积脏数据的问题，让作者的每一本书都能随时导出为开放 Markdown 目录进行 Git 版本管理或网盘备份。

---

## 四、核心命题三：如何提供系统化方法论，让模型写出真正像人的好文章？

模型写网文最容易出现三大毛病：**“AI 腔/套话味重”、“节奏平、没钩子”、“整章重写丢掉作者原本写得好的 70%”**。V2.2 从 **“输入端方法论注入 → 产出端双层质检 → 修稿端外科手术式合稿”** 形成完整闭环。

### 1. 输入端：纯提示词型标准 `SKILL.md` 沙箱引擎 + 阶段精准绑定
- **借鉴来源**：[EthanYoQ/Pagekin](https://github.com/EthanYoQ/Pagekin) 的纯提示词 `SKILL.md` 沙箱导入 + [Narcooo/inkos](https://github.com/Narcooo/inkos) 的按 ID 覆盖机制 + [PenglongHuang/chinese-novelist-skill](https://github.com/PenglongHuang/chinese-novelist-skill) 的模块化写作指南。
- **嫁接到织章骨干**：
  - 不另建一套平行体系，而是直接扩展现有 `library_technique_cards` + `author_library_mounts`，新增 `asset_kind ('technique' | 'skill')`、`stage_bindings`（`plan` / `write` / `review` / `refine` / `deslop`）与 `references_json`；
  - 新增 `skill-importer.ts`：支持导入本地文件夹或单个标准 `SKILL.md`（含 `references/**/*.md|txt`，单文件 ≤ 128 KiB），**严格安全沙箱——静态解析 YAML frontmatter，强制剥离/拒绝脚本、Hook、工具与子代理声明，安装前弹窗预览全文**；
  - **阶段精准注入**：写作时只注入绑定 `write` 的 Skill/技法，审稿时只注入 `review`，去 AI 味时只注入 `deslop`，防止不同阶段的方法论互相干扰并稳定 Prefix 缓存；
  - **修复覆写继承 Bug**：修复 `domain/fanqie/library.ts:rankTechniquesForChapter` 中项目级覆写全局卡（`overrideOfId`）后丢失原挂载规则的缺陷。

### 2. 质检端：离线规则体检 + 去 AI 味双层防线 + 定性举证 `Observation`
- **借鉴来源**：[akira399/dsh-novel-writer](https://github.com/akira399/dsh-novel-writer) 的 234 词 AI 味词库与黄金三章离线诊断 + [voocel/ainovel-cli](https://github.com/voocel/ainovel-cli) 的机械黑名单/语义判据双层去味 + [Narcooo/inkos](https://github.com/Narcooo/inkos) 的定性 `Observation` 审稿。
- **V2.2 落地**：
  - **第一层（零 Token 离线规则引擎，新增 `src/domain/fanqie/diagnostics.ts`）**：
    - **黄金三章 6 维离线诊断**（前 3 章自动激活）：开场钩子、前 300 字冲突触发、设定灌输连续段、对话占比、段落呼吸感、字数达标带，秒级出分并定位问题段落；
    - **可配置 AI 味机械扫描**：内置高频词/套句/过度总结连接词词库 + 支持作者在项目级用简单清单追加自定义禁用词/白名单，计算每千字 AI 味密度。
  - **第二层（带原文举证的定性 `Observation` 审稿，新增 `author_chapter_observations` 表）**：
    - 审稿输出不再粗暴给章节判“通过/失败”，而是沉淀按维度（连续性 / OOC / 节奏 / 伏笔 / 文风 / AI 味）分类、附带**原文精确摘句（`quote`）**与修改建议的观察条目；
    - 作者可**逐条勾选**认同的问题，一键发起定向修稿，拒绝盲目全章重写。
  - **头条精修优化**：拆分 `domain/toutiao/rules.ts` 消除循环依赖；`refineArticle` 支持 `AbortSignal` 并**默认保留历史最高分轮次**，防止第 2 轮改写反而掉分。

### 3. 修稿端：外科手术式逐段字级 Diff + 正文选段浮动微改写
- **借鉴来源**：[akira399/dsh-novel-writer](https://github.com/akira399/dsh-novel-writer) 的逐段采纳字级 Diff 与实时预览 + [EthanYoQ/Pagekin](https://github.com/EthanYoQ/Pagekin) 的选段局部微交互 + [swjybky/deepwrite](https://github.com/swjybky/deepwrite) 的写前 Diff 审阅。
- **V2.2 落地**：
  - **逐段字级 Diff 采纳（升级 `diff.ts` + `views/diff-view.ts`）**：在段落 LCS 上叠加中文单字/英文词块级段内 LCS，给每个变更段配独立采纳复选框、`📍 定位` 正文跳转高亮、顶部实时合稿预览条与 30 步选择撤销栈，并用 `contentSig` 指纹缓存免疫 2 秒轮询重建；扩展 `candidate.adopt` 支持 `mergedBody` 与 `adoptionMode: "full" | "partial"`，保持 `candidates` 原表不可变。
  - **选段浮动微操作条（新增 `views/selection-microbar.ts`）**：在正文 `#body` 拖选任意片段（≥ 4 字）时弹出 `[润色] [扩写] [改对话] [选段续写] [自定义…]`，走单轮无工具请求 `selection.rewrite`（附前后各 400 字 + 本章角色知情边界），原地弹出字级 Diff 浮卡，确认后经 `editor.setRangeText(...)` 写回编辑器（完整保留原生 `Ctrl+Z` 与 `DraftVault` 本地草稿保护）。

---

## 五、核心命题四：如何在数百章连载中死守剧情与设定的连贯性？

织章 V2 已经在 `knownFrom`（人物视角知情时间线）和 `reorder`（调序翻转门禁）上领先行业，V2.2 的策略是**补齐“手改感知 → 自动提议 → 远期召回 → 精准检错”的闭环**，把连贯性做成自动化防线。

### 1. SHA-256 改稿漂移检测 + `fact_sync` 提案 + `CHAPTER_COMMIT` 闭环
- **借鉴来源**：[voocel/ainovel-cli](https://github.com/voocel/ainovel-cli) 的 `/sync` SHA-256 变更感知 + [Narcooo/inkos](https://github.com/Narcooo/inkos) 的 Settler Delta + [lingfengQAQ/webnovel-writer](https://github.com/lingfengQAQ/webnovel-writer) 的 `CHAPTER_COMMIT` 原子多路投影。
- **闭环机制（严守作者主权）**：
  1. 新增 `author_chapter_memory_sync`（记录 `current_body_sha256`、`synced_body_sha256`、`sync_status`）与 `author_chapter_entities`（零 Token 实体倒排表）。
  2. 作者每次保存正文（`appendDraftRevision`），同事务自动比对 SHA-256：若与已同步版本不一致则置 `dirty`（章节树亮起柔和“待同步事实”角标，绝不打断写作），同时零 Token 刷新本章实体出现频次。
  3. 作者写完或手改完一章后，一键点击“提取本章事实变更”→ 触发 `proposal.generate(kind: "fact_sync")`（有历史同步基线时仅传增量段落 Diff），单轮无工具提取 `{ newFacts, knownFromUpdates, foreshadowUpdates, summaryDraft }` 落入 `author_ai_proposals`。
  4. 作者在收件箱**逐条勾选确认**，系统在单个写事务中执行 `CHAPTER_COMMIT`：原子更新 `author_settings`、`author_lore_current`、`author_foreshadows`、`author_documents.summary`、`author_evidence`（原文唯一命中自动绑定证据）并置回 `clean`，事件水位推进后所有下游 `settings-view` 自动刷新。

### 2. 4 维零 Token 相关历史章推荐（放大 `knownFrom` 优势）
- 新增纯领域评分模块 `src/domain/fanqie/related-chapters.ts`，排除最近 5 章（已由滚动摘要覆盖），从全书历史章中按四维综合打分召回 Top-4 注入新槽位 `relatedHistory`：
  - **伏笔维度（0.35）**：未回收伏笔埋设章，若本章为预定回收章直接拉满；
  - **角色维度（0.25）**：基于 `author_chapter_entities` 计算本章出场角色（视角人物 2x 权重）的覆盖度；
  - **知情源头维度（0.25，织章独有优势）**：当前视角人物在本章已知关键设定的 `knownFrom[viewpoint]` 获知源头章与锁定设定转折章；
  - **关系与语义维度（0.15）**：多角色共现度 + 重构后的 `fts_chapters` BM25 得分。

### 3. External Content FTS5 与多 Scope 防饿死融合排序
- 重构 `src/storage/fts.ts`：引入 `fts_rowid_map` + 3 张只读外部内容视图（`v_fts_chapters` / `v_fts_lore` / `v_fts_library`）+ External Content FTS5 虚表，彻底消除 `UNINDEXED` 列删除时的全表扫描与双倍正文存储；补齐 `rebuildProjectFts` 覆盖 `fts_library`；查询改用加权 `bm25()` + RRF 融合 + **每非空 Scope 保底 Top-2 配额**，防止设定和技法卡被高频章节结果截断。

### 4. 四项连续性算法与分页精准修复
- `anchors.ts:resolveAnchor`：修复空段落数组越界返回 `undefined` 与非有限 `point`；
- `hierarchy.ts:planTreeChapterMove`：修复 `matchingSiblings` 未按 `beforeOrder` 排序导致的拖放移章错位；
- `lore.ts:detectLoreConflicts`：基于预建 `positions` Map 消除 $O(N^2)$，用精确边界分词替代 `.includes(factId)` 根除 `f1` 误中 `f10`，新增 `inverted-validity-interval`（失效早于生效）与 `known-before-effective`（角色在设定生效前已“知情”）两类 `error` 检测；
- `fanqie/lore.ts:queryLore`：改为 `(decided_seq DESC, fact_id DESC)` Keyset 游标分页，解除 200 条硬截断。

---

## 六、底座止血、平台解耦与 DsH 宿主交付闭环

上述四大创作能力必须建立在坚如磐石的工程底座上。V2.2 同步完成全仓审计发现的 P0 止血与 DsH 实战防坑：

1. **存储与并发止血（零数据撕裂）**：
   - 新增 `src/storage/tx.ts`（统一 `withReadTx` / `withWriteTx` + `SAVEPOINT` 嵌套 + 禁止读内升写），收口 `author-generation.ts`（修复 `beginCall`/`receiveCall` 双写无事务）、`command.ts`、`projection.ts`、`export.ts`、`context.ts`；
   - 新增 `src/storage/migrations.ts`（`schema_migrations` 原子版本化迁移，修复 2.0→2.1 删旧索引后崩溃永久漏回填）；
   - `backup.ts` 新增 `createHotBackup`（`VACUUM INTO` 在线热备）与覆写恢复前强制清理 `-wal`/`-shm`；`store.ts:openStore` 默认开启 `foreign_keys`/`WAL`/`busy_timeout`；`command_journal` 增加 `request_hash` 与分级剪枝防库膨胀。
2. **宿主生命周期与前端交互止血**：
   - `author-workspace.ts:recoverStartup()` 补齐 `runs.recoverGenerations()`；`host/plugin.ts` 卸载时先 `abort()` 并优雅排空在途任务（上限 5s）再关闭 SQLite，为 `GET /state` 补统一错误映射、为 `proposal.generate` 加并发互斥与取消通道；
   - `runstate.ts:recordLateUsage` 拦截全部终态；`author-reads.ts` 保留多阶段 `checkpoints` 并对冷启动日志按 `limit = 1000` 分页回放；
   - 前端 `shell.ts` 彻底拆分 `userBusy` 与 2 秒 `pollInFlight` 双通道防止轮询吞点击；修复 `modal.ts` 重入取消值错配与 `showModal()` 后再聚焦；`workbench.css` 用 `--nav-col` / `--pipe-col` 正交变量消除宽栏 + 专注模式左侧空列；统一 `dom.ts` `el()` 签名并清理 `shell.ts` 硬编码 `"fanqie"`。
3. **平台解耦与热点拆分**：
   - 清除 `snapshot-service.ts` 与 `proposal-service.ts` 对产品线专属表的跨层硬编码；拆分 `fanqie/library.ts`（963 行 → 4 子模块）与 `toutiao.ts`（513 行 → 4 子模块，统一 `stmt()` 并修复 `renameArticle` 同步旧标题到 FTS）；为 `tree.ts`/`library` 补齐缺失的 `ctx.event` 保证 `ifSequence` 零漏刷；收紧 `contracts/`（构造期固定 `diagnosticId`、`approval.ts` 空白防护、收紧 DTO 判别联合）。
4. **DsH 0.2.2+ 宿主双入口协同与交付防坑**（借鉴 [dsh-novel-writer](https://github.com/akira399/dsh-novel-writer) & [dsh-novel-writing](https://github.com/peterwangze/dsh-novel-writing)）：
   - 保留 `iframe` 强隔离与无工具正文生成，新增可选的 **7 只读查询工具**（查树、读章、查某角色某章知情事实、FTS 搜索、查冲突、跑离线诊断）+ **3 提案型工具**（提设定/提伏笔/提技法，严守作者主权只进收件箱）；
   - 接入 DsH `settings.plugins.tab`（`ctx.configForms`）与脱敏 `/diag` 诊断导出；
   - 新增 `scripts/deploy.mjs` 刷新 `dist/client/*` 的 `mtime`，彻底规避 DsH `artifactRevision` 遇 `npm pack` 1985 年时间戳导致 `immutable` 缓存僵死的实战深坑；分离 `dist/server` 与 `dist/client`；拉齐 `dev-server.mjs` 与生产 `plugin.ts` 的原子交付（`wx` + `linkSync`）；新增 `scripts/preflight.mjs` 校验 Node `>=24.15.0`。

---

## 七、V2.2 刻意不做的边界（Non-Goals）

为防止功能膨胀稀释织章的核心优势，V2.2 明确划定以下红线：
- **不引入第三方运行时依赖**：不接 Qdrant/Chroma 等外置向量库，不引入 React/Vue/Electron/Prisma；
- **不做无人值守全自动连写整本书**：保持作者在关键节点的主权审批与逐段合稿体验；
- **不做平台自动爬虫/自动发文**：避免卷入外部平台风控与脆弱的页面适配维护黑洞；
- **不允许任何外部 Skill 或 DsH 对话工具直接改写权威正文/设定表**：所有 AI 写意图一律经由候选稿或提案收件箱中转。

---

## 八、V2.2 四阶段实施路线图与量化验收门禁

每个 Sprint 均可拆分为 3–4 路无文件冲突的并发模块执行，交付即可独立验证：

| 迭代阶段 | 周期建议 | 核心交付包（含精准源码范围） | 量化验收门禁 |
| :--- | :--- | :--- | :--- |
| **Sprint 1：底座止血与成本/缓存加固** | 4–5 天 | ① 存储事务与安全：`storage/{tx,migrations,author-schema,author-generation,backup,command,store}.ts`<br>② 状态机、预算与宿主生命周期：`workflow/{runstate,writing-budget,context-slots,author-reads}.ts`、`host/{plugin,writing,delivery-io}.ts`、`scripts/{dev-server,preflight}.mjs`<br>③ 契约与核心领域止血：`contracts/{errors,approval,workspace-dto}.ts`、`domain/{shared/anchors,fanqie/hierarchy,fanqie/lore,toutiao/rules,toutiao/refinement}.ts`<br>④ 前端 P0 止血：`client/workbench/{dom,modal,draft-vault,shell}.ts`、`plugins/fanqie.ts`、`workbench.css` | Node 24 全量 53+ 测试 100% 通过；新增事务嵌套、WAL 热备、modal 重入、轮询不吞点击、专注+宽栏网格回归用例全绿；头条接入 Prefix Cache 且运行检查器展示 `effectiveBilledTokens` 与 `cacheHitRate` |
| **Sprint 2：连贯性记忆闭环、FTS5 与平台解耦** | 5–6 天 | ① `storage/fts.ts`（External Content + `fts_rowid_map` + BM25/RRF）<br>② 记忆闭环与 4 维召回：`domain/fanqie/related-chapters.ts`、`application/{context,proposal-service}.ts`、`fanqie/{lore,context,proposal-decide}.ts`<br>③ 平台解耦与热点拆分：`application/{snapshot-service,product-line,author-workspace}.ts`、`fanqie/{library-crud,library-mount,tree,io}.ts`、`toutiao/{index,generation,workflow,delivery}.ts` | `fts` 完整性校验全通且多 scope 检索零饿死；手改正文触发 `dirty` → `fact_sync` 提案 → `CHAPTER_COMMIT` 端到端全通；4 维推荐准确召回伏笔与 `knownFrom` 源头章；`library`/`toutiao` 拆后单文件 < 350 行；`io.ts` 重复导入零重复 |
| **Sprint 3：写作方法论引擎与外科手术式修稿** | 5–7 天 | ① 标准 `SKILL.md` 沙箱：`fanqie/skill-importer.ts`、`domain/fanqie/library.ts`（覆写挂载继承 + 阶段绑定）<br>② 离线规则体检与定性审稿：`domain/fanqie/diagnostics.ts`、`author_chapter_observations` 与勾选定向修稿<br>③ 逐段字级 Diff 与选段微改写：`client/workbench/{diff,views/diff-view,views/selection-microbar}.ts`、`application/run-service.ts`（`mergedBody`） | 导入标准 `SKILL.md` 自动剥离脚本并按阶段注入 Prefix 区；黄金三章与 AI 味密度离线秒级出分；逐段 Diff 采纳、顶部实时预览、`📍 定位` 与选段局部微改写全部通过单测与 E2E，2 秒轮询零重置勾选态 |
| **Sprint 4：长篇项目管理、书斋冷启动与 DsH 深融** | 4–5 天 | ① 控制面与滚动规划：`author_project_controls`（指南针 + 当前焦点 + 卷弧摘要）<br>② 5000 章性能与书斋：`views/{tree-sidebar,outline-board,study-home,new-book-wizard}.ts`、`seed-packs.ts`、墨纸/青简/夜航主题<br>③ DsH 深融与交付闭环：`host/{tools,settings}.ts`、`tsconfig*.json`（`dist/server` vs `dist/client`）、`scripts/{deploy,browser-check}.mjs`、`test/{refactor-v2,client-views-v2}.test.mjs`、`docs/*` 同步 | 5000 章左侧树 DOM ≤ 45、大纲板首屏 DOM ≤ 120；DsH 对话可调用 7 只读 + 3 提案型工具且零越权写正文；真实 DsH Web `0.2.2-rc.4` 隔离 profile 安装/升级（`deploy.mjs` 刷新 `mtime`）/4 视口几何验收全通；静态文档守卫全绿 |
