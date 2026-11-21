# 织章 V2.3 实现状态对照表

> **本表是什么**：`docs/zhizhang_v2_3_full_optimization_plan.md` 中 123 条发现的**代码核对结果**。只记录"代码里到底有没有"，不含排期、人力与决策；排期与决议仍以计划正文为准。
>
> **核对基线**：2026-11-21 · 代码 HEAD `7379354`（B2-5 复核补丁后，另有文档提交） · `npm run check` 通过 · `npm test` = 44 文件 / 335 用例 · `npm run test:v23` = 12 文件 / 87 用例 · `npm run test:all` = 70 文件 / 508 用例（需 Node ≥ 24.15 全绿；Node 22 实测 507 执行 / 506 通过，`workflow-w01` 的 `using` 语法失败） · 源码 126 文件 / 31,324 行 TS（含注释与空行） · Schema 40 表 / 40 索引 / 14 触发器（见 [schema.md](schema.md)）
>
> **状态定义**
> - ✅ **已落地**：实现 + 测试，且真实调用链走通，可验收。
> - ⚠️ **底座就位**：纯函数或 schema 已写，但没接进调用链。**功能上尚未生效**，不能计入完成。
> - ❌ **未动**：无实现。

---

## 1. 总览

| 模块 | ✅ 已落地 | ⚠️ 底座就位 | ❌ 未动 | 合计 |
| --- | ---: | ---: | ---: | ---: |
| 前端 UI 工作台（FE） | 11 | 5 | 18 | 34 |
| DsH 插件逻辑（DSH） | 5 | 7 | 16 | 28 |
| 后端数据库逻辑（DB） | 17 | 4 | 6 | 27 |
| 番茄小说工作线（FQ） | 10 | 7 | 17 | 34 |
| **合计** | **43** | **23** | **57** | **123** |

**结论**：数据库底座完成度最高（63%）；宿主层已有 5/28 落地（工具契约、可选服务、thinking 过滤、排空、微改写账本），身份边界与 worker 化仍未动；**P0 24/24 经 B2-5 独立复核补丁后维持**，但复核发现的原缺陷与仍未解决的限制见 [§9](#9-b25--p0-清零复核补丁2026-11-21)。后续重心转入 P1 前应先处理 §9.2 的决议 #3 / #5。

---

## 2. P0 专项（24 条，24 ✅ / 0 ⚠️ / 0 ❌）

| 编号 | 状态 | 现状 |
| --- | --- | --- |
| FE-01 | ✅ | `resolveCapturedSelection`：切章拒绝、唯一匹配重定位、0/多命中拒绝 |
| FE-02 | ✅ | `execCommand("insertText")` 优先 + 10 步 AI 撤销栈 |
| FE-06 | ✅ | `--vrow-h` CSS 变量 + `ResizeObserver` 重算行高 |
| FE-07 | ✅ | 读 15s / 写 30s / 长耗时 120s（`selection.rewrite`、`backup.create`、`article.deliver` 等）；超时提示保留本地草稿；幂等键经评估对非幂等 `draft.save` 无效，未引入 |
| FE-12 | ✅ | raw 模式保留已勾选 hunk，部分勾选显示 banner |
| FE-27 | ✅ | 键盘处理器在 `event.isComposing` 或编辑器组字期间直接返回，输入法选词时不会触发 Ctrl+S |
| DSH-01 | ✅ | 10 个工具全部声明 `output{schema,render}` 与 `additionalProperties:false`，`dsh-tools-adapter` 注册前自检、失败整体回滚 |
| DSH-02 | ✅ | 可选服务走 `ctx.get`；有 `ctx.inject` 时工具与设置表单各挂独立子作用域，注册失败只记日志 |
| DSH-03 | ✅ | `block-end` 按块类型回删 thinking 增量；严格长度上限移到最终可见 `body`，长思维链不再占满配额 |
| DSH-08 | ✅ | `accepting`/`dbOpen` 双状态门；15 秒预算耗尽后强制二次 abort 并记日志，但仍等所有 task settle 才关库，迟到回执不丢 |
| DSH-10 | ✅ | 新增 `micro-service`：inflight 行即文档级锁、四类用量落库、卸载中止并对账；运行检查器显示累计微改写 |
| DB-01 | ✅ | `normalizeUsage` 四类互斥，`writing-budget` 已改用 |
| DB-02 | ✅ | 宿主启动即修剪一次，此后每 6 小时一次；失败只记日志，不阻塞工作台 |
| DB-07 | ✅ | `busy_timeout` 前置、`journal_size_limit = 64MiB`、Windows 关 `mmap` |
| DB-08 | ✅ | 语句缓存 LRU，上限 256 |
| DB-14 | ✅ | `late_usage` 严格每笔未回执调用记录一次（`246f80d`） |
| DB-21 | ✅ | `schema-doc.mjs` 生成确定性 schema 文档 + 测试 |
| FQ-01 | ✅ | `commitFactBatch`、`knownFromUpdates`、`setting.decide` 均走 `mergeFactVersion`（`ed83ef9`） |
| FQ-02 | ✅ | 证据、增量同步、诊断统一走 `pointAtOffset`；回填脚本 `migrate:evidence-point`（`07df82d`） |
| FQ-03 | ✅ | 生成时写 `base_revision_id` + 全文 `source_sha256`；unpinned 行用 body hash 兜底，未验证的提交保持 dirty（`854ccbf` / B2-5） |
| FQ-06 | ✅ | 库条目写入与删除均校验 scope/project；伏笔跨项目拒绝；`decideProposal` 固定 `row.projectId` 并剥离含 `overrideOfId` 的保留字段 |
| FQ-07 | ✅ | 章节绑定提案创建/生成/决策强制 `documentId`；决策目标固定 `row.documentId`；历史空文档行可在决策时补绑 |
| FQ-08 | ✅ | 补 `foreshadow.create/patch`，应用层统一调 `assertForeshadowTransition`；回收不再清空 `targetChapterId`/`plantedPoint`（`bd0763c`） |
| FQ-10 | ✅ | 服务端生成 `fq-<uuid>` 并 remap 同载荷引用；规范化已幂等且覆盖手工提案与 `editedPayload`；`retiredFacts` 上报 `unapplied` |

**P0 退出标准达成情况**：跨模块 point 一致性、第 3 章知情第 10 章更新仍可见、跨项目 id 攻击被拒、严格 registrar 下 10 工具注册成功 —— **4/4 全部可验收**（B2-4 补齐跨项目写入拦截）。P0 至此清零。

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
| FE-07 | P0 | ✅ | 读 15s / 写 30s / 长耗时 120s；超时文案提示本地稿已保留（幂等键残余风险见 §9.2） |
| FE-08 | P1 | ❌ | 导入仍单请求，无 `importId/part/commit` 分批协议 |
| FE-09 | P1 | ❌ | 无 `project.bootstrap` 实现，向导仍多请求 |
| FE-10 | P2 | ✅ | 三主题补齐 diff/success/warning 等 29 处 token |
| FE-11 | P2 | ✅ | `matchMedia` change 监听 + Esc 关闭 popover |
| FE-12 | P0 | ✅ | raw 模式保留 `adopted`，部分勾选有 banner |
| FE-13 | P1 | ✅ | 空行 spacer 归属相邻 hunk + `detectLineEnding` 还原 |
| FE-14 | P2 | ✅ | 句级切分 + Myers + 哈希锚点段落配对 |
| FE-15 | P2 | ❌ | 无 `document.title` 同步 |
| FE-16 | P2 | ⚠️ | 前端已改用浏览器镜像 `client/contracts/protected-rules.ts`（`toutiao.ts` 的 34/2、`fanqie.ts` 的审稿上限、`api.ts` 文案），`db-v23` 校验镜像与真源逐字一致；`check`/`build`/`test` 已通过，**待 `test:browser` 后升 ✅** |
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
| FE-27 | P0 | ✅ | 组字期间跳过全部快捷键（`event.isComposing`） |
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
| DSH-01 | P0 | ✅ | `dsh-tools-adapter` 统一补 `output{schema,render}`；严格 registrar 下 10 工具注册成功，任一失败整体回滚 |
| DSH-02 | P0 | ✅ | `ctx.get('tools'/'configForms')` 解析 + 独立 `ctx.inject` 子作用域；无 `inject` 的旧宿主走属性回退 |
| DSH-03 | P0 | ✅ | `blockTypes` 记录块类型；严格 `MAX_CANDIDATE_LENGTH` 校验放在拼好的可见正文上 |
| DSH-04 | P1 | ❌ | 无 Peer/Actor，`command_journal` 无 `actor_id` |
| DSH-05 | P1 | ❌ | 只读工具无动作白名单，无 `chapter.read` 精简 DTO |
| DSH-06 | P1 | ⚠️ | `origin`/`origin_ref` 列已建；应用层不写 |
| DSH-07 | P2 | ❌ | 导入/导出/FTS 重建/热备仍同步执行，无 `worker_threads` |
| DSH-08 | P0 | ✅ | `accepting` 拒新请求；15 秒预算耗尽后不提前关库，等迟到的回执写完才 `db.close()` |
| DSH-09 | P2 | ❌ | 模型默认值未贯通到运行表单 |
| DSH-10 | P0 | ✅ | `author_micro_calls` 接入写路径：inflight 唯一索引即锁，completed/failed/uncertain 三态收尾 |
| DSH-11 | P2 | ⚠️ | 已有 `AbortSignal.timeout(180_000)`；无上游超时/重试口径收敛 |
| DSH-12 | P3 | ❌ | 运行检查器不展示 `cache_read / input` |
| DSH-13 | P1 | ❌ | 错误码→HTTP 仅 404/400/409 三分支，无 403/422/503 |
| DSH-14 | P2 | ⚠️ | `dsh-adapter.ts` 已单点收口宿主 API，`docs/03` 有服务契约表；**未**固定上游类型、未录制隔离 profile 样本（阻塞于决议 #5） |
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
| DB-02 | P0 | ✅ | `pruneCommandJournal` 由宿主启动时执行并每 6 小时重复，`unref` 定时器不阻塞退出 |
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
| FQ-01 | P0 | ✅ | `commitFactBatch`、`knownFromUpdates` 与 `setting.decide` 均走 `mergeFactVersion`；第 3 章知情、第 10 章更新后第 5 章仍可见 |
| FQ-02 | P0 | ✅ | 证据、增量同步、诊断统一走 `splitChapterParagraphs`/`pointAtOffset`；回填脚本先出报告再热备执行 |
| FQ-03 | P0 | ✅ | 漂移校验抽出 `proposal-freshness.ts`；unpinned 行用 body hash 兜底并拒绝改稿；放行时保持 dirty；compact 只钉 pending/inflight |
| FQ-04 | P1 | ❌ | 无"按当前正文重新生成"与强制应用通道 |
| FQ-05 | P1 | ❌ | 未挂载技法卡仍自动注入（决议：不注入） |
| FQ-06 | P0 | ✅ | 库/伏笔按 id 写入与删除均拒绝跨项目；提案 payload 剥离 id/scope/projectId/priority/status/overrideOfId |
| FQ-07 | P0 | ✅ | 创建/生成/决策强制章节；决策目标固定 `row.documentId`；历史空文档行可补绑同项目章节 |
| FQ-08 | P0 | ✅ | 补 `foreshadow.create`/`foreshadow.patch`，`upsert` 退化为兼容 shim；单条与批量写路径均校验状态迁移；前端“标记回收”改 patch，保留目标章与埋设段 |
| FQ-09 | P1 | ❌ | 仍读 `author_chapter_order`，章序两个真源 |
| FQ-10 | P0 | ✅ | 规范化幂等且覆盖生成、手工提案与 `editedPayload` 三条路径；`updates` 未知 id 明确拒绝；`retiredFacts` 记入 `unapplied` |
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

- README / `docs/05` 计数改为实测值：`npm test` 38 文件 / 288 用例，`test:all` 64 / 461；
- 新增 `npm run test:v23`，并把 `*-v23` 纳入 `npm test` / `verify`（此前 36 个 V2.3 用例不在日常门禁内；M0 文档守卫与 FQ-01/02 回归测试后为 44 个）；
- 新增 `npm run docs:schema`，生成 [schema.md](schema.md)（40 表 / 40 索引 / 14 触发器），`docs/04` 表清单改为按生成结果对齐；
- `docs/03` 补充 V2.3 增补的 42 个动作与第七节增量架构说明；
- 修正 v2.3 计划 §7 对已删除 v2.2 计划的引用，并在计划头部标注"非进度真源"；
- `AGENTS.md` 补受保护常量的"唯一定义位置"条款（对应决议 #2）；
- `docs/optimization/` 四份评审、v2.3 计划与本表纳入版本控制。

### B2 · 剩余开发批次

按"能验收的退出标准"排序，不做新底座：

| 批次 | 条目 | 产出 | 预估 |
| --- | --- | --- | --- |
| B2-1 连续性接线（✅ 已完成） | ~~FQ-01~~、~~FQ-02~~、~~FQ-03~~、~~FQ-08~~、~~FQ-10~~ | fact-sync 改用 `mergeFactVersion`；应用层统一 `splitChapterParagraphs`；提案校验 `base_revision_id` 并返回 `proposal-stale`；服务端生成 factId | 已完成 |
| B2-2 宿主可启动（✅ 已完成） | ~~DSH-01~~、~~DSH-02~~、~~DSH-03~~、DSH-14（①④） | `dsh-adapter.ts` 单点收口；工具补 `output{schema,render}` 并进子作用域；thinking 增量过滤；注册失败降级不拖垮工作台 | 已完成 |
| B2-3 账本不丢（✅ 已完成） | ~~DSH-08~~、~~DSH-10~~、~~DB-02~~ | 排空期继续写回执；微改写入账；`pruneCommandJournal` 定时调用 | 已完成 |
| B2-4 写入安全（✅ 已完成） | ~~FQ-06~~、~~FQ-07~~、~~FE-07~~、~~FE-27~~（FQ-09 仍留 P1） | 跨项目 id 拒绝；`documentId` 三处必填；前端按动作超时；保存键组字保护 | 已完成 |

B2-1 ~ B2-4 全部完成，P0 达 **24/24（清零）**。

### B2-2 执行清单（✅ 全部完成）

| # | 条目 | 改动点 | 完成判据 |
| --- | --- | --- | --- |
| 1 ✅ | DSH-01 | 新增 `host/dsh-tools-adapter.ts`：`{name,description,parameters(additionalProperties:false),output{schema,render},execute(args,exec)}` + 注册前自检 + 失败整体回滚；`support/` 新增 `createStrictToolRegistrar` 复刻上游校验 | `test/host-tools-v23.test.mjs` 用严格 registrar 注册 10 个工具全部通过；缺 `output` / 开放参数 / 非法 `timeoutMs` 均被拒 |
| 2 ✅ | DSH-02 | 新增 `host/dsh-adapter.ts`：`HOST_SERVICE_CONTRACTS` 契约表、`getHostService`（`ctx.get` → 属性回退）、`runInServiceScope`；工具与设置表单改挂独立 `ctx.inject` 子作用域 | Cordis 型宿主下 `ctx.tools` 为空仍注册 10 工具；旧宿主走属性回退；契约表必需项与 `inject` 一致 |
| 3 ✅ | DSH-03 | `writing.ts` 维护 `blockTypes`，`block-end='thinking'` 删除该 index；正文只拼 text 或未声明类型的块，`MAX_CANDIDATE_LENGTH` 只计可见文本 | thinking 增量不入正文；整段只有思考时返回 `thinking_exhausted` 而非空稿 |
| 4 ✅ | DSH-14（①④） | 宿主 API 单点收口到 `dsh-adapter.ts`；`docs/03` 增补服务契约表（必需/可选/来源） | host 目录外无宿主类型引用；表与 `HOST_SERVICE_CONTRACTS` 有测试守护 |
| 5 ✅ | 启动降级 | 工具/表单注册移出主 try 块；失败只 `logger.error` 并在 `/diag` 标 `agentToolsRegistered=false` / `agentToolsError` | 宿主拒绝注册时 `/workbench` 与 `/state` 仍 200，`/diag` 如实降级 |

**验收**：`test:v23` 10 文件 / 69 用例全绿；`npm test` 42 文件 / 315 用例全绿；`test:all` 68 文件 / 488 用例（Node 24 全绿；Node 22 仅 `workflow-w01` 的 `using` 语法失败）。

**遗留（阻塞于决议 #5）**：DSH-14 的②（固定上游类型/devDependency）与③（隔离 profile 录制一次 route/llm/tools 样本）未做。在拿到真实录制前，`dsh-adapter.ts` 的接口仍是“按公开文档推断”，不能标注为已在真实 DsH 验证。

### B2-3 执行清单（✅ 全部完成）

| # | 条目 | 改动点 | 完成判据 |
| --- | --- | --- | --- |
| 1 ✅ | DSH-08 | `plugin.ts` 用 `accepting`（拒新请求 503）与 `dbOpen`（继续写账本）替代单一 `closing`；排空上限 5s → 15s（决议 #8）；`selection.rewrite` 纳入 inFlight | 卸载时已在途的生成/微改写仍把回执与结果落库；重开后 attempt 为 `completed` 而非 `uncertain` |
| 2 ✅ | DSH-10 | 新增 `application/micro-service.ts`：`begin` 写 inflight 行（唯一索引即文档级锁）、`recordReceipt` 存四类用量、`finish` 收尾为 completed/failed/uncertain、`recover` 启动对账 | 微改写用量不占写作预算但落 `author_micro_calls`；同文档并发第二次返回 409 `rewrite-in-progress`；卸载中止后重开无 inflight |
| 3 ✅ | DSH-10（可见性） | `RunDetailDto.microUsage` + 运行检查器新增“微改写累计”板块（次数/状态/输入输出/缓存/已结算） | 打开任一 run 详情即可看到本文档累计微改写用量 |
| 4 ✅ | DB-02 | 宿主启动即调用 `pruneCommandJournal`，此后每 6 小时一次；定时器 `unref`，卸载清理；失败仅记日志 | 120 条 40 天前日志在启动后只剩每文档 50 条，且 payload 已压缩为空 |

**验收**：`test:v23` 11 文件 / 74 用例全绿；`npm test` 43 文件 / 320 用例全绿；`test:all` 69 文件 / 493 用例（Node 24 全绿；Node 22 仅 `workflow-w01` 的 `using` 语法失败）。

### B2-4 执行清单（✅ 全部完成）

**目标**：关掉 P0 最后四条——跨项目写入、无章节提案、请求无超时、输入法误触保存。

| # | 条目 | 改动点 | 完成判据 |
| --- | --- | --- | --- |
| 1 ✅ | FQ-06（库与伏笔） | `library-crud` 写入前调用 `assertLibraryWriteScope`，scope/project 不一致即 `invalid("id","scope-mismatch")`；`upsertForeshadow` 带 id 时要求 `projectId` 与既有行一致 | 跨项目、global↔project 覆写全部被拒，原行内容不变 |
| 2 ✅ | FQ-06（提案） | `proposal-decide` 固定 `projectId = row.projectId`，并剥离 payload 的 `id/scope/projectId/priority/status`；deconstruct/technique 的 scope 只由提案行决定 | 伪造 `projectId` / `scope` / `id` / `priority` 均不生效；committed 落在原项目 |
| 3 ✅ | FQ-07 | 章节绑定提案（`setting/summary/fact_sync/chapter_review`）在 `proposal.create`、`proposal.generate`、`proposal.decide` 三处强制 `documentId`；删除 `chapterOrder()[0]` 回落；智能体伏笔工具同步要求 `documentId` | 无文档提案在三个入口均返回 `chapter-required`；历史空文档提案保持 pending 并拒绝确认 |
| 4 ✅ | FE-07 | `apiRequest` 按动作设超时（读 15s / 写 30s / 导入导出 120s），`AbortSignal.timeout` 触发后抛出“本地草稿已保留”的中文提示；`perform()` 的 finally 释放 UI 锁 | 服务端挂起时 UI 在预算内复位；DraftVault 中本地稿仍可复制/回填 |
| 5 ✅ | FE-27 | 键盘处理器开头 `if (event.isComposing \|\| composing) return;` | 输入法组字期间 Ctrl+S / 切换快捷键均不触发 |

**关于幂等键**：`draft.save` 在命令表里是 `idempotent: false`，前端传 key 会被服务端覆盖，重试仍可能撞 `version.conflict`。本批按已批准的“超时 + 本地稿兜底”实现，**未**引入幂等键；若后续要改，需先改命令表并同步 DB-02 审计语义。

**验收**：`test:v23` 12 文件 / 78 用例全绿；`npm test` 44 文件 / 325 用例全绿；`test:all` 70 文件 / 498 用例（Node 24 全绿；Node 22 仅 `workflow-w01` 的 `using` 语法失败）。

### B2-1 执行清单（✅ 全部完成）

**目标**：把 Wave 1 已写好的五个纯函数接进真实写路径，让 P0 的前三条退出标准第一次可验收。

| # | 条目 | 改动点 | 完成判据 |
| --- | --- | --- | --- |
| 1 ✅ | FQ-02 | `fact-sync.ts:81` 与 `fanqie.ts:115` 的 `body.slice(0, start).split(/\r?\n/).length` 改为 `pointAtOffset(body, start)`；新增迁移 `2.3.1-evidence-point-backfill`，按 `quote_start` 重算 `author_evidence.point` | 含"段间空行"的样章中，证据、fact_sync、诊断三处 point 完全一致 |
| 2 ✅ | FQ-01 | `commitFactBatch`（`fact-sync.ts:101`）改用 `mergeFactVersion`；`materializeApprovedLore` 同步；known-before-effective 由 error 降 warning | 第 3 章已知情 → 第 10 章更新 → 第 5 章查询仍可见 |
| 3 ✅ | FQ-03 | `beginProposalGeneration` 写入 `base_revision_id` + `source_sha256`；`decideProposal` 在 kind 分发前校验当前 `revisionId`；漂移则 `refuse("proposal.decide","proposal-stale")` 并保持 dirty | 生成提案后改稿 → 确认被拒；未改稿 → 正常通过 |
| 4 ✅ | FQ-08 | `commitForeshadowBatch` / `upsertForeshadow` 调 `assertForeshadowTransition`；补 `foreshadow.create/patch` 并让前端回收只传变更字段 | `proposed → resolved` 的跳变被拒，合法路径逐条通过；回收不丢目标章与埋设段 |
| 5 ✅ | FQ-10 | 服务端为 `newFacts` 生成 `fq-<uuid>`；`updates` 校验 `factId` 必须已存在并消费为版本更新 | 模型回传重复/未知 factId 时被服务端改写或明确拒绝 |

**开工前决策门（D1 已确认，D2 待执行）**：

- **D1 · 拒绝理由（已确认）**：`proposal-stale` 不新增错误码，作为 `gate.denied` 的 `reason` 实现，沿用 409；前端补一条文案。**不修改** `contracts/errors.ts` 与 HTTP 映射。
- **D2 · 历史数据回填**：迁移会重算既有 `author_evidence.point`。按决议 #12，执行前必须先热备并输出 point 变化报告供作者核对，不可静默改数。

**验收**：`test:v23` 10 文件 / 69 用例全绿；`npm test` 42 文件 / 315 用例全绿；`test:all` 68 文件 / 488 用例（Node 24 全绿；Node 22 仅 `workflow-w01` 的 `using` 语法失败）。"第 3 章知情 → 第 10 章更新 → 第 5 章可见"由 `fanqie-memory-merge-v23` 与 `sprint2-v2` 覆盖。

---

## 8. 维护约定

- 每完成一批，**只改本表对应行的状态与"现状"**，并在提交信息里带上条目编号（如 `feat(fanqie): wire mergeFactVersion (FQ-01)`）。
- 状态升级必须有测试支撑：⚠️ → ✅ 需在 `test/*-v23.test.mjs` 或对应分层测试中新增至少一个**走真实调用链**的用例。
- 本表不复制计划正文、不记录决策；决议仍以计划 §6.0 为准。
- 每次改动后跑 `npm run verify`（只读类型检查 + 335 个核心用例）与 `npm run test:all`（508 个全量用例，需 Node ≥ 24.15），数字写回本页顶部基线。
- P0 表由 `doc-status-v23` 第 5 个用例守卫（24 行、全 ✅、标题计数与明细行一致）；状态升级仍要求人工/独立复核走真实调用链，守卫只保证表格自洽。

---

## 9. B2-5 · P0 清零复核补丁（2026-11-21）

B2-4 后以三路独立只读审查复核了全部 15 个提交，找出 **8 条会写坏数据或丢账的真实缺陷**，说明当时的「24/24」只是文档自证 —— `doc-status-v23` 原先明确把 P0 三列表排除在断言之外。本批已全部修复并补走真实调用链的用例；守卫测试新增第 5 个用例，强制 P0 表 24 行、全 ✅、标题计数一致、且与明细行的 phase/status 对齐。

### 9.1 已修复

| 缺陷 | 修法 | 验收 |
| --- | --- | --- |
| `commitFactSyncProposal` 读 `input.documentId`，可把提交重定向到同项目另一章，绕过 FQ-03/FQ-07 | 固定 `proposalDocId`，删除回落 | `fanqie-proposal-v23` 两条 B2-5 用例 |
| unpinned / 手工提案把改稿后的正文标 `clean` | `assertProposalFresh` 用 `source_sha256` 兜底；`staleCheck !== "fresh"` 跳过 `markChapterMemoryClean` | `fanqie-proposal-v23` 的 unpinned dirty 用例 |
| 历史 `document_id IS NULL` 提案永久无法确认 | `pinProposalChapter` 允许决策时补绑同项目章节，跨项目拒绝 | `fanqie-security-v23` 回填用例 |
| `deconstruct.delete` / `technique.delete` 只按 id 删除 | `assertLibraryDeleteScope`：项目资产须同项目，全局资产须显式 `scope:"global"`；前端与夹具同步补参 | `fanqie-security-v23` 删除用例 |
| `overrideOfId` 未从 payload 剥离 | 加入 `RESERVED_PAYLOAD_FIELDS` | 既有 FQ-06 用例 |
| 手工 fact_sync 提案的模型 id 直接落库 | `normalizeFactSyncPayload` 改为幂等，并在 `createManualProposal` 与 `decideProposal` 两处调用 | `fanqie-fact-sync-v23` 手工提案用例 |
| 15 秒排空超时后无条件 `dbOpen=false; db.close()`，迟到回执被静默吞掉 | 超时只强制二次 abort + 记日志 + 清内存锁，**继续 `await` 所有 task** 才关库；`shutdownDrainMs` 可注入 | `host-ledger-v23` 20ms 预算超时用例 |
| thinking 增量占满 `MAX_CANDIDATE_LENGTH` 误抛 | 流式只留 4× 宽松内存上限，严格上限移到最终可见 `body` | `generation-v2` 长 thinking 用例 |
| `selection.rewrite` / `backup.create` 等同步长耗时动作被压到 30s | 加入 120s 白名单 | `client-v2` 分类断言 |
| `ctx.inject` 返回的 disposer 被丢弃 | `runInServiceScope` 收集并返回给父 effect | `host-tools-v23` 作用域用例 |

为容纳漂移校验与补绑逻辑，新增 `src/application/proposal-freshness.ts`；`proposal-decide.ts` 从 363 行降回 308 行，满足 <350 行架构守卫。

### 9.2 仍未解决 / 已知限制（不计入 P0 完成）

1. **决议 #3 未决**：`writing.ts` 的回执四元组绕过 `normalizeUsage`；若宿主 `inputTokens` 已含缓存命中，`settled` / `microUsage.totalInput` 会双计。改动涉及账单语义，须先定 #3。
2. **决议 #5 未决**：DSH-14 的②（固定上游类型）与③（隔离 profile 录制）仍缺；`assertHostToolDefinition` 只是对齐自造的 strict registrar，与 fixture 尚有 4 处规则漂移；`output.schema` 用 `additionalProperties:true` 与上游类型契约相反。
3. **FE-16 仍 ⚠️**：`test:browser` 依赖 Playwright，本机未安装。
4. **FE-07 幂等键**：`draft.save` 非幂等，超时重试仍可能撞 `version.conflict`；当前策略是「超时 + 本地稿兜底」，无自动重读对账。
5. **测试链覆盖**：多数 `*-v23` 用例走 `ws.app.mutation`（真实 mutation 分发），但绕过 host HTTP / 异步 `proposal.generate`；前端 TS 视图与 agent 工具入口基本零覆盖；`client-v2` 的 FE-27 是源码字符串正则而非运行时行为断言。
6. **thinking 乱序边界**：同一 index 被 `block-end` 双向覆盖、或流在声明块类型前截断，仍可能丢正文或把思维链当正文；`sawThinkingBlock` 置位后不复原。
7. **宿主次要竞态**：启动失败 catch 用 `void dispose()` 不等异步 disposer；`microUsage` 在组合根填充，与 `run.detail` 其余字段不是同一读快照；`recoverMicroCalls()` 一律标 `uncertain`，不区分已有回执。
8. `project.import_bundle` 直写库资产表，未复用 `assertLibraryWriteScope`（自身按项目隔离，无跨项目覆盖能力，但零测试）。

### 9.3 验收

`npm run check` 通过；`npm test` 44 文件 / 335 用例全绿；`test:v23` 12 / 87 全绿；`npm run build` 通过且产出浏览器镜像；`test:all` 静态 70 / 508，本机 Node 22 实测 507 执行 / 506 通过（唯一失败仍是 `workflow-w01` 的 `using` 语法，需 Node ≥ 24.15）。

