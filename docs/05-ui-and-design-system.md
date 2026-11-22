# 05 · 前端「素纸朱印」设计体系与交互规范（Zhizhang 3.0）

织章前端位于 `src/client/`，采用**零第三方前端框架、原生 TypeScript ES 模块、纯 CSS 变量体系**构建，面向长时间中文深度创作与 DsH 对话伴生审阅场景。

---

## 1. 视觉美学：「素纸朱印 · Contemporary Editorial Atelier」

设计放弃廉价胶囊标签堆砌与高饱和霓虹渐变，以宣纸质感层次、克制朱砂印章点缀与稳定编辑排版营造书房专注感：

- **三套护眼纸面主题（`appearance.ts` + `workbench.css`）**：
  1. `墨纸（ink-paper）`：宣纸暖白底（`#FAF7F2`）× 靛蓝墨色正文（`#1F242D`）× 朱印点缀（`#C23B2B`），默认日间纸感主题。
  2. `青简（bamboo）`：竹青宣纸底（`#F2F6F1`）× 松烟深绿正文，舒缓长时间阅读视觉疲劳。
  3. `夜航（night）`：低眩光深蓝炭黑底（`#131720`）× 暖白墨字，支持跟随操作系统 `prefers-color-scheme` 自动切换，并可独立调节正文排版字号与行距。
- **字体与数字对齐**：标题与章节名使用编辑衬线体（`--font-editorial`），控件与界面元信息使用清晰无衬线体，字数/分数/Token 统一使用 `font-variant-numeric: tabular-nums`（`.tabular`）防止实时计数抖动。

---

## 2. 统一基础组件原语（`src/client/workbench/ui/primitives.ts`）

所有视图（书斋首页、三步开新书向导、Agent 伴生面板、作业中心、拆书/技法库、模态框与顶栏）严格复用四类统一无依赖原语：

| 原语 | 导出函数 | 规范与交互 |
| --- | --- | --- |
| **Button** | `createButton` | 四档语义（`primary` / `secondary` / `ghost` / `danger`）、三档尺寸（`sm` / `md` / `lg`）；统一 `8px` 圆角；指针按下与键盘 `Enter`/`Space` 一致触发 `data-pressing="true"` 微压缩反馈（尊重 `prefers-reduced-motion`） |
| **Input** | `createInput` | 覆盖单行输入、多行文本域与下拉框；统一 `8px` 圆角、聚焦光环与无障碍校验态（`aria-invalid` / `setError`） |
| **Card** | `createCard` | 四档层次（`default` / `elevated` / `interactive` / `subtle`）；统一 `12px` 圆角、抬头右对齐操作槽与四级阴影阶梯 |
| **Navbar** | `createNavbar` / `enhanceNavbar` | 三区编辑顶栏（品牌与面包屑 · 中央六视图分段导航 · 右侧外观与快捷动作），支持滚动抬升态 `data-scrolled="true"` |

---

## 3. 空间架构：六视图一体书房 + `?view=conversation` 窄栏伴生分屏

### 3.1 `main` 全宽工作台（三栏布局）

1. **顶栏（`header.top`）**：左侧品牌与面板折叠按钮；中央切换六大工作视图——**写作 / 卷幕大纲 / 设定库 / 拆书库 / 技法卡 / 导入导出**；右侧提供主题外观弹出层、全局检索/跳转命令面板入口。
2. **左栏（`#navigation`）**：作品切换与新建、番茄三级卷/幕/章树状导航（虚拟高度优化 + 滚动摘要）或头条篇目列表。
3. **主画布（`.canvas`）**：
   - **书斋冷启动首页（`study-home.ts`）**：最近写作一键续写、三步开新书向导（预装 7 套题材起步包）、一键导入示例书（`灰塔长夜`）、按产品线筛选书架。
   - **写作主稿区**：顶部承载 **共创直写变更/一键回滚横幅（`#agent-write-banner`）**、**交办 Agent 状态条（`#agent-handoff-strip`）**、修订冲突横幅与正文编辑区；编辑器内划词弹出微操作浮条（首位即「交给 Agent 改写」）；下方并排提供段落/字级 Diff 审阅区（支持整章采纳或勾选段落合并）。
   - **其余五大视图**：卷幕大纲与指南针、动态设定库与伏笔/冲突预警、拆书库与技法卡（含「带此技法交办 Agent」与 `SKILL.md` 导入）、本地目录/JSON 资产包导出与三阶段非标准材料重写入工作台。
4. **右栏（`#pipeline`）**：4 个协同面板 tab——**共创（默认主 tab） / 流转 / 规划 / 设定**。
   - **共创 tab**：顶部常驻 **Agent 共创伴生面板（`agent-companion.ts`）**（按书切换审慎/共创模式、产品线一键交办 Agent 快捷动作、待审提案跳转、渐进披露系统提示词预览与开关）；下方可折叠展开 **内置直连批处理兜底引擎（`#fallback-engine-drawer`）**（单章直连生成、自治多章连跑、统一作业中心）。
   - **规划 / 设定 / 流转 tab**：章纲与上下文预算/调参预览、角色知情视角查询与设定审批、离线双轨诊断（黄金三章 + AI 腔 + Quality v2）与章节审稿定稿流转。

### 3.2 `?view=conversation` 对话伴生分屏模式

当 DsH 在对话窗口右侧以窄栏（例如 `480px` 宽）嵌入 `/workbench?view=conversation` 时，`body.view-conversation` 自动：
- 收起左栏目录与多余装饰控件，聚焦当前章节编辑/Diff 审阅区与 Agent 共创伴生面板；
- 保持水平零溢出（`overflow-x` 无横向滚动条），所有交办动作优先通过 `window.parent.postMessage({ type: "zhizhang:handoff", ... })` 推送至 DsH 对话宿主并同步复制剪贴板兜底。

---

## 4. 快捷键、数据保护与安全硬红线

### 全局快捷键（`shell.ts`）

| 快捷键 | 功能 |
| --- | --- |
| `Cmd / Ctrl + S` | 立即保存当前章节或文章正文 |
| `Cmd / Ctrl + K` | 打开快速跳转命令面板 |
| `Cmd / Ctrl + Shift + F` | 打开全书 FTS5 全文检索面板 |
| `Cmd / Ctrl + \` | 一键收起/展开左右侧栏进入沉浸模式 |
| `Alt + 1 / 2 / 3 / 4` | 快速切换右栏 4 个协同 tab |

### 数据保护与前端安全红线

1. **本地草稿保险箱（`draft-vault.ts`）**：所有未保存正文按 `documentId` 防抖暂存本地存储；若服务端修订号变化触发 `version.conflict`，顶部弹出无阻塞冲突条，提供「复制本地稿」与「确认采用服务器版本」，绝不丢失手稿。
2. **零原始 HTML 注入**：全前端（`src/client/**/*.ts`）严禁出现 `innerHTML`、`outerHTML`、`insertAdjacentHTML` 与 `document.write`，全部使用 `el()` 与安全 DOM 原语构造节点（由 `test/10-client-workbench.test.mjs` 自动守卫）。
3. **零原生阻塞弹窗**：严禁调用 `window.alert`、`window.confirm`、`window.prompt`，全部确认与输入交互统一走无障碍 `<dialog>` 模态控制器（`modal.ts`）。
4. **CSP 与模块白名单**：仅加载 `src/client/manifest.ts` 显式声明的 ES 模块，配合服务端 `Content-Security-Policy: default-src 'self'` 杜绝越权资源加载。
