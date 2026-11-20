# 织章 V2.3 实现状态对照表

> **本表是什么**：`docs/zhizhang_v2_3_full_optimization_plan.md` 中 123 条发现的**代码核对结果**。只记录"代码里到底有没有"，不含排期、人力与决策；排期与决议仍以计划正文为准。
>
> **核对基线**：2026-11-20 23:40 · HEAD `d0781a8` + 文档对齐 · `npm run check` 通过 · `npm test` = 36 文件 / 284 用例 · `npm run test:all` = 62 文件 / 457 用例全绿 · 源码 123 文件 / 15,037 行 TS · Schema 40 表 / 40 索引 / 14 触发器（见 [schema.md](schema.md)）
>
> **状态定义**
> - ✅ **已落地**：实现 + 测试，且真实调用链走通，可验收。
> - ⚠️ **底座就位**：纯函数或 schema 已写，但没接进调用链。**功能上尚未生效**，不能计入完成。
> - ❌ **未动**：无实现。

---

## 1. 总览

| 模块 | ✅ 已落地 | ⚠️ 底座就位 | ❌ 未动 | 合计 |
| --- | ---: | ---: | ---: | ---: |
| 前端 UI 工作台（FE） | 9 | 6 | 19 | 34 |
| DsH 插件逻辑（DSH） | 0 | 7 | 21 | 28 |
| 后端数据库逻辑（DB） | 16 | 5 | 6 | 27 |
| 番茄小说工作线（FQ） | 3 | 12 | 19 | 34 |
| **合计** | **28** | **30** | **65** | **123** |

**结论**：数据库底座完成度最高（59%），番茄线大量逻辑停在"纯函数写完未接线"，宿主层**整层未动（0/28）**。

---

## 2. P0 专项（24 条，9 ✅ / 8 ⚠️ / 7 ❌）

| 编号 | 状态 | 现状 |
| --- | --- | --- |
| FE-01 | ✅ | `resolveCapturedSelection`：切章拒绝、唯一匹配重定位、0/多命中拒绝 |
| FE-02 | ✅ | `execCommand("insertText")` 优先 + 10 步 AI 撤销栈 |
| FE-06 | ✅ | `--vrow-h` CSS 变量 + `ResizeObserver` 重算行高 |
| FE-07 | ❌ | `apiRequest` 无超时、无幂等键，挂起即锁死全部操作 |
| FE-12 | ✅ | raw 模式保留已勾选 hunk，部分勾选显示 banner |
| FE-27 | ⚠️ | 仅在保存按钮可用时 `preventDefault`；无 `isComposing` 保护 |
| DSH-01 | ❌ | `tools.ts` 中 `output` 出现 0 次，真实宿主注册会抛错 |
| DSH-02 | ❌ | 无 `ctx.get`/`ctx.inject`，可选服务仍是硬依赖 |
| DSH-03 | ❌ | `text-delta` 不区分块类型，thinking 增量直接进 `blocks` |
| DSH-08 | ❌ | 排空期用 `if (!closing)` 丢弃真实用量回执 |
| DSH-10 | ⚠️ | `author_micro_calls` 表与 3 个索引已建；无写入 API，`selection.rewrite` 仍不入账 |
| DB-01 | ✅ | `normalizeUsage` 四类互斥，`writing-budget` 已改用 |
| DB-02 | ⚠️ | `request_hash` 列 + `pruneCommandJournal` 已有；宿主从不调用修剪 |
| DB-07 | ✅ | `busy_timeout` 前置、`journal_size_limit = 64MiB`、Windows 关 `mmap` |
| DB-08 | ✅ | 语句缓存 LRU，上限 256 |
| DB-14 | ✅ | `late_usage` 严格每笔未回执调用记录一次（`246f80d`） |
| DB-21 | ✅ | `schema-doc.mjs` 生成确定性 schema 文档 + 测试 |
| FQ-01 | ⚠️ | `mergeFactVersion` 已实现；`fact-sync.ts` 仍走旧覆盖逻辑 |
| FQ-02 | ⚠️ | `splitChapterParagraphs` 已实现；应用层仍 `split(/\r?\n/).length` 数行 |
| FQ-03 | ⚠️ | schema 有 `base_revision_id`；`decideProposal` 不校验、无 `proposal-stale` |
| FQ-06 | ❌ | 库条目/伏笔仍可按 id 跨项目覆写；AI payload 无字段白名单 |
| FQ-07 | ❌ | 提案 `documentId` 可为 null，无 `chapter-required` 拒绝 |
| FQ-08 | ⚠️ | `FORESHADOW_TRANSITIONS` 已实现；`upsertForeshadow` 不调用断言 |
| FQ-10 | ⚠️ | 提示词已拆 `newFacts`/`updates`；服务端未生成 `fq-<uuid>`、未校验 updates 存在性 |

**P0 退出标准达成情况**：跨模块 point 一致性、第 3 章知情第 10 章更新仍可见、跨项目 id 攻击被拒、严格 registrar 下 10 工具注册成功 —— **目前 0/4 可验收**，卡点即上表 8 条 ⚠️ 与 7 条 ❌。

---

## 3. 前端 UI 工作台（34 条）

| 编号 | 阶段 | 状态 | 现状与缺口 |
| --- | --- | --- | --- |
| FE-01 | P0 | ✅ | 选段捕获 `{documentId, revisionId, start, end, text}` + 应用前校验/重定位 |
| FE-02 | P0 | ✅ | `execCommand` 优先，回退 `setRangeText`；AI 替换撤销栈 |
| FE-03 | P1 | ❌ | 仅生成 running 时 `setInterval`；无 15s 常驻轮询、无 `BroadcastChannel` |
| FE-04 | P1 | ❌ | `apiRequest` 已支持 `ifSequence`；后端无 `treeSeq`/`unchanged`，仍每次 `tree.get` |
| FE-05 | P1 | ❌ | 大纲板/设定库无本地草稿，重绘覆盖正在输入的内容 |
| FE-06 | P0 | ✅ | 虚拟列表行高变量化 + `ResizeObserver` |
| FE-07 | P0 | ❌ | 无 `AbortSignal.timeout`、无幂等键 |
| FE-08 | P1 | ❌ | 导入仍单请求，无 `importId/part/commit` 分批协议 |
| FE-09 | P1 | ❌ | 无 `project.bootstrap` 实现，向导仍多请求 |
| FE-10 | P2 | ✅ | 三主题补齐 diff/success/warning 等 29 处 token |
| FE-11 | P2 | ✅ | `matchMedia` change 监听 + Esc 关闭 popover |
| FE-12 | P0 | ✅ | raw 模式保留 `adopted`，部分勾选有 banner |
| FE-13 | P1 | ✅ | 空行 spacer 归属相邻 hunk + `detectLineEnding` 还原 |
| FE-14 | P2 | ✅ | 句级切分 + Myers + 哈希锚点段落配对 |
| FE-15 | P2 | ❌ | 无 `document.title` 同步 |
| FE-16 | P2 | ⚠️ | `contracts/protected-rules.ts` 已建；`client/plugins/toutiao.ts:6` 仍写死 `34` |
| FE-17 | P2 | ⚠️ | `ActionMap` 28 个动作已声明；`apiRequest(action: string)` 未泛型化 |
| FE-18 | P2 | ❌ | `shell.ts` 仍 971 行，未拆 `state.ts`/`run-panel.ts` |
| FE-19 | P3 | ❌ | 无 axe/对比度校验 |
| FE-20 | P3 | ❌ | 无 `aria-busy` 等进行中语义 |
| FE-21 | P3 | ❌ | 无 `createLatestTask`/`AbortController` 取消旧请求 |
| FE-22 | P2 | ❌ | 仍 `Cache-Control: no-store`，无 ETag/304 |
| FE-23 | P2 | ⚠️ | iframe `sandbox` + `referrerPolicy` 已定；双实例只读模式未处理 |
| FE-24 | P2 | ⚠️ | `defaultModel` 设置项已存在；运行表单仍回退字面量 `"default"` |
| FE-25 | P3 | ❌ | 无只读模式/模板预览 |
| FE-26 | P3 | ❌ | 仅外观面板有 aria；无焦点陷阱与全键盘路径 |
| FE-27 | P0 | ⚠️ | Ctrl+S 仅在按钮可用时拦截；无输入法组字保护 |
| FE-28 | P3 | ❌ | 导入导出 UI 无 v2 预览与选择性恢复 |
| FE-29 | P2 | ❌ | 无 `FakeLlmTransport` 录制回放夹具 |
| FE-30 | P3 | ❌ | seed-packs 无主题/排版预设 |
| FE-31 | P1 | ⚠️ | `DRAFT_VAULT_TTL_MS` + `pruneStale` 已有；无 `beforeunload` 拦截 |
| FE-32 | P2 | ✅ | `atmosphere` 已纳入 `TECHNIQUE_CATEGORIES`，与种子包一致 |
| FE-33 | P2 | ❌ | 正文区无当前段落号指示，表单仍手填 `point` |
| FE-34 | P3 | ❌ | 客户端零 i18n，全部硬编码中文 |

---

## 4. DsH 插件逻辑（28 条）

| 编号 | 阶段 | 状态 | 现状与缺口 |
| --- | --- | --- | --- |
| DSH-01 | P0 | ❌ | 10 个工具无 `output{schema,render}` |
| DSH-02 | P0 | ❌ | 无 `ctx.get`/嵌套 `ctx.inject`，无子作用域注册 |
| DSH-03 | P0 | ❌ | thinking 增量混入候选正文；测试仍以错误值为期望 |
| DSH-04 | P1 | ❌ | 无 Peer/Actor，`command_journal` 无 `actor_id` |
| DSH-05 | P1 | ❌ | 只读工具无动作白名单，无 `chapter.read` 精简 DTO |
| DSH-06 | P1 | ⚠️ | `origin`/`origin_ref` 列已建；应用层不写 |
| DSH-07 | P2 | ❌ | 导入/导出/FTS 重建/热备仍同步执行，无 `worker_threads` |
| DSH-08 | P0 | ❌ | `closing` 时直接丢弃回执（`if (!closing) recordReceipt`） |
| DSH-09 | P2 | ❌ | 模型默认值未贯通到运行表单 |
| DSH-10 | P0 | ⚠️ | `author_micro_calls` 表+索引已建；无 storage API，微改写不入账 |
| DSH-11 | P2 | ⚠️ | 已有 `AbortSignal.timeout(180_000)`；无上游超时/重试口径收敛 |
| DSH-12 | P3 | ❌ | 运行检查器不展示 `cache_read / input` |
| DSH-13 | P1 | ❌ | 错误码→HTTP 仅 404/400/409 三分支，无 403/422/503 |
| DSH-14 | P2 | ❌ | 无 `dsh-adapter.ts`，宿主 API 直接散布在 `plugin.ts` |
| DSH-15 | P2 | ❌ | 静态资源无 ETag/304 |
| DSH-16 | P2 | ⚠️ | `planRetention` + `pruneBackups` 已实现并测试；宿主从不调用 |
| DSH-17 | P2 | ⚠️ | `sandbox`/`referrerPolicy` 已定；baseURI 拼接与双实例未改 |
| DSH-18 | P2 | ❌ | `linkSync` 失败无回退，启动不清理残留 `.tmp` |
| DSH-19 | P2 | ❌ | 无迁移前/每日首次/交稿后自动热备 |
| DSH-20 | P1 | ❌ | 工具注册未隔离，失败会拖垮整个工作台 |
| DSH-21 | P1 | ❌ | Agent 工具无项目级开关（决议：默认关闭） |
| DSH-22 | P1 | ⚠️ | schema 有 `ux_proposal_inflight`；应用层仍只靠内存锁快速失败 |
| DSH-23 | P1 | ⚠️ | `store.ts` 已 `tmp-uuid` + `rename`；启动恢复分项容错未做 |
| DSH-24 | P3 | ❌ | 读体无超时、`closing` 检查滞后于读体、CSP 未显式收紧（`plugin.ts:63,105-128`） |
| DSH-25 | P3 | ❌ | 未声明 `peerDependencies`、未导出 `name`、`files` 打入全部 docs |
| DSH-26 | P3 | ❌ | 提案 JSON 用正则剥围栏，解析失败时原始输出丢失（`plugin.ts:320-334`） |
| DSH-27 | P3 | ❌ | 宿主测试缺口：无严格 registrar、Peer 注入、生命周期排空、传输契约测试 |
| DSH-28 | P3 | ❌ | 文档与代码漂移（宿主章节），缺"宿主契约表" |

---

## 5. 后端数据库逻辑（27 条）

| 编号 | 阶段 | 状态 | 现状与缺口 |
| --- | --- | --- | --- |
| DB-01 | P0 | ✅ | `normalizeUsage` 四类互斥，`writing-budget` 已使用 |
| DB-02 | P0 | ⚠️ | `request_hash` + `pruneCommandJournal` 已有；无定时调用 |
| DB-03 | P2 | ⚠️ | `createProjectionStore` 每项目共享折叠；检查点节流/LRU 淘汰未验证 |
| DB-04 | P1 | ✅ | `backup()` 在线热备，`VACUUM INTO` 回退 |
| DB-05 | P1 | ✅ | 两段式 FTS（先 rowid 排序 LIMIT，再 snippet），bm25 分权重 |
| DB-06 | P2 | ✅ | 1–2 字走 `author_chapter_entities` 倒排，再 title/summary，最后有界 body LIKE |
| DB-07 | P0 | ✅ | `busy_timeout` 前置、`journal_size_limit`、Windows 禁 `mmap` |
| DB-08 | P0 | ✅ | 语句缓存 LRU 上限 256 |
| DB-09 | P2 | ❌ | 迁移仍按版本号命名，未按 platform/fanqie/toutiao 命名空间拆分 |
| DB-10 | P2 | ❌ | `STRICT` 仅 2 表、`CHECK` 仅 2 处 |
| DB-11 | P2 | ✅ | `sort_key` + `SORT_KEY_STEP=1024` + `computeSortKeyBetween` |
| DB-12 | P1 | ✅ | 40 个显式索引（`docs/schema.md` 实测，含 2.3.0 热点索引迁移） |
| DB-13 | P1 | ✅ | `ux_proposal_inflight` 部分唯一索引 |
| DB-14 | P0 | ✅ | `late_usage` 严格一次 |
| DB-15 | P1 | ❌ | `pendingJobs` 只在 DTO 中声明，快照不返回 |
| DB-16 | P2 | ⚠️ | `rebuildProjectFts`/`optimizeFts` 已有；导入路径调用点待确认 |
| DB-17 | P2 | ✅ | FTS 触发器改为 `UPDATE OF` 指定列 |
| DB-18 | P3 | ⚠️ | `compactAutoSaveRevisions` 按天合并；`synced_body` 仍整篇存一份 |
| DB-19 | P3 | ⚠️ | `auditEventLogConcerns` + 隔离表已有；缺 concern 回填迁移未做 |
| DB-20 | P2 | ✅ | Windows 保留设备名处理 |
| DB-21 | P0 | ✅ | `schema-doc.mjs` + 确定性测试 |
| DB-22 | P2 | ❌ | `rowCount` 等死代码仍导出 |
| DB-23 | P1 | ❌ | 错误码→HTTP 无 403 映射 |
| DB-24 | P1 | ✅ | `db-bench.mjs` 5000 章 / 5 万事件 |
| DB-25 | P2 | ✅ | `meta.db_uuid` 作为缓存键 |
| DB-26 | P3 | ❌ | 无月度/项目累计预算（默认关闭的可选功能） |
| DB-27 | P2 | ✅ | 事务交叉校验 `foreign-transaction` |

---

## 6. 番茄小说工作线（34 条）

| 编号 | 阶段 | 状态 | 现状与缺口 |
| --- | --- | --- | --- |
| FQ-01 | P0 | ⚠️ | `mergeFactVersion` 已有；`fact-sync.ts` 未调用 |
| FQ-02 | P0 | ⚠️ | `splitChapterParagraphs` 已有；应用层仍按行数算 point |
| FQ-03 | P0 | ⚠️ | `base_revision_id` 列已有；决策时不校验 |
| FQ-04 | P1 | ❌ | 无"按当前正文重新生成"与强制应用通道 |
| FQ-05 | P1 | ❌ | 未挂载技法卡仍自动注入（决议：不注入） |
| FQ-06 | P0 | ❌ | 跨项目按 id 覆写未拦；payload 无白名单 |
| FQ-07 | P0 | ❌ | 提案可不带 `documentId` |
| FQ-08 | P0 | ⚠️ | 转换表已有；`upsertForeshadow` 不调用断言 |
| FQ-09 | P1 | ❌ | 仍读 `author_chapter_order`，章序两个真源 |
| FQ-10 | P0 | ⚠️ | 提示词已拆 `newFacts`/`updates`；factId 仍由模型给 |
| FQ-11 | P1 | ❌ | 章节号仍 3 位固定，未按总数自适应宽度 |
| FQ-12 | P3 | ❌ | 工程包仍 `format: zhizhang-novel-bundle/v1`，不含设定版本史 |
| FQ-13 | P2 | ⚠️ | 续写/重写/定向修稿三模板常量已有；无选择逻辑 |
| FQ-14 | P2 | ⚠️ | `pacing_tier`/`genre_tags_json` 列已有；controls/context 不读 |
| FQ-15 | P2 | ✅ | 黄金三章计分重写，app 已传 `targetLength` |
| FQ-16 | P2 | ✅ | AI 味非重叠匹配 + 类别权重 + 句长变异系数 |
| FQ-17 | P2 | ❌ | 观察无 `verified` 标记与过期判定 |
| FQ-18 | P2 | ❌ | 上下文装配无位置 Map/实体索引优化 |
| FQ-19 | P2 | ⚠️ | domain 层别名合并已有；`memory-sync` 仍纯子串计数 |
| FQ-20 | P2 | ⚠️ | `retiredFacts` 提示词字段已有；decide 未写 `effectiveTo` |
| FQ-21 | P2 | ⚠️ | `targetChapterId`/`hintedChapterIds` 已有；UI 无入口 |
| FQ-22 | P1 | ❌ | 章序影响分析不含伏笔与章纲锁定事实 |
| FQ-23 | P2 | ❌ | 滚动幕规划取章范围、提示词契约与新幕插入位置均有问题 |
| FQ-24 | P0 | ❌ | 无章末锚点归一（末段 point 收尾） |
| FQ-25 | P3 | ⚠️ | `CHAPTER_TRANSITIONS` + 表驱动测试已有（已授权）；应用层零调用 |
| FQ-26 | P3 | ❌ | 无创作过程报告（AI 参与度/采纳后编辑量） |
| FQ-27 | P3 | ❌ | 无日更与字数里程碑追踪 |
| FQ-28 | P3 | ❌ | SKILL.md 不支持 `\|`/`>` 块标量；未知 pacing 无降级；注入未截断 |
| FQ-29 | P2 | ❌ | 前端仍 `quickEstimateTokens`，估算偏高未校准 |
| FQ-30 | P3 | ❌ | 番茄 UI 可用性：stateLabels/章节标题不统一、提案只能整包确认、常量未下发 |
| FQ-31 | P3 | ⚠️ | `ActionMap` 声明了 `project.bootstrap`；无实现 |
| FQ-32 | P3 | ❌ | 番茄测试集中在 Sprint 大文件，未按行为拆分 |
| FQ-33 | P3 | ✅ | 文档已对齐：README 计数、v2.3 计划引用、`docs/optimization/` 跟踪、`docs/schema.md` 自动生成 |
| FQ-34 | P1 | ❌ | 全局共享库变更无跨项目事件 |

---

## 7. 下一批建议

### B0 · 文档与门禁对齐（✅ 2026-11-20 完成）

- README / `docs/05` 计数改为实测值：`npm test` 36 文件 / 284 用例，`test:all` 62 / 457；
- 新增 `npm run test:v23`，并把 `*-v23` 纳入 `npm test` / `verify`（此前 36 个 V2.3 用例不在日常门禁内；M0 新增文档守卫后为 40 个）；
- 新增 `npm run docs:schema`，生成 [schema.md](schema.md)（40 表 / 40 索引 / 14 触发器），`docs/04` 表清单改为按生成结果对齐；
- `docs/03` 补充 V2.3 增补的 42 个动作与第七节增量架构说明；
- 修正 v2.3 计划 §7 对已删除 v2.2 计划的引用，并在计划头部标注"非进度真源"；
- `AGENTS.md` 补受保护常量的"唯一定义位置"条款（对应决议 #2）；
- `docs/optimization/` 四份评审、v2.3 计划与本表纳入版本控制。

### B2 · 剩余开发批次

按"能验收的退出标准"排序，不做新底座：

| 批次 | 条目 | 产出 | 预估 |
| --- | --- | --- | --- |
| B2-1 连续性接线 | FQ-01、FQ-02、FQ-03、FQ-08、FQ-10 | fact-sync 改用 `mergeFactVersion`；应用层统一 `splitChapterParagraphs`；提案校验 `base_revision_id` 并返回 `proposal-stale`；服务端生成 factId | 3–4 天 |
| B2-2 宿主可启动 | DSH-01、DSH-02、DSH-03、DSH-14 | `dsh-adapter.ts` 单点收口；工具补 `output{schema,render}` 并进子作用域；thinking 增量过滤 | 3 天 |
| B2-3 账本不丢 | DSH-08、DSH-10、DB-02 | 排空期继续写回执；微改写入账；`pruneCommandJournal` 定时调用 | 2 天 |
| B2-4 写入安全 | FQ-06、FQ-07、FQ-09、FE-07、FE-27 | 跨项目 id 拒绝；`documentId` 必填；章序单真源（先定 schema）；前端超时+幂等键；保存键组字保护 | 3 天 |

完成 B2-1 ~ B2-3 后 P0 可达 **20/24**；再加 B2-4 可达 **24/24**（P0 清零）。

### B2-1 执行清单（待开工，按依赖顺序）

**目标**：把 Wave 1 已写好的五个纯函数接进真实写路径，让 P0 的前三条退出标准第一次可验收。

| # | 条目 | 改动点 | 完成判据 |
| --- | --- | --- | --- |
| 1 | FQ-02 | `fact-sync.ts:81` 与 `fanqie.ts:115` 的 `body.slice(0, start).split(/\r?\n/).length` 改为 `pointAtOffset(body, start)`；新增迁移 `2.3.1-evidence-point-backfill`，按 `quote_start` 重算 `author_evidence.point` | 含"段间空行"的样章中，证据、fact_sync、诊断三处 point 完全一致 |
| 2 | FQ-01 | `commitFactBatch`（`fact-sync.ts:101`）改用 `mergeFactVersion`；`materializeApprovedLore` 同步；known-before-effective 由 error 降 warning | 第 3 章已知情 → 第 10 章更新 → 第 5 章查询仍可见 |
| 3 | FQ-03 | `beginProposalGeneration` 写入 `base_revision_id` + `source_sha256`；`decideProposal` 在 kind 分发前校验当前 `revisionId`；漂移则 `refuse("proposal.decide","proposal-stale")` 并保持 dirty | 生成提案后改稿 → 确认被拒；未改稿 → 正常通过 |
| 4 | FQ-08 | `commitForeshadowBatch` / `upsertForeshadow` 调 `assertForeshadowTransition` | `proposed → resolved` 的跳变被拒，合法路径逐条通过 |
| 5 | FQ-10 | 服务端为 `newFacts` 生成 `fq-<uuid>`；`updates` 校验 `factId` 必须已存在 | 模型回传重复/未知 factId 时被服务端改写或明确拒绝 |

**开工前需作者确认的两个门**：

- **D1 · 新增错误码**：`proposal-stale` 目前不在 `contracts/errors.ts`。新增会动到已冻结的错误信封与 HTTP 映射（当前只有 404/400/409 三分支），属契约变更，需作者确认措辞与状态码（建议 `422`）。
- **D2 · 历史数据回填**：迁移会重算既有 `author_evidence.point`。按决议 #12，执行前必须先热备并输出 point 变化报告供作者核对，不可静默改数。

**验收**：`test:v23` 新增 ≥6 个走真实调用链的用例；`test:all` 从 453 增至 ≥459 且全绿；手工跑通"第 3 章知情 → 第 10 章更新 → 第 5 章可见"。

---

## 8. 维护约定

- 每完成一批，**只改本表对应行的状态与"现状"**，并在提交信息里带上条目编号（如 `feat(fanqie): wire mergeFactVersion (FQ-01)`）。
- 状态升级必须有测试支撑：⚠️ → ✅ 需在 `test/*-v23.test.mjs` 或对应分层测试中新增至少一个**走真实调用链**的用例。
- 本表不复制计划正文、不记录决策；决议仍以计划 §6.0 为准。
- 每次改动后跑 `npm run verify`（只读类型检查 + 280 个核心用例）与 `npm run test:all`（453 个全量用例），数字写回本页顶部基线。
