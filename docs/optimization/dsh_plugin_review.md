# 织章 V2 · DsH 插件逻辑视角全量审阅与优化计划

> 审阅范围：`src/host/**`、`src/bundle/**`、`src/client/slot.ts`、`src/client/manifest.ts`、`package.json`、`tsconfig*.json`、`scripts/{preflight,deploy,model-check}.mjs`、宿主相关测试与 docs/03、05。只读分析，未运行 npm、未访问 DsH profile、未调用模型。外部事实均来自 DsH 上游公开文档（见各条引用）。

## 一、现状概述

织章的 DsH 宿主层（src/host 约 1.2k 行）结构清楚：plugin.ts 在单个 Cordis effect 里完成目录/SQLite 初始化、启动恢复、静态资产与 /state、/mutate、/diag 路由注册，并把 run.generate/proposal.generate 托管为 202 异步任务，卸载时 abort+5s 排空+recover+关库；writing.ts 是与领域无关的零工具单轮流式调用器，带输入预留、4 类用量回执、finish reason 与截断/思考耗尽恢复提示；delivery-io 用 wx+硬链接实现不覆盖的原子交稿；tools.ts 提供 7 只读+3 提案工具，settings.ts 提供脱敏诊断。测试对 HTTP 头、2 MiB 限制、状态映射、取消、导出冲突与重启恢复覆盖扎实。主要问题在于：宿主 API 全部为自拟接口并由自造 mock 验证，与上游 DsH 实际契约（tools.register 需 output、可选服务需 ctx.get、配置需导出 Config、路由携带 Peer）存在偏差，导致 Agent 工具在真实宿主上大概率无法注册甚至拖垮插件；其次是作者主权仅靠约定（actor 写死 author、只读工具未强制只读且泄露候选稿）、selection.rewrite 与卸载排空期的账本漏记、同步 SQLite 阻塞宿主事件循环，以及 mtime 刷新方案对 tgz 无效。

## 二、优点

- 宿主层严格无领域依赖：writing.ts 只依赖 workflow/contracts，产品管线通过 generationRunner 注入
- LLM 调用零工具、单轮、带输入预留与 4 元组用量校验；缺回执即 usage.uncertain 并阻断后续生成，绝不静默重发
- 启动失败时逆序注销已注册路由并关闭数据库（有用例覆盖），卸载时 abort+限时排空+recover
- /mutate 严格 Content-Type、流式读体 2 MiB 上限、结构化错误信封与 diagnosticId，不泄露堆栈与正文
- 交稿文件 wx+硬链接原子发布、同名不同内容拒绝覆盖并可在作者处理后重试，重启自动续导
- manifest.ts 单一资产清单被宿主、dev-server、browser-check 共用，并有清单↔TS 源一致性守卫
- /diag 明确脱敏并有“不含正文、不含绝对路径”的断言

## 三、发现总表（共 28 条：严重 1 / 高 8 / 中 14 / 低 5）

| ID | 严重度 | 类别 | 标题 | 工作量 |
|---|---|---|---|---|
| DSH-01 | 严重 | bug | Agent 7+3 工具定义与真实 DsH ToolRuntime 契约不兼容：缺 output{schema,render}，注册即抛错并会拖垮整个插件启动 | M |
| DSH-02 | 高 | architecture | 可选服务 tools/configForms 未声明 inject、也未用 ctx.get()，与 Cordis 依赖语义不符 | S |
| DSH-03 | 高 | correctness | 思考块（thinking）增量文本可能混入候选正文 | S |
| DSH-04 | 高 | security | 插件内无身份：忽略宿主 Peer，actor 写死 'author'，浏览器与 Agent 工具调用不可区分 | M |
| DSH-05 | 高 | security | “只读”工具未被机制保证只读，且 read_chapter 过度暴露（全部项目列表 + 未采纳候选稿） | M |
| DSH-07 | 高 | performance | 同步 node:sqlite 在 DsH 主事件循环执行重操作，/diag 每次全量 FTS integrity-check | L |
| DSH-08 | 高 | correctness | 卸载/重载时排空窗口内丢弃真实用量回执与已完成结果 | S |
| DSH-10 | 高 | correctness | selection.rewrite 绕过账本：用量不落库、无并发锁、不随卸载中止 | M |
| DSH-14 | 高 | architecture | 宿主 API 全靠自拟接口与自造 mock，违背 AGENTS.md“不得假设 DsH API” | L |
| DSH-06 | 中 | security | Agent 提案无来源标记、无数量上限，作者无法区分“我提的”与“AI 对话提的” | M |
| DSH-09 | 中 | architecture | 配置链路断裂：无 Cordis Config schema；defaultProvider/defaultModel 从未被使用；configForms 为自拟 API | M |
| DSH-11 | 中 | correctness | LLM 单次调用只有 180s 总超时，无空闲超时，超时不给恢复建议 | S |
| DSH-13 | 中 | maintainability | HTTP 状态码映射过粗，500 日志只记 error.name 无法排障 | S |
| DSH-15 | 中 | performance | 静态资源全部 no-store，每次打开 iframe 重拉 26 个模块 + 1541 行 CSS | S |
| DSH-16 | 中 | maintainability | deploy:touch 刷新 mtime 对 tgz 安装无效，且测试会改写源码树 mtime | S |
| DSH-17 | 中 | security | Slot iframe 地址依赖 document.baseURI，缺 sandbox，双实例各自轮询 | S |
| DSH-18 | 中 | bug | 交稿原子写依赖硬链接，exFAT/FAT/部分网络盘必失败；崩溃残留 .tmp 不清理 | S |
| DSH-19 | 中 | feature-gap | 插件未提供任何备份入口；备份清单不含 exports/ 工程包 | M |
| DSH-20 | 中 | maintainability | 工具参数 Schema 松散，错误未转为宿主可识别的带码异常 | S |
| DSH-21 | 中 | security | Agent 工具默认开启，正文会被送入对话所用的任意模型提供方 | S |
| DSH-22 | 中 | correctness | 并发控制：提案锁仅在内存且键基于未解析输入，无全局生成并发上限 | S |
| DSH-23 | 中 | correctness | 启动健壮性：createStore 竞态与启动恢复异常导致整插件不可用 | S |
| DSH-27 | 中 | testing | 宿主测试缺口 | M |
| DSH-12 | 低 | maintainability | 超长输出抛裸 Error 且按 UTF-16 计数，100 万字符上限与预算脱节 | S |
| DSH-24 | 低 | security | 请求处理细节：读体无超时、closing 检查滞后、CSP 未显式收紧 | S |
| DSH-25 | 低 | maintainability | 包元数据：未声明宿主兼容区间、未导出 name、files 打入全部 docs | S |
| DSH-26 | 低 | ux | 提案 JSON 解析过于宽松/脆弱，失败时作者看不到原始输出 | S |
| DSH-28 | 低 | docs | 文档与代码漂移 | S |

## 四、发现详情

### DSH-01 · Agent 7+3 工具定义与真实 DsH ToolRuntime 契约不兼容：缺 output{schema,render}，注册即抛错并会拖垮整个插件启动

- **严重度 / 类别 / 工作量**：严重 / bug / M
- **位置**：`src/host/tools.ts:3-10`；`src/host/tools.ts:230-241`；`src/host/plugin.ts:193-194`；`src/host/plugin.ts:404-408`；`support/v2-harness.mjs:276-313`
- **证据**：ZhizhangAgentToolDefinition 只有 name/description/readOnly/proposalOnly/parameters/execute(args)。DsH 上游 tools.register() 在入口处校验 definition.output 必须是含 schema 与 render 函数的对象，否则抛 TypeError `tool "x" must declare output {...}`；execute 合约为 execute(args, exec) 并须遵守 exec.signal。registerZhizhangTools 在 plugin.ts:194 的 effect try 块内调用，一旦抛错会走 404-408 的 catch：逆序注销所有已注册路由、关闭 SQLite 并重抛——即工作台整体不可用。测试用 createMockDsHHost 自造了 registrar，从不校验 output，因此 417 项全绿也掩盖了该问题。
- **影响**：在真实 DsH（若 ctx.tools 可用）中启用 enableAgentTools（默认 true）会让整个织章插件加载失败；7+3 工具这一 V2.2 交付物在真实宿主上不可用。
- **建议**：1) 新建 src/host/dsh-tools-adapter.ts，把每个工具映射为上游形状：{ name, description, parameters(JSON Schema, additionalProperties:false), output:{ schema, render:(args,value)=>[{type:'text',text:JSON.stringify(value)}] }, execute:async(args, exec)=>{ exec.signal.throwIfAborted(); ... } }；2) 把工具注册移出主 effect，放进独立的 ctx.inject(['tools'], sub => sub.effect(...)) 子作用域，注册失败只记录日志、不影响工作台路由；3) 在 support/ 下新增 createStrictToolRegistrar()，复刻上游 register 的 output 校验与 timeoutMs 校验，host-plugin 测试改用它；4) 在隔离 profile 中用真实 DsH 版本完成一次加载验收并记录到契约文档。
- **参考**：https://errors.standardbeagle.com/deepseek-ai/deepseek-harness/tool-name-must-declare-output-schema-rende/；https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-tool.md

### DSH-02 · 可选服务 tools/configForms 未声明 inject、也未用 ctx.get()，与 Cordis 依赖语义不符

- **严重度 / 类别 / 工作量**：高 / architecture / S
- **位置**：`src/host/plugin.ts:39-58`；`src/host/plugin.ts:193-195`；`src/host/settings.ts:20-22,80-90`
- **证据**：`export const inject = ["connection","llm"]`，但代码直接读 ctx.tools 与 ctx.configForms。DsH 文档：必需依赖写进 inject；可选依赖应省略 inject 并在使用处 ctx.get('name') 查询。并且必需服务消失时依赖插件会被自动 dispose、服务回来再加载。
- **影响**：真实宿主中 ctx.tools / ctx.configForms 很可能为 undefined（工具与设置表单静默不注册），或产生未声明访问告警；工具与配置不随服务热插拔正确装卸。
- **建议**：可选服务一律 `const tools = ctx.get('tools')` 判空，或用 `ctx.inject(['tools'], (sub)=>sub.effect(()=>registerTools(sub), 'zhizhang: agent tools'))` 嵌套作用域；同理 settings。为每个服务写一行“必需/可选/来源版本”的契约表（docs/03 宿主章节）。
- **参考**：https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/framework/service.md；https://github.com/anywhere-labs/dsh-desktop/blob/master/docs/plugin-development.en.md

### DSH-03 · 思考块（thinking）增量文本可能混入候选正文

- **严重度 / 类别 / 工作量**：高 / correctness / S
- **位置**：`src/host/writing.ts:189-206`；`src/host/writing.ts:231-234`；`test/generation-v2.test.mjs:38-67`
- **证据**：流循环对所有 text-delta 按 index 累加进 blocks，不区分块类型；block-end 为 thinking 时只设 sawThinkingBlock=true，不删除该 index 已累加的文本。测试第 38 行把 index 0 声明为 thinking 块，却断言输出为 "第一段落\n第二段落"——即 thinking 块的增量被保留进正文。
- **影响**：若宿主 LLM 传输以 text-delta 形式下发思考内容（DeepSeek 推理模型常见），模型的思维链会作为候选稿正文呈现给作者，并可能被“全部采纳”写入工作稿；同时撑大 MAX_CANDIDATE_LENGTH 计数。
- **建议**：维护 blockTypes: Map<number,string>；block-end.type==='thinking' 时 blocks.delete(index)；最终只拼接 blockTypes.get(i)==='text' 或未声明类型但从未被标记 thinking 的块。改正 generation-v2 第一个用例的期望（应为 "第二段落" 或拆两个用例），并新增“thinking delta 不入正文”回归用例。同时在契约文档记录宿主流块类型的真实取值（需在隔离 profile 抓一次真实流）。

### DSH-04 · 插件内无身份：忽略宿主 Peer，actor 写死 'author'，浏览器与 Agent 工具调用不可区分

- **严重度 / 类别 / 工作量**：高 / security / M
- **位置**：`src/host/plugin.ts:168-181`；`src/host/plugin.ts:226-403`；`src/application/context.ts:178-188`；`src/contracts/errors.ts:16-28`
- **证据**：路由处理器签名只有 (request)，不接收宿主 admission 后的 Peer；commandInput 固定 actor:'author'；工具 execute 直接调用 workspace.mutation()，与 /mutate 走同一路径；错误码表中 auth.denied 从未被使用。DsH webServer 文档说明路由默认 required、需要活跃 Peer，资源处理器会收到 peer。
- **影响**：command_journal.actor_id 失去审计意义；一旦工具门面或未来新动作有疏漏，Agent 就能以“作者”身份执行权威命令（定稿/批准/交稿/采纳）；‘作者主权’只靠约定而非机制保证。
- **建议**：1) 路由注册显式声明 auth:'required'，处理器签名改为 (request, peer)；2) 定义 Actor = {kind:'author', peerId} | {kind:'agent', toolCallId, agentId}；mutation(action, input, actor) 透传至 commandInput；3) 在 contracts/commands.ts 的 7 个权威命令及 approval.decide/article.deliver/candidate.adopt/reorder.commit/setting.decide 上加 actor.kind==='author' 断言，否则抛 auth.denied(403)；4) 测试：伪造 agent actor 调用权威命令必须 403。
- **参考**：https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/host/webserver/README.md

### DSH-05 · “只读”工具未被机制保证只读，且 read_chapter 过度暴露（全部项目列表 + 未采纳候选稿）

- **严重度 / 类别 / 工作量**：高 / security / M
- **位置**：`src/host/tools.ts:23-125`；`src/application/snapshot-service.ts:8-97`；`src/application/author-workspace.ts:44-127`
- **证据**：7 个 readOnly 工具全部经通用 workspace.mutation()/snapshot() 执行，没有动作白名单、没有包裹只读事务；zhizhang_read_chapter 返回完整 WorkspaceSnapshot：projects（含头条项目）、documents、runs[].candidateBody（awaiting-author 的模型候选全文）、planning 等。sprint4 测试只断言 active.body，未覆盖泄露面。
- **影响**：Agent 对话可读到未经作者采纳的模型候选稿并“洗”进对话或提案，破坏三态隔离；整份快照灌入对话上下文浪费 token；readOnly 标志只是元数据，未来误把写动作挂到只读工具不会被拦截。
- **建议**：新增 host/agent-facade.ts：①只读工具在 withReadTx 中执行（tx.ts 已拒绝读事务内写）；②固定动作白名单 READ_TOOL_ACTIONS = ['tree.get','settings.read','workspace.search','lore.conflicts','chapter.diagnose','controls.get','chapter.read']；③新增精简 DTO chapter.read：{documentId,title,state,revisionId,body(分页 offset/limit≤8000 字),planning,activeContext}，不含 runs/候选/其它项目；④search limit 夹紧 1..20。

### DSH-07 · 同步 node:sqlite 在 DsH 主事件循环执行重操作，/diag 每次全量 FTS integrity-check

- **严重度 / 类别 / 工作量**：高 / performance / L
- **位置**：`src/host/settings.ts:104-116`；`src/host/plugin.ts:197-224`；`src/application/products/fanqie/io.ts`；`src/storage/fts.ts`
- **证据**：插件与 DsH 同进程，所有 SQLite 调用同步阻塞事件循环；/diag 对 fts_chapters/fts_lore/fts_library 三表执行 integrity-check（O(索引大小)），每次 GET 都跑；工程包导入导出、FTS 重建、备份同样在请求线程同步完成；前端 2 秒轮询每次重建快照。
- **影响**：5000 章、trigram 索引数百 MB 时，一次 /diag 或导入即可让整个 DsH（含其它会话的流式输出、WebSocket 心跳）卡顿数秒。
- **建议**：①/diag 默认只返回计数与迁移，`?deep=1` 才做 integrity-check，并缓存结果 10 分钟；②为 /state、/mutate 加耗时埋点，>50ms 记 warn（含 action 名，不含正文）；③导入/导出/FTS 重建/热备迁入 worker_threads（独立 DatabaseSync 连接，WAL 下可并发读），对外返回 202 + jobId；④在 workspace-bench 增加“事件循环阻塞 p95 < 20ms”门禁。

### DSH-08 · 卸载/重载时排空窗口内丢弃真实用量回执与已完成结果

- **严重度 / 类别 / 工作量**：高 / correctness / S
- **位置**：`src/host/plugin.ts:254-262`；`src/host/plugin.ts:307-333`；`src/host/plugin.ts:410-436`
- **证据**：dispose 先置 closing=true 并 abort，随后最多等待 5s；但 receive() 与 .then() 都以 `if (!closing)` 守卫，排空期间到达的 usage 回执与成功结果被丢弃；随后 workspaceOnClose 把仍 open 的尝试按 interrupted 收尾→inflight 变 uncertain。DsH 文档指出必需服务（llm/connection）重载时依赖插件会被自动 dispose；配置变更同样触发重载。
- **影响**：每次插件重载/配置切换/LLM 服务热更新，正在生成的任务即使模型已计费返回，也会进入 uncertain 并阻塞该文档后续生成，要求作者手工对账；账本失真。
- **建议**：把 closing 拆成 accepting=false（拒绝新请求，返回 503）与 dbOpen=true（排空期间继续写回执/收尾）；仅在 Promise.allSettled 结束或超时后 dbOpen=false 再 recover+close；selection.rewrite 也纳入 inFlight 集合。新增测试：dispose 期间 gate 放行、usage 到达 → 重开后 attempt 为 completed/failed 而非 uncertain。
- **参考**：https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/framework/service.md

### DSH-10 · selection.rewrite 绕过账本：用量不落库、无并发锁、不随卸载中止

- **严重度 / 类别 / 工作量**：高 / correctness / M
- **位置**：`src/host/plugin.ts:363-390`
- **证据**：createSingleShotCaller 传入的 receipts 为 { begin: () => 'selection', receive: () => {} }；tokens 仅返回给前端，不写 author_generation_calls 或任何表；只绑定 request.signal，不在 generations/proposalJobs 中登记。
- **影响**：违背 README“4 类令牌账本完整记账”的承诺：微改写的真实花费在运行检查器与对账中不可见；高频选段操作会造成成本盲区；卸载时请求仍在跑。
- **建议**：复用提案账本：beginSelectionRewrite() 在 author_ai_proposals 插入 kind='selection_rewrite', status='inflight' 行（或新建 author_micro_calls 表），receive 写入 4 元组用量，完成/失败收尾；按 documentId 加锁；登记到 inFlight 以便 dispose abort+drain；前端运行检查器展示累计微改写用量。

### DSH-14 · 宿主 API 全靠自拟接口与自造 mock，违背 AGENTS.md“不得假设 DsH API”

- **严重度 / 类别 / 工作量**：高 / architecture / L
- **位置**：`src/host/plugin.ts:32-52`；`src/host/writing.ts:18-41`；`support/v2-harness.mjs:276-313`；`docs/03-architecture.md（宿主章节）`
- **证据**：DsHPluginContext.connection.fetch.register({path,methods,requestBody,fetch})、logger.error(object)、configForms、tools、llm.prepareCall().stream() 的 chunk 联合类型全部为手写接口；mock host 照此实现，测试无法发现与真实宿主的偏差（DSH-01/02/09 均由此产生）。AGENTS.md 明确要求仅在隔离 profile 验证目标版本并记录契约后再添加平台适配。
- **影响**：“全绿测试”与“真实可装”之间无任何保障；DsH 版本升级时没有可执行的兼容检测。
- **建议**：①集中到 src/host/dsh-adapter.ts：唯一处引用宿主 API，其余 host 代码只依赖本地窄接口；②以 devDependency 方式固定上游类型（或 vendor 对应版本 .d.ts 至 src/host/vendor/dsh-0.2.x.d.ts），tsc 校验适配层；③在隔离 profile 录制一次真实 route/llm/tools 交互样本，存为 support/fixtures/dsh-contract-0.2.x.json，契约测试回放；④package.json 增加 peerDependencies 声明支持区间。
- **参考**：https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-tool.md；https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/host/webserver/README.md；https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/framework/service.md

### DSH-06 · Agent 提案无来源标记、无数量上限，作者无法区分“我提的”与“AI 对话提的”

- **严重度 / 类别 / 工作量**：中 / security / M
- **位置**：`src/host/tools.ts:126-226`；`src/application/products/fanqie/proposal-decide.ts:61-97`
- **证据**：propose_foreshadow/technique 走 proposal.create → createManualProposal，写入 provider=null, model=null，source_ref=标题；propose_setting 的 source 是模型自填自由文本。无 origin 字段，无每项目 pending 上限。
- **影响**：作者收件箱中 AI 对话产物伪装成手工提案；对话循环可能刷爆收件箱；违背“AI 写意图一律可追溯”的作者主权审计要求。
- **建议**：author_ai_proposals 与 author_settings(pending) 增加 origin TEXT CHECK(origin IN ('author-ui','ai-generate','agent-tool')) 与 origin_ref（toolCallId）；agent-tool 来源每项目 pending ≤ 20，超出返回 gate.denied/proposal-quota；前端收件箱显示“对话提议”徽标。需与数据库视角协同迁移。

### DSH-09 · 配置链路断裂：无 Cordis Config schema；defaultProvider/defaultModel 从未被使用；configForms 为自拟 API

- **严重度 / 类别 / 工作量**：中 / architecture / M
- **位置**：`src/host/plugin.ts:25-30`；`src/host/settings.ts:36-90`；`src/client/workbench.html:353-354`；`src/client/workbench/plugins/fanqie.ts:59-60`；`src/client/workbench/views/outline-board.ts:427`；`src/bundle/cordis.patch.yml:1-5`
- **证据**：插件未导出 Config（Cordis 用导出的 Standard Schema 校验并填默认值）；全仓 grep 显示 defaultProvider/defaultModel 只出现在 settings.ts 与 plugin.ts 类型里，前端三处硬编码 'deepseek-account'/'deepseek-flash'；设置表单 tab 'settings.plugins.tab' + register(schema) 并非上游 settings 服务（register(ns, schema) 返回 get/watch/update scope）。
- **影响**：作者在设置里改默认模型无效；配置错误不会在加载期被校验；切换 enableAgentTools 依赖整插件重载（触发 DSH-08）。
- **建议**：①导出 `Config`（Schema 对象：dataDirectory 必填、defaultProvider/defaultModel/enableAgentTools 可选带默认）；②新增 GET /api/zhizhang/bootstrap 返回 {defaults:{provider,model}, agentToolsEnabled, version}，前端三处改读它；③用 ctx.get('settings')?.register('zhizhang', schema) 并 watch(enableAgentTools) 只重装工具子作用域，无需重载整个工作台。
- **参考**：https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/config.md；https://github.com/Stelquis/DeepSeek-Harness/blob/master/packages/settings/settings/README.md

### DSH-11 · LLM 单次调用只有 180s 总超时，无空闲超时，超时不给恢复建议

- **严重度 / 类别 / 工作量**：中 / correctness / S
- **位置**：`src/host/writing.ts:164`；`src/host/plugin.ts:263-275`；`src/host/writing.ts:83-121`
- **证据**：AbortSignal.timeout(180_000) 为整次调用总时长；6000 字章节 + 深度思考在慢速提供方下可超 3 分钟；超时抛 TimeoutError，plugin 映射为 generation.failed，buildRecoveryHints 无对应分支。
- **影响**：长章生成被误杀且已产生的输出费用作废；作者只看到笼统失败。
- **建议**：改为“空闲超时 60s（每收到 chunk 重置）+ 总上限按阶段可配（write 600s / qa 180s / proposal 120s）”；TimeoutError 附加 recoveryKind='timeout'，提示“可关闭深度思考或分段生成后原地重试”。在 Config 暴露 timeouts。

### DSH-13 · HTTP 状态码映射过粗，500 日志只记 error.name 无法排障

- **严重度 / 类别 / 工作量**：中 / maintainability / S
- **位置**：`src/host/plugin.ts:94-103`；`src/contracts/errors.ts:16-28`
- **证据**：除 input.not_found→404、input.invalid→400 外，所有 ContractError（含 auth.denied、dependency.unavailable、storage.format_unsupported、budget.exhausted、usage.uncertain、stage.output_invalid）一律 409；非契约异常只记录 {diagnosticId, name}。
- **影响**：前端与宿主无法依据状态码做重试/降级；诊断号对应的日志没有 message/stack，作者报障后开发者也查不出原因。
- **建议**：映射表：auth.denied→403，dependency.unavailable→503(+Retry-After)，storage.format_unsupported→503，budget.exhausted/usage.uncertain/stage.output_invalid→422，gate.denied/version.conflict/idempotency.mismatch→409；500 日志记录 name+message(截断 500 字)+stack 首 10 行（宿主本地日志，不回传客户端）。补表驱动测试。

### DSH-15 · 静态资源全部 no-store，每次打开 iframe 重拉 26 个模块 + 1541 行 CSS

- **严重度 / 类别 / 工作量**：中 / performance / S
- **位置**：`src/host/plugin.ts:83-92`；`src/host/plugin.ts:183-191`；`src/client/manifest.ts:7-34`
- **证据**：staticResponse 统一 Cache-Control: no-store；slot.ts 在 main 与 conversation.view 两个槽位各挂一个 iframe。
- **影响**：冷/热打开都要 28 个请求；远程访问 DsH 时首屏明显变慢；也是“mtime 缓存僵死”问题的反向过度修复。
- **建议**：启动时对每个资产计算 sha256 前 16 位作为强 ETag；响应 `Cache-Control: no-cache` + ETag，处理 If-None-Match→304；workbench.html 中模块 URL 附 `?v=<buildHash>`，或在 manifest 生成 import map。JSON API 维持 no-store。

### DSH-16 · deploy:touch 刷新 mtime 对 tgz 安装无效，且测试会改写源码树 mtime

- **严重度 / 类别 / 工作量**：中 / maintainability / S
- **位置**：`scripts/deploy.mjs:14-62`；`test/sprint4-v2.test.mjs:206-222`；`docs/05-development-and-ops.md（打包章节）`
- **证据**：npm pack 会把 tarball 内所有文件 mtime 统一为 1985-10-26，本地 touch 只影响目录/link 安装；touchBuildArtifacts 还 utimes 了 src/client/workbench.html/css；sprint4 #3 在 dist 存在时于 npm test 内调用它并 import dist/server（结果依赖本地是否 build 过）。
- **影响**：文档宣称“彻底规避 npm pack 1985 时间戳缓存僵死”并不成立；测试非密闭、结果不确定，并违背“检查/测试只读”的工作区约定精神。
- **建议**：以内容哈希替代 mtime（见 DSH-15）；若 DsH artifactRevision 确为 mtime 驱动，向上游提 issue 并在文档写明 tgz 安装后的处理步骤；把 touch 从测试中移除，改为纯函数 planTouch() 单测；dist 加载测试改为显式 `npm run test:dist` 专项。
- **参考**：https://github.com/pillarjs/send/issues/176；https://github.com/yarnpkg/yarn/pull/6010

### DSH-17 · Slot iframe 地址依赖 document.baseURI，缺 sandbox，双实例各自轮询

- **严重度 / 类别 / 工作量**：中 / security / S
- **位置**：`src/client/slot.ts:29-36`；`src/client/slot.ts:48-63`
- **证据**：`new URL("api/zhizhang/workbench", document.baseURI)` 为相对路径；DsH 若在嵌套路由下且无 <base>，会解析成 /chat/xxx/api/...；iframe 无 sandbox/referrerpolicy；main 与 conversation.view 同时渲染时两个工作台实例并行轮询并各自持有 DraftVault。
- **影响**：特定路由下工作台 404；iframe 权限面过宽；同页双实例增加负载并制造自我冲突横幅。
- **建议**：以宿主提供的 API base（client metadata）或 `new URL('/api/zhizhang/workbench', location.origin)` 拼接；iframe 增加 sandbox='allow-scripts allow-same-origin allow-forms allow-modals allow-downloads' 与 referrerpolicy='same-origin'；工作台内用 BroadcastChannel('zhizhang') 选主轮询、其余实例订阅。

### DSH-18 · 交稿原子写依赖硬链接，exFAT/FAT/部分网络盘必失败；崩溃残留 .tmp 不清理

- **严重度 / 类别 / 工作量**：中 / bug / S
- **位置**：`src/host/delivery-io.ts:9-28`
- **证据**：writeFileSync(wx)+linkSync+unlinkSync；linkSync 在不支持硬链接的卷上抛 EPERM/ENOTSUP/EXDEV，被当作普通错误重抛→交付 failed；进程在 link 前崩溃会留下 `.id.uuid.tmp`，启动不清理。
- **影响**：作者把 DSH_HOME 放在 U 盘/网盘时头条交稿永久失败；deliveries 目录逐渐堆积隐藏临时文件（backup 只收 UUID.md 不受影响但磁盘泄漏）。
- **建议**：linkSync 失败且 code∈{EPERM,ENOTSUP,EXDEV,EINVAL} 时回退 copyFileSync(pending, path, COPYFILE_EXCL)+fsync；EEXIST 语义保持。启动 resumeExports 前清理 mtime 超过 10 分钟的 `.*.tmp`。新增用例：模拟 linkSync 抛 ENOTSUP。

### DSH-19 · 插件未提供任何备份入口；备份清单不含 exports/ 工程包

- **严重度 / 类别 / 工作量**：中 / feature-gap / M
- **位置**：`src/host/plugin.ts（无 backup 引用）`；`src/storage/backup.ts`；`test/backup-v2.test.mjs:72-111`；`docs/05-development-and-ops.md（灾备章节）`
- **证据**：backupWorkspace/createHotBackup 只能通过 scripts/workspace-data.mjs 离线调用，且文档要求先停止 DsH profile；manifest 只收 work.db 与 deliveries/<uuid>.md；plugin 写入的 exports/<projectId>/ 未纳入；迁移执行前无自动备份。
- **影响**：普通作者几乎不会手动停 profile 去跑脚本；一旦迁移或损坏只能求助开发者。
- **建议**：新增 action backup.create（VACUUM INTO 热备，写入 dataDirectory/backups/<ISO>/，保留 7 份，复用 pruneBackups）与 backup.list；启动发现待执行迁移时先自动热备；manifest 可选纳入 exports/；前端设置页加“立即备份/打开备份目录”。热备放 worker（见 DSH-07）。

### DSH-20 · 工具参数 Schema 松散，错误未转为宿主可识别的带码异常

- **严重度 / 类别 / 工作量**：中 / maintainability / S
- **位置**：`src/host/tools.ts:27-30,57-64,79-84,132-142,162-171,199-209`
- **证据**：people:{type:'array'} 无 items；limit/point 无 minimum/maximum/integer；无 additionalProperties:false；字符串无 minLength/maxLength；execute 直接抛 ContractError，而上游只有 HarnessError 子类才会在结果中保留 code。
- **影响**：模型生成畸形参数时错误信息含糊，Agent 难以自我纠正；超长 note/executionSteps 可写入数据库。
- **建议**：为每个工具写完整 JSON Schema（additionalProperties:false、字符串 1..4000、limit 1..20、point 整数 ≥1、people items:{type:'object',required:['character'],properties:{character:{type:'string'},point:{type:'integer',minimum:1}}}）；适配层把 ContractError 转为上游 HarnessError 子类并保留 code 与 details。
- **参考**：https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-tool.md

### DSH-21 · Agent 工具默认开启，正文会被送入对话所用的任意模型提供方

- **严重度 / 类别 / 工作量**：中 / security / S
- **位置**：`src/host/plugin.ts:193`；`src/host/settings.ts:43`
- **证据**：enableAgentTools 默认 true；对话 Agent 的提供方可与作者在工作台选定的不同；read_chapter 返回整章正文。
- **影响**：作者未知情时手稿被外发；与“作者主权、全离线持久化”的定位不一致。
- **建议**：默认 false；首次开启在工作台弹出说明（会把章节内容发送给对话模型）；按项目粒度开关（author_project_controls.agent_tools_enabled）；已定稿/锁定章节可配置为不对 Agent 可见。

### DSH-22 · 并发控制：提案锁仅在内存且键基于未解析输入，无全局生成并发上限

- **严重度 / 类别 / 工作量**：中 / correctness / S
- **位置**：`src/host/plugin.ts:147-149`；`src/host/plugin.ts:284-297`；`src/application/proposal-service.ts:50-123`
- **证据**：lockKey=`${kind}:${documentId ?? projectId ?? 'global'}` 在 beginProposalGeneration 解析之前计算，同一文档用 projectId 或 documentId 调用得到不同键；DB 侧 author_ai_proposals 无 inflight 唯一约束。正文生成有 DB 守卫（generation.pending / assertRunAvailable），但跨文档无总并发上限。
- **影响**：可绕过“同类提案进行中”互斥造成重复计费；多文档同时生成会压垮单进程宿主与提供方限流。
- **建议**：DB 增加部分唯一索引 `CREATE UNIQUE INDEX ux_proposal_inflight ON author_ai_proposals(kind, COALESCE(document_id, project_id, 'global')) WHERE status='inflight'`，锁以 DB 为准、内存 Set 仅做快速拒绝；锁键在解析后计算；引入全局信号量 MAX_CONCURRENT_LLM=3（Config 可调），超出返回 gate.denied/llm-busy。

### DSH-23 · 启动健壮性：createStore 竞态与启动恢复异常导致整插件不可用

- **严重度 / 类别 / 工作量**：中 / correctness / S
- **位置**：`src/host/plugin.ts:140-166`；`src/storage/store.ts:createStore`
- **证据**：existsSync→createStore→openStore：createStore 在 CREATE TABLE 与 INSERT 之间崩溃会留下无 schema 行的文件，之后永远被 openStore 拒绝（schema-missing）；recoverStartup（含 resumeExports 写文件）任一异常都会让 effect 抛错，宿主侧没有任何降级页面。
- **影响**：一次异常断电即可让作者打开 DsH 后看不到织章入口，也没有错误提示。
- **建议**：createStore 写入 `workspace.sqlite.tmp-<uuid>` 后 renameSync；recoverStartup 分项 try/catch，失败记日志并在 /diag 与工作台横幅提示，不阻断路由注册；数据库无法打开时仍注册 /workbench 降级页 + /diag 显示 storage.format_unsupported 与恢复指引。

### DSH-27 · 宿主测试缺口

- **严重度 / 类别 / 工作量**：中 / testing / M
- **位置**：`test/host-plugin-v2.test.mjs`；`test/generation-v2.test.mjs`；`test/sprint4-v2.test.mjs:206-222`；`support/v2-harness.mjs`
- **证据**：全仓无用例覆盖：selection.rewrite 用量入账、调用超时、thinking 增量泄露、上游 tools.register 形状校验、Peer/actor 授权、dispose 排空期回执、linkSync 不可用回退、registerZhizhangSettings 行为；sprint4 #3 依赖本地 dist 是否存在。
- **影响**：上述 P0/P1 缺陷均无法被回归测试捕获。
- **建议**：新增 test/host-contract-v2.test.mjs（严格 registrar、Peer 注入、状态码表）、test/host-lifecycle-v2.test.mjs（排空、重载、启动降级）、test/transport-v2.test.mjs（thinking、超时、长度上限）；sprint4 #3 拆出到 test:dist；保持 AGENTS.md 的计数规则同步更新 README/05 文档中的用例数。

### DSH-12 · 超长输出抛裸 Error 且按 UTF-16 计数，100 万字符上限与预算脱节

- **严重度 / 类别 / 工作量**：低 / maintainability / S
- **位置**：`src/host/writing.ts:190-192`；`src/workflow/writing-stages.ts:49`
- **证据**：`throw new Error("Candidate too long")`：非 ContractError，宿主映射为 generation.failed，无 details/recoveryHint；MAX_CANDIDATE_LENGTH=1_000_000 远大于任何 maxTokens 可能产生的长度。
- **影响**：异常路径不可诊断；上限形同虚设。
- **建议**：改为 ContractError('stage.output_invalid',{stage, missing:'length-cap'}) 并 attachRecoveryKind('output_truncated')；上限取 min(MAX_CANDIDATE_LENGTH, maxTokens*4) 字符；用 [...text].length 或累计 code point。

### DSH-24 · 请求处理细节：读体无超时、closing 检查滞后、CSP 未显式收紧

- **严重度 / 类别 / 工作量**：低 / security / S
- **位置**：`src/host/plugin.ts:63`；`src/host/plugin.ts:105-128`；`src/host/plugin.ts:226-233`；`src/host/plugin.ts:79-81`
- **证据**：requestObject 在 closing 检查前读完最多 2 MiB 请求体且无读超时；JSON 响应无 X-Content-Type-Options；CSP 仅 default-src 'self'，无 form-action/connect-src/script-src 显式声明。
- **影响**：慢速请求可占用卸载窗口；防御纵深不足（低风险，宿主已做 owner 校验）。
- **建议**：先判 closing 再读体；读体加 AbortSignal.timeout(10_000)；json() 统一加 nosniff；CSP 改为 "default-src 'self'; script-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self' data: blob:; form-action 'none'; frame-ancestors 'self'; base-uri 'none'; object-src 'none'"（先在浏览器 E2E 验证 Blob 下载与 dialog 正常）。

### DSH-25 · 包元数据：未声明宿主兼容区间、未导出 name、files 打入全部 docs

- **严重度 / 类别 / 工作量**：低 / maintainability / S
- **位置**：`package.json:1-59`；`src/host/plugin.ts:58`；`src/bundle/cordis.patch.yml:1-5`
- **证据**：无 peerDependencies/engines 约束 DsH 版本；插件模块未导出 name；files 含整个 docs/（含优化计划等内部文档）；diag version 硬编码 '2.2.0'（settings.ts:128）。
- **影响**：版本不兼容时只能在运行期出错；发布包体积与内部信息外泄（低）。
- **建议**：peerDependencies 声明 DsH/cordis 支持区间；`export const name = 'zhizhang-workbench'`；files 仅保留 docs/01-overview.md 与 README；构建时由 package.json 生成 src/host/version.ts，diag 读取之。

### DSH-26 · 提案 JSON 解析过于宽松/脆弱，失败时作者看不到原始输出

- **严重度 / 类别 / 工作量**：低 / ux / S
- **位置**：`src/host/plugin.ts:320-334`
- **证据**：仅用正则剥离首尾 ``` 围栏；模型若在 JSON 前后加说明文字即 stage.output_invalid，且 raw 未保存。
- **影响**：已计费的提案因格式小瑕疵整体作废，作者无法手工挽救。
- **建议**：提取首个平衡的 {...} 片段再 JSON.parse；失败时把 raw 前 2000 字存入 proposal.error_detail，收件箱提供“查看原始输出/手动修正后入队”。

### DSH-28 · 文档与代码漂移

- **严重度 / 类别 / 工作量**：低 / docs / S
- **位置**：`docs/03-architecture.md（宿主章节）`；`docs/05-development-and-ops.md（安装章节）`
- **证据**：03 文档称启动执行 recoverGenerations()+resumeExports()（现为 recoverStartup()）、测试表提到“宿主插件 HTTP/SSE”（无 SSE）、owner-only 依赖“DsH Web 0.2.2-rc.4”未见验证记录；05 安装步骤写 2.1.0.tgz 而构建产物为 2.2.0；“mtime 刷新彻底规避缓存”表述不成立（DSH-16）。
- **影响**：新成员与作者按文档操作会踩坑；验收结论缺乏可追溯证据。
- **建议**：修正上述条目；在 docs/03 增加“宿主契约表”（服务名/必需性/验证版本/验证日期/证据位置）；文档守卫测试增加版本号一致性断言。

## 五、分阶段路线图

### P0 · 宿主契约止血（1 周内）

**目标**：让插件在真实 DsH 上可加载、可卸载、不错账：修正工具/服务契约，堵住思考链泄露与账本漏洞。

**包含**：DSH-01、DSH-02、DSH-03、DSH-08、DSH-10、DSH-14

**退出标准**：
- support 中严格 registrar 复刻上游 output/timeoutMs 校验，10 个工具全部注册成功；工具注册失败不影响 /workbench 路由（用例覆盖）
- tools/settings 通过 ctx.get 或嵌套 ctx.inject 获取，mock host 移除对 ctx.tools 的隐式提供后工作台仍正常
- 新增 thinking-delta 用例：候选正文不含任何 thinking 块文本；generation-v2 首个用例期望已更正
- dispose 排空用例：gate 在 closing 后放行，重开后 attempt 状态为 completed 而非 uncertain
- selection.rewrite 后数据库可查到 4 元组用量记录，运行检查器显示累计
- 在授权的隔离 DsH profile 完成一次安装→打开工作台→生成→卸载，契约样本存入 support/fixtures（需作者授权执行）

### P1 · 身份与 Agent 边界（第 2 周）

**目标**：把“作者主权”从约定变为机制：Peer→Actor 贯穿命令、只读工具真只读、提案可溯源有上限。

**包含**：DSH-04、DSH-05、DSH-06、DSH-20、DSH-21、DSH-22、DSH-13

**退出标准**：
- agent actor 调用 7 个权威命令及 approval/deliver/adopt/reorder.commit 全部返回 403 auth.denied（表驱动用例）
- 只读工具在 withReadTx 内执行；人为把写动作挂到只读工具时用例报 gate.denied/write-inside-read-tx
- zhizhang_read_chapter 返回体不含 runs/candidateBody/其它项目，单次正文 ≤ 8000 字且支持分页
- author_ai_proposals.origin 落库，agent 来源 pending 超 20 条返回 proposal-quota
- enableAgentTools 默认 false，开启需前端确认
- 状态码映射表用例全覆盖 11 个错误码；500 日志含 message 与 stack 摘要

### P2 · 性能、运维与交付体验（第 3–4 周）

**目标**：不让插件拖慢 DsH 主进程，资产缓存正确，备份与启动降级对作者友好。

**包含**：DSH-07、DSH-11、DSH-15、DSH-16、DSH-17、DSH-18、DSH-19、DSH-23、DSH-09

**退出标准**：
- workspace-bench 新增事件循环阻塞指标：5000 章工程 /state p95 < 20ms，/diag（非 deep）< 5ms
- 导入/导出/FTS 重建/热备在 worker 中执行，期间并发 /state 不被阻塞（用例测量 < 50ms）
- 静态资产二次加载全部 304；tgz 安装后更新版本前端即生效（隔离 profile 验收）
- linkSync 抛 ENOTSUP 时交稿成功且内容一致；启动清理过期 .tmp
- backup.create 生成可被 verifyBackup 通过的热备，保留 7 份；有待执行迁移时自动先备份
- 人为截断 meta 行的数据库：工作台显示降级页与恢复指引而非入口消失
- 前端默认模型来自 /bootstrap，修改设置后无需重载插件即生效

### P3 · 契约固化与文档（持续）

**目标**：把宿主适配层固化成可随 DsH 版本演进的契约资产，文档与代码同源。

**包含**：DSH-12、DSH-24、DSH-25、DSH-26、DSH-27、DSH-28

**退出标准**：
- 新增 host-contract/host-lifecycle/transport 三个测试文件并纳入 test:host，README 与 05 文档用例数同步
- package.json 声明 peerDependencies，diag.version 与 package.json 一致（守卫测试）
- CSP 收紧后浏览器 E2E 三旅程 pageerror 为空
- docs/03 增加宿主契约表（服务/必需性/验证版本/日期/证据）

## 六、需要其他视角配合的事项

- 【数据库】DSH-06 需新增 author_ai_proposals.origin/origin_ref 与 pending 配额；DSH-22 需部分唯一索引；DSH-10 需微改写用量表或复用提案账本；DSH-19 热备需 worker 连接与 WAL 下 VACUUM INTO 验证。
- 【数据库/应用层】DSH-04 需把 Actor 透传进 context.commandInput 与 command_journal.actor_id，并在 contracts/commands.ts 声明“仅作者”命令集合。
- 【前端】DSH-09 前端三处硬编码 provider/model 改读 /bootstrap；DSH-17 iframe 地址/sandbox 与 BroadcastChannel 选主轮询；DSH-06 收件箱“对话提议”徽标；DSH-10 运行检查器展示微改写用量；DSH-21 首次开启工具的确认弹窗。
- 【前端】DSH-15 资产 ETag/版本化 URL 需 workbench.html 模块引用方式配合（import map 或 ?v=hash）。
- 【番茄】DSH-05 新的 chapter.read 精简 DTO 字段（planning/activeContext/伏笔提醒）需番茄线确认；DSH-21 定稿/锁定章节对 Agent 的可见性策略需番茄线定义。
- 【番茄/提示词】DSH-11 按阶段超时（write 600s 等）需结合番茄章节字数带与思考开关的实测数据定值。

## 七、待作者确认的问题

1. 目标 DsH 版本具体是哪一个（0.2.2 正式版还是 rc.4）？是否授权在隔离 profile 安装并录制一次真实 route/llm/tools 交互样本作为契约基线？
2. DsH 的插件 HTTP 注册服务名到底是 connection 还是 webServer？当前代码依赖的 ctx.connection.fetch.register 是否来自已验证的宿主版本？
3. Agent 对话工具是否应默认关闭、并按项目开关？已定稿/锁定章节是否允许对话 Agent 读取？
4. selection.rewrite 的用量是否计入所在章节的写作任务预算，还是单独的“微改写”账户？
5. 是否接受为同步 SQLite 重操作引入 worker_threads（仍零第三方依赖）？
6. 插件卸载排空上限 5s 是否可放宽到 15–30s，以便长章生成在配置切换时尽量完成并入账？
7. 备份目录默认放在 dataDirectory/backups 是否可接受？保留份数默认 7 份是否合适？

## 八、与既有计划的重叠与差异

与 docs/zhizhang_v2_2_optimization_plan.md 第六节“DsH 宿主双入口协同与交付防坑”重叠部分：卸载 abort+排空、proposal.generate 互斥与取消、7+3 工具、settings.plugins.tab、/diag、deploy.mjs mtime、dist/server 与 dist/client 分离——这些已实现，但本审阅指出其中三项在真实宿主语义下不成立或不完整：(1) 7+3 工具与 configForms 基于自拟 API，未按上游 tools.register 契约（output 必填）与可选服务 ctx.get 语义实现（DSH-01/02/09）；(2) 排空期回执被 closing 守卫丢弃（DSH-08）；(3) mtime 刷新无法解决 npm pack tarball 的 1985 时间戳（DSH-16）。计划第二节第 4 条“host/writing.ts 计算剩余额度扣除 inflightTokens”已落地（writing.ts:145）。与 docs/framework/03-migration-roadmap.md 的关系：M3 已完成“宿主去领域化”，本审阅确认 writing.ts 无 domain 导入；但 M4 验收中“DsH Web 0.2.2-rc.4 隔离 profile 安装/卸载验证”在仓库内没有可追溯证据（无契约样本、无记录），本计划 P0 最后一项与 DSH-14 补齐。新增、两份文档均未涉及的内容：Peer→Actor 身份贯穿（DSH-04）、只读工具强制只读与候选稿泄露（DSH-05）、Agent 提案溯源与配额（DSH-06）、thinking 增量泄露（DSH-03）、selection.rewrite 账本（DSH-10）、事件循环阻塞（DSH-07）、静态资产 ETag（DSH-15）、硬链接回退（DSH-18）、插件内备份入口（DSH-19）、启动降级（DSH-23）。

## 九、已阅读文件

- README.md
- AGENTS.md
- docs/zhizhang_v2_2_optimization_plan.md
- docs/framework/03-migration-roadmap.md
- src/host/plugin.ts
- src/host/writing.ts
- src/host/tools.ts
- src/host/settings.ts
- src/host/delivery-io.ts
- src/host/workspace.ts
- src/host/index.ts
- src/bundle/cordis.patch.yml
- src/bundle/index.ts
- src/bundle/locale/en.json
- src/bundle/locale/zh.json
- src/client/slot.ts
- src/client/manifest.ts
- package.json
- tsconfig.json
- tsconfig.build.json
- tsconfig.client.json
- scripts/preflight.mjs
- scripts/deploy.mjs
- scripts/model-check.mjs
- test/host-plugin-v2.test.mjs
- test/generation-v2.test.mjs
- test/backup-v2.test.mjs
- docs/03-architecture.md
- docs/05-development-and-ops.md
- src/application/snapshot-service.ts
- （部分，用于核实调用链）src/workflow/budget.ts:96-191
- src/application/proposal-service.ts:46-130（部分）
- src/application/run-service.ts:118-208,338-433（部分）
- src/application/context.ts:146-237（部分）
- src/application/products/fanqie/diagnostics.ts:79-120（部分）
- src/application/products/fanqie/proposal-decide.ts:55-110（部分）
- src/storage/stmt-pool.ts
- src/storage/store.ts（前 2500 字符）
- src/contracts/errors.ts:14-40（部分）
- support/v2-harness.mjs:276-370（createMockDsHHost，部分）
- test/sprint4-v2.test.mjs:1-222（部分）
- test/sprint3-v2.test.mjs:645-690（部分）
- test/refactor-v2.test.mjs:350-368（部分）
- scripts/dev-server.mjs（grep 定位）
