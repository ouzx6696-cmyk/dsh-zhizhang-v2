# 织章 V2 · 后端数据库逻辑全量审阅与优化计划

> 审阅范围：src/storage、src/workflow，平台应用服务（context、run、proposal、snapshot），src/contracts，以及相关测试和文档。全程只读，未修改项目文件。

## 一、现状概览

数据层只通过 node:sqlite 一个入口访问（driver.ts），在此之上有三套机制。一是单事务内按『幂等→基准→业务』顺序执行的命令账本，配合 tx.ts 的 BEGIN IMMEDIATE/SAVEPOINT 嵌套。二是每个项目一条单调递增的事件日志，加上投影和读模型（readserve/author-reads），支持检查点冷恢复，并有 8 行恢复矩阵测试。三是由 schema_migrations 管理的 38 张业务表，加上 External Content 的 FTS5 trigram 三张表、映射表和 14 个触发器，以及与外部写文件分离的交付状态机和带 SHA-256 清单的备份。整体设计意图清晰，契约冻结严谨，对正确性语义的测试很充分。短板集中在『规模与运维』：账本用量口径冲突，journal 和正文保存的写放大，读模型冷启动时按键各自全量回放、导航 reducer 为 O(N²)，FTS 的排序成本和短词检索，备份没有接入生产，以及 schema 归属分散。

## 二、优点

- 驱动入口单点隔离（driver.ts）
- 命令写入顺序被冻结且只实现一次：先查幂等再查基准，canonicalJson 结构化比对，出错整体回滚
- appendEvent 用一条 SQL 原子分配 seq，消除多连接竞态
- tx.ts 的 SAVEPOINT 嵌套、读事务内禁止写，均有测试覆盖
- 生成账本把中断的 inflight 标为 uncertain，由人工 reconcile，不猜测用量
- FTS 使用外部内容视图，正文不重复存储，并有完整性校验测试
- 交付提交与写文件分离，失败分为可重试和需作者处理两类
- schema 窗口拒绝 v1.x 和 3.x 的库；从 2.0 升级的测试完备

## 三、发现汇总

| ID | 严重度 | 类别 | 标题 | 工作量 |
|---|---|---|---|---|
| DB-01 | high | correctness | 令牌用量口径冲突：cache_read 被重复计入已结算用量与预算 | M |
| DB-02 | high | performance | command_journal 写放大：非幂等命令也把完整请求体（含整章正文）写入日志，而修剪函数从未被调用 | M |
| DB-03 | high | performance | 读模型冷启动：每个缓存键都独立回放整个项目日志，导航 reducer 为 O(N²)，读请求还会触发写检查点 | L |
| DB-04 | high | correctness | 备份链路未接入生产；离线备份可能丢失 WAL 内容；哈希计算和清单写入不安全 | M |
| DB-05 | high | performance | FTS 检索先对所有命中行计算 snippet 并 JOIN，再排序截断；项目过滤发生在 MATCH 之后 | M |
| DB-06 | high | performance | 1–2 个字的中文查询退化为全表 LIKE 扫描，相关章召回直接丢弃短词 | M |
| DB-07 | medium | correctness | PRAGMA 与连接配置不完整：busy_timeout 设得比切换 WAL 晚，缺少 journal_size_limit 和 optimize，Windows 上 mmap 设为 256MB | S |
| DB-08 | medium | performance | 预编译语句缓存没有上限，而且连动态拼接的 SQL 也被缓存 | S |
| DB-09 | medium | architecture | Schema 归属分散：平台层的 author-schema 里包含两条产品线的表，产品模块重复执行 DDL，部分 DDL 绕过了迁移体系 | L |
| DB-10 | medium | correctness | 外键与约束覆盖不全：ALTER 新增的列没有外键，没有 STRICT/CHECK，JSON 列不校验，时间戳类型不统一 | L |
| DB-11 | medium | performance | 章序用整本书的 JSON 数组存储（author_chapter_order），每次移动都要整体重写和解析 | M |
| DB-12 | medium | performance | 热点查询缺少索引 | S |
| DB-13 | medium | correctness | AI 提案账本没有数据库级互斥，也没有『用量不确定』这一语义 | M |
| DB-14 | medium | correctness | 生成回执可能被静默丢弃；同一份用量存了两处 | S |
| DB-15 | medium | performance | snapshot/readState 每次都返回很重的全量快照，ifSequence 只覆盖当前项目 | M |
| DB-16 | medium | performance | rebuildProjectFts 实际上会重建全库，而且在导入后的写事务里同步执行 | S |
| DB-18 | medium | performance | 保存正文的整体写放大：修订永久保留，记忆同步还另存一份正文 | M |
| DB-19 | medium | correctness | 事件日志无限增长，且只要有一条历史事件缺少 concern，整个项目的读模型都会失效 | M |
| DB-20 | medium | bug | 本地导出没有处理 Windows 保留文件名，目录替换缺少重试 | S |
| DB-21 | medium | docs | docs/04 与代码实现不一致 | S |
| DB-24 | medium | testing | 缺少规模化测试和故障注入测试 | M |
| DB-17 | low | performance | 拆书和技法的 FTS 触发器在任意列更新时都会整条重建索引 | S |
| DB-22 | low | maintainability | 死代码和仅供测试使用的 API 混在 storage 的公共出口中 | S |
| DB-23 | low | maintainability | 错误码到 HTTP 状态码的映射太粗 | S |
| DB-25 | low | correctness | 读模型内存缓存与恢复的边界情况 | S |
| DB-26 | low | feature-gap | 缺少项目级和月度累计预算账本 | M |
| DB-27 | low | maintainability | 事务封装没有和驱动层的实际事务状态做交叉校验 | S |

## 四、发现详情

### DB-01 令牌用量口径冲突：cache_read 被重复计入已结算用量与预算
- **严重度 / 类别 / 工作量**：high / correctness / M
- **文件**：src/workflow/budget.ts:96-98；src/workflow/writing-budget.ts:81-96,122；src/host/writing.ts:208-218；src/application/run-service.ts:407-408；src/application/proposal-service.ts:127；src/client/workbench/views/run-inspector.ts:57-63
- **证据**：host/writing.ts 把 LlmUsage 映射为 [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens]；sumUsageTuple→totalTokens 把四类直接相加（input+output+cache_read+cache_write），结果写入 author_runs.settled、预算守卫 settle 和提案 settled。但 computeRunBilling 与 run-inspector 用 `input - cacheRead` 计算有效计费，说明代码自己把 cache_read 当成 input 的子集。DeepSeek 用量中 prompt_cache_hit_tokens + prompt_cache_miss_tokens 才是总输入；如果 DsH 的 inputTokens 表示总输入（AI SDK 等常见约定），cache_read 就被算了两遍。
- **影响**：缓存命中越高，settled 被高估越多。番茄的 Prefix-First 正是为了提高命中率，结果反而会更早触发 budget.exhausted（actual-usage），把写作误判为超预算。账本、提案 settled、运行检查器的计费是三套不一致的数字，作者用 run.reconcile 对账时也无法和提供方账单对齐。
- **建议**：1) 在 host 边界把 LlmUsage 统一规范为互斥的四类：input 只含未命中输入，cache_read 为命中输入，另加 cache_write 和 output；在 contracts 中写明语义并补单测；2) 集中实现 normalizeUsage(raw, {inputIncludesCache})，该参数默认值以 DsH 实测为准；3) computeRunBilling 和 run-inspector 去掉 `cacheRead <= input ?` 这种猜测分支；4) 回归测试：回执 input=1000、cache_read=800 时，settled 必须是 1000+output，而不是 1800+output。四类互斥后，B.4 规定的『settle 对四类求和』依然成立，不需要改冻结契约，但口径需要作者确认。
- **参考**：https://api-docs.deepseek.com/guides/kv_cache

### DB-02 command_journal 写放大：非幂等命令也把完整请求体（含整章正文）写入日志，而修剪函数从未被调用
- **严重度 / 类别 / 工作量**：high / performance / M
- **文件**：src/application/context.ts:178-193；src/storage/command.ts:200-255,269-306,550-553；src/contracts/commands.ts:58-136
- **证据**：commandInput() 把整个 input 作为 payload，包括 draft.save 的 body、candidate.adopt 的 mergedBody、run.start 的 instruction 等。executeCommand 对 idempotent=false 的命令（draft.save、run.start、draft.finalize、setting.decide、article.accept）生成随机 UUID 作为键，这些行永远不会被重放，却仍以 canonicalJson 写入 request_payload 和 result_payload。全仓库 grep 显示，pruneCommandJournal 只在测试里被调用。
- **影响**：每保存一次正文，正文就至少多存一份（2,500 字的章节约 7.5KB UTF-8）。5000 章、多次保存之后，command_journal 可能比正文本身还大，拖慢备份、VACUUM 和哈希校验，数据库体积无上限增长。
- **建议**：1) executeCommand 遇到 idempotent=false 时只写审计元数据（command_id、document_id、request_hash、created_at、结果小摘要），或干脆不写；2) 可重放命令的 request_payload 去掉大字段（body、mergedBody、sourceText），只保存它们的 sha256，重放时比对哈希；3) 宿主启动时以及每 24 小时调用一次 pruneCommandJournal，由 ctx.effect 注册定时器，卸载时清理；4) 测试：100 次 draft.save 后 command_journal 总大小 < 100KB。

### DB-03 读模型冷启动：每个缓存键都独立回放整个项目日志，导航 reducer 为 O(N²)，读请求还会触发写检查点
- **严重度 / 类别 / 工作量**：high / performance / L
- **文件**：src/workflow/author-reads.ts:51-175,339-429；src/workflow/readserve.ts:108-171；src/storage/projection.ts:109-189
- **证据**：createAuthorModelReader 为每个 cacheKey（[projectId, model, ...identity, point]）各建一个 ProjectionStore，只注册一个 unit；没有检查点时，从 seq=0 开始按每页 1000 条把整个项目日志全部折叠一遍。revision-candidate 按文档分键，settings-view 按角色和 point 分键，每个键都要全量回放一次。navigation reducer 每遇到一条 document.created 就执行 `[...state.chapters, x]`，每遇到一条 chapter.reordered 就整表排序，5000 章约产生 1250 万次元素复制。只要本次折叠了事件（>0 条），读请求就会开写事务，把完整状态 JSON 写入 author_read_checkpoints，这张表的行数随键数无限增长。readserve.ts 注释里的设计是『一个共享水位推进所有读模型』，但实际实现没有共享。
- **影响**：大书冷启动、或第一次打开某一章或某个角色的知情视图时，读延迟随日志长度线性增长、随章节数平方增长；读路径上产生写入，导致 WAL 增长和锁竞争；检查点表持续膨胀。
- **建议**：1) 每个项目只建一个 ProjectionStore，已用到的 unit 一次注册，共用一遍折叠（与 B.7 的共享水位设计一致）；新 unit 先从自己的检查点恢复，否则单独补折叠；2) navigation reducer 内部改用 Map 加有序 id 数组做增量更新，到 view 时再物化；3) 检查点按事件数（每 200 条）或空闲时间（5 秒）节流后批量写入；4) author_read_checkpoints 增加 last_used_at 列，按 LRU 保留至多 2000 行；5) event_log 增加冗余的 concern 列和 (project_id, concern, seq) 索引，只用来加速读取；6) 基准：5 万条事件、5000 章，navigation 冷读 < 300ms、热读 < 5ms。

### DB-04 备份链路未接入生产；离线备份可能丢失 WAL 内容；哈希计算和清单写入不安全
- **严重度 / 类别 / 工作量**：high / correctness / M
- **文件**：src/storage/backup.ts:56-59,92-132,135-187,220-244,284-300；src/host/plugin.ts（未调用任何备份 API）
- **证据**：createHotBackup 只被导出和在测试中使用，宿主没有任何自动备份。createBackup/backupWorkspace 只 copyFile 主库文件：如果 -wal 还没有 checkpoint（宿主异常退出或仍有其他连接打开），WAL 中已提交的事务不会进入备份。sha256OfFile 用 readFile 把整个库读入内存；manifest.json 直接 writeFile，没有先写临时文件再 rename；listBackups 每次都把所有备份完整重新哈希一遍。
- **影响**：作者以为有备份，实际上从未自动备份过；在 WAL 模式下，手动离线备份可能不完整；库达到几百 MB 时，备份和校验会占用大量内存；列出备份很慢。
- **建议**：1) 改用 node:sqlite 的 backup(sourceDb, path) 做在线分页备份，或用 VACUUM INTO；createBackup 发现 -wal 存在时，先执行 wal_checkpoint(TRUNCATE)，做不到就拒绝备份；2) 哈希改为流式计算；3) manifest 先写 .tmp 文件，再 rename 成正式文件；4) listBackups 缓存校验结果；5) 宿主在三个时机自动备份：迁移前、每天首次打开时、交稿后；保留份数（7）需作者确认；6) /diag 显示最近一次有效备份的时间。
- **参考**：https://nodejs.org/api/sqlite.html https://www.sqlite.org/lang_vacuum.html#vacuuminto https://www.sqlite.org/wal.html

### DB-05 FTS 检索先对所有命中行计算 snippet 并 JOIN，再排序截断；项目过滤发生在 MATCH 之后
- **严重度 / 类别 / 工作量**：high / performance / M
- **文件**：src/storage/fts.ts:497-550,552-597,599-665,747-802
- **证据**：章节查询写法是：SELECT 列里有两次 snippet()，FROM fts JOIN fts_rowid_map JOIN v_fts_chapters，WHERE 先 MATCH 全库，ORDER BY bm25(...) LIMIT ?。按 bm25 表达式排序时，每一条命中行都要先算出全部结果列，snippet 还需要通过外部内容视图回读整章正文，然后才排序；project_id 的过滤也是在全库 MATCH 之后通过 JOIN 才生效。
- **影响**：一个常见的三字词如果在 5000 章中命中上千章，每次搜索都要把这些章的正文全部读出来生成片段，延迟随命中数线性增长；有多本书时还会扫到别的书。
- **建议**：1) 改成两段式查询：内层只选 rowid，按 rank 排序后 LIMIT（rank 通过 'rank' 配置项设为 bm25(6,3,1)），外层只对前 K 条做 JOIN 和 snippet；2) 项目过滤：在外部内容视图里加一个 project_id UNINDEXED 列，或者内层多取 4 倍再在外层过滤；3) 基准：5000 章中命中 1000 章时，搜索 < 50ms。
- **参考**：https://www.sqlite.org/fts5.html

### DB-06 1–2 个字的中文查询退化为全表 LIKE 扫描，相关章召回直接丢弃短词
- **严重度 / 类别 / 工作量**：high / performance / M
- **文件**：src/storage/fts.ts:681-689,523-542,572-589,756-765
- **证据**：代码中 useFts = 查询长度 >= 3。少于 3 个字时，对所有正文执行 `LIKE '%x%'`；searchRelatedChaptersByFts 直接跳过少于 3 个字的词。中文人名大多是 2 个字，而 trigram 分词器无法为少于 3 个字符的子串建立索引。
- **影响**：作者最常搜索的恰恰是 2 字人名，在大书上每次搜索都要全量扫描正文；四维相关章召回中的语义维度对 2 字实体完全失效。
- **建议**：1) 2 字以内的查询先查 author_chapter_entities（实体倒排表）和标题、摘要；正文 LIKE 只作兜底，并加 LIMIT；2) 可选方案（P2，需要先做基准）：建一张影子 FTS5 表，用 unicode61 分词，存入预先切好的重叠二元组，让 2 字查询也能走索引；3) 相关章召回中，2 字实体改用 entities 表打分。
- **参考**：https://www.sqlite.org/fts5.html

### DB-07 PRAGMA 与连接配置不完整：busy_timeout 设得比切换 WAL 晚，缺少 journal_size_limit 和 optimize，Windows 上 mmap 设为 256MB
- **严重度 / 类别 / 工作量**：medium / correctness / S
- **文件**：src/storage/stmt-pool.ts:27-36；src/storage/driver.ts:36-38；src/storage/store.ts:57-80
- **证据**：切换 journal_mode=WAL 时 busy_timeout 还没设置（node:sqlite 的 timeout 默认为 0）；全仓库没有 journal_size_limit、wal_autocheckpoint、PRAGMA optimize、ANALYZE、wal_checkpoint；mmap_size 写死为 256MB；创建连接时也没有使用 timeout、defensive 等构造选项。
- **影响**：多个连接首次打开时可能直接报 SQLITE_BUSY；WAL 文件在长期运行中可能持续变大；查询优化器缺少统计信息；Windows 上映射大文件会加剧 EPERM/EBUSY 冲突。
- **建议**：1) openDatabase 统一传入 {timeout:5000, enableForeignKeyConstraints:true, defensive:true}；2) 先设 busy_timeout，再切换 WAL，并设置 journal_size_limit=64MB；3) 关闭连接前执行 PRAGMA optimize，导入后执行 ANALYZE，正常卸载时执行 wal_checkpoint(TRUNCATE)；4) Windows 上 mmap 默认设为 0；5) /diag 输出各 PRAGMA 的实际值。
- **参考**：https://nodejs.org/api/sqlite.html https://www.sqlite.org/wal.html https://www.sqlite.org/pragma.html#pragma_optimize

### DB-08 预编译语句缓存没有上限，而且连动态拼接的 SQL 也被缓存
- **严重度 / 类别 / 工作量**：medium / performance / S
- **文件**：src/storage/stmt-pool.ts:3-21；src/application/products/fanqie/context.ts:174-179；src/application/products/fanqie/lore.ts:312-318；src/application/products/fanqie/proposal-decide.ts:122-130
- **证据**：stmt() 永久缓存每一条 SQL 对应的预编译语句；fanqie/context.ts 的 `IN (?, ?, …)` 每种长度都会生成一条新语句；lore 和 proposal 的 WHERE 条件按组合动态拼接；缓存的语句从不 finalize。
- **影响**：长时间运行时预编译语句不断累积，占用内存，缓存也失去意义。
- **建议**：1) 改为 LRU 缓存，上限 256 条，淘汰时调用 close()；也可以直接用 node:sqlite 的 createTagStore(maxSize)；2) 可变长度的 IN 统一写成 `IN (SELECT value FROM json_each(?))`；3) 可选筛选条件写成固定 SQL：`(? IS NULL OR col = ?)`。
- **参考**：https://nodejs.org/api/sqlite.html https://www.sqlite.org/json1.html#jeach

### DB-09 Schema 归属分散：平台层的 author-schema 里包含两条产品线的表，产品模块重复执行 DDL，部分 DDL 绕过了迁移体系
- **严重度 / 类别 / 工作量**：medium / architecture / L
- **文件**：src/storage/author-schema.ts:59-265,453-514；src/application/products/fanqie.ts（initSchema）；src/application/products/toutiao/index.ts（initSchema）；src/storage/author-generation.ts:34-55；src/storage/fts.ts:271-301；src/application/context.ts:97-103
- **证据**：storage 层的 author-schema 创建了 library_*、foreshadows、article_reports、candidate_qa 等产品线专属的表；fanqie.initSchema 又调用一次 createAuthorSchema，toutiao.initSchema 又重复声明了两张表；生成账本和 FTS 的 DDL 不在 schema_migrations 管理范围内；meta.schema 一直停留在 'zhizhang/2.0'。
- **影响**：违背 AGENTS.md 规定的分层边界；新增产品线或调整表结构时找不到唯一的定义来源；备份无法判断库的真实版本。
- **建议**：1) 迁移按命名空间拆分为 platform:*、fanqie:*、toutiao:* 三组，由 ProductLineModule.migrations 提供各自迁移，统一由 runMigrations 执行；2) 所有 DDL 都通过迁移创建；3) 将 meta.schema 更新为 'zhizhang/2.2'，同时设置 user_version，并在备份清单中记录已应用的迁移；4) 增加静态守卫：storage/ 目录中不允许出现产品线表名前缀。

### DB-10 外键与约束覆盖不全：ALTER 新增的列没有外键，没有 STRICT/CHECK，JSON 列不校验，时间戳类型不统一
- **严重度 / 类别 / 工作量**：medium / correctness / L
- **文件**：src/storage/author-schema.ts:126-131,183-195,248-264,269-273；src/storage/export.ts:49-59；src/storage/eventlog.ts:69-80
- **证据**：author_documents 的 volume_id/act_id，foreshadows 中的各个章节 id，proposals 的 project_id/document_id，deliveries 的 article_id，都没有外键；状态列没有 CHECK 约束；JSON 列没有 json_valid 校验；author_approvals.at 是 TEXT，其他时间戳是 INTEGER；event_log 没有时间戳。
- **影响**：容易产生孤儿行和脏数据，只能在读取时兜底处理；审计时无法知道事件发生的时间。
- **建议**：1) 在 2.3 迁移中按 SQLite 官方的十二步改表法重建相关表：补齐外键，状态列加 CHECK（取值与 TS 常量同源），JSON 列加 json_valid 校验，新表采用 STRICT；2) event_log 新增 created_at 列，不修改 payload，因此不影响 B.7；3) /diag 中执行 foreign_key_check 和 quick_check。
- **参考**：https://www.sqlite.org/lang_altertable.html#otheralter https://www.sqlite.org/stricttables.html

### DB-11 章序用整本书的 JSON 数组存储（author_chapter_order），每次移动都要整体重写和解析
- **严重度 / 类别 / 工作量**：medium / performance / M
- **文件**：src/storage/author-schema.ts:132-135；src/application/context.ts:248-256；src/application/products/fanqie/tree.ts:70-75；src/application/snapshot-service.ts:16-21
- **证据**：saveFlatOrder 把所有章节 id 拼成一个 JSON 整行写入；每次 snapshot 都要 JSON.parse 整个数组；author_documents 表没有排序列。
- **影响**：5000 章时每移动一章就要写约 180KB；每次轮询都要解析整个数组；无法按章节顺序做索引分页。
- **建议**：在 author_documents 增加 sort_key 列（分数索引）并建 (project_id, volume_id, act_id, sort_key) 索引，迁移时从现有 JSON 回填；移动一章只更新一行；两步重排协议的语义保持不变。

### DB-12 热点查询缺少索引
- **严重度 / 类别 / 工作量**：medium / performance / S
- **文件**：src/storage/command.ts:68-83；src/storage/author-generation.ts:45,126-130；src/storage/author-schema.ts:313-331；src/application/proposal-service.ts:176-184
- **证据**：revisions 和 candidates 都没有 document_id 索引；generation 按 state 查询、proposals 按 status 和 document_id 查询都会全表扫描；author_runs 的索引不含 state；没有 settings(project_id, fact_id) 和 foreshadows 按章节的索引。
- **影响**：数据量增长后，启动恢复、并发竞争检查、知情查询和伏笔召回会逐渐变慢。
- **建议**：新增以下索引（多为部分索引）：revisions(document_id, created_at)、candidates(document_id)、attempts(state) WHERE 状态为未完成、proposals(status) WHERE status='inflight'、proposals(document_id)、runs(document_id, state)、settings(project_id, fact_id)、foreshadows(project_id, target_chapter_id)；另新增 query-plan 测试，用 EXPLAIN QUERY PLAN 断言约 20 条热点 SQL 不出现大表 SCAN。
- **参考**：https://www.sqlite.org/eqp.html https://www.sqlite.org/partialindex.html

### DB-13 AI 提案账本没有数据库级互斥，也没有『用量不确定』这一语义
- **严重度 / 类别 / 工作量**：medium / correctness / M
- **文件**：src/application/proposal-service.ts:50-123,176-184；src/host/plugin.ts:284-297
- **证据**：互斥只依赖插件进程内存中的 proposalLocks；recoverProposals 把所有 inflight 记录一律标为 failed；开始生成时不写任何事件。
- **影响**：多连接或多实例时可能重复扣费；中断导致的用量被当作 0，和正文生成『uncertain + 人工核对』的处理方式不一致；前端感知不到提案已开始。
- **建议**：1) 建部分唯一索引：同一 kind 和作用域在 status='inflight' 时只能有一条，冲突时返回 gate.denied；2) 提案复用 generation 的调用级账本，中断时标为 uncertain，可走 reconcile；3) 开始生成时写一条 proposal.started 事件。

### DB-14 生成回执可能被静默丢弃；同一份用量存了两处
- **严重度 / 类别 / 工作量**：medium / correctness / S
- **文件**：src/application/run-service.ts:390-394；src/storage/author-generation.ts:96-112,121-124
- **证据**：recordGenerationReceipt 忽略 receiveCall 返回的 false，迟到的回执被直接丢掉；calls.usage 和 attempts.usage 各存一份用量。
- **影响**：取消或超时之后才到的真实用量会丢失，作者对账时少计；两处数据存在不一致的风险。
- **建议**：迟到回执写入 late_usage 列或一条事件，供 reconcile 页面展示；attempt 的用量改为从 calls 求和得出，或在 /diag 中做一致性比对。

### DB-15 snapshot/readState 每次都返回很重的全量快照，ifSequence 只覆盖当前项目
- **严重度 / 类别 / 工作量**：medium / performance / M
- **文件**：src/application/snapshot-service.ts:8-109
- **证据**：当前项目的 seq 一变就重建全部内容：所有项目和文档列表、JSON 章序、整章正文、最近的运行、产品线追加的数据；其他项目发生变化时仍返回 unchanged。
- **影响**：任何一个小事件都会触发一次全量重建和传输；跨项目的变化无法及时反映到界面。
- **建议**：拆成轻量快照（带 ETag）和按需获取的重型内容（按 revisionId 缓存）；ifSequence 改为全局 seq 加项目 seq 的组合；章序结果按 seq 缓存。

### DB-16 rebuildProjectFts 实际上会重建全库，而且在导入后的写事务里同步执行
- **严重度 / 类别 / 工作量**：medium / performance / S
- **文件**：src/storage/fts.ts:412-470；src/application/products/fanqie/io.ts:828
- **证据**：函数最后对三张 FTS 表执行全表 'rebuild'；每次导入都会调用它。
- **影响**：书越多导入越慢，期间一直持有写锁，导致其他标签页保存失败（busy_timeout 只有 5 秒）。
- **建议**：改为只按本项目的映射行删除后重新插入；全库重建单独命名为 rebuildAllFts，只用于维护；导入完成后执行一次 'optimize'。
- **参考**：https://www.sqlite.org/fts5.html

### DB-18 保存正文的整体写放大：修订永久保留，记忆同步还另存一份正文
- **严重度 / 类别 / 工作量**：medium / performance / M
- **文件**：src/application/context.ts:210-246；src/storage/command.ts:347-365；src/storage/author-schema.ts:425-433
- **证据**：一次 draft.save 会写入：完整修订、trigram 先删后插、journal 中的正文副本、memory_sync.synced_body 中的正文副本、事件日志。修订没有任何保留策略。
- **影响**：库体积约为正文的 5–10 倍，备份和校验耗时随之线性增长。
- **建议**：1) memory_sync 改为只记录 synced_revision_id，删除 synced_body；2) 修订保留策略需作者决定：定稿、被采纳候选的基准版本、交稿版本和每日最后一版永久保留，更早的自动保存版本合并为每日快照，作为需作者确认的维护命令；3) /diag 中显示各表体积。

### DB-19 事件日志无限增长，且只要有一条历史事件缺少 concern，整个项目的读模型都会失效
- **严重度 / 类别 / 工作量**：medium / correctness / M
- **文件**：src/storage/eventlog.ts:69-127；src/workflow/readserve.ts:78-97,137-144
- **证据**：读取时，concern 不在封闭词表内的事件会直接抛出 unknown-concern 错误，即使该事件已在水位之下也照样检查；日志既不归档也不压缩。
- **影响**：一条脏事件就会让整个项目的读模型不可用，而且没有自动恢复手段。
- **建议**：1) 写一个迁移，按 kind 推断并回填缺失的 concern，无法推断的事件放入隔离表；2) 启动时只读自检，结果在 /diag 中报告；3) 日志归档涉及 B.7，列为需作者授权的 P3 选项。

### DB-20 本地导出没有处理 Windows 保留文件名，目录替换缺少重试
- **严重度 / 类别 / 工作量**：medium / bug / S
- **文件**：src/storage/local-io.ts:26-34,135-192
- **证据**：sanitizePathSegment 没有处理 CON、NUL、COM1 等保留名，也没有去掉结尾空格；renameSync 在目录被资源管理器占用时会抛出 EPERM。
- **影响**：项目实际运行在 Windows 上，章节如果以保留名命名、或导出目录正被打开，导出就会失败。
- **建议**：1) 保留名加后缀，并附加短哈希避免同名冲突；2) rename 遇到 EPERM/EBUSY 时退避重试 3 次，仍失败则返回 dependency.unavailable；3) 增加 Windows 专项单测。
- **参考**：https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file

### DB-21 docs/04 与代码实现不一致
- **严重度 / 类别 / 工作量**：medium / docs / S
- **文件**：docs/04-data-and-workflow.md；src/workflow/writing-budget.ts:41-67；src/workflow/author-reads.ts:331-429
- **证据**：文档写的是 23 张表，实际有 38 张表，另有 3 张 FTS 表、3 个视图、14 个触发器、25 个索引；文档说输入估算按 UTF-8 字节数 + 128，实际是 CJK 1.4 加权；文档说 LRU 为 32，实际是 256；文档描述的恢复流程用 readTail，实际用锚点加分页 serve。
- **影响**：后续开发者和 Agent 会按错误的模型去优化或排查问题。
- **建议**：新增 scripts/schema-doc.mjs，从 sqlite_master 自动生成 schema 文档；docs/04 只保留设计意图，并加一项守卫测试检查生成文档与实际 schema 是否一致。

### DB-24 缺少规模化测试和故障注入测试
- **严重度 / 类别 / 工作量**：medium / testing / M
- **文件**：test/workspace-v2.test.mjs:286-308,392-422；test/sprint1-v2.test.mjs；test/sprint2-v2.test.mjs；scripts/workspace-bench.mjs
- **证据**：现有测试规模只有 5–25 章；bench 只测了 650 章的响应体积；没有 EXPLAIN 断言；没有测试覆盖 cache_read 计费口径、journal 体积、SQLITE_FULL、跨进程 BUSY、-wal 存在时的备份。
- **影响**：DB-01/02/03/05/06 这几类问题在现有测试下全部是绿灯，无法发现回归。
- **建议**：1) 新增 scripts/db-bench.mjs：构造 5000 章 × 2500 字、5 万条事件，输出 JSON 并设门限；2) 新增 query-plan 测试；3) 新增 usage-ledger 测试；4) 用 child_process 起一个持有写锁的进程，测试 BUSY 场景。

### DB-17 拆书和技法的 FTS 触发器在任意列更新时都会整条重建索引
- **严重度 / 类别 / 工作量**：low / performance / S
- **文件**：src/storage/fts.ts:180-199,213-232
- **证据**：触发器写的是 UPDATE ON library_*，没有用 UPDATE OF 限定列。
- **影响**：仅修改 updated_at 或 priority 时，也会做一次 trigram 删除和重建。
- **建议**：改为 UPDATE OF 文本列加 status；补充测试：只改 updated_at 时，fts_library 不应发生变化。

### DB-22 死代码和仅供测试使用的 API 混在 storage 的公共出口中
- **严重度 / 类别 / 工作量**：low / maintainability / S
- **文件**：src/storage/projection.ts:58-67,222-256；src/storage/index.ts；src/storage/command.ts:367-467；src/storage/backup.ts:92-107
- **证据**：生产代码从未调用 projection_rows/saveCheckpoint、createHotBackup、pruneCommandJournal、verifyFtsIntegrity、saveDraft/adoptCandidate、commitDelivery；rowCount 通过拼接表名构造 SQL。
- **影响**：公共出口过宽，阅读成本高；真正有用的维护能力反而没有接入。
- **建议**：示例命令和 rowCount 移到 support/ 目录；修剪、热备、FTS 校验接入宿主的维护任务和 /diag；projection_rows 要么作为 DB-03 中共享 Store 的检查点表启用，要么删除。

### DB-23 错误码到 HTTP 状态码的映射太粗
- **严重度 / 类别 / 工作量**：low / maintainability / S
- **文件**：docs/02-domain-rules.md（错误码表）；src/host/plugin.ts（handleRouteError）
- **证据**：auth.denied、storage.format_unsupported、dependency.unavailable 都返回 409。
- **影响**：监控和日志无法区分权限问题、库损坏和依赖不可用。
- **建议**：auth.denied 映射为 403，storage.format_unsupported 为 500，dependency.unavailable 为 503；错误码集合和信封格式不变（B.1）；需与 DsH、前端两个视角一起修改。

### DB-25 读模型内存缓存与恢复的边界情况
- **严重度 / 类别 / 工作量**：low / correctness / S
- **文件**：src/workflow/author-reads.ts:344-429
- **证据**：缓存只在 seq 回退时失效；每个读模型最多缓存 256 份完整状态，每次读取都要 structuredClone。
- **影响**：进程不重启就替换数据库时，可能返回旧数据；clone 大对象有 CPU 开销。
- **建议**：缓存键中加入数据库标识（在 meta 里存一个 uuid）；大视图改为返回冻结对象，避免每次 clone。

### DB-26 缺少项目级和月度累计预算账本
- **严重度 / 类别 / 工作量**：low / feature-gap / M
- **文件**：src/workflow/budget.ts:122-191；src/application/proposal-service.ts:56；src/application/run-service.ts:118-144
- **证据**：预算只针对单次 run，提案和选段改写各自使用默认额度，没有累计上限；MoneyCap 尚未冻结（C.1-11）。
- **影响**：作者无法控制一本书的总花费，Agent 工具频繁调用时尤其明显。
- **建议**：需作者决策：新增按项目和日期汇总的账本视图，默认只做软提醒，硬上限沿用 budget.exhausted。

### DB-27 事务封装没有和驱动层的实际事务状态做交叉校验
- **严重度 / 类别 / 工作量**：low / maintainability / S
- **文件**：src/storage/tx.ts:10-100
- **证据**：事务状态只记录在 WeakMap 中；如果有人绕过封装直接执行 BEGIN，记录就会和实际状态不一致。node:sqlite 提供了 isTransaction 属性。
- **影响**：将来出现隐蔽的嵌套事务错误时难以排查。
- **建议**：进入事务前断言 `!db.isTransaction || txStates.has(db)`，否则拒绝并报 foreign-transaction。
- **参考**：https://nodejs.org/api/sqlite.html

## 五、分阶段路线图

### P0 快速止血（3–4 天）
- 目标：修正账本口径，阻止数据库无界膨胀，补齐连接配置
- 包含：DB-01, DB-02, DB-07, DB-08, DB-14, DB-21
- 退出标准：
  - usage-ledger 测试：input=1000、cache_read=800 时 settled=1000+output，runs、proposals、run-inspector 三处结果一致
  - 100 次 draft.save 后 command_journal 总大小 < 100KB；/diag 能证明宿主启动时执行过修剪
  - busy_timeout 在 WAL 切换之前设置；/diag 输出各 PRAGMA 的实际值
  - stmt 缓存条目 ≤ 256
  - schema 文档由脚本生成并通过守卫测试；npm run test:all 全绿

### P1 读写热点与备份（1.5–2 周）
- 目标：读模型、检索、快照、备份在 5000 章规模下可用
- 包含：DB-03, DB-04, DB-05, DB-12, DB-13, DB-15, DB-16, DB-17, DB-24
- 退出标准：
  - db-bench（5000 章、5 万事件）：navigation 冷读 < 300ms、热读 < 5ms；三字搜索 < 50ms；轻量快照 < 20ms
  - 没有新事件时，读请求不产生任何写事务
  - query-plan 测试中热点 SQL 无大表 SCAN
  - 迁移前和每天首次打开时自动热备并校验通过；-wal 存在时备份会先 checkpoint，否则拒绝
  - 两个连接同时提交同类提案，只有一个进入 inflight

### P2 结构治理（2–3 周）
- 目标：理清 schema 归属，加固约束，改造章序存储与短词检索
- 包含：DB-06, DB-09, DB-10, DB-11, DB-18, DB-19, DB-20, DB-22
- 退出标准：
  - 迁移按 platform/fanqie/toutiao 命名空间拆分，并有静态守卫
  - meta.schema=zhizhang/2.2 且与 user_version 一致
  - foreign_key_check 结果为空；写入非法状态值会被 CHECK 拒绝
  - 拖动一章只更新 1 行；5000 章重排 commit < 100ms
  - 5000 章中搜索 2 字人名 < 80ms
  - Windows 保留名和 EPERM 重试的用例通过

### P3 需作者授权的演进项
- 目标：修订保留、日志归档、全局预算、状态码映射
- 包含：DB-18, DB-19, DB-23, DB-25, DB-26, DB-27
- 退出标准：
  - 作者书面确认保留策略后才执行；维护命令执行前先备份，并提供预览
  - B.7 的变更经作者确认后，recovery-d02 全部用例通过
  - 状态码映射与 DsH、前端联合验收

## 六、跨视角事项

- 【DsH】DB-01 需要确认 LlmUsage.inputTokens 是否已包含缓存命中，规范化放在 host/writing.ts 中完成
- 【DsH】DB-02/04 的定时修剪和自动热备要挂到 plugin.ts 的 ctx.effect 生命周期上；/diag 增加备份、PRAGMA、表体积和 FK 检查
- 【DsH】DB-13 的互斥下沉到数据库之后，proposalLocks 和 generations 只用来快速失败
- 【DsH/前端】DB-23 的状态码调整需与 api.ts 的错误解析同步修改
- 【前端】DB-15 的轻量快照需要前端轮询配合改造
- 【前端】DB-01 修正后，run-inspector.ts 的计费改为直接使用后端返回的 billing
- 【番茄】DB-06 依赖 author_chapter_entities 的维护质量，related-chapters 的语义维度改为走实体表
- 【番茄】DB-11 的 sort_key 会影响 tree/hierarchy/reorder/io，但两步重排语义不变
- 【番茄】DB-18 改用 synced_revision_id 后，需要同步修改 memory-sync.ts 的基线读取

## 七、待作者确认

1. DsH 的 inputTokens 是否包含缓存命中？B.4『对四类求和』是否按四类互斥的口径执行？
2. 修订保留策略：是否允许把旧的自动保存版本合并为每日快照？
3. 备份保留份数（7 份）和触发时机是否确认？
4. event_log 是否允许归档压缩（涉及 B.7）？
5. 非幂等命令是否还需要在 journal 中保留审计行？
6. 是否需要按项目或按月的累计预算？
7. Q-05：是否正式冻结使用 node:sqlite，以便使用 backup、createTagStore、isTransaction 等 API？

## 八、与既有计划的关系

V2.2 计划中的 tx/migrations/WAL/热备/request_hash 修剪、FTS External Content+RRF、keyset 分页、读模型分页回放都已落地（本次已确认实现存在）。本计划补充了以下内容：①已实现的维护能力（热备、修剪、FTS 校验）从未接入生产；②V2.2 加入计费透视时引入了 cache_read 重复计算（DB-01）；③journal 写放大、读模型冷启动的结构性问题、FTS 排序成本、2 字查询、JSON 存章序、schema 归属、约束与索引、Windows 路径，这些问题原计划都没有覆盖；④可以作为 framework/03 中 M0–M4 之后新增的『M5 数据层规模化』里程碑，沿用『每个阶段全绿、可独立验收』的门禁方式。

## 九、阅读范围

- README.md
- AGENTS.md
- docs/zhizhang_v2_2_optimization_plan.md
- docs/framework/03-migration-roadmap.md
- docs/04-data-and-workflow.md
- docs/02-domain-rules.md
- src/storage/{driver,errors,schema,stmt-pool,store,migrations,author-generation,author-schema,command,eventlog,projection,export,delivery,backup,fts,local-io,index,tx}.ts（全部 18 个文件）
- src/workflow/{author-reads,readserve,readmodels,budget,runstate,stages,index,writing-budget,writing-stages,context-slots}.ts（全部 10 个文件）
- src/application/{context,run-service,proposal-service,snapshot-service,product-line,author-workspace}.ts
- src/contracts/{errors,approval,commands,index}.ts
- src/contracts/workspace-dto.ts（只核对了被引用的类型，未逐行通读）
- support/a01.mjs
- support/v2-harness.mjs（第 1–200 行）
- test/：21 个存储、读模型、预算相关测试文件的全部用例标题，以及 workspace-v2、sprint1-v2、sprint2-v2 中与数据库相关的用例正文
- 交叉核对的片段：src/host/writing.ts（用量映射），src/application/products/fanqie/{context,lore,proposal-decide,tree}.ts、toutiao/index.ts 中的 SQL