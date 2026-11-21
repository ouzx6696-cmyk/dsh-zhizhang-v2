# 开发、精简测试体系与安全运维指南（Zhizhang 3.0）

---

## 1. 运行环境要求

- **Node.js**：`>= 22.0.0`（必须支持内置 `node:sqlite` 与原生 `node:test`）
- **TypeScript**：`5.8.3`（唯一开发依赖，用于类型检查与编译构建）
- **运行时依赖**：**零（0）第三方运行时依赖**（由 `npm run preflight` 与架构守卫测试共同锁定）

---

## 2. 常用研发命令

| 命令 | 说明 |
| --- | --- |
| `npm run check` | 只读类型检查（同时校验后端 `tsconfig.json` 与前端 `tsconfig.client.json`，不产出文件） |
| `npm run build` | 编译服务端代码至 `dist/server/`，编译浏览器 ES 模块至 `dist/client/` |
| `npm test` | 运行全部 12 套件精简测试（确定性、纯本地、不联网，耗时 ~3 秒） |
| `npm run verify` | 研发提交前一键闭环：`npm run check && npm test` |
| `npm run dev` | 构建并启动本地预览服务（默认监听 `http://localhost:3000/workbench`） |
| `npm run start` | 直接启动已构建的预览服务（`node scripts/dev-server.mjs`） |
| `npm run docs:schema` | 从当前 `zhizhang/3.0` 真实 SQLite DDL 重新生成 `docs/schema.md` |
| `npm run bench` | 运行工作台与 SQLite/FTS5 性能基准脚本 |
| `npm run preflight` | 发布前环境自检（Node 版本、`node:sqlite`、零运行时依赖） |
| `npm run deploy:touch` | 验证 DsH 部署包结构与触发文件（dry-run / touch-only） |

---

## 3. 精简高效的 12 套件测试体系

测试体系严格拒绝重复取证夹具与脆弱的文档表格校验，全部测试收拢为 **`test/` 目录下 12 个高信噪比 `node:test` 文件**，共用测试夹具统一置于 `support/harness.mjs`（遵守 Node 测试发现规则，不污染用例计数）：

| 套件 | 覆盖维度 |
| --- | --- |
| `test/01-contracts-protected.test.mjs` | 受保护常量不变式、前端镜像逐字一致性、`ContractError`、审批门禁、零运行时 DTO 校验、3.x Schema 窗口 |
| `test/02-domain-fanqie.test.mjs` | 番茄章节审稿流转与 2 次打回上限、设定区间与角色知情点、重排冲突、段落锚点、伏笔/技法排序、AI 腔与黄金三章诊断 |
| `test/03-domain-toutiao.test.mjs` | 头条 34 字标题上限、微头条无标题约束、84 分 QA 通过线、2 轮回改上限与固定交付尾句 |
| `test/04-storage-fts.test.mjs` | `zhizhang/3.0`（`user_version = 30`）洁净建表、命令幂等日志、事件归类审计、External Content FTS5 与 2 字 CJK 回退 |
| `test/05-unified-job-kernel.test.mjs` | 统一 `author_jobs` / `author_job_calls` 台账、晚到回执恒等校验、并发锁、`HostJobEngine` 全链路执行与有界卸载排空 |
| `test/06-app-fanqie-workflow.test.mjs` | 番茄端到端作者流程（卷幕章建构 → 连续性 → 挂载与上下文预估 → 生成采纳 → 审稿 → 定稿锁定） |
| `test/07-app-toutiao-workflow.test.mjs` | 头条端到端作者流程（策划 → QA 84 → 验收 → 审批 → 交付与断网重启续传、微头条限制、2 轮自动回改熔断） |
| `test/08-host-plugin-tools.test.mjs` | `applyWorkbench` Next-Gen HTTP 路由、静态清单、安全响应头（CSP / nosniff / Referrer-Policy）、脱敏 `/diag`、11 个声明式 Agent 工具边界 |
| `test/09-client-core.test.mjs` | 段落/字级 Diff 与局部勾选合并、`draft-vault` 草稿保险箱、`renderGate` 竞态防抖、划词重定位、`api.ts` 路由分发 |
| `test/10-client-workbench.test.mjs` | `workbench.html` 三区布局与挂载点、`CLIENT_JS_MODULES` 清单完备性、零原生弹窗与零原始 HTML 注入守卫、统一基础组件与 `JobCenter` 交互 |
| `test/11-backup-and-io.test.mjs` | 在线热备份 / 离线冷备份、SHA-256 篡改检测、非空恢复目录拒绝、保留策略修剪、整书包导入导出、Skill 导入与原子交付路径约束 |
| `test/12-architecture-guards.test.mjs` | 跨层依赖红线、双产品线隔离、`host/tools.ts` 产品无关性、交付尾句单一定义、零运行时依赖与测试目录洁净守卫 |

---

## 4. 安全边界、数据备份与运维诊断

### 默认内置防护边界

- **文件与目录路径约束**：交付文件写入（`src/host/delivery-io.ts`）、本地整书包导出（`src/storage/local-io.ts`）与备份校验恢复（`src/storage/backup.ts`）均强制校验文件名合法性并锁定在目标根目录内，避免意外越界写入。
- **前端 DOM 渲染与浏览器头防护**：所有前端视图采用纯 DOM 节点创建（全前端零 `innerHTML`），静态资源与 API 响应统一启用 `Content-Security-Policy`（`default-src 'self'`）、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer` 与 `Cache-Control: no-store`。
- **请求校验与异常脱敏**：所有写入型 `POST` 接口强制校验 `application/json` 类型与请求体上限（`2 MiB`）；非预期异常仅返回关联 `diagnosticId`，不暴露内部堆栈与本机路径。

### 数据备份与恢复（`src/storage/backup.ts`）

- **在线热备份（`createHotBackup`）**：直接基于活跃 SQLite 连接执行在线备份，写入目标目录并生成带 SHA-256 的清单文件，不阻塞读者。
- **离线冷备份（`createBackup`）**：对已关闭的数据库文件执行 WAL 检查点校验与流式 SHA-256 备份。
- **安全恢复（`restoreBackup` / `restoreWorkspace`）**：先逐文件校验 SHA-256 清单与目标目录路径约束，并强制拒绝向非空目录静默覆盖（`restore-target-not-empty`），保护现有手稿。
- **自动修剪（`planRetention` / `pruneBackups`）**：按保留份数清理旧备份，并保证**永远不删除最后一份有效备份**。

### 运行时诊断（`GET /api/zhizhang/diag`）

诊断端点返回脱敏 JSON 摘要，包含：
- 当前版本号（`3.0.0`）、Schema ID（`zhizhang/3.0`）与 `user_version`（`30`）
- 统一作业各类型活跃计数与用量对账一致性问题数
- Agent 工具注册状态
- 严格脱敏：不返回任何 API 密钥、环境变量、本机目录路径或正文原文
