# 织章 V2 · 前端 UI 工作台全量审阅与优化计划

> 审阅范围：`src/client/**`（32 个文件，8,450 行，含 CSS/HTML）、`src/contracts/workspace-dto.ts`、前端相关测试与脚本、相关文档，合计约 11,150 行。全程只读：没有修改项目文件，没有运行 npm，也没有调用模型。

## 一、现状概览

织章前端是零依赖的原生 TypeScript ES Module 工作台：由 slot.ts 以 iframe 注入 DsH 的 main / sidebar / conversation 三个槽位；workbench.html 承载 3 栏布局，manifest.ts 统一维护 26 个静态模块；bootWorkbench 构造 WorkbenchShellHost，挂载 fanqie/toutiao 两个 ProductLineUiModule，通过 4 类槽位回调把产品线 UI 与外壳隔离。状态以 GET /state?ifSequence 增量同步，配合 loadSequence 与用户 epoch 丢弃过期响应，ActionCoordinator 隔离用户动作与后台轮询；DraftVault（sessionStorage + 带 owner 标记的 localStorage）、editSequence 与 IME 组字保护共同实现慢保存期间零丢字和跨标签页冲突保留；5000 章目录通过拍平树 + 固定行高虚拟列表渲染，大纲板默认只读行并惰性挂载编辑器；候选稿采用两层 LCS（段落 + 字级）对照，支持逐段勾选采纳、30 步撤销与原文定位；还包括选段微改写、命令面板 / FTS 检索、上下文槽位预览、离线体检与定性审稿、书斋 / 三步向导、三套纸面主题与正文排版。整体工程纪律好（零 innerHTML 注入面、自研 dialog 替代原生弹窗、CSP、ID 契约测试），主要短板是：落地功能在边界条件下的正确性、同步模型覆盖面、长篇下的请求放大，以及前端测试缺少真实布局与交互回归。

## 二、优点

- 零运行时依赖、原生 ESM + 共享纯类型 DTO（workspace-dto.ts 严格 type-only），前后端单一契约来源
- 产品线 UI 插件化（ProductLineUiModule/Session + WorkbenchShellHost）与后端 ProductLineModule 对称
- 防丢字设计扎实：DraftVault 双存储 + owner 隔离 + editSequence 慢保存保护 + IME 组字保护 + 冲突横幅，并有 Playwright 慢保存/多标签旅程验证
- 并发细节到位：loadSequence 与选择快照丢弃过期响应，用户动作与后台轮询双通道，轮询不吞点击
- 长篇性能意识强：拍平树 + 虚拟列表、大纲板分页与惰性编辑器、RenderGate 签名比对，并有 DOM 节点数上限测试
- 安全面小：DOM 基本通过 el()/textContent 构建，仅 2 处静态模板使用 innerHTML；CSP default-src 'self'；自研 <dialog> 替代原生 confirm/prompt
- 作者主权在 UI 层落实：候选稿只读对照、采纳 / 定稿 / 批准都有二次确认，提案统一进入收件箱
- 契约测试有效：HTML ID 唯一性与引用完整性、标签与面板 1:1、manifest 与 HTML 入口一致

## 三、发现汇总

共 **34** 条：严重 1 · 高 7 · 中 16 · 低 10。

| ID | 严重度 | 类别 | 标题 | 工作量 |
|---|---|---|---|---|
| FE-01 | 🔴 严重 | 缺陷 | 选段微改写在过期偏移上替换：切章或请求期间继续输入会把 AI 文本写进错误位置甚至错误章节 | S |
| FE-02 | 🟠 高 | 正确性 | 『可用 Ctrl+Z 撤销』承诺不成立：setRangeText 与 editor.value 赋值不进入原生撤销栈 | S |
| FE-03 | 🟠 高 | 缺陷 | 状态同步只在『正文生成 running』时轮询：异步提案、Agent 工具提案、其他标签页保存都不会自动出现 | M |
| FE-04 | 🟠 高 | 性能 | 每次保存都会触发目录树全量重拉与多视图刷新：一次 Ctrl+S 约 6 个请求，5000 章时目录树载荷达 MB 级 | M |
| FE-05 | 🟠 高 | 缺陷 | 大纲板/设定库整块重绘会吞掉正在编辑的摘要与指南针文本 | S |
| FE-06 | 🟠 高 | 缺陷 | 虚拟列表行高与 CSS 实际高度不一致：滚动时跳行、末尾截断、scrollToIndex 定位不准 | S |
| FE-07 | 🟠 高 | 正确性 | 请求没有超时、也没有幂等键：后端卡住会锁死全部操作，加超时后重试保存会被误报成版本冲突 | S |
| FE-08 | 🟠 高 | 能力缺口 | 长篇导入走单个 JSON 请求，会撞上宿主 2 MiB 请求体上限：百万字作品无法导入 | M |
| FE-09 | 🟡 中 | 体验 | 开新书向导和示例书导入：中途失败会留下半成品项目，错误提示被模态框挡住看不见 | M |
| FE-10 | 🟡 中 | 缺陷 | 主题色板不完整：系统深色模式下浅色纸面会混入深色语义色，字级 Diff 颜色写死、引用未定义变量 | S |
| FE-12 | 🟡 中 | 正确性 | 切到『候选原文』模式会把部分勾选悄悄变成整篇采纳 | S |
| FE-13 | 🟡 中 | 正确性 | 部分合稿丢失空行分隔、格式不一致 | S |
| FE-14 | 🟡 中 | 性能 | 字级 Diff 降级阈值过低：中文长段很容易退化成整段替换；段落级降级按位置配对 | M |
| FE-15 | 🟡 中 | 架构 | 外壳里残留产品线专属逻辑：『微头条』兜底、示例书导入写死番茄动作 | S |
| FE-16 | 🟡 中 | 可维护性 | 受保护阈值在前端重复硬编码（34 / 84 / 2 / 2），存在漂移风险（不改数值） | S |
| FE-17 | 🟡 中 | 可维护性 | 动作 API 没有类型约束：action 是任意字符串，候选稿 QA 以字符串 JSON 下发、在 render 中裸解析 | M |
| FE-18 | 🟡 中 | 可维护性 | shell.ts 971 行单闭包，职责过多 | M |
| FE-19 | 🟡 中 | 体验 | 可访问性缺口：标签页、目录树、命令面板、Diff 都缺少语义与键盘操作 | L |
| FE-20 | 🟡 中 | 体验 | 忙碌期间的点击被静默丢弃，没有任何反馈 | S |
| FE-21 | 🟡 中 | 缺陷 | 上下文预览与诊断面板没有『以最后一次为准』：刷新被丢弃或乱序，显示过期数据 | S |
| FE-22 | 🟡 中 | 性能 | 静态资源全部 no-store，也没有 modulepreload：每次打开 iframe 都要瀑布式下载 26 个模块 | M |
| FE-23 | 🟡 中 | 架构 | 同一工作台可能同时存在两个 iframe 实例（main 与 conversation.view），会产生自我冲突 | S |
| FE-29 | 🟡 中 | 测试 | 前端测试覆盖集中在纯函数，关键交互路径与真实布局没有回归保护 | L |
| FE-33 | 🟡 中 | 能力缺口 | 编辑器看不到段落编号，但知情点、证据、Diff 定位都以『第 N 段』为单位 | M |
| FE-11 | ⚪ 低 | 体验 | 『跟随宿主』主题不会随系统或宿主切换而更新；外观弹层不能用 Esc 或点击外部关闭 | S |
| FE-24 | ⚪ 低 | 体验 | 模型提供方/模型默认值有 3 处且互不一致，没有持久化 | S |
| FE-25 | ⚪ 低 | 体验 | 提案和设定展示偏『开发者视角』：直接显示原始 JSON、章节 UUID | M |
| FE-26 | ⚪ 低 | 体验 | 部分破坏性操作没有确认；SKILL.md 只能粘贴导入 | S |
| FE-27 | ⚪ 低 | 缺陷 | 全局快捷键的细节问题：保存禁用时 Ctrl+S 会打开浏览器『另存为』，且没有处理输入法组字 | S |
| FE-28 | ⚪ 低 | 性能 | 渲染路径上的小浪费：每次轮询都重建 Blob URL、写 localStorage、序列化全文签名 | S |
| FE-30 | ⚪ 低 | 文档 | 文档与实现不一致：UI 槽位契约和客户端描述已经过时 | S |
| FE-31 | ⚪ 低 | 体验 | 本地存储不可用且有未保存修改时，关闭页面没有拦截 | S |
| FE-32 | ⚪ 低 | 正确性 | 种子技法包分类与技法卡分类表不一致（atmosphere） | S |
| FE-34 | ⚪ 低 | 体验 | 窄屏与会话侧栏场景：960px 断点按视口宽度判断，不按 iframe 容器宽度 | M |

> 工作量：S < 0.5 天，M 1–2 天，L 3–5 天，XL > 1 周。

## 四、发现详情

### FE-01 选段微改写在过期偏移上替换：切章或请求期间继续输入会把 AI 文本写进错误位置甚至错误章节

- **严重度 / 类别 / 工作量**：🔴 严重 / 缺陷 / S
- **位置**：`src/client/workbench/views/selection-microbar.ts:87-141`、`src/client/workbench/shell.ts:235-245`、`src/client/workbench/shell.ts:570-574`
- **证据**：triggerRewrite 在 await host.request('selection.rewrite') 之前捕获 sel={start,end,text}，applyBtn.onclick 直接 applySelectionReplacement(editor, sel.start, sel.end, res.rewrittenText)，不校验 editor.value.slice(start,end)===sel.text，也不校验 documentId。请求进行中编辑器仍可输入（perform 只锁按钮不锁 textarea）；previewCard 在 selectDocument/onDocumentSelected 中不会被隐藏，render() 对非锁定文档只调用 selectionMicrobar.refresh()（refresh 不隐藏预览卡）。因此：①生成期间在选区前插入文字→替换错位；②预览出来后切换到另一章再点『应用替换』→在新章同一偏移处覆写正文。
- **影响**：静默篡改作者正文，违反『作者主权、模型绝不静默改稿』的核心承诺；错位替换不易察觉，且 setRangeText 不进入原生撤销栈（见 FE-02），难以恢复。
- **建议**：1) 捕获 {documentId, revisionId: editorBase.revisionId, start, end, text}；2) 应用前校验 host.getState().documentId===captured.documentId，且 editor.value.slice(start,end)===text；不一致时在全文中查找 text 的唯一出现位置并重定位，0 次或多次命中则拒绝并提示『原选段已变化，请重新选择』；3) 在 selectDocument()、onDocumentSelected、render() 检测到 active.id 变化时调用 selectionMicrobar.hide()；4) 请求进行中给预览卡显示『生成中』并在完成时再次校验；5) 新增单测：请求期间修改正文/切章后 apply 必须拒绝。

### FE-02 『可用 Ctrl+Z 撤销』承诺不成立：setRangeText 与 editor.value 赋值不进入原生撤销栈

- **严重度 / 类别 / 工作量**：🟠 高 / 正确性 / S
- **位置**：`src/client/workbench/views/selection-microbar.ts:15-33`、`src/client/workbench/views/selection-microbar.ts:135`、`src/client/workbench/shell.ts:341-343`、`src/client/workbench/shell.ts:570`
- **证据**：applySelectionReplacement 使用 editor.setRangeText(...,'select') 并派发 input 事件，提示文案写『已替换选中片段（可用 Ctrl+Z 撤销）』。程序化修改（setRangeText / value 赋值）不属于用户编辑历史，浏览器不会把它放进撤销栈；只有 document.execCommand('insertText') 会保留编辑历史。shell 在保存回包、render 恢复本地稿时也直接赋值 editor.value，会清空此前的撤销历史。
- **影响**：作者按 Ctrl+Z 无法回到 AI 替换前的文本；结合 FE-01，错误替换几乎不可逆（只能靠 DraftVault 旧版本或服务器修订）。
- **建议**：1) 替换优先走 editor.focus(); editor.setSelectionRange(start,end); document.execCommand('insertText', false, text)，返回 false 时再回退 setRangeText；2) 另加轻量『撤销上次 AI 替换』按钮：替换前把 {start, before, after} 压入内存栈（最多 10 步），一键还原，不依赖浏览器撤销；3) 文案改为『可点击“撤销替换”或 Ctrl+Z』，并以实测结果为准；4) render() 仅在 value 实际不同且非输入中时赋值（已有），保存回包路径避免无谓赋值。
- **参考**：https://stackoverflow.com/questions/73129862/is-it-possible-to-undo-setrangetext；https://stackoverflow.com/questions/78656916/how-can-i-preserve-undo-history-when-programmatically-changing-the-value-of-a-te；https://developer.mozilla.org/en-US/docs/Web/API/HTMLTextAreaElement/setRangeText

### FE-03 状态同步只在『正文生成 running』时轮询：异步提案、Agent 工具提案、其他标签页保存都不会自动出现

- **严重度 / 类别 / 工作量**：🟠 高 / 缺陷 / M
- **位置**：`src/client/workbench/shell.ts:646-656`、`src/client/workbench/views/diagnostics-panel.ts:104-118`、`src/client/workbench/views/outline-board.ts:421-438`、`src/host/plugin.ts:284-330`
- **证据**：pollTimer 仅在 run.state==='running' 且 generationState∈{prepared,inflight,received} 时建立。proposal.generate（chapter_review / arc_plan / fact_sync / summary 等）在宿主是后台任务，前端发出后立即 refreshForDocument / refresh 一次，此时提案尚未生成完成，之后再无轮询；DsH 对话里 Agent 调用 3 个提案工具写入收件箱后，工作台也不会刷新；第二个标签页保存后，本页要到下一次操作才发现版本冲突。
- **影响**：作者以为 AI 审稿/滚动规划『没反应』而重复点击（叠加宿主内存锁报 proposal-in-progress）；冲突发现滞后，增加本地稿与服务器分叉的概率。
- **建议**：1) 常驻低频同步：页面可见时每 15s 带 ifSequence 拉 /state（unchanged 时几乎零成本），visibilitychange→visible 与 window focus 时立即拉一次；2) 快照新增 pendingJobs: {kind, documentId, startedAt}[]（需后端配合），存在待完成作业时切换到 2s 快轮询，完成后自动刷新对应视图并提示『AI 审稿提案已生成』；3) 轮询统一走 coordinator.runBackgroundPoll，保持不吞点击；4) 用 BroadcastChannel('zhizhang') 在同源标签页之间广播 saved/asOfSeq，收到即刷新。

### FE-04 每次保存都会触发目录树全量重拉与多视图刷新：一次 Ctrl+S 约 6 个请求，5000 章时目录树载荷达 MB 级

- **严重度 / 类别 / 工作量**：🟠 高 / 性能 / M
- **位置**：`src/client/workbench/shell.ts:503-515`、`src/client/workbench/plugins/fanqie.ts:353-389`、`src/client/workbench/plugins/fanqie.ts:439-443`、`src/client/workbench/views/outline-board.ts:81-86`
- **证据**：docSig 中包含 snapshot.asOfSeq，任何事件都会让目录签名变化，于是调用番茄 session.onDirectoryUpdated → 每次 host.request('tree.get')（含全部章节 summary），并在非写作视图下 refreshActiveStudioView（大纲板再次 tree.get + 2×proposal.list + controls.get）；renderDocumentSlots 以 `${active.id}:${asOfSeq}` 为键，每次保存都触发 context.preview + observation.list + proposal.list。一次保存 ≈ /mutate + /state + tree.get + context.preview + observation.list + proposal.list。
- **影响**：长篇（650–5000 章）下保存延迟、主线程 JSON 解析与目录重绘抖动明显；大纲视图下保存会再叠加 4 个请求；对 DsH Connection 路由和 SQLite 读负载造成无谓压力。workspace-bench 只测了服务端 snapshot，没覆盖这条前端链路。
- **建议**：1) docSig 去掉 asOfSeq，只用 `${projectId}:${documents.map(id:title)}`；2) 后端 tree.get 支持 ifSequence/treeSeq（目录相关事件的水位），未变返回 {unchanged:true}；前端缓存 lastTree；3) context.preview 仅在『候选』标签可见时，且 instruction/tokenLimit/point 变化或保存后 800ms 防抖刷新；4) 诊断面板只在面板展开时刷新；5) 新增前端请求计数基准：保存一次的请求数 ≤3，5000 章保存不触发 tree.get。

### FE-05 大纲板/设定库整块重绘会吞掉正在编辑的摘要与指南针文本

- **严重度 / 类别 / 工作量**：🟠 高 / 缺陷 / S
- **位置**：`src/client/workbench/views/outline-board.ts:101-106`、`src/client/workbench/views/outline-board.ts:168-194`、`src/client/workbench/views/outline-board.ts:323-336`、`src/client/workbench/plugins/fanqie.ts:387-388`
- **证据**：paint() 每次 container.replaceChildren() 全量重建；展开章节的 summaryInput.value=ch.summary、指南针 intentInput.value=controls.authorIntent 都来自上次请求结果。onDirectoryUpdated 在非写作视图下会调用 refreshActiveStudioView → outlineView.refresh() → paint()，而 asOfSeq 的任何变化（后台生成轮询、其他操作）都会触发它；作者正在输入的摘要/指南针文字被覆盖，且没有本地暂存。
- **影响**：作者在大纲板编辑长摘要或全书指南针时，内容可能在无提示的情况下丢失，与『防丢字』承诺相悖。
- **建议**：1) 组件内维护 drafts: Map<key, string>（key=chapterId/'compass'），input 事件写入，paint 时优先使用 drafts，保存成功后清除；2) container.contains(document.activeElement) 且焦点在 textarea 时推迟重绘（设置 pendingRepaint，在 blur 后执行）；3) 修好 FE-04 后，这类刷新本身也会大幅减少；4) 加测试：展开编辑→触发 refresh→文本保持不变。

### FE-06 虚拟列表行高与 CSS 实际高度不一致：滚动时跳行、末尾截断、scrollToIndex 定位不准

- **严重度 / 类别 / 工作量**：🟠 高 / 缺陷 / S
- **位置**：`src/client/workbench/views/tree-sidebar.ts:244-250`、`src/client/workbench/views/virtual-list.ts:49-68`、`src/client/workbench.css:499-507`、`src/client/workbench.css:1121-1128`、`src/client/workbench.css:1130-1135`
- **证据**：createVirtualList 的 rowHeight=36，用 items.length*36 计算总高、用 start*36 做 translateY；但 .vlist-window 设置了 gap:2px，章节行 .doc-list button 的高度为 padding 8×2 + 13px×1.6 行高 + 2px 边框 ≈ 39px（只有卷/幕行显式 height:36px）。窗口内第 k 行的实际位置 = start*36 + k*(≈41)，与计算位置的偏差随 k 累积（17 行时约 80px），start 变化时窗口整体跳动；总高偏小会导致最后几章需要越界滚动才能看到。现有单测用的是假 DOM，测不出几何问题。
- **影响**：5000 章目录滚动出现抖动/跳行、点击位置与视觉不符，直接削弱 V2.2『5000 章流畅』的卖点。
- **建议**：1) CSS：.vlist-window{gap:0} .vlist-window>*{height:var(--vrow-h,36px);min-height:0;box-sizing:border-box;padding-block:0;}，章节行改为单行 flex 并 align-items:center；2) virtual-list 通过 container.style.setProperty('--vrow-h', rowHeight+'px') 统一行高来源；3) 打开项目/切章时调用 scrollToIndex(activeIndex) 让当前章可见（目前从未调用）；4) 加 ResizeObserver(container) 在侧栏尺寸变化时 refresh；5) Playwright 用 5000 章夹具断言：任意滚动位置下，可见行的 getBoundingClientRect().top 与 index*36 的偏差 ≤1px。

### FE-07 请求没有超时、也没有幂等键：后端卡住会锁死全部操作，加超时后重试保存会被误报成版本冲突

- **严重度 / 类别 / 工作量**：🟠 高 / 正确性 / S
- **位置**：`src/client/workbench/api.ts:32-73`、`src/client/workbench/store.ts:39-57`、`src/client/workbench/shell.ts:319-350`、`src/application/context.ts:178-188`
- **证据**：apiRequest 直接 fetch(url, options)，没有 signal；runUserAction 在 work 结束前 userBusy=true，此期间所有 bindClick/bindForm 返回 false。后端 commandInput 只在 input.key 为字符串时启用幂等（context.ts:186），前端只给 candidate.adopt（candidateId）和 article.deliver 传了 key，draft.save 等没有。若第一次保存已落库但响应丢失，重试会因 baseRevisionId 过期返回 version.conflict，提示『稿件版本已更新』，其实是作者自己的保存。REASON_MESSAGES 也没有 too-large、网络错误等映射。
- **影响**：DsH 宿主或 SQLite 一旦卡顿，工作台整体『点不动』；网络抖动后作者会看到假冲突横幅、怀疑丢稿。
- **建议**：1) apiRequest 增加 options.timeoutMs（读 15s，写 30s，导入导出 120s），signal=AbortSignal.any([AbortSignal.timeout(ms), userAbort])；2) shell.change() 每次用户动作生成一次 key=crypto.randomUUID()，同一动作的自动/手动重试复用该 key（后端已支持 idempotencyKey 重放）；3) 超时/网络错误映射为『网络超时，本地稿已保留，可点击重试』，并在通知条提供『重试』按钮（复用 key）；4) REASON_MESSAGES 补充 too-large、expected-json、unknown-action、generation.failed 等；5) 单测：模拟超时→userBusy 复位；保存重试→复用 key。
- **参考**：https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/timeout_static

### FE-08 长篇导入走单个 JSON 请求，会撞上宿主 2 MiB 请求体上限：百万字作品无法导入

- **严重度 / 类别 / 工作量**：🟠 高 / 能力缺口 / M
- **位置**：`src/client/workbench/views/io-view.ts:109-131`、`src/client/workbench/views/io-view.ts:139-155`、`src/host/plugin.ts:105-117`、`scripts/dev-server.mjs:20`
- **证据**：目录导入把所有 .md/.json 读成 {path,content}[] 后一次性 POST project.import_bundle；host/plugin.ts 的 requestObject 在累计超过 MAX_REQUEST_BYTES=2 MiB 时抛 input.invalid/too-large。100 万汉字的 UTF-8 约 3 MB，加上 JSON 转义就超限；前端提示为『input.invalid · too-large』，没有大小预检、进度和分批。
- **影响**：『本地 Markdown 工程包双向同步』在真实长篇（番茄连载常见 50 万–300 万字）上不可用，迁移与备份恢复受阻。
- **建议**：1) 前端预检：用 TextEncoder 计算字节数，超过 1.5 MiB 时自动分批（按卷目录或每批 ≤1 MiB）；2) 协议（需后端配合）：project.import_bundle 支持 {importId, part, totalParts, files}，最后一批 commit，服务端在单个写事务中落库，或每批幂等合并（io.ts 已有内容哈希幂等）；3) 进度 UI：『已上传 3/12 批』，可取消；4) 导出同理：大 bundle 分文件下载，或改为只用 writeToDisk；5) 基准：200 万字、3000 章夹具导入 <30s，且不触发 too-large。

### FE-09 开新书向导和示例书导入：中途失败会留下半成品项目，错误提示被模态框挡住看不见

- **严重度 / 类别 / 工作量**：🟡 中 / 体验 / M
- **位置**：`src/client/workbench/views/new-book-wizard.ts:52-127`、`src/client/workbench/views/new-book-wizard.ts:278-281`、`src/client/workbench/shell.ts:414-470`、`src/client/workbench.html:92-95`
- **证据**：finishWizard 串行发出 project.create → controls.save → volume.create → 1–3×document.create → draft.save → N×(technique.save+library.mount)；importDemoBook 更多。任一步失败，perform 只在主页面 #notice 显示错误，而向导是置顶 <dialog>（top layer），作者看不到错误，对话框也不关闭；再次点击『创建并进入写作』会再建一个同名项目。
- **影响**：冷启动第一印象受损；书架上残留多个半成品项目。
- **建议**：1) 向导内放一个错误区和进度（step i/n），提交期间禁用按钮；2) 失败时提供『继续完成剩余步骤』（记录已创建的 projectId，后续步骤从断点继续），而不是重新创建；3) 更彻底的做法（需后端配合）：新增 project.bootstrap 复合动作，在一个写事务里完成项目+卷+章+技法+挂载，同时把番茄专属的种子数据移出 shell（见 FE-15）；4) 对 modal.prompt/confirm 流程统一：dialog 打开期间的错误渲染进 dialog。

### FE-10 主题色板不完整：系统深色模式下浅色纸面会混入深色语义色，字级 Diff 颜色写死、引用未定义变量

- **严重度 / 类别 / 工作量**：🟡 中 / 缺陷 / S
- **位置**：`src/client/workbench.css:29-47`、`src/client/workbench.css:69-94`、`src/client/workbench.css:1363-1377`、`src/client/workbench.css:1384`、`src/client/workbench/appearance.ts:54-70`
- **证据**：@media (prefers-color-scheme: dark) 中的 :root:not([data-theme="light"]) 会对 data-theme=ink-paper/bamboo 也生效（applyAppearancePreferences 从不写 'light'），而 ink-paper/bamboo 只覆盖了背景、前景和 primary，success/warning/destructive/diff-*-bg 仍然是深色模式的亮色值（如 #fbbf24 警告字出现在白纸上）。.diff-char-del/.diff-char-ins 写死浅色 rgba，并引用未定义的 --danger、--accent-ink、--surface-alt（只能落到 fallback），夜航主题下删除/新增字的对比度不足。
- **影响**：可读性与可访问性下降（WCAG 对比度不达标），作者在夜间审稿时 Diff 难以辨认。
- **建议**：1) 每个主题（ink-paper/bamboo/night）定义完整 token 集（含 success/warning/destructive/diff-add/del/chg、diff-char-ins/del 的前景与背景）；2) 删除 :root:not([data-theme="light"]) 媒体查询分支，auto 模式由 JS 写 data-theme，CSS 只认 data-theme；3) 把 --danger/--accent-ink/--surface-alt 换成已定义 token；4) 加静态测试：解析 CSS，断言每个主题都定义了全部必需 token；5) browser-check 加 colorScheme light/dark × 3 主题的截图或对比度断言。

### FE-12 切到『候选原文』模式会把部分勾选悄悄变成整篇采纳

- **严重度 / 类别 / 工作量**：🟡 中 / 正确性 / S
- **位置**：`src/client/workbench/views/diff-view.ts:340-350`、`src/client/workbench/shell.ts:807-841`
- **证据**：getAdoptionPayload 中 isFull = mode==='raw' || totalHunks===0 || adopted.size===totalHunks。作者在并排模式取消几处勾选后切到『候选原文』查看全文，再点『采纳』，提交的就是 adoptionMode='full' + candidateBody，确认框文案也变成整篇采纳，勾选状态被忽略。
- **影响**：违背『逐段外科合稿』的预期，作者不想要的改动被并入工作稿（可撤回，但需要人工比对）。
- **建议**：1) 采纳计划只由 adopted 集合决定，与显示模式无关；2) raw 模式顶部显示『当前勾选 x/y 处，采纳将按勾选合稿』，并可一键切回并排；3) 单测：取消勾选→切 raw→getAdoptionPayload 仍为 partial。

### FE-13 部分合稿丢失空行分隔、格式不一致

- **严重度 / 类别 / 工作量**：🟡 中 / 正确性 / S
- **位置**：`src/client/workbench/diff.ts:106-128`、`src/client/workbench/views/diff-view.ts:36-38`、`src/client/workbench/views/diff-view.ts:326-333`
- **证据**：isBlankSpacer 行（两侧都是空行）不进入 hunkIndices，因此永远不会被『采纳』；mergeParagraphSelections 对 added 空行只有在 adopted 中才输出、对 removed 空行在未采纳时保留。结果是：候选稿新增的段间空行全部被丢弃，原稿删除的空行全部被保留，合并结果的段落分隔与两份原稿都不一致；输出统一用 '\n' 连接，原稿的 CRLF 被规范化。
- **影响**：部分采纳后排版走样（番茄后台对空行/段落敏感），作者需要手工修空行。
- **建议**：1) 把空行行并入相邻非空 hunk：只要相邻 hunk 被采纳，就跟随候选稿的空行，否则跟随原稿；2) 记录原稿的换行风格（\r\n 或 \n）并在合并时还原；3) 单测：候选稿只把单换行改成双换行、全选与全不选时，输出分别等于候选稿与原稿。

### FE-14 字级 Diff 降级阈值过低：中文长段很容易退化成整段替换；段落级降级按位置配对

- **严重度 / 类别 / 工作量**：🟡 中 / 性能 / M
- **位置**：`src/client/workbench/diff.ts:44-61`、`src/client/workbench/diff.ts:63-69`、`src/client/workbench/diff.ts:141-158`
- **证据**：computeInlineDiff 在 m*n>80,000 时只做公共前后缀（两段各约 283 个汉字就会触发，番茄常见长段很容易超过）；完整 LCS 使用 (m+1)×(n+1) 的 Uint32Array 表，内存是 O(mn)。段落级在 m*n>250,000 时按下标逐段配对，中间插入一段会把后面所有段落都标成 changed。
- **影响**：『字级 Diff 外科合稿』在长段落上失效，作者看到整段红绿，无法判断改了哪几个字；大章节的 Diff 计算可能卡住主线程。
- **建议**：1) 字级改用 Myers O(ND) 算法（加编辑距离上限 D≤2000，超限再降级），内存 O(N)；2) 先按句末标点（。！？…；和引号闭合）把段落切成句子，做句级 LCS，再对 changed 句做字级 diff，长段落也能精确；3) 段落级先用 patience 锚点（只出现一次的相同段落）切块，块内再做 LCS/Myers，替代按位置配对；4) 超过 2,000 段或 20 万字时放到 requestIdleCallback 或 Worker 中计算，并显示『计算差异中』；5) 基准：3000 字章节 / 30 段 / 每段 200 字的随机改写，<30ms，字级结果与完整 LCS 的一致率 ≥95%。
- **参考**：https://publications.mpi-cbg.de/Myers_1986_6330.pdf；https://github.com/mathertel/Diff/blob/main/doku.md

### FE-15 外壳里残留产品线专属逻辑：『微头条』兜底、示例书导入写死番茄动作

- **严重度 / 类别 / 工作量**：🟡 中 / 架构 / S
- **位置**：`src/client/workbench/shell.ts:24`、`src/client/workbench/shell.ts:414-470`、`src/client/workbench/shell.ts:524`、`src/client/workbench/shell.ts:547`、`src/client/workbench/shell.ts:551`、`src/client/workbench/views/command-palette.ts:120`、`src/client/workbench/views/tree-sidebar.ts:237`
- **证据**：shell.ts 3 处使用 `active.title || "微头条"`；importDemoBook 在外壳中直接调用 controls.save/volume.create/act.create/chapter.summary.save/technique.save/library.mount，并 import DEMO_BOOK_PRESET（番茄种子）；command-palette 与 tree-sidebar 也用『微头条』兜底。这与 docs/framework 的『底座零产品分支』目标矛盾，refactor-v2 的静态守卫只检查了后端。
- **影响**：新增第三条产品线时必须改外壳；两条产品线的 UI 语义互相渗透。
- **建议**：1) ProductLineUiModule 新增 documentTitle(doc: {title, mode}) 钩子，头条返回『微头条』，番茄返回『未命名章节』；外壳/目录/命令面板统一调用；2) 把 importDemoBook 移到 fanqieUiModule，新增可选的 bootstrapDemo(host) / seedPresets 钩子，study-home 按模块列出『导入示例』；3) refactor-v2 增加前端守卫：shell.ts、store.ts、views/{tree-sidebar,command-palette,virtual-list,diff-view,run-inspector,study-home}.ts 不得出现 'fanqie'/'toutiao'/'微头条' 字面量。

### FE-16 受保护阈值在前端重复硬编码（34 / 84 / 2 / 2），存在漂移风险（不改数值）

- **严重度 / 类别 / 工作量**：🟡 中 / 可维护性 / S
- **位置**：`src/client/workbench/plugins/toutiao.ts:6`、`src/client/workbench/plugins/toutiao.ts:211`、`src/client/workbench/plugins/fanqie.ts:460-462`、`src/client/workbench.html:214`、`src/client/workbench.html:356`、`src/client/workbench/api.ts:17-22`、`src/domain/toutiao/rules.ts:3-6`
- **证据**：TITLE_MAX=34 在 domain/toutiao/rules.ts 和 plugins/toutiao.ts 各定义一次；qaRounds>=2、editorialRejections>=2 与『/ 2 次』在前端写死；HTML 中写死『通过线 84』『最多自动回改两轮』；api.ts 的提示文案里也写死了数字。workspace-dto.ts 是纯类型文件，前端无法引用运行时常量，所以只能复制。
- **影响**：一旦作者授权调整阈值，前后端可能不一致（前端放行、后端拒绝，或反过来）；也违背 AGENTS.md 要求的单一语义来源。
- **建议**：不改任何数值：1) 新增浏览器安全的纯常量模块 src/contracts/protected-rules.ts（零 import，只导出 as const），domain/toutiao/rules.ts 与 domain/fanqie/editorial.ts 改为从这里取值，客户端 tsconfig 与 manifest 也纳入该模块；或者由快照下发只读的 rules: {titleMax, qaPass, qaRefineLimit, rejectionLimit}；2) HTML 中的数字改为渲染时注入；3) 架构测试：前端源码中不得出现裸数字 34/84 的阈值判断；断言 protected-rules 与 domain 值相等。该改动只调整引用方式，不改变受保护语义的数值。

### FE-17 动作 API 没有类型约束：action 是任意字符串，候选稿 QA 以字符串 JSON 下发、在 render 中裸解析

- **严重度 / 类别 / 工作量**：🟡 中 / 可维护性 / M
- **位置**：`src/client/workbench/api.ts:32-37`、`src/client/workbench/plugins/types.ts:27-32`、`src/contracts/workspace-dto.ts:115-128`、`src/contracts/workspace-dto.ts:674-748`、`src/client/workbench/shell.ts:603`
- **证据**：workspace-dto.ts 已有 WorkspaceAction 联合类型（74 个动作），但 apiRequest/host.request/host.change 的 action 参数类型都是 string，返回值依赖调用方手写泛型。RunSummary.candidateQa 是 string，shell.render() 中 JSON.parse(pending.candidateQa) 没有 try，一旦数据异常整个 render 抛错，界面停在半渲染状态。
- **影响**：改名或删除动作时编译器发现不了；候选 QA 数据异常会让整个写作台不可用。
- **建议**：1) 在 workspace-dto.ts 增加 interface ActionMap { 'draft.save': {input: DraftSaveInput; output: {revisionId: string}}; ... }，request<A extends WorkspaceAction>(action: A, input: ActionMap[A]['input']): Promise<ActionMap[A]['output']>，可以先覆盖前端用到的约 50 个动作；2) 后端改为下发结构化的 candidateQa: CandidateQaReport | null（需后端配合），过渡期前端用 safeJson() 包裹；3) render 的各个子块分别 try/catch 并报告诊断，避免一处异常拖垮整页。

### FE-18 shell.ts 971 行单闭包，职责过多

- **严重度 / 类别 / 工作量**：🟡 中 / 可维护性 / M
- **位置**：`src/client/workbench/shell.ts:61-971`
- **证据**：bootWorkbench 一个闭包里包含：定位段落、草稿暂存、目录、预算提示、loadState/change、示例书导入、render（约 175 行）、侧栏切换、命令面板、全局快捷键、冲突横幅、项目/稿件表单、采纳/舍弃/取消/生成、运行检查器与历史分页、对账。
- **影响**：改动风险高、难以单测（目前对 shell 的竞态逻辑没有单元测试，见 FE-29）。
- **建议**：按职责拆分为（不引入框架）：shell/state.ts（snapshot/loadState/change/轮询，纯逻辑可单测）、shell/editor.ts（编辑器、DraftVault、IME、定位）、shell/run-panel.ts（start/generate/adopt/discard/cancel/inspector/history/reconcile）、shell/navigation.ts（项目、稿件、目录、侧栏）、shell/shortcuts.ts；shell.ts 只负责组装，目标 <300 行；manifest.ts 同步登记新模块（client-v2 测试会校验）。

### FE-19 可访问性缺口：标签页、目录树、命令面板、Diff 都缺少语义与键盘操作

- **严重度 / 类别 / 工作量**：🟡 中 / 体验 / L
- **位置**：`src/client/workbench.html:16-23`、`src/client/workbench.html:193-198`、`src/client/workbench/views/tree-sidebar.ts:203-242`、`src/client/workbench/views/command-palette.ts:39-62`、`src/client/workbench/views/diff-view.ts:53-77`、`src/client/workbench/modal.ts:32-62`
- **证据**：顶部视图切换 role=tablist 下的按钮没有 role=tab；所有标签都没有 aria-controls，面板没有 role=tabpanel，也不支持方向键（只有 Alt+1–4 切流程标签）。目录树没有 tree/treeitem 语义和方向键导航，虚拟滚动会回收已聚焦的按钮导致焦点丢失。命令面板结果不是 listbox，不支持上下键/回车选择首项。Diff 不能键盘跳到下一处改动。modal 关闭后不归还焦点。
- **影响**：纯键盘作者（长时间写作的常见习惯）效率低；屏幕阅读器用户基本无法使用。
- **建议**：1) 按 APG Tabs 模式：role=tab/aria-controls/tabpanel + roving tabindex + 左右/Home/End；2) 目录树按 APG Tree View：role=tree/treeitem、aria-level/aria-expanded、上下键移动、左右键折叠展开、Enter 打开；虚拟列表记住 focusedKey，重绘后恢复焦点；3) 命令面板：input aria-controls=listbox，上下键移动 aria-activedescendant，Enter 选中；4) Diff：J/K 或 Alt+↓/↑ 跳到下一个/上一个 hunk，空格切换采纳；5) modal 记录打开前的 activeElement，关闭后恢复；6) browser-check 可选接入 axe-core（仅开发期依赖，可用环境变量开关）。
- **参考**：https://www.w3.org/WAI/ARIA/apg/patterns/tabs/；https://www.w3.org/WAI/ARIA/apg/patterns/treeview/examples/treeview-navigation/；https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/

### FE-20 忙碌期间的点击被静默丢弃，没有任何反馈

- **严重度 / 类别 / 工作量**：🟡 中 / 体验 / S
- **位置**：`src/client/workbench/store.ts:39-46`、`src/client/workbench/shell.ts:229-233`、`src/client/workbench/shell.ts:311-317`
- **证据**：runUserAction 在 userBusy 时直接 return false；目录点击、按钮点击、Ctrl+S 在保存或请求期间都会被吞掉，按钮不会变灰，也没有忙碌指示。
- **影响**：作者以为没点到而反复点击；慢网络下切章失败但没有提示。
- **建议**：1) 全局忙碌指示：document.body.dataset.busy + aria-busy，顶栏显示细进度条；2) 导航类动作（selectDocument）改为『最后一次生效』排队：忙碌时记下 pendingDocId，当前动作结束后执行；3) 普通按钮在忙碌时显示 disabled 样式；4) 被丢弃的点击给出轻提示『上一操作进行中』。

### FE-21 上下文预览与诊断面板没有『以最后一次为准』：刷新被丢弃或乱序，显示过期数据

- **严重度 / 类别 / 工作量**：🟡 中 / 缺陷 / S
- **位置**：`src/client/workbench/views/context-preview.ts:21-52`、`src/client/workbench/views/diagnostics-panel.ts:235-274`
- **证据**：context-preview 用 loading 布尔值，加载中再次调用 refresh() 会直接 return，最后一次参数的刷新永远不会执行；diagnostics refreshForDocument 只校验 documentId，同一文档的两次请求乱序返回时，旧结果会覆盖新结果。
- **影响**：作者改了写作要求或预算后看到的槽位占用是旧的，可能据此做出错误的预算判断。
- **建议**：统一用 seq 计数 + AbortController：每次 refresh 先 abort 上一次请求、seq++，回包时校验 seq；loading 期间的新调用标记 dirty，结束后补跑一次。抽成通用工具 createLatestTask() 放进 store.ts 供各视图复用。

### FE-22 静态资源全部 no-store，也没有 modulepreload：每次打开 iframe 都要瀑布式下载 26 个模块

- **严重度 / 类别 / 工作量**：🟡 中 / 性能 / M
- **位置**：`src/host/plugin.ts:83-92`、`src/client/manifest.ts:7-34`、`src/client/workbench.html:8-9`、`src/client/slot.ts:49-63`
- **证据**：staticResponse 统一使用 Cache-Control:no-store；workbench.html 只引入 main.js，其余 25 个模块要靠 import 链逐级发现（main→shell→views→…，深度 3–4 层）；slot.ts 在 main 与 conversation.view 两处各挂一个 iframe，每次挂载都重新下载约 250 KB 的 JS/CSS。
- **影响**：在 DsH 中切换视图或重开会话时，工作台首屏变慢（RTT × 依赖深度）。
- **建议**：1) 构建期从 manifest 生成 <link rel="modulepreload"> 列表注入 HTML（或由 plugin.ts 在返回 HTML 时注入），把瀑布压成一轮并行请求；2) 静态资源改为 Cache-Control: no-cache + ETag（基于内容 SHA-256，而不是 mtime，同时规避 npm pack 的 1985 时间戳问题），HTML 中的模块 URL 带 ?v=<hash>；3) 需要 DsH 插件侧配合（见跨视角事项）；4) 基准：冷启动请求数不变但关键路径 RTT ≤2，热启动 304 命中率 100%。
- **参考**：https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/rel/modulepreload；https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/ETag

### FE-23 同一工作台可能同时存在两个 iframe 实例（main 与 conversation.view），会产生自我冲突

- **严重度 / 类别 / 工作量**：🟡 中 / 架构 / S
- **位置**：`src/client/slot.ts:29-63`、`src/client/workbench/draft-vault.ts:22-24`、`src/client/workbench/shell.ts:758-761`
- **证据**：slot.ts 把同一个 Workbench 组件注册到 main 与 conversation.view 两个槽位；每个 iframe 有独立的 DraftVault owner、轮询和编辑器状态。如果 DsH 同时渲染两处（例如主区打开工作台，同时在会话视图中也打开），同一章节在两个实例里编辑，就会互相触发『基于旧版本的本地编辑』冲突横幅。conflict-copy 使用 navigator.clipboard，iframe 没有声明 allow=clipboard-write，也没有回退。
- **影响**：作者在 DsH 中看到莫名其妙的冲突提示；双倍轮询与请求。
- **建议**：1) 先确认 DsH 是否会同时挂载这两个槽位（待作者/宿主确认）；2) 若会：conversation.view 改为轻量『只读预览 + 跳转到主区』，或者通过 BroadcastChannel 让后挂载的实例进入只读模式；3) iframe 增加 title 区分，并按需加 allow="clipboard-write"，同时提供 execCommand('copy') 回退。

### FE-29 前端测试覆盖集中在纯函数，关键交互路径与真实布局没有回归保护

- **严重度 / 类别 / 工作量**：🟡 中 / 测试 / L
- **位置**：`test/client-v2.test.mjs`、`test/client-views-v2.test.mjs`、`scripts/browser-check.mjs`、`scripts/dev-server.mjs:133-138`
- **证据**：client-v2/client-views-v2 使用手写假 DOM，测不到 CSS 几何（FE-06）、主题 token（FE-10）与焦点；shell 的竞态逻辑（loadState 的 seq/epoch、change 的 editSequence 保护）没有单测；selection-microbar 的过期替换、diff-view 在 raw 模式下的采纳、各插件的渲染、命令面板与 io-view 都没有测试。browser-check 只覆盖 3 条旅程；dev-server 直接拒绝 run.generate / proposal.generate，前端的生成轮询链路在本地无法验证。
- **影响**：本报告中的 FE-01/05/06/12/21 等问题都能通过现有测试，后续重构 shell 时缺少安全网。
- **建议**：1) 在 dev-server 与 browser-check 中增加确定性的 FakeLlmTransport（本地固定文本、可配置延迟/失败/中途中断，不联网、不调用真实模型），覆盖生成→轮询→候选→部分采纳全链路；2) Playwright 新增旅程：选段改写期间切章（必须拒绝）、部分采纳+raw 模式、5000 章目录滚动几何、大纲编辑中刷新不丢字、深浅主题 token 检查；3) 把 FE-18 拆出的 shell/state.ts 做纯逻辑单测；4) test 计数按 AGENTS.md 规则同步。

### FE-33 编辑器看不到段落编号，但知情点、证据、Diff 定位都以『第 N 段』为单位

- **严重度 / 类别 / 工作量**：🟡 中 / 能力缺口 / M
- **位置**：`src/client/workbench.html:145-151`、`src/client/workbench.html:262`、`src/client/workbench.html:276`、`src/client/workbench.html:325`、`src/client/workbench/shell.ts:97-149`
- **证据**：设定生效点、知情段落、run 的 point、证据锚点、Diff 行号都按段落计数，但正文是普通 textarea，没有段号显示；locateEditorParagraph 按行数比例估算 scrollTop（在自动换行时不准确）。作者只能自己数段落来填 point。
- **影响**：番茄线的核心卖点『人物视角知情边界』在交互上门槛很高，容易填错段号，导致知情计算错误。
- **建议**：保持 textarea（不引入重型编辑器）：1) 页脚实时显示『光标在第 N 段 / 共 M 段』（根据 selectionStart 计算，O(n) 且防抖）；2) 所有 point 输入框旁加『用当前光标段』按钮；3) 定位改用镜像 div 测量（与 textarea 同字体同宽度，计算目标段落的 offsetTop），代替行数比例；4) 可选：左侧段号槽（对镜像 div 做绝对定位），只在宽屏开启。

### FE-11 『跟随宿主』主题不会随系统或宿主切换而更新；外观弹层不能用 Esc 或点击外部关闭

- **严重度 / 类别 / 工作量**：⚪ 低 / 体验 / S
- **位置**：`src/client/workbench/appearance.ts:93-209`、`src/client/workbench.html:28`
- **证据**：isHostDark() 只在 sync() 时读取一次 matchMedia('(prefers-color-scheme: dark)').matches，没有监听 change 事件；弹层只能再次点击按钮关闭，没有 keydown Escape、outside click、焦点移入/归还。按钮初始文案『深色』与功能不符（HTML:28）。
- **影响**：DsH 或系统切换深浅色后，工作台保持旧主题，直到刷新页面。
- **建议**：1) mql.addEventListener('change', () => theme==='auto' && sync())；2) 如果 DsH 能通过 postMessage 下发宿主主题，优先采用宿主主题（需与 DsH 侧确认）；3) 弹层支持 Esc/外部点击关闭，打开时聚焦当前选中项，关闭时把焦点还给按钮；4) HTML 初始文案改为『外观』。
- **参考**：https://developer.mozilla.org/en-US/docs/Web/API/MediaQueryList/change_event

### FE-24 模型提供方/模型默认值有 3 处且互不一致，没有持久化

- **严重度 / 类别 / 工作量**：⚪ 低 / 体验 / S
- **位置**：`src/client/workbench.html:353-354`、`src/client/workbench/plugins/fanqie.ts:56-62`、`src/client/workbench/shell.ts:393-404`、`src/client/workbench/views/outline-board.ts:427`、`src/host/plugin.ts:25-30`
- **证据**：HTML 写死 deepseek-account / deepseek-flash；番茄插件兜底同值；选段微改写兜底为 'default'；大纲板又兜底一次。宿主 DsHPluginConfig 已有 defaultProvider/defaultModel，但没有下发给前端；输入框是自由文本，每次刷新后恢复默认。
- **影响**：选段改写等路径可能使用与作者预期不同的模型；配置分散，排查困难。
- **建议**：1) 快照下发 llmDefaults {provider, model, options?}（来自 settings.ts 的配置表单）；2) 前端集中管理 getProviderModel()，表单值存入 localStorage；3) 若 DsH 能列出可用 provider/model，改为下拉框。

### FE-25 提案和设定展示偏『开发者视角』：直接显示原始 JSON、章节 UUID

- **严重度 / 类别 / 工作量**：⚪ 低 / 体验 / M
- **位置**：`src/client/workbench/views/worldbook-view.ts:162`、`src/client/workbench/views/worldbook-view.ts:232`、`src/client/workbench/views/library-view.ts:129`、`src/client/workbench/views/outline-board.ts:239`
- **证据**：设定/拆书/技法提案以 <pre>JSON.stringify(payload)</pre> 展示；设定档案显示『生效章 ${chapterId}』（UUID）；摘要提案的回退文案也是 documentId。
- **影响**：作者审批提案的成本高，不利于『作者主权门』的逐条把关。
- **建议**：1) 为每类提案写一个轻量渲染器（设定条目卡片：实体/内容/生效点/知情人；伏笔：标题/状态/埋设章；技法：标题/触发条件/步骤）；原始 JSON 放进可折叠的『详情』；2) 章节 ID 一律经 chapterTitles 映射为『第 N 章·标题』；3) 逐条勾选机制从 fact_sync 推广到 setting/technique 提案（需后端支持 selectedIds）。

### FE-26 部分破坏性操作没有确认；SKILL.md 只能粘贴导入

- **严重度 / 类别 / 工作量**：⚪ 低 / 体验 / S
- **位置**：`src/client/workbench/views/outline-board.ts:440-446`、`src/client/workbench/views/worldbook-view.ts:257-276`、`src/client/workbench/views/library-view.ts:74-117`
- **证据**：『删空卷』直接调用 volume.delete；『标记已在当前章回收』直接把伏笔置为 resolved，并以当前打开的章节作为回收章，没有确认；SKILL.md 只能粘贴进 prompt 文本框（上限 128 KiB），不能选文件或文件夹（references/ 子目录无法导入）。
- **影响**：误操作风险；从社区获取的 Skill 文件夹无法按标准结构导入。
- **建议**：1) 删除卷、回收伏笔使用 modal.confirm，并显示目标章节名；2) SKILL.md 导入增加 <input type=file accept=.md> 与 webkitdirectory 文件夹选择，读取 SKILL.md + references/**/*.md|txt 后调用现有 skill.import（保持纯提示词沙箱、≤128 KiB，不做成重型流程）。

### FE-27 全局快捷键的细节问题：保存禁用时 Ctrl+S 会打开浏览器『另存为』，且没有处理输入法组字

- **严重度 / 类别 / 工作量**：⚪ 低 / 缺陷 / S
- **位置**：`src/client/workbench/shell.ts:715-742`
- **证据**：仅在保存按钮可见且可用时才 preventDefault，锁定/冲突状态下按 Ctrl+S 会弹出浏览器保存页面对话框；keydown 没有检查 event.isComposing；Alt+1..4 在部分系统或输入法下有冲突。
- **影响**：作者在定稿章节上习惯性按 Ctrl+S 时会被浏览器对话框打断。
- **建议**：1) Ctrl/Cmd+S 始终 preventDefault，不可保存时显示提示原因（已定稿/版本冲突）；2) 处理器首行 if (event.isComposing || event.keyCode===229) return；3) 在命令面板中列出全部快捷键（可发现性）。
- **参考**：https://developer.mozilla.org/en-US/docs/Web/API/Element/compositionend_event

### FE-28 渲染路径上的小浪费：每次轮询都重建 Blob URL、写 localStorage、序列化全文签名

- **严重度 / 类别 / 工作量**：⚪ 低 / 性能 / S
- **位置**：`src/client/workbench/plugins/toutiao.ts:224-230`、`src/client/workbench/shell.ts:543-548`、`src/client/workbench/views/diff-view.ts:324`、`src/client/workbench/shell.ts:264-282`
- **证据**：头条 renderDocumentSlots 每次 render 都执行 revokeObjectURL + createObjectURL(new Blob(delivery))；writeLastActiveRef 每次 render 都写 localStorage；diffView.update 每次都 JSON.stringify(原稿+候选稿全文) 生成签名；updateBudgetHint 每次 render 都遍历全文估算 token。
- **影响**：单次开销不大，但会在 2s 轮询和长章节下累积，增加 GC 压力与卡顿。
- **建议**：Blob URL 以 exportStatus.hash 为键，变化时才重建；lastActive 只在 active.id 变化时写入；diff 签名改为 candidateId + baseRevisionId + revisionId；预算估算只在 body 或 instruction 变化时重算。

### FE-30 文档与实现不一致：UI 槽位契约和客户端描述已经过时

- **严重度 / 类别 / 工作量**：⚪ 低 / 文档 / S
- **位置**：`docs/framework/02-contracts-and-extensions.md:201-247`、`docs/03-architecture.md:113-123`
- **证据**：02 文档中的 ProductLineUiSession 是 renderHeaderSlot/renderPipelineSlots/renderRunStartExtras，实际代码是 renderDocumentSlots/onDirectoryUpdated/onWorkspaceViewChanged/validateRunStartParams/collectRunStartParams；03 文档仍写 Diff 是『纯段落级 LCS』、主题是『浅色纸面/深色墨石』，没有提到字级 Diff、三套纸面主题、选段微改写、虚拟目录等。
- **影响**：新贡献者与 AI 编码代理会按过时契约开发，增加返工。
- **建议**：1) 用 plugins/types.ts 作为唯一来源：文档只链接类型文件并附简要说明；2) 补全 03 文档客户端表格（14 个视图模块）；3) refactor-v2 增加静态守卫：文档中出现的 Session 方法名必须存在于 types.ts。

### FE-31 本地存储不可用且有未保存修改时，关闭页面没有拦截

- **严重度 / 类别 / 工作量**：⚪ 低 / 体验 / S
- **位置**：`src/client/workbench/draft-vault.ts:92-95`、`src/client/workbench/shell.ts:711-714`
- **证据**：vault.isUnavailable() 为真时只显示一条警告；pagehide 仍然调用 stash()（写入失败），没有 beforeunload 提示；localStorage 中的 zhizhang:draft:* 也没有过期清理。
- **影响**：在隐私模式或存储配额满的极端情况下，可能丢失未保存文字；长期使用后 localStorage 堆积孤儿草稿。
- **建议**：1) 仅当 dirty() && vault.isUnavailable() 时注册 beforeunload，调用 preventDefault；2) 草稿记录写入 savedAt，启动时清理 30 天以上且服务器已有更新修订的条目。

### FE-32 种子技法包分类与技法卡分类表不一致（atmosphere）

- **严重度 / 类别 / 工作量**：⚪ 低 / 正确性 / S
- **位置**：`src/client/workbench/seed-packs.ts:75`、`src/domain/fanqie/library.ts:4-12`、`src/client/workbench/views/library-view.ts:200-205`、`src/application/products/fanqie/library-crud.ts:197`
- **证据**：玄幻种子包的『灵压五感具象化』category='atmosphere'，不在 TECHNIQUE_CATEGORIES 中，也不在前端分类下拉里；后端 technique.save 不校验分类（optionalText），会照样入库。
- **影响**：按分类推荐或筛选时，这张卡会被遗漏；编辑时下拉框显示错误。
- **建议**：1) 要么把 atmosphere 加入分类表（需番茄线确认），要么把种子改为已有分类；2) 后端校验分类（跨视角）；3) 前端分类选项改为由快照或常量模块下发，避免再出现三处不一致。

### FE-34 窄屏与会话侧栏场景：960px 断点按视口宽度判断，不按 iframe 容器宽度

- **严重度 / 类别 / 工作量**：⚪ 低 / 体验 / M
- **位置**：`src/client/workbench.css:1035-1089`、`src/client/workbench.css:207-213`、`src/client/slot.ts:58-63`
- **证据**：布局只在 max-width:960px 时切换为单列，此时流程栏堆叠到正文下方，需要长距离滚动；工作台运行在 iframe 中，在 conversation.view 这种窄容器里通常会触发单列；侧栏不是 sticky，长流程面板会随页面滚走。
- **影响**：在 DsH 会话视图中使用体验较差。
- **建议**：1) 在窄宽度下把流程栏改为可切换的抽屉或底部标签，而不是堆叠；2) 两侧栏 position:sticky; top:52px; max-height:calc(100dvh - 52px); overflow:auto，正文独立滚动；3) browser-check 的视口列表增加 480px 宽。

## 五、分阶段路线图

### P0 快速止血：数据安全与操作可用性（1–2 天）

**目标**：消除静默改稿、假冲突和整页锁死这几类直接威胁作者正文与信任的问题

**包含**：FE-01、FE-02、FE-07、FE-12、FE-06、FE-27、FE-17

**退出标准**：
- [ ] 新增单测：选段改写请求期间修改正文或切章后，『应用替换』被拒绝且正文不变
- [ ] Playwright：AI 替换后点击『撤销替换』恢复原文；Chrome 中 Ctrl+Z 可撤销（execCommand 路径）
- [ ] 模拟 /mutate 挂起 35s：UI 在 30s 内复位并提示可重试；重试 draft.save 复用同一 key，不出现 version.conflict
- [ ] candidateQa 为非法 JSON 时 render 不抛错（单测）
- [ ] 取消勾选→切到 raw→采纳：提交的 adoptionMode 为 partial（单测）
- [ ] 5000 章 Playwright 夹具：任意滚动位置下可见行 top 与 index×36 的偏差 ≤1px
- [ ] npm run verify 与 npm run test:all 全绿，测试计数同步更新

### P1 同步模型与长篇性能（约 1 周）

**目标**：让工作台在长篇和多来源修改（AI 提案、Agent 工具、多标签页）下保持实时、轻量、不丢字

**包含**：FE-03、FE-04、FE-05、FE-21、FE-20、FE-08、FE-09、FE-13、FE-10

**退出标准**：
- [ ] 提交 chapter_review/arc_plan 提案后无需任何操作，≤3s 内自动出现在面板中（FakeLlmTransport 旅程）
- [ ] 其他标签页保存后，本页 ≤15s 内（或切回可见时立即）显示冲突或刷新
- [ ] 650 章与 5000 章夹具：一次 Ctrl+S 的请求数 ≤3，且不触发 tree.get
- [ ] 大纲板编辑摘要时触发刷新，文本保持不变（单测与 E2E）
- [ ] 200 万字 / 3000 章导入成功，分批进度可见，不出现 too-large
- [ ] 向导中途注入失败：错误显示在向导内；『继续』不创建重复项目
- [ ] 部分合稿的空行与换行风格单测通过；三主题 × 深浅系统模式 token 完整性静态测试通过

### P2 架构收口与 Diff 质量（1–2 周）

**目标**：外壳零产品分支、契约强类型、Diff 算法适配中文长段，并为后续重构准备测试安全网

**包含**：FE-14、FE-15、FE-16、FE-18、FE-22、FE-24、FE-29、FE-33、FE-32

**退出标准**：
- [ ] 架构守卫：shell.ts 与通用 views 不含 fanqie/toutiao/微头条 字面量；前端无裸阈值数字，protected-rules 与 domain 值相等
- [ ] request<A extends WorkspaceAction> 覆盖前端调用的全部动作，npm run check 零报错（FE-17 类型化部分）
- [ ] shell.ts <300 行；拆出的 state.ts 有覆盖 seq/epoch/editSequence 的单测
- [ ] Diff 基准：30 段 × 200 字随机改写 <30ms，字级精确率 ≥95%；中间插入一段不会把后续段落标成 changed
- [ ] 热启动静态资源 304 命中率 100%；关键路径 RTT ≤2（Playwright 网络日志）
- [ ] 页脚显示当前段号，『用当前光标段』按钮可以填充 point 输入框
- [ ] browser-check 新增 FakeLlmTransport 生成旅程且 pageerror 为空

### P3 体验打磨与可访问性（持续）

**目标**：达到可长期日更使用的成熟度：键盘可达、可读、窄屏可用、文档一致

**包含**：FE-19、FE-11、FE-23、FE-25、FE-26、FE-28、FE-30、FE-31、FE-34

**退出标准**：
- [ ] 标签页、目录树、命令面板、Diff 全部可以纯键盘完成（Playwright 键盘旅程）
- [ ] 可选的 axe-core 检查在主流程页面无 serious/critical 问题
- [ ] 跟随宿主主题随系统切换即时更新
- [ ] 提案卡片不再出现原始 JSON（可折叠的详情除外），章节显示为标题
- [ ] 480px 宽视口无横向溢出，流程栏以抽屉形式可用
- [ ] docs/03 与 framework/02 的 UI 契约与 types.ts 一致（静态守卫）

## 六、跨视角事项（需要其他视角配合）

- 【后端/DB】快照新增 pendingJobs（异步提案/生成作业）与目录水位 treeSeq；tree.get 支持 ifSequence 返回 unchanged（FE-03/FE-04）
- 【后端/DB】所有作者写命令的幂等键：前端会为每个用户动作传 key，需确认 command_journal 对 draft.save 等动作的重放语义与修剪窗口（FE-07）
- 【DsH 插件】MAX_REQUEST_BYTES=2 MiB 与分批导入协议（importId/part/commit）；或对 import_bundle 单独放宽上限（FE-08）
- 【DsH 插件】静态资源改为 ETag（内容哈希）+ no-cache，HTML 注入 modulepreload 与 ?v=hash，同时解决 mtime 缓存问题（FE-22）
- 【DsH 插件】确认 main 与 conversation.view 是否会同时挂载；iframe 是否需要 allow=clipboard-write；能否通过 postMessage 下发宿主主题（FE-23/FE-11）
- 【DsH 插件】把 DsHPluginConfig.defaultProvider/defaultModel 经快照下发给前端，统一模型选择（FE-24）
- 【后端】RunSummary.candidateQa 改为结构化对象；为前端提供 ActionMap 的输入/输出类型（FE-17）
- 【后端】新增 project.bootstrap 复合动作（项目+卷+章+技法+挂载，单个写事务），向导与示例书改为调用它（FE-09）
- 【契约】新增浏览器安全的 contracts/protected-rules.ts 纯常量模块，domain 与 client 共用（不改数值）（FE-16）
- 【番茄线】技法分类表与种子包对齐（atmosphere），后端 technique.save 校验分类（FE-32）；提案逐条勾选从 fact_sync 推广到 setting/technique（FE-25）；段号可见性直接影响 knownFrom 知情点填写质量（FE-33）
- 【测试基建】dev-server 与 browser-check 增加确定性的 FakeLlmTransport（不联网、不调用真实模型），供前端生成与提案链路回归（FE-29）

## 七、待作者确认

1. DsH 是否会同时渲染 main 与 conversation.view 两个槽位中的工作台？如果会，会话视图是否接受降级为只读预览 + 跳转？
2. 大文件导入希望采用『分批上传 + 最终提交』，还是只通过 writeToDisk/本地目录在宿主侧读取（绕过浏览器上传）？
3. 常驻低频轮询（可见时每 15s，带 ifSequence）是否可以接受？还是希望等 DsH 提供推送通道（SSE/WebSocket）？
4. 受保护阈值改为由 contracts/protected-rules.ts 统一提供（数值不变），是否需要作者另行书面授权？（本报告视为不触及语义）
5. 编辑器是否允许增加轻量段号显示或光标段号提示？是否仍坚持纯 textarea、不引入富文本编辑器？
6. 技法分类 atmosphere 是保留并加入正式分类表，还是改为已有分类？
7. 字级 Diff 的降级上限可以接受多大的主线程耗时（例如 ≤50ms）？是否接受用 Worker 计算（会多一个静态模块）？

## 八、与既有计划的关系

与 docs/zhizhang_v2_2_optimization_plan.md 的关系：该计划 Sprint 1 的前端止血（modal 重入、双通道协调器、CSS 正交变量、shell 去硬编码）、Sprint 3 的字级 Diff、逐段采纳与选段微改写、Sprint 4 的 5000 章虚拟目录、大纲板惰性挂载、书斋、向导与三主题，均已在代码中落地，测试也覆盖了对应的纯函数。本报告不重复这些功能，而是指出落地后的正确性缺口：选段在过期偏移上替换（FE-01）、撤销承诺不成立（FE-02）、虚拟行高与 CSS 不一致（FE-06）、raw 模式吞掉部分采纳（FE-12）、合稿丢空行（FE-13）、中文长段 Diff 降级（FE-14）、深色系统下主题 token 泄漏（FE-10），以及计划没有涉及的同步模型（FE-03/04/05）、网络健壮性与幂等（FE-07）、大文件导入（FE-08）。与 docs/framework/03-migration-roadmap.md 的关系：M4『前端 WorkbenchShell 一体化』已标记完成，但 shell.ts 仍有 971 行，且残留『微头条』兜底与番茄示例书逻辑（FE-15/FE-18），02 文档中的槽位契约也已与代码脱节（FE-30）。建议把 FE-15/16/17/18 作为 M4 的收尾项（M4.1），并为前端增加与后端 refactor-v2 同等级的静态守卫。

## 九、已阅读文件

- `README.md`
- `AGENTS.md`
- `docs/zhizhang_v2_2_optimization_plan.md`
- `docs/framework/03-migration-roadmap.md`
- `docs/03-architecture.md（客户端章节）`
- `docs/framework/02-contracts-and-extensions.md（前端槽位章节）`
- `docs/05-development-and-ops.md（前端相关段落）`
- `src/client/index.ts`
- `src/client/manifest.ts`
- `src/client/slot.ts`
- `src/client/workbench.html`
- `src/client/workbench.css`
- `src/client/workbench/api.ts`
- `src/client/workbench/appearance.ts`
- `src/client/workbench/diff.ts`
- `src/client/workbench/dom.ts`
- `src/client/workbench/draft-vault.ts`
- `src/client/workbench/main.ts`
- `src/client/workbench/modal.ts`
- `src/client/workbench/seed-packs.ts`
- `src/client/workbench/shell.ts`
- `src/client/workbench/store.ts`
- `src/client/workbench/plugins/fanqie.ts`
- `src/client/workbench/plugins/toutiao.ts`
- `src/client/workbench/plugins/types.ts`
- `src/client/workbench/views/command-palette.ts`
- `src/client/workbench/views/context-preview.ts`
- `src/client/workbench/views/diagnostics-panel.ts`
- `src/client/workbench/views/diff-view.ts`
- `src/client/workbench/views/io-view.ts`
- `src/client/workbench/views/library-view.ts`
- `src/client/workbench/views/new-book-wizard.ts`
- `src/client/workbench/views/outline-board.ts`
- `src/client/workbench/views/run-inspector.ts`
- `src/client/workbench/views/selection-microbar.ts`
- `src/client/workbench/views/study-home.ts`
- `src/client/workbench/views/tree-sidebar.ts`
- `src/client/workbench/views/virtual-list.ts`
- `src/client/workbench/views/worldbook-view.ts`
- `src/contracts/workspace-dto.ts`
- `test/client-v2.test.mjs`
- `test/client-views-v2.test.mjs`
- `scripts/browser-check.mjs`
- `scripts/dev-server.mjs`
- `scripts/workspace-bench.mjs`
- `（核对用片段）src/host/plugin.ts 的 requestObject/staticResponse/路由、src/application/context.ts 的 commandInput、src/domain/fanqie/library.ts 的 TECHNIQUE_CATEGORIES、test/sprint1/sprint3/refactor-v2/workbench-c01 的用例清单`
