# 05 · 开发、验收与运维指南

本文档面向参与开发的工程师与日常维护数据的作者/运维人员，提供从环境初始化、双管线构建、本地预览、全量测试到打包部署和离线灾备恢复的完整实操手册。

---

## 一、环境准备与依赖安装

### 1. 工具链版本要求（对应 [package.json](../package.json)）
- **Node.js**：`>=24.15.0`（支持内置 TypeScript 类型擦除直接运行 `.ts` 源码）
- **npm**：`>=11.0.0`
- **TypeScript**：`5.8.3`（锁定在 `package-lock.json`，全项目**零运行时第三方依赖**）

### 2. 初始化安装
```bash
npm ci --ignore-scripts
```
> **Windows PowerShell 说明**：若当前系统 PowerShell 执行策略禁止加载 `npm.ps1`，请将下文所有 `npm` 命令替换为 `npm.cmd`（例如 `npm.cmd ci --ignore-scripts`、`npm.cmd run verify`）。

---

## 二、TypeScript 检查与双管线构建

项目拆分为两条独立的严格 TypeScript 编译管线，利用 [src/node-builtins.d.ts](../src/node-builtins.d.ts) 声明 Node 24 内置模块与 Web 标准全局类型（无需安装 `@types/node`）：

| 配置文件 | 目标环境 | 输出位置 | 覆盖范围与说明 |
| --- | --- | --- | --- |
| [tsconfig.json](../tsconfig.json) | Node 24 (`NodeNext`) | 不发射文件 (`noEmit`) | 后端只读静态检查（供 `npm run check` 使用） |
| [tsconfig.build.json](../tsconfig.build.json) | Node 24 (`NodeNext`) | `dist/`（含 `.d.ts`） | 编译宿主插件、应用服务、领域、存储与工作流模块为原生 ESM |
| [tsconfig.client.json](../tsconfig.client.json) | 浏览器 (`ESNext` + DOM) | `dist/client/` | 编译 `src/client/slot.ts` 与 `src/client/workbench/**/*.ts` 浏览器 ESM 模块 |

常用构建与检查命令：

```bash
# 仅执行只读严格类型检查（不写入任何产物）
npm run check

# 全量编译后端与浏览器前端至 dist/
npm run build
```

---

## 三、本地开发预览服务器

无需启动完整 DsH 宿主即可在本地浏览器直接调试工作台 UI 与前后端完整交互：

```bash
# 1. 必须先构建前端模块到 dist/client/
npm run build

# 2. 启动本地 HTTP 预览服务（默认端口 3000）
npm run dev
```

启动后访问：`http://localhost:3000/workbench`。

### 环境变量与行为差异

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址（安全默认仅监听本机回环；仅在明确可信局域网场景才显式覆盖） |
| `ZHIZHANG_DATA_DIR` | 未设置（纯内存 `:memory:`） | 设置为本地路径时，持久化读写 `<dir>/workspace.sqlite` 并在 `<dir>/deliveries/` 写入交稿 `.md` |

> **预览环境限制**：[scripts/dev-server.mjs](../scripts/dev-server.mjs) 不挂载真实 DsH LLM 传输，调用 `run.generate` 时会返回 `gate.denied (preview-no-llm-transport)`；你可以通过工作台「候选」页签的**「手动导入候选稿」**完整体验差异对照、采纳、QA、批准与本地 Markdown 交稿流程。

---

## 四、自动化测试架构与专项验证矩阵

项目测试体系采用**「共享夹具底座（`support/`）+ 分层无跳过离线回归（`test/`）+ 专项基准/浏览器验收（`scripts/`）」**六层结构，全部基于 Node 24 内置测试运行器 `node --test`，**100% 离线确定性执行、零外部网络与模型费用、严格遵守 [AGENTS.md](../AGENTS.md) 测试目录布局规则**：

- **共享测试基础设施（`support/`，严禁放进 `test/`）**：
  - [support/a01.mjs](../support/a01.mjs)：历史取证与冻结契约共用基础断言、叙事锚点原语及临时目录包装（由 [test/support-a01.test.mjs](../test/support-a01.test.mjs) 固定）；
  - [support/v2-harness.mjs](../support/v2-harness.mjs)：V2 统一测试底座（Windows 安全的 SQLite/WAL 多连接句柄生命周期管理器 `createTestWorkspace`、支持异步门控与中止信号的剧本化 LLM 传输 `createScriptedLlm`、mock DsH Cordis 宿主适配器 `createMockDsHHost`、浏览器双存储与全局对象临时注入器 `createMemoryStorage`/`withBrowserGlobals` 及 `ContractError` 断言），由 [test/support-v2.test.mjs](../test/support-v2.test.mjs) 固定。

### 1. 分层离线测试套件（`node --test`）

| 命令 | 测试范围 | 文件数 | 用例数 | 覆盖职责与说明 |
| --- | --- | :---: | :---: | --- |
| `npm run test:contracts` | `*-d02`、`*-w02` | 14 | 147 | **冻结契约合规**：存储格式窗口、命令幂等账本、事件日志、冷启动恢复、运行状态机、预算守卫与交稿批准门 |
| `npm run test:v2` | `*-v2`、`smoke` | 9 | 61 | **V2 应用与全栈测试**：工作区核心流程、宿主 Cordis 插件 HTTP/SSE 状态流、LLM 单次传输与自动回改、双线深度边界、离线灾备恢复、前端无浏览器单测与静态架构守卫 |
| `npm run test:host` | `host-plugin-v2`、`generation-v2`、`backup-v2` | 3 | 16 | **宿主、传输与灾备专测**：`/workbench`/`/state`/`/mutate` CSP 与状态码映射、202 异步生成与取消、`export.conflict` 与重启恢复、SHA-256 整库备份还原与防篡改 |
| `npm run test:client` | `client-v2` | 1 | 5 | **前端无浏览器单元测试**：`DraftVault` 多标签 owner 隔离与慢保存恢复、大型段落 LCS `computeParagraphDiff`、`apiRequest` 错误汉化、`slot.ts` 三槽位注入、`workbench.html` 全量 ID/页签/Manifest 静态契约校验 |
| `npm run test:arch` | `smoke`、`refactor-v2` | 2 | 13 | **架构边界与布局守卫**：全仓库 `.ts` 递归依赖隔离（双产品线/宿主/存储/客户端零越界）、`workspace-dto.ts` 纯类型零运行时校验、`AGENTS.md` 目录纯净度、`manifest`/`package.json`/`cordis.patch.yml` 一致性 |
| `npm test` | `test:contracts` + `test:v2` | 23 | 208 | **日常核心回归** |
| `npm run test:evidence` | `*-?01.test.mjs` | 26 | 173 | **历史规则取证**：固定录存 v1.x 规则裁决证据与原始对照行为 |
| `npm run test:all` | `test/*.test.mjs` | 49 | 381 | **发版前全量验收**：核心 + 取证全覆盖（无跳过、总数精确等于 `test` + `test:evidence`） |
| `npm run verify` | `check` + `npm test` | 23 | 208 | **日常开发必跑门禁** |

> **测试目录布局规范（[AGENTS.md](../AGENTS.md)）**：`node --test` 默认把 `test/` 下所有 `.mjs` 文件计为测试文件，因此多夹具共享辅助工具严格位于 `support/` 下，且由 [test/refactor-v2.test.mjs](../test/refactor-v2.test.mjs) 自动化断言 `test/` 目录内仅存在 `*.test.mjs` 文件。

### 2. 专项验证脚本

```bash
# 1. 确定性模型传输回放验证（3000字长图文 + QA + 1轮回改 + 4类令牌 + 超预算 + 缺失回执）
npm run test:model

# 2. 650章万字与100条历史万字候选快照体积与延迟基准
npm run test:bench

# 3. Playwright 浏览器端三旅程端到端验收（需先执行 npm run build）
npm run test:browser
```

- **性能基线红线（`workspace-bench.mjs`）**：首次打开 650 章万字小说快照须 `< 100 KiB`；叠加 100 条万字舍弃候选历史后须 `< 150 KiB`（当前实测分别约 `74.7 KiB` 与 `75.3 KiB`，中位响应 `< 1.1 ms`）。
- **浏览器端三旅程（`scripts/browser-check.mjs`）**：在独立 Playwright Chromium 中加载真实编译后的前端 JS，依次验证：
  1. **慢保存防丢字与多标签冲突保护**（保存期间继续键入不被覆盖、刷新恢复、第二标签页冲突保留本地稿）；
  2. **番茄连载多人物知情与冻结输入到定稿**（多人物不同章节段落知情、失效段落边界、任务冻结设定隔离、审稿到定稿）；
  3. **头条改题、质检、版本批准到交稿导出**。
  - 可通过环境变量 `ZHIZHANG_PLAYWRIGHT` 与 `ZHIZHANG_CHROMIUM` 指向本机已安装的 Playwright 模块与 Chromium 可执行文件。

---

## 五、打包与 DsH Web 安装部署

### 1. 构建与生成发布包
```bash
npm ci --ignore-scripts
npm run verify
npm run test:all
npm run build
npm pack --ignore-scripts
```
执行后会在根目录生成安装包 `zhizhang-dsh-workbench-2.1.0.tgz`（包含 `dist/`、`src/client/workbench.html`、`src/client/workbench.css`、`src/bundle/cordis.patch.yml`、`src/bundle/locale/`、`docs/`）。

### 2. 在 DsH Web `0.2.2-rc.4` 中安装运行
1. 打开 DsH Web 插件管理器 → **添加插件** → 选择本地包 `zhizhang-dsh-workbench-2.1.0.tgz`，启用 **织章工作台**。
2. 从 DsH 左侧面板点击 **织章**（`sidebar.panellist`），或在会话视图选择 **织章**（`conversation.view`）进入工作台。
3. **运行时数据布局**（默认位于 `DSH_HOME/zhizhang-v2/`）：
   - `workspace.sqlite`：全部项目、章节、修订、候选、设定、事件、读模型检查点与任务调用账本；
   - `deliveries/<documentId>.md`：头条交稿导出的原子 Markdown 文件。

---

## 六、离线备份、校验与灾备恢复

> **重要前提**：执行任何备份、恢复或整库搬运前，**必须先停止对应的 DsH profile**，确保无写入句柄占用 `workspace.sqlite`。

仓库提供基于 SHA-256 清单校验的离线运维工具 [scripts/workspace-data.mjs](../scripts/workspace-data.mjs)（底层调用 [src/storage/backup.ts](../src/storage/backup.ts)）：

```bash
# 1. 创建完整备份（目标必须是全新的空目录）
node scripts/workspace-data.mjs backup <原数据目录> <全新备份目录>

# 2. 校验并恢复到全新数据目录
node scripts/workspace-data.mjs restore <备份目录> <全新数据目录>
```

### 机制与安全保障
- **备份内容与清单（`backupWorkspace`）**：将宿主数据库 `workspace.sqlite` 复制为备份目录内的 `work.db`，遍历 `deliveries/` 下所有 UUID 命名的 `.md` 文件一并拷贝，并计算所有文件 SHA-256 摘要与库 `schema` 写入 `manifest.json`。
- **强校验与映射恢复（`restoreWorkspace`）**：
  1. 逐项校验 `manifest.json` 结构、所有文件存在性及 SHA-256 哈希（任意字节被篡改或缺失文件立即拒止为 `storage.format_unsupported`）；
  2. 打开 `work.db` 验证 `zhizhang/2.x` Schema 窗口并运行 `PRAGMA quick_check;` 确认数据库页完整；
  3. 写入全新的 `target` 目录（权限 `0o700`）并将 `work.db` 映射恢复为宿主所需的 `workspace.sqlite`；建议先在隔离 DsH profile 中打开验证，确认无误后再切换，原目录可随时用于回退。
- **保留策略保障（`planRetention` / `pruneBackups`）**：清理旧备份时，若某次清理会导致有效备份数量归零，系统强制保留最新的一份有效备份并在 `refused` 字段记录拒删原因。

---

## 七、常见故障与诊断排查速查

工作台出错时若提示含 **诊断号（`diagnosticId`）**，作者可点击横幅「复制诊断号」配合下表定位原因：

| 错误码 / 提示原因 (`reason`) | 成因定位 | 作者 / 运维处置步骤 |
| --- | --- | --- |
| `version.conflict` | 编辑器基准修订落后于数据库（多标签页修改或操作顺序交错），或章序重排期间项目 `asOfSeq` 发生变更 | 页面已保留本地编辑并弹出冲突横幅：点「查看服务器最新正文」对照 → 「复制本地稿」留存 → 手动合并或「使用服务器版本」；章序调整需重新刷新后重试 |
| `gate.denied` · `generation-needs-reconciliation` | 上一次生成任务在模型调用中途（`inflight`）断电/崩溃，存在 `uncertain` 尝试未核对用量 | 在流程「候选」页签查看待对账任务详情，登录 DsH 账单核实实际消耗令牌数，填入「确认用量对账」表单提交即可解锁后续生成 |
| `gate.denied` · `export.conflict` | 交稿记录已在库中提交为 `已交稿`，但目标目录已存在同名 `.md` 且内容与本次获批版本不同 | 先点击页面「下载获批 Markdown」留存，随后检查 `deliveries/<documentId>.md` 移走或重命名冲突文件，再点「重试或检查导出」 |
| `budget.exhausted` | 输入预留超预算，或生成/自动回改累积总令牌超出任务设定额度 | 发起前点击「按当前修订核算」采用建议总额（含输出与回改余量）；已失败任务可调整策略后新建或重新创建更高预算任务 |
| `usage.uncertain` | 配置费用上限时费率未知，或 LLM 流结束未返回合规 4 元组用量 | 核对 DsH 模型提供方配置与流式回调日志，并在工作台对账表单补录真实用量 |
| `gate.denied` · `setting-is-locked` | 试图批准的新设定提案与已有已锁定（`locked: true`）设定编号冲突 | 保留原锁定设定，或为新变更启用新的设定编号 |
| `storage.format_unsupported` | 数据库文件损坏、缺少 `meta` 行、或属于 v1.x / 3.x 非 `zhizhang/2.x` Schema | 停止 profile 后使用最近通过 `verifyBackup` 的离线备份恢复到全新目录，切勿强行手工修改 `meta` 表 |
