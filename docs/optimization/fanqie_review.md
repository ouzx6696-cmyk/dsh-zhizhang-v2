# 织章 V2 · 番茄小说工作线全量审阅与优化计划

> 视角：番茄连载（domain/fanqie + shared、application/products/fanqie、写作阶段与上下文、番茄前端视图）  
> 审阅方式：只读全量阅读（约 11097 行源码/文档，测试只扫描了标题与关键断言），并联网核实外部事实  
> 约束：遵守 AGENTS.md，受保护语义只编码不变更（相关条目标记 🔒）

## 一、现状与架构

番茄工作线由 domain/fanqie（约 1,460 行纯规则）、application/products/fanqie（约 5,000 行，按 tree/lore/library/memory-sync/io 等 15 个子模块组织）以及前端 plugins/fanqie 和 9 个视图（约 2,400 行）组成，通过 ProductLineModule 挂到底座上，未发现番茄与头条之间互相 import。已经落地的能力相当完整：卷/幕/章三级树与平铺章序、带半开有效期和逐角色 knownFrom 的设定版本、章序翻转影响门、4 维零 Token 相关章召回、Prefix/Dynamic 两段上下文装配、SHA-256 漂移检测加增量 fact_sync、黄金三章与 AI 味离线体检、定性 Observation 定向修稿、SKILL.md 沙箱导入、全局库加项目覆写与 4 级挂载、Markdown 工程包。主要问题集中在：①『连续性真源』的数据正确性：知情史被覆盖、段号语义不一致、提案不绑定版本、章序双真源、伏笔回收丢字段；②Prefix 缓存与作者主权：推荐卡片自动注入并让 Prefix 失稳；③写作方法论偏通用：只有一个 WRITER_SYSTEM，节奏档在 UI 层没有接通，诊断用一刀切的爽文词表；④大书规模下的 O(C×F) 计算与频繁预览。整体上底座设计好，需要先止血数据正确性，再提升写作质量。

## 二、优点

- 领域层是纯函数、零 IO：settingsAt、reorderImpact、detectLoreConflicts、rankRelatedChapters、diagnoseGoldenThree 都容易做表驱动测试。
- 叙事锚点 + 半开区间 + 逐角色 knownFrom 的建模领先同类工具；anchors.ts 的注释如实记录了与 fixture 的分歧，没有擅自选边。
- 作者主权路径基本完整：AI 输出只进 author_ai_proposals/author_settings(pending)，确认后才物化；锁定设定拒绝覆盖。
- 章序变更采用 preview→asOfSeq→confirmed 三段协议，tree.move 与 reorder 都带 version.conflict 校验。
- 上下文装配有完整的槽位报告（rawTokens/includedTokens/status），前端能可视化，作者可以看到哪些内容被裁剪。
- 导入链路有多重保护：已定稿章节跳过、锁定设定跳过、assertSafeRelativePath 防路径穿越、SKILL 导入剥离高危 frontmatter 和可执行文件。
- approvedFacts 按 currentSeq 做每连接 memo；lore 已改为 keyset 分页，修复了 200 条截断。
- 前端视图做了分页和懒展开（大纲板按卷分页、章行默认只读），所有 DOM 都通过 el()/textContent 构建，没有 XSS 面。

## 三、发现总表

| ID | 严重度 | 类别 | 标题 | 工作量 |
|---|---|---|---|---|
| FQ-01 | critical | correctness | 记忆同步/设定提案会覆盖已有事实的 knownFrom 知情史 | M |
| FQ-02 | high | correctness | 『段落 point』在证据、增量同步、诊断、UI 四处语义不一致 | M |
| FQ-03 | high | correctness | AI 提案不绑定基准修订：正文漂移后确认会写错证据并把未同步改动标为 clean | M |
| FQ-04 | high | performance | Prefix 稳定区并不稳定：自动推荐卡片与按动态尾长度裁剪混入 Prefix | M |
| FQ-05 | high | architecture | 未经挂载的技法卡被自动注入写作上下文，偏离作者主权 | S |
| FQ-06 | high | security | 库条目与伏笔可被跨项目/跨作用域按 id 覆写；AI 提案 payload 可携带 id 与 projectId | S |
| FQ-07 | high | correctness | setting 提案缺 documentId 时回落到第一章生效，导致早期章节人物『提前知情』 | S |
| FQ-08 | high | bug | 『标记已在当前章回收』会清空伏笔预定回收章与埋设段；伏笔状态无转换约束 | S |
| FQ-09 | high | correctness | 平铺章序与卷/幕树是两套真源，上移/下移、挂树、拖动会互相覆盖并绕过影响门 | M |
| FQ-10 | high | correctness | fact_sync 新事实的 factId 由模型自取，与已有事实同名时会静默变成新版本 | M |
| FQ-11 | medium | bug | 工程包超过 999 章后排序错乱；导入忽略 manifest 中的章序 | S |
| FQ-12 | medium | feature-gap | Markdown 工程包号称无损，实际丢失设定版本史、Skill 元数据与写作控制面 | L |
| FQ-13 | medium | feature-gap | 番茄写作只有一个通用 WRITER_SYSTEM，缺少任务模式与番茄方法论 | M |
| FQ-14 | medium | feature-gap | 节奏档/题材在 UI 与项目层完全缺失，相关逻辑实际不生效 | M |
| FQ-15 | medium | correctness | 黄金三章离线诊断的几处计分缺陷 | S |
| FQ-16 | medium | correctness | AI 味扫描：短语重叠重复计数，中性词误报 | S |
| FQ-17 | medium | correctness | 审稿 Observation 的摘句不校验，修订后不会失效；UI 只能整包确认 | S |
| FQ-18 | medium | performance | 5000 章规模下上下文构建与连续性检查的复杂度 | M |
| FQ-19 | medium | correctness | 实体提及按纯子串计数且不支持别名 | S |
| FQ-20 | medium | feature-gap | 设定无法通过记忆同步失效或撤回 | S |
| FQ-21 | medium | feature-gap | 伏笔生命周期建模不足：无预定回收章入口，超期判断参照全书总章数 | M |
| FQ-22 | medium | correctness | 章序影响分析不包含伏笔与章纲锁定事实 | S |
| FQ-23 | medium | bug | 滚动幕规划的上下文与提交逻辑问题 | S |
| FQ-24 | medium | correctness | 审稿与选段改写的知情查询固定在章首（point=1） | S |
| FQ-25 | medium | maintainability | 番茄章节状态机没有显式的转换表 🔒 | S |
| FQ-26 | medium | feature-gap | 缺少『AI 参与度/创作过程』存证，作者面对平台审核难以自证 | M |
| FQ-28 | medium | feature-gap | SKILL.md 导入的兼容性与注入方式 | S |
| FQ-29 | medium | performance | CJK token 估算比 DeepSeek 实际高约 2.3 倍，导致上下文被过度裁剪 | M |
| FQ-27 | low | feature-gap | 没有日更与字数里程碑追踪 | S |
| FQ-30 | low | ux | 番茄 UI 的若干可用性问题 | M |
| FQ-31 | low | ux | 三步开新书不是原子操作，题材种子包也偏少 | S |
| FQ-32 | low | testing | 番茄相关测试集中在少数按 Sprint 命名的大用例中 | M |
| FQ-33 | low | docs | 文档与注释漂移 | S |
| FQ-34 | low | correctness | 全局库变更不产生项目事件，导致其他项目快照不刷新 | S |

## 四、发现详情

### FQ-01 · 记忆同步/设定提案会覆盖已有事实的 knownFrom 知情史
- **严重度 / 类别 / 工作量**：critical / correctness / M
- **位置**：`src/application/products/fanqie/fact-sync.ts:101-150`；`src/application/products/fanqie/fact-sync.ts:248-270`；`src/domain/fanqie/editorial.ts:34-58`
- **证据**：commitFactBatch 对 newFacts/settings 中每一项都新建一个 SettingFact，effectiveFrom=本章@point、knownFrom 只来自本条的 people（buildKnownFromMap）。若 factId 已存在且未锁定，则生成同 id 新版本；settingsAt 按同 id 取最新 effectiveFrom 的版本，旧版本里第 3 章就已知情的角色在新版本 knownFrom 中消失。knownFromUpdates 分支 `{...existing.knownFrom, [character]: anchor(doc.id, point)}` 无条件覆盖，若角色更早已知情会被推迟到当前章。
- **影响**：长篇最核心的『人物知情时间线』在一次常规 fact_sync 确认后被静默改写：已知秘密的角色在后续章节被视为不知情，写作冻结上下文与 OOC 审稿全部失真，且没有任何告警。
- **建议**：1) 新增纯函数 domain/fanqie/lore.ts `mergeFactVersion(prev, incoming, order)`：knownFrom 逐角色取更早锚点（precedes 比较），effectiveFrom 默认继承 prev（仅当作者显式勾选『设定变更自本章起生效』才改为本章）；2) commitFactBatch / knownFromUpdates 统一走 mergeFactVersion；3) 提案 UI 对『更新已有事实』展示 before/after 差异；4) 回归测试：ch3 角色A知情 → ch10 fact_sync 更新 note → settingsAt(ch5, A) 仍返回该事实。

### FQ-02 · 『段落 point』在证据、增量同步、诊断、UI 四处语义不一致
- **严重度 / 类别 / 工作量**：high / correctness / M
- **位置**：`src/application/products/fanqie.ts:115`；`src/application/products/fanqie/fact-sync.ts:81`；`src/application/products/fanqie/memory-sync.ts:29-34,99`；`src/domain/fanqie/diagnostics.ts:147-154`；`src/domain/shared/anchors.ts:105-114`；`docs/02-domain-rules.md:39`；`src/client/workbench/plugins/fanqie.ts:84`
- **证据**：recordEvidence/bindExactEvidence 用 `body.slice(0,start).split(/\r?\n/).length` 计行（含空行）；computeParagraphDelta 用 `split(/\r?\n+/)`+过滤空行，标注 [P{j+1}]（只数非空段）；scanAiSlop 的 paragraphIndex=原始行号；文档与 UI 写的是『第 N 段』。网文常见『段间空一行』排版，同一位置在证据里是 point=7、在增量同步里是 P4。无基线首次同步时 deltaText 是整章原文，不带 [Pn] 标签，FACT_SYNC_SYSTEM 也未说明 point 的含义，模型只能猜。
- **影响**：知情锚点、证据锚点、伏笔 plantedPoint 落在错误段落；按段查询『人物此时所知』结果偏移，跨模块对照（诊断定位、证据回显）错位。
- **建议**：1) 在 domain/shared/anchors.ts 新增唯一真源 `splitChapterParagraphs(body)`（非空行=段）与 `pointAtOffset(body, offset)`；2) recordEvidence、bindExactEvidence、diagnostics、computeParagraphDelta、resolveAnchor 全部改用它；3) fact_sync 无论有无基线都以 `[P{n}]` 标注全文/增量，提示词写明 point=P 编号；4) 一次性迁移：对 author_evidence 用 quote_start 重新计算 point；5) 新增跨模块一致性测试（含空行排版样例）。

### FQ-03 · AI 提案不绑定基准修订：正文漂移后确认会写错证据并把未同步改动标为 clean
- **严重度 / 类别 / 工作量**：high / correctness / M
- **位置**：`src/application/proposal-service.ts:58-120`；`src/application/products/fanqie/proposal-decide.ts:135-258`；`src/application/products/fanqie/fact-sync.ts:221-292`
- **证据**：author_ai_proposals 只存 project_id/document_id/payload，不存生成时的 revision_id 或正文 hash。decideProposal(fact_sync) 用『当前』doc.body 绑定证据、markChapterMemoryClean(当前 body)：生成提案(R1)→作者继续改写(R2)→再确认，R1→R2 之间新增的设定永远不会进入同步，章节却显示 clean。chapter_review 观察条目也写入当前 revisionId 而非审阅时的版本。
- **影响**：记忆闭环出现『假干净』，后续写作冻结上下文缺事实；摘句定位到错误版本。
- **建议**：1) author_ai_proposals 增加 base_revision_id、source_sha256 列（迁移）；2) beginProposalGeneration 写入；3) decideProposal 对 fact_sync/chapter_review/summary 校验当前 revisionId，漂移时 refuse('proposal.decide','proposal-stale')，UI 提供『按当前正文重新生成』；如作者坚持应用，则 markChapterMemoryClean 使用 base 正文 hash（保持 dirty）；4) 测试：生成后改稿再确认 → 拒绝或保持 dirty。

### FQ-04 · Prefix 稳定区并不稳定：自动推荐卡片与按动态尾长度裁剪混入 Prefix
- **严重度 / 类别 / 工作量**：high / performance / M
- **位置**：`src/application/products/fanqie/library-mount.ts:184-221`；`src/application/products/fanqie/context.ts:200-203,312-344`；`src/workflow/context-slots.ts:97-164`；`test/sprint4-v2.test.mjs:69`
- **证据**：techniques（group=prefix）= 显式挂载 + queryTechniqueRecommendations 中 score≥85 的前 2 张未挂载卡；评分依赖 instruction 文本、pacing、chapterIndex<3（黄金三章 +60），每换一句指令或从第 3 章写到第 4 章 Prefix 字节就变。assembleContextBundle 的 maxShare 上限基于 availableForShares（含动态槽 framing 与非空槽数量），第二阶段按 medium/optional 档逆序裁剪时也会截断 prefix 组的 techniques/deconstructions，裁剪量取决于本章正文长度。现有测试只在小篇幅、同指令下断言 Prefix 相等。
- **影响**：README 与 V2.2 计划宣称的 Prefix Cache 命中在真实写作中大面积失效，长篇连写的输入成本无法降低；而且 Prefix 内容随正文长度漂移，作者难以解释。
- **建议**：1) Prefix 只放显式挂载（pin/include）且按稳定 id 排序；推荐卡移入 dynamic 槽『本章推荐技法（未挂载，仅参考）』或只在 context-preview 中展示；2) context-slots 把预算拆成 prefixBudget=f(tokenLimit)（与动态内容无关）和 dynamicBudget；第二阶段只裁剪 dynamic 组；prefix 超额时报告 overBudget，不静默截断；3) 新增性质测试：同一章不同 instruction、第 3/4 章、正文 500 字与 6000 字，stablePrefix 逐字节相等。

### FQ-05 · 未经挂载的技法卡被自动注入写作上下文，偏离作者主权
- **严重度 / 类别 / 工作量**：high / architecture / S
- **位置**：`src/domain/fanqie/library.ts:205-237`；`src/application/products/fanqie/library-crud.ts:205`；`src/application/products/fanqie/skill-importer.ts:303`
- **证据**：默认 priority=50（Skill 导入默认 65）；黄金三章 opening/hook +60、pacing 匹配 +80、标签命中每个 +45，阈值 85 很容易越过，于是前 3 章总会自动带入 2 张作者从未挂载的卡片。
- **影响**：作者看不出模型为什么换了写法，也和『一切采纳由作者决定』的定位冲突；与 FQ-04 叠加还会破坏缓存。
- **建议**：移除 resolveMountedLibraryForChapter 中的 recommended 自动注入；保留 context-preview 的推荐列表和『一键挂载到本章』。如作者希望保留，再加项目开关 controls.autoRecommend（默认关），开启时只注入 dynamic 槽。

### FQ-06 · 库条目与伏笔可被跨项目/跨作用域按 id 覆写；AI 提案 payload 可携带 id 与 projectId
- **严重度 / 类别 / 工作量**：high / security / S
- **位置**：`src/application/products/fanqie/library-crud.ts:148-171,210-236`；`src/application/products/fanqie/lore.ts:387-420`；`src/application/products/fanqie/proposal-decide.ts:166-189`
- **证据**：persistTechniqueCard/persistDeconstruction 接受 input.id 直接 `ON CONFLICT(id) DO UPDATE`，不校验已有行的 scope/project_id：项目 A 用全局卡 id 以 scope=project 保存就会改写全局卡正文，删除全局卡时会静默删除所有项目的挂载。decideProposal 把 `...edited`（模型输出）原样传入，模型可回传 id/priority/scope；projectId 优先取 input.projectId，可把 A 项目的提案应用到 B 项目。upsertForeshadow 同样 `ON CONFLICT(id)`，不校验 project_id。
- **影响**：DsH Agent 的 3 个提案工具与导入包都是半可信输入，一次误确认就可能污染全局库或他书伏笔。
- **建议**：1) 写库前若 id 已存在，要求 existing.scope/project_id 与本次一致，否则 invalid('id','scope-mismatch')；2) AI 来源 payload 白名单字段（删除 id/scope/projectId/priority/status）；3) decideProposal 的 projectId 固定为 row.projectId；4) upsertForeshadow 在 ON CONFLICT 中加 `WHERE author_foreshadows.project_id = excluded.project_id`，并检查 changes；5) 全局卡删除改为软归档（status='archived'）并给受影响项目写事件。

### FQ-07 · setting 提案缺 documentId 时回落到第一章生效，导致早期章节人物『提前知情』
- **严重度 / 类别 / 工作量**：high / correctness / S
- **位置**：`src/application/products/fanqie/proposal-decide.ts:206-229`
- **证据**：`const fallbackChapterId = row.documentId ?? ctx.chapterOrder(projectId)[0]`，commitFactBatch 再以该章作为 effectiveFrom 与 knownFrom。第 50 章提取的设定会从第 1 章起生效。
- **影响**：违反『角色 B 在第 12 章前绝不能提前知情』这一核心壁垒，冻结上下文会把未来信息喂给前文改写。
- **建议**：没有 documentId 时拒绝（invalid('documentId','chapter-required')），或要求作者在确认 UI 中选择生效章；测试覆盖。

### FQ-08 · 『标记已在当前章回收』会清空伏笔预定回收章与埋设段；伏笔状态无转换约束
- **严重度 / 类别 / 工作量**：high / bug / S
- **位置**：`src/client/workbench/views/worldbook-view.ts:257-273`；`src/application/products/fanqie/lore.ts:387-420`；`src/application/products/fanqie/fact-sync.ts:153-205`
- **证据**：worldbook-view 调用 foreshadow.upsert 时不传 targetChapterId/plantedPoint；upsertForeshadow 对缺省字段取 null/1，并在 ON CONFLICT 中整行覆盖。commitForeshadowBatch 与 upsertForeshadow 都允许 resolved→planted、abandoned→hinted 任意跳转；fact_sync 新建伏笔的 planted_point 固定为 1。
- **影响**：伏笔账本丢数据，related-chapters 的『伏笔预定回收章』维度与 stale-foreshadow 超期判断失效。
- **建议**：1) 拆成 foreshadow.create 与 foreshadow.patch（只更新传入字段）；2) domain/fanqie/lore.ts 新增 FORESHADOW_TRANSITIONS（proposed→planted→hinted→resolved，任意→abandoned，resolved/abandoned→planted 需 reopen:true），upsert 前校验；3) fact_sync 的 foreshadowUpdates 支持 point；4) UI 回收时只发 {id,status,resolvedChapterId}。

### FQ-09 · 平铺章序与卷/幕树是两套真源，上移/下移、挂树、拖动会互相覆盖并绕过影响门
- **严重度 / 类别 / 工作量**：high / correctness / M
- **位置**：`src/client/workbench/plugins/fanqie.ts:275-305`；`src/application/products/fanqie/lore.ts:167-185`；`src/application/products/fanqie/tree.ts:107-149,77-105`；`src/application/products/fanqie.ts:200-227`
- **证据**：move-up/down 基于 snapshot.documents 交换后走 reorder.commit，只写 author_chapter_order，不改 volume_id/act_id，可以把第二卷的章挪到第一卷前面。之后任何 attachChapterToTree（新建章挂卷）都会 flattenNovelOrder 重新分组并 saveFlatOrder，既不做 planReorder 影响检查，也只发 chapter.moved 而不发 chapter.reordered；settings-view 读模型只监听 document.created/chapter.reordered，顺序与真实章序分叉。
- **影响**：作者确认过的章序被静默还原，知情翻转门被绕过；事件回放的 settings-view 与 settings.read 结果不一致（违背文档『三处结果完全一致』的承诺）。
- **建议**：1) 规定唯一真源：树（卷 sort/幕 sort/组内 rank），平铺序始终由 flattenNovelOrder 派生；2) reorder.commit 拒绝跨组移动（或同时更新归属），上移/下移改用 chapter.move{beforeChapterId}；3) attachChapterToTree 走 applyHierarchyOrderChecked，并在顺序变化时发 chapter.reordered；4) 测试：跨卷上移→新建章→顺序与读模型保持一致。

### FQ-10 · fact_sync 新事实的 factId 由模型自取，与已有事实同名时会静默变成新版本
- **严重度 / 类别 / 工作量**：high / correctness / M
- **位置**：`src/workflow/writing-budget.ts:22-23`；`src/application/products/fanqie/fact-sync.ts:116-136`；`src/client/workbench/views/worldbook-view.ts:146-161`
- **证据**：FACT_SYNC_SYSTEM 要求返回 newFacts[].factId，服务端直接 text(item,'factId') 入库。模型容易复用『f1』『主角身份』这类 id，和已有不同实体的事实撞车，等于覆盖（只有 locked 会拒绝）。UI 勾选列表只显示 entityName/note，不提示『将覆盖已有事实 X』。
- **影响**：设定库被不同实体的内容覆盖；配合 FQ-01 会抹掉知情史。
- **建议**：1) 提示词改为 newFacts（不带 id，由服务端生成 `fq-<短 uuid>`）与 updates（必须引用 existingLoreHints 中的 factId）两类；2) decide 时 updates 的 factId 必须已存在，newFacts 的 id 必须不存在；3) UI 分区展示『新增』与『更新（含 diff）』。

### FQ-11 · 工程包超过 999 章后排序错乱；导入忽略 manifest 中的章序
- **严重度 / 类别 / 工作量**：medium / bug / S
- **位置**：`src/application/products/fanqie/io.ts:28-30,83`；`src/application/products/fanqie/io.ts:388-395,492-501`
- **证据**：章文件名 `padIndex(idx+1, 3)`，导入时按 `a.path.localeCompare(b.path)` 排序决定 importedChapterOrder：'1000_x' 会排到 '100_' 与 '101_' 之间。manifest.chapters 自带顺序但导入没有使用。
- **影响**：README 宣称支持 5000 章级项目，导出再导入后章序会被打乱，进而触发大量知情翻转。
- **建议**：宽度改为 max(4, String(total).length)；导入时有 manifest 就按 manifest.chapters 顺序，没有才按自然排序（数字前缀按 parseInt 比较）；加 1200 章往返测试。

### FQ-12 · Markdown 工程包号称无损，实际丢失设定版本史、Skill 元数据与写作控制面
- **严重度 / 类别 / 工作量**：medium / feature-gap / L
- **位置**：`src/application/products/fanqie/io.ts:40-161`；`src/application/products/fanqie/io.ts:503-553,715-766`
- **证据**：导出的 lore 只来自 author_lore_current（每个事实只有最新版本），多版本有效期链丢失；settings.md 不含 knownFrom/effectiveTo。导入技法卡时丢 asset_kind/stage_bindings/references_json（Skill 退化成普通技法、阶段绑定变成 write）；章节 state/final_revision、editorial_rejections、author_project_controls、slop 配置、observations、evidence 都不导出；io.ts:829-831 的 `void refuse` 是死代码。
- **影响**：用 Git/网盘备份的工程无法完整还原；跨设备迁移会丢失作者确认过的时间线。
- **建议**：引入 format v2：导出 author_settings 中 approved 的全部版本（按 decided_seq）、controls、slop、chapter state（导入时 final 只作为提示，不自动锁定）、evidence（按 quote 重定位）；导入保留 assetKind/stageBindings/references 并校验 pacing/category；v1 包继续兼容读取；补齐往返等价测试（导出→导入→再导出，manifest 语义相等）。

### FQ-13 · 番茄写作只有一个通用 WRITER_SYSTEM，缺少任务模式与番茄方法论
- **严重度 / 类别 / 工作量**：medium / feature-gap / M
- **位置**：`src/workflow/writing-budget.ts:4-5`；`src/application/products/fanqie/context.ts:471-499`；`src/client/workbench/views/diagnostics-panel.ts:210-229`
- **证据**：createFanqieGenerationRunner 不论 stage 是 write/refine/deslop 都用 phase 'write' 和同一句通用 system（『只返回候选正文』）；续写、整章重写、按观察条目定向修改只能靠作者在 instruction 里写清楚。定向修稿的 instruction 是硬编码的中文句子；PACING 的 opening/payoff 指南从未进入提示词；AI 味词表只在选段润色中用到。
- **影响**：候选稿经常整章改写（与『保留作者 70%』的目标相反）；节奏与章末钩子没有约束，质量依赖模型的默认风格。
- **建议**：保持轻量：新增 3 段模板常量（FANQIE_SYSTEM_CONTINUE / REWRITE / TARGETED），由 stage 和是否有 observationIds 选择；在 dynamic 槽加入『本书节奏档说明』（来自 PACING）与『禁用套话 Top10』（scanAiSlop 默认库+项目自定义）；定向修稿要求逐段保留未提及段落，并在 diff 视图默认只勾选变化段。这些都是纯提示词，不新增流程引擎。

### FQ-14 · 节奏档/题材在 UI 与项目层完全缺失，相关逻辑实际不生效
- **严重度 / 类别 / 工作量**：medium / feature-gap / M
- **位置**：`src/domain/fanqie/editorial.ts:10-14`；`src/client/workbench.html`；`src/application/products/fanqie/library-mount.ts:142-170`；`src/domain/fanqie/diagnostics.ts:198-246`
- **证据**：全仓只有 shell.ts:453（示例书技法）传了 pacing；start-run 表单没有 pacing 字段，项目也不存题材或节奏档。rankTechniquesForChapter 的节奏匹配维度、validatePacingLabel 实际都用不上；黄金三章诊断用固定的爽文关键词（退婚/系统/跪/杀），对悬疑、言情、种田类开篇系统性低分。
- **影响**：番茄不同频道的开篇与爽点节奏差异最大，现在是一刀切。
- **建议**：author_project_controls 增加 pacing_tier（快爽/稳推/慢燃）与 genre_tags；新书向导第 1 步选择；context 构建、推荐、诊断都从 controls 读取；诊断的钩子与冲突关键词按节奏档切换词表（悬疑用『异常/尸/失踪/门锁』之类，言情用『婚/离/误会/重逢』之类）。节奏档本身是已有的软建议词表，只是接通，不改语义。

### FQ-15 · 黄金三章离线诊断的几处计分缺陷
- **严重度 / 类别 / 工作量**：medium / correctness / S
- **位置**：`src/domain/fanqie/diagnostics.ts:198-346`；`src/application/products/fanqie/diagnostics.ts:81-96`
- **证据**：options.targetLength 已经传入但从未使用，字数带固定为 1500–6000；HOOK/CONFLICT 关键词包含单字『死、杀、滚、血、惊、竟、却』，按子串命中（『死板』『却说』都算）；对白正则只认“”「」和 ASCII 双引号，不认『』‘’；同一个长段落会同时扣信息倾泻（≥260 字）和段落墙（>160 字）两次分；isGoldenThreeChapter 只是一个标记，第 4 章以后照样计算并展示黄金三章总分（UI 只在 isGolden 时显示，但 warnings 仍会产出）。
- **影响**：分数波动大、误报多，作者会逐渐忽略体检结果。
- **建议**：字数维度改为以章纲 target 为中心 ±25%（无 target 时回退 2000–2500 建议带，1500–6000 只作提醒）；单字关键词改为词边界的双字词表并支持项目自定义；补全引号；长段只按更严重的一项扣分；非黄金三章只输出节奏与字数两项。全部保持零 Token 纯函数并补表驱动测试。

### FQ-16 · AI 味扫描：短语重叠重复计数，中性词误报
- **严重度 / 类别 / 工作量**：medium / correctness / S
- **位置**：`src/domain/fanqie/diagnostics.ts:23-196`
- **证据**：『命运的齿轮』与『仿佛命运的齿轮开始转动』『眼中闪过一丝』『一丝不易察觉的』等存在包含关系，逐条 indexOf 会在同一位置命中多次；『与此同时』『事实上』『下意识地』『不由自主地』在正常叙述中很常见；对白里的口头禅也计入。所有命中等权，『千字 7 次』即判 high，阈值没有依据。外部报道中读者识别 AI 文的三大特征之一是『句子长短过于均匀』，现有扫描没有覆盖。
- **影响**：密度虚高，白名单负担重；最能体现『AI 腔』的句长单调没有被测到。
- **建议**：1) 先按长度降序做非重叠最长匹配（标记已占用区间）；2) 给类别加权（summary_connector 0.5、cliche 1.0、custom 1.0），提供『排除对白』选项；3) 新增零 Token 指标 sentenceLengthCV（句长变异系数）和连续同长度句计数，作为『节奏单调』提示；4) 阈值按加权密度重新标定，并用 3 份人工样章做基线测试。
- **参考**：https://www.cnblogs.com/txgg/p/22927972

### FQ-17 · 审稿 Observation 的摘句不校验，修订后不会失效；UI 只能整包确认
- **严重度 / 类别 / 工作量**：medium / correctness / S
- **位置**：`src/application/products/fanqie/diagnostics.ts:98-141`；`src/application/products/fanqie/proposal-decide.ts:232-245`；`src/client/workbench/views/diagnostics-panel.ts:152-170,265-267`
- **证据**：insertObservationsBatch 原样存入模型给的 quote，不检查它是否在正文中出现；README 宣称『带原文摘句举证』。正文修改后，旧观察依然是 open 状态并被默认全选进入定向修稿；diagnostics-panel 的『确认录入观察』不传 selectedObservationIndices（后端支持，UI 没接）。
- **影响**：幻觉摘句会误导定向修稿；作者无法逐条取舍审稿意见。
- **建议**：确认时对 quote 做精确唯一匹配（复用 recordEvidence 逻辑），匹配不到的标 verified=false 并在 UI 灰显；observation 记录 revision_id，渲染时如果 quote 已不在当前正文则显示『已过期』且不默认勾选；审稿提案 UI 逐条勾选后再提交。

### FQ-18 · 5000 章规模下上下文构建与连续性检查的复杂度
- **严重度 / 类别 / 工作量**：medium / performance / M
- **位置**：`src/application/products/fanqie/context.ts:206-250`；`src/domain/fanqie/related-chapters.ts:115-169`；`src/domain/fanqie/lore.ts:145-161`；`src/application/products/fanqie/memory-sync.ts:195-226`；`src/application/context.ts:248-256`；`src/client/workbench/plugins/fanqie.ts:439-443`
- **证据**：每次 run.start / context.preview 都会：全量读取 author_chapter_entities 与全部章节行；approvedFacts 返回所有历史版本，rankRelatedChapters 对每个候选章遍历全部事实（O(C×F)）；activeForeshadows 在 filter 中调用 order.indexOf（O(F×N)）。detectLoreConflicts 对每个章纲 × 每个 factId 新建正则（O(O×F)）。每次批准设定都会在写事务内扫描全书正文刷新实体提及。chapterOrder 每次调用都解析 5000 个 id 的 JSON。前端在 asOfSeq 每次变化（含每次保存）时都重新请求 context.preview 与诊断。
- **影响**：百万字项目里一次预览可能达到秒级并占用写锁，保存时卡顿；大书的『零 Token 本地计算』实际成为瓶颈。
- **建议**：1) 先构建一次 Map：chapterId→相关事实，position Map 替代 indexOf；2) lockedFacts 先按 [A-Za-z0-9_-]+ 切词再查 Set，代替逐个 new RegExp；3) refreshEntityMentionsForFact 先用 fts_chapters trigram 查出候选章，只扫描命中的章；4) chapterOrder 与 approvedFacts 一样按 currentSeq 做 memo；5) 前端 preview 只在切换文档、显式点击或停止输入 1.5 秒后刷新；6) workspace-bench 增加 5000 章 / 3000 事实场景，目标 context.preview p95 < 300ms。

### FQ-19 · 实体提及按纯子串计数且不支持别名
- **严重度 / 类别 / 工作量**：medium / correctness / S
- **位置**：`src/application/products/fanqie/memory-sync.ts:16-27,166-187`
- **证据**：countOccurrences(body, name) 是子串匹配：『李四』会命中『李四海』，『林远』会命中『林远山』；没有别名/称谓（『师父』『老林』）；名字少于 2 字直接跳过。
- **影响**：相关章召回的角色维度与多角共现评分不准，长篇里常见的称谓切换完全丢失。
- **建议**：lore 条目增加 aliases（字符串数组，存在 value JSON 中，无需新表）；计数时把所有名字和别名合并，按长度降序做非重叠最长匹配；UI 在设定编辑中提供别名输入。

### FQ-20 · 设定无法通过记忆同步失效或撤回
- **严重度 / 类别 / 工作量**：medium / feature-gap / S
- **位置**：`src/workflow/writing-budget.ts:22-23`；`src/workflow/writing-stages.ts:117-165`；`src/application/products/fanqie/memory-sync.ts:116-122`
- **证据**：fact_sync 的 schema 只有 newFacts/knownFromUpdates/foreshadowUpdates/summaryDraft；作者删掉『某人已死』的段落后，delta 只给出『[段落删减]』文字，没有任何结构化通道可以给事实加 effectiveTo 或撤回。
- **影响**：改稿后设定库只增不减，冻结上下文持续注入已经被作者推翻的事实。
- **建议**：schema 增加 retiredFacts: [{factId, point, reason}]，确认后生成带 effectiveTo=本章@point 的新版本（复用 mergeFactVersion）；validator 与 UI 同步更新。

### FQ-21 · 伏笔生命周期建模不足：无预定回收章入口，超期判断参照全书总章数
- **严重度 / 类别 / 工作量**：medium / feature-gap / M
- **位置**：`src/client/workbench/views/worldbook-view.ts:92-110`；`src/domain/fanqie/lore.ts:163-190`；`src/application/products/fanqie/context.ts:205-226`
- **证据**：登记伏笔只能填标题，没有 targetChapterId；stale-foreshadow 用『全书章数−1−埋设位置 ≥ 25』判断，包含尚未写的计划章，并非当前写作进度；hinted 不记录推进章；冻结上下文只罗列全部活跃伏笔，没有突出『本章预定回收』。
- **影响**：伏笔提醒要么漏报要么噪声大；作者最需要的『写到第 278 章提醒第 15 章那条线该收了』无法实现。
- **建议**：UI 增加预定回收章与预计回收区间；stale 改为相对『当前章』与『最后有正文的章』计算，阈值进项目 controls；context 增加高优先级行『本章预定回收：X（埋于第 N 章）』；hinted 时追加 hinted_chapter_ids（JSON 列）。

### FQ-22 · 章序影响分析不包含伏笔与章纲锁定事实
- **严重度 / 类别 / 工作量**：medium / correctness / S
- **位置**：`src/application/products/fanqie/shared.ts:42-54`；`src/application/products/fanqie/lore.ts:73-78`；`src/application/products/fanqie/tree.ts:96,420`
- **证据**：reorderRelations 只从已批准事实构造『设定有效期』与『X 知晓』两类关系；author_foreshadows 的埋设→预定回收/已回收、章纲 lockedFacts 引用、证据锚点都不参与 planReorder。
- **影响**：移动章节可能让回收章跑到埋设章之前，而确认弹窗显示『未翻转任何关系』。
- **建议**：reorderRelations 增加伏笔关系（planted→resolved/target，标签『伏笔「标题」回收』）；章纲 lockedFacts 引用的事实，如果在新顺序下未生效，作为 warning 一并展示；补测试。

### FQ-23 · 滚动幕规划的上下文与提交逻辑问题
- **严重度 / 类别 / 工作量**：medium / bug / S
- **位置**：`src/application/products/fanqie.ts:393-435`；`src/workflow/writing-budget.ts:28-29`；`src/workflow/writing-stages.ts:189-198`；`src/application/products/fanqie/controls.ts:48-129`；`src/client/workbench/views/outline-board.ts:209-235`
- **证据**：recentChapters 用 `ORDER BY rowid DESC LIMIT 12`（创建顺序，不是叙事顺序，重排或导入后就错了）；ARC_PLAN_SYSTEM 只写『只返回 JSON』，没有字段约束，validator 却接受 chapterBeats，commit 时又忽略它；新幕总是追加到卷末（max sort_order+1），不在目标幕之后；UI 只能整包接受或拒绝，不能修改标题或目标。
- **影响**：滚动规划依据错误的『最近章节』，产出的结构也不稳定。
- **建议**：改用 chapterOrder 取当前幕或目标幕之前的 12 章；system 中写明 JSON 字段（actSummary/nextActTitle/nextActGoal/nextActSummary/pacingTemplate/currentFocus）；删除 chapterBeats 或落地为章纲草案提案；新幕插入到目标幕之后；UI 接受前允许编辑。

### FQ-24 · 审稿与选段改写的知情查询固定在章首（point=1）
- **严重度 / 类别 / 工作量**：medium / correctness / S
- **位置**：`src/application/products/fanqie.ts:369,464`；`src/application/products/fanqie/context.ts:137-143`
- **证据**：chapter_review 与 selection.rewrite 都用 anchor(doc.id, 1) 计算 knownFacts，本章中途刚获知的事实被排除；审稿 OOC 判断与选段改写会把合理的知情当成越界，或者漏掉越界。
- **影响**：OOC 与知情边界提示在本章后半段失真。
- **建议**：审稿使用章末锚点（段数+1）并在 extra 中给出『本章内新知情』列表；选段改写用选区所在段号（pointAtOffset(selectionStart)）。

### FQ-25 · 番茄章节状态机没有显式的转换表（🔒 需作者授权）
- **严重度 / 类别 / 工作量**：medium / maintainability / S
- **位置**：`src/domain/fanqie/editorial.ts:4-23`；`src/application/products/fanqie.ts:160-198,308-313`；`src/application/products/fanqie/io.ts:458-462`；`docs/02-domain-rules.md:15-26`
- **证据**：头条有 ARTICLE_TRANSITIONS 加 assertArticleTransition；番茄的转换散落在 onDraftSaved、reviewChapter、finalizeChapter 与 io 导入中（io 里重复了一份 onDraftSaved 逻辑）。reviewChapter 没有走 ctx.dispatch（没有幂等），assertChapterFinalizable 检查的是 `editorialRejections > 2`，这个值由 reviewChapter 保证永远不会出现。现状与 docs 状态图一致，但没有表驱动测试守住。
- **影响**：将来改动容易无意中改变受保护的状态语义。
- **建议**：只做编码，不改语义：在 domain/fanqie/editorial.ts 新增 CHAPTER_TRANSITIONS（逐条照抄 docs/02 的状态图）与 assertChapterTransition；各处改为调用它；io 导入复用 onDraftSaved；加表驱动测试。转换表需要作者逐条确认后冻结。

### FQ-26 · 缺少『AI 参与度/创作过程』存证，作者面对平台审核难以自证
- **严重度 / 类别 / 工作量**：medium / feature-gap / M
- **位置**：`src/application/run-service.ts:176-208`；`src/storage/command.ts`；`src/client/workbench/views/run-inspector.ts`
- **证据**：系统已经有完整的修订链、候选采纳事件（adoptionMode full/partial）和作者手动保存记录，但没有任何汇总。公开报道称番茄 2026 年 7 月单月处置 AI 低质内容约 5.4 万本，打击重点是『整章一键生成、只做少量修改』，同时建议作者保留大纲和改稿过程作为自证材料。
- **影响**：织章本来最能证明『作者主导』，这块数据却没有利用起来。
- **建议**：零 Token 计算每章指标：首次出现于采纳候选稿的字符占比、采纳后作者再编辑的字符量、手写保存次数、章纲/设定是否由作者确认；在章节头部和导出包中输出《创作过程报告》（只做统计，不做判定）。数据全部来自现有表，不新增流程。
- **参考**：https://www.cnblogs.com/txgg/p/22927972

### FQ-28 · SKILL.md 导入的兼容性与注入方式
- **严重度 / 类别 / 工作量**：medium / feature-gap / S
- **位置**：`src/application/products/fanqie/skill-importer.ts:33-43,282-305`；`src/application/products/fanqie/context.ts:27-46`；`src/client/workbench/views/library-view.ts:73-118`
- **证据**：frontmatter 解析不支持 YAML 块标量（`description: |` 或 `>-` 会被解析成『|』）；未知 pacing 直接抛错，导致社区 Skill 导入失败；category 不校验；正文最多 128 KiB 会整段注入 Prefix，再被 techniques maxShare 0.18 静默截掉尾部；没有利用标准里 name/description 的渐进加载；UI 只能粘贴单个 SKILL.md，不支持 references 或文件夹（后端已支持）。
- **影响**：长 Skill 尾部的关键约束会被截断；常见格式的 Skill 无法导入。
- **建议**：保持轻量：1) 支持 | 和 > 块标量；2) 未知 pacing/category 降级为警告并置空；3) 注入时只放 description 加正文前 N 字（N 由作者在卡片上设置，默认 1500），全文留在预览里；4) 导入 UI 用文件夹选择器复用 io-view 的 webkitdirectory 读取 SKILL.md 与 references/。
- **参考**：https://atlan.com/know/ai-agent/ai-agent-skills/skill-md-file-explained/ https://learn.microsoft.com/fil-ph/agent-framework/agents/skills

### FQ-29 · CJK token 估算比 DeepSeek 实际高约 2.3 倍，导致上下文被过度裁剪
- **严重度 / 类别 / 工作量**：medium / performance / M
- **位置**：`src/workflow/writing-budget.ts:41-59`；`src/application/products/fanqie/context.ts:146-149`
- **证据**：estimateTokenCount 对汉字按 1.4 token 计；DeepSeek 官方文档给出的经验值约为 1 个汉字 ≈ 0.6 token。maxInputTokens=tokenLimit×0.72 再按 1.4 估算，相当于实际可用上下文只用了不到一半，rollingSummaries/relatedHistory 被提前裁掉。
- **影响**：长篇写作最需要的前情与远期召回被挤掉；同时预算建议偏高。
- **建议**：保留保守估算作为冷启动默认值，在 recordGenerationReceipt 时按 provider/model 记录『实际 input ÷ 估算』的指数移动平均（例如存入 author_project_controls 或新的 kv 表），之后乘以校准系数（下限 0.35，并留 15% 安全余量）。需要和 DsH/数据库视角配合。
- **参考**：https://api-docs.deepseek.com/quick_start/token_usage

### FQ-27 · 没有日更与字数里程碑追踪
- **严重度 / 类别 / 工作量**：low / feature-gap / S
- **位置**：`src/application/products/fanqie/tree.ts:151-199`；`src/client/workbench/views/outline-board.ts:108-113`
- **证据**：目录树只显示总字数，没有按日统计的产出，也没有签约字数节点提示。二手资料称番茄全勤档为日更 4000/6000 字，2 万字与 8 万字是常见的签约节点（以作者后台最新规则为准）。
- **影响**：连载作者的日常目标管理需要另开表格。
- **建议**：用 revisions.created_at 加正文字数增量做零 Token 的日产出统计（今日/近 7 日），项目 controls 中设置日目标；里程碑做成可配置提醒，不硬编码平台条款（遵守 01-overview『不固化易变的平台条款』）。
- **参考**：https://wenku.baidu.com/aggs/c4032f2d4b73f242336c5f86.html https://linux.do/t/topic/2954668

### FQ-30 · 番茄 UI 的若干可用性问题
- **严重度 / 类别 / 工作量**：low / ux / M
- **位置**：`src/client/workbench/views/outline-board.ts:297`；`src/client/workbench/views/worldbook-view.ts:162,232`；`src/client/workbench/views/library-view.ts:129`；`src/client/workbench/plugins/fanqie.ts:59-60,460-463`；`src/client/workbench/views/outline-board.ts:427`
- **证据**：大纲板直接显示英文 state（drafting）；设定库『生效章』显示章节 UUID；提案以原始 JSON <pre> 呈现；fact_sync 只能勾选 newFacts，knownFrom/伏笔更新只能全收；审稿按钮硬编码『/ 2』；provider/model 默认值『deepseek-flash』散落在 3 处；大纲板不能编辑四段式章纲。
- **影响**：作者理解成本高，容易误点。
- **建议**：统一 stateLabels 与章节标题映射；提案改为结构化卡片加逐项勾选和编辑；EDITORIAL_REJECTION_LIMIT 从 snapshot 下发；provider/model 读取 settings；大纲板展开项内嵌四段式章纲编辑。

### FQ-31 · 三步开新书不是原子操作，题材种子包也偏少
- **严重度 / 类别 / 工作量**：low / ux / S
- **位置**：`src/client/workbench/views/new-book-wizard.ts:52-127`；`src/client/workbench/seed-packs.ts:27-142`
- **证据**：向导依次发 project.create、controls.save、volume.create、document.create×N、draft.save、technique.save、library.mount 共 8 到 10 个请求，中途失败会留下半成品项目。番茄种子包只有都市/玄幻/悬疑 3 套，没有番茄流量较大的女频言情、年代种田、系统流。
- **影响**：首次体验出错的代价高。
- **建议**：新增服务端动作 project.bootstrap，一个事务完成全部创建；种子包新增 2 到 3 套（技法内容仍是纯数据，作者可编辑）。

### FQ-32 · 番茄相关测试集中在少数按 Sprint 命名的大用例中
- **严重度 / 类别 / 工作量**：low / testing / M
- **位置**：`test/sprint1-v2.test.mjs`；`test/sprint2-v2.test.mjs`；`test/sprint3-v2.test.mjs`；`test/sprint4-v2.test.mjs`；`test/context-kernel-v2.test.mjs`
- **证据**：sprint2/3 分别只有 5/7 个 test()，却有 600 到 790 行，一个用例里串起多个模块的断言；本报告 FQ-01/02/03/04/06/07/08/09/10/11 这类缺陷都没有回归用例覆盖（例如 Prefix 稳定性只测了理想场景）。
- **影响**：定位失败困难，问题很容易回归。
- **建议**：按行为拆分为 test/fanqie-{memory,anchors,library,io,context,tree}-v2.test.mjs；每个 P0/P1 修复都配一个最小复现用例；新增性质测试（Prefix 字节稳定、导出导入往返等价、point 一致性）。注意 AGENTS.md 要求报告的用例总数与实际一致。

### FQ-33 · 文档与注释漂移
- **严重度 / 类别 / 工作量**：low / docs / S
- **位置**：`src/domain/fanqie/index.ts:1-6`；`src/application/products/fanqie/io.ts:829-831`；`README.md`；`docs/zhizhang_v2_2_optimization_plan.md:43,77`
- **证据**：domain/fanqie/index.ts 头注释仍写着『只导出冻结的 B.8 部分』，实际已导出全部模块；V2.2 计划声称 Prefix『禁止本章变动信息混入』、工程包『无损幂等』，与 FQ-04、FQ-12 不符；io.ts 中有死代码。
- **影响**：后续协作者会按文档做出错误判断。
- **建议**：修复完成后同步 README、docs/02、docs/04 与计划文档的状态列，删除死代码，更新头注释。

### FQ-34 · 全局库变更不产生项目事件，导致其他项目快照不刷新
- **严重度 / 类别 / 工作量**：low / correctness / S
- **位置**：`src/application/products/fanqie/library-crud.ts:178,247,298,345`
- **证据**：scope=global 的保存与删除只在有 projectId 时写事件；全局卡被改写或删除（同时删掉所有项目的挂载）后，各项目的 asOfSeq 不变，前端 ifSequence 轮询返回 unchanged，上下文预览仍显示旧内容。
- **影响**：多书共用技法库时状态不一致。
- **建议**：全局变更时对挂载了该条目的所有项目写 library.global.changed 事件（查 author_library_mounts 去重 project_id）；或在 snapshot 中增加 library 版本水位。

## 五、分阶段路线图

### P0 · 连续性数据正确性止血（约 5–7 人日）
- 目标：保证设定、知情、证据、伏笔与提案确认不会静默写错数据
- 包含：FQ-01、FQ-02、FQ-03、FQ-06、FQ-07、FQ-08、FQ-10
- 退出标准：
  - 新增回归测试全部通过：ch3 已知 → ch10 更新后 settingsAt(ch5) 仍可见；无 documentId 的 setting 提案被拒绝；回收伏笔后 targetChapterId 保留
  - point 一致性测试：含『段间空行』的样章中，evidence.point、fact_sync [Pn]、诊断 paragraphIndex、resolveAnchor 指向同一段
  - 生成提案后修改正文再确认 fact_sync，返回 proposal-stale 或保持 dirty
  - 跨项目 id 覆写、AI payload 携带 id/projectId 的攻击用例全部被拒绝
  - npm run test:all 全绿，报告的用例数与 test/*.test.mjs 实际总数一致

### P1 · 章序真源统一与 Prefix 缓存兑现（约 6–8 人日）
- 目标：树是唯一章序真源；Prefix 字节稳定；大书性能达标
- 包含：FQ-04、FQ-05、FQ-09、FQ-11、FQ-18、FQ-22、FQ-24、FQ-25
- 退出标准：
  - 性质测试：不同 instruction、第 3/4 章、500 字与 6000 字正文下，stablePrefix 逐字节相等
  - 跨卷移动 → 新建章挂卷后，ctx.chapterOrder 与 settings-view 读模型顺序一致；绕过影响门的路径为 0
  - 1,200 章导出→导入往返后章序不变
  - workspace-bench 新增 5000 章 / 3000 事实场景：context.preview p95 < 300ms，draft.save p95 < 80ms
  - CHAPTER_TRANSITIONS 经作者确认冻结，表驱动测试覆盖 docs/02 中每条边

### P2 · 写作方法论与质检提质（约 6–8 人日）
- 目标：以轻量提示词模板和零 Token 规则提高候选稿质量、降低误报
- 包含：FQ-13、FQ-14、FQ-15、FQ-16、FQ-17、FQ-19、FQ-20、FQ-21、FQ-23、FQ-28、FQ-29
- 退出标准：
  - 续写/重写/定向修稿三种模式有独立模板，model-check 回放下定向修稿中未提及段落的保留率 ≥ 90%
  - 项目可设置节奏档；诊断、推荐、上下文三处均读取该设置，并有对应测试
  - AI 味扫描对 3 份人工基线样章的误报 ≤ 1 次/千字；新增句长变异系数指标
  - 无法匹配的观察摘句被标记 unverified，修订后的旧观察显示『已过期』
  - Token 校准系数在有回执后生效，并在 context-preview 中展示『估算 vs 实际』

### P3 · 作者体验与生态（约 6–10 人日）
- 目标：无损迁移、过程存证、日更管理与 UI 打磨
- 包含：FQ-12、FQ-26、FQ-27、FQ-30、FQ-31、FQ-32、FQ-33、FQ-34
- 退出标准：
  - format v2 往返等价：导出→导入→再导出，manifest 语义 diff 为空（v1 包仍可读取）
  - 每章可查看《创作过程报告》（采纳占比、采纳后编辑量），并随导出包输出
  - project.bootstrap 单事务；故障注入下不留半成品项目
  - 番茄测试按行为拆分完成，docs 与 README 状态同步

## 六、需要其他视角配合的事项

- [DsH 插件] host/plugin.ts 的 proposal.generate 对所有提案统一 maxOutputTokens=2400；6000 字章节的 chapter_review 或含较多事实的 fact_sync 很容易被截断，进而 stage.output_invalid。建议按 kind 配置（review/fact_sync 4000+），并结合 finishReason=length 生成 recoveryHints。
- [DsH 插件] FQ-04 修好后，还要确认 host/writing.ts 是否真正把 cachePrefix 作为 messages 的首段字节原样发送（DeepSeek 的上下文缓存按前缀匹配），并在 run-inspector 中展示 cache_read 命中率以验证。
- [数据库] 需要的迁移：author_ai_proposals 增加 base_revision_id/source_sha256；author_project_controls 增加 pacing_tier/genre_tags/daily_goal/token_calibration；author_foreshadows 增加 hinted_chapter_ids；按新的 point 语义回填 author_evidence.point。都需要走 migrations.ts。
- [数据库] 章序唯一真源（FQ-09）要调整 author_chapter_order 的定位：改为派生缓存，或增加组内 rank 列；同时影响 workflow/author-reads 的读模型投影事件。
- [数据库] FQ-18 中实体提及的增量刷新依赖 fts_chapters trigram 查询的可用性；对 author_chapter_entities(project_id, entity_name) 补索引。
- [前端] context.preview 与诊断的触发频率（每个 asOfSeq 都触发）需要在 shell 层统一节流；提案 UI 的结构化渲染与逐项勾选可以复用 diff-view 的勾选组件。
- [头条] WRITER_SYSTEM 由两条线共用；FQ-13 应新增番茄专用常量，而不是修改共享常量，以免影响头条的 QA 管线。
- [前端/头条] 本报告确认了前期结论：provider/model 默认值硬编码分布在 plugins/fanqie.ts、outline-board.ts 等多处，应统一由 settings 下发。

## 七、待作者确认的问题

1. point 的唯一语义是否确定为『非空行为一段』？已有证据是否允许按 quote_start 自动回填（会改变已存 point 值）？
2. 设定合并时，同一角色的 knownFrom 是否一律『取更早者』？是否存在需要『推迟知情』的场景（例如失忆）需要显式操作？
3. known-before-effective（角色在设定生效前就知情，如预言、计划中的事件）目前是 error，是否应降级为 warning？
4. 推荐但未挂载的技法卡：完全不自动注入，还是提供默认关闭的项目开关？
5. 漂移的提案：一律拒绝重生成，还是允许作者在看到 diff 后强制应用（此时保持 dirty）？
6. 番茄章节转换表（CHAPTER_TRANSITIONS）是否按 docs/02 状态图逐条冻结？审稿打回计数在定稿前是否始终不清零（受保护语义，仅确认，不建议改）？
7. 工程包 format v2 是否需要导出完整设定版本史与观察/证据？final 状态在导入到新项目时应恢复为锁定，还是只作提示？
8. 是否需要日更目标与签约里程碑提醒？如需要，里程碑数值由作者配置还是内置可编辑默认值？
9. Token 估算校准是否只对 DeepSeek 提供方生效，其他提供方继续使用保守 1.4 系数？
10. 是否接受新增 project.bootstrap 这类组合动作（会扩大 WorkspaceAction 面）？

## 八、与现有计划的关系

与 docs/zhizhang_v2_2_optimization_plan.md：该计划列出的番茄能力（指南针/滚动幕规划、5000 章虚拟化、SKILL.md 沙箱与阶段绑定、离线体检与 Observation、fact_sync/CHAPTER_COMMIT、4 维召回、keyset 分页、override 继承修复）在源码中都已实现，本审阅确认 resolveEffectiveMount 的 fallback 继承、keyset 分页、detectLoreConflicts 的 positions Map 已修复。差异有四处：①计划 §2.1 承诺『禁止本章变动信息混入 Prefix』，但推荐卡自动注入和动态裁剪使其失效（FQ-04/05）；②计划 §3.4 承诺『无损、幂等』的工程包，实际是有损的（FQ-11/12）；③CHAPTER_COMMIT 闭环存在知情覆盖和漂移确认两类数据正确性缺陷（FQ-01/03/10），计划未涉及；④detectLoreConflicts 仍有『章纲 × 事实』的正则复杂度（FQ-18）。与 docs/framework/03-migration-roadmap.md：M0–M4 已全部完成，属于架构收口；本计划不改变 ProductLineModule 边界，只在番茄模块内部与少量共享纯函数（anchors 段落切分）上动刀，可作为『V2.3 番茄线』独立实施。新增迁移须遵守 AGENTS.md，受保护语义只编码、不变更。

## 九、外部参考
- DeepSeek Token 用量说明：https://api-docs.deepseek.com/quick_start/token_usage
- 番茄 AI 低质内容处置数据（二手报道，需以官方公告为准）：https://www.cnblogs.com/txgg/p/22927972
- 番茄全勤与签约字数（二手资料，以作者后台为准）：https://wenku.baidu.com/aggs/c4032f2d4b73f242336c5f86.html ；https://linux.do/t/topic/2954668
- SKILL.md 规范与渐进加载：https://atlan.com/know/ai-agent/ai-agent-skills/skill-md-file-explained/ ；https://learn.microsoft.com/fil-ph/agent-framework/agents/skills
