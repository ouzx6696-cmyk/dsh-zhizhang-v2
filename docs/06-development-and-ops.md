# 06 · 开发指南、14 套件测试体系与安全运维（Zhizhang 3.1）

---

## 1. 运行环境与研发门禁

- **Node.js**：`>= 24.9.0`（使用内置 `node:sqlite` 与原生 `node:test`）
- **TypeScript**：`5.8.3`
- **运行时依赖**：**0 个第三方运行时依赖**（由 `npm run preflight` 与 `test/12-architecture-guards.test.mjs` 双重锁定）

| 命令 | 说明 |
| --- | --- |
| `npm run check` | 只读类型检查（同时校验后端 `tsconfig.json` 与前端 `tsconfig.client.json`，零构建副作用） |
| `npm run build` | 编译服务端代码至 `dist/server/`，浏览器 ES 模块至 `dist/client/` |
| `npm test` | 运行 `test/` 下全部 14 套件精简测试（确定性、纯本地、不联网，耗时 ~4 秒） |
| `npm run verify` | 提交前一键闭环：`npm run check && npm test` |
| `npm run dev` | 构建并启动本地预览服务（默认 `http://localhost:3000/workbench`） |
| `npm run start` | 直接启动已构建服务（`node scripts/dev-server.mjs`） |
| `npm run docs:schema` | 从当前 `zhizhang/3.0` 真实 SQLite DDL 重新生成 `docs/schema.md` |
| `npm run bench` | 运行工作台与 SQLite/FTS5 性能基准 |
| `npm run bench:strict` | 运行长篇基准，性能门槛未通过时返回失败 |
| `npm pack` | 重新构建并生成可安装的 DsH Bundle |
| `npm run preflight` | 发布前环境自检（Node 版本、`node:sqlite`、零运行时依赖） |
| `npm run deploy:touch` | 刷新构建产物时间戳 |

---

## 2. 14 套件高信噪比测试体系

`test/` 目录下严格仅存放 14 个 `*.test.mjs` 文件，共用夹具统一置于 `support/harness.mjs`（避免污染 Node 测试发现计数）：

| 套件 | 验证焦点 |
| --- | --- |
| `01-contracts-protected.test.mjs` | 受保护常量、浏览器镜像逐字一致性、`ContractError`、审批门禁、零运行时 DTO、3.x Schema 窗口 |
| `02-domain-fanqie.test.mjs` | 番茄审稿流转与 2 次打回上限、设定区间与角色知情点、重排冲突、段落锚点、伏笔/技法排序、AI 腔与黄金三章诊断 |
| `03-domain-toutiao.test.mjs` | 头条 34 字标题上限、微头条无标题约束、84 分 QA 通过线、2 轮回改上限与固定交付尾句 |
| `04-storage-fts.test.mjs` | `zhizhang/3.0`（`user_version = 30`）洁净建表、命令幂等日志、事件归类审计、External Content FTS5 与 2 字 CJK 回退 |
| `05-unified-job-kernel.test.mjs` | `author_jobs` / `author_job_calls` 台账、晚到回执恒等校验、并发锁、`HostJobEngine` 执行与有界卸载排空 |
| `06-app-fanqie-workflow.test.mjs` | 番茄端到端作者流程（卷幕章 → 连续性 → 挂载与上下文预估 → 生成采纳 → 审稿 → 定稿锁定） |
| `07-app-toutiao-workflow.test.mjs` | 头条端到端作者流程（策划 → QA 84 → 验收 → 审批 → 交付与断网续传、微头条限制、2 轮自动回改熔断） |
| `08-host-plugin-tools.test.mjs` | Next-Gen HTTP 路由、静态清单、安全响应头、`ctx.systemPrompt` 注册与降级、脱敏 `/diag`、23 个声明式 Agent 工具边界 |
| `09-client-core.test.mjs` | 段落/字级 Diff 与局部勾选合并、`draft-vault` 草稿保险箱、`renderGate` 竞态防抖、划词重定位、`api.ts` 路由 |
| `10-client-workbench.test.mjs` | `workbench.html` 布局挂载点、`CLIENT_JS_MODULES` 清单完备性、零原生弹窗与零原始 HTML 注入守卫、UI 原语与 `JobCenter` |
| `11-backup-and-io.test.mjs` | 在线热备份 / 离线冷备份、SHA-256 篡改检测、非空恢复拒绝、保留策略修剪、整书包导入导出、Skill 沙箱导入与原子交付路径约束 |
| `12-architecture-guards.test.mjs` | 六层跨层依赖红线、双产品线隔离、`host/tools.ts` 与 `host/system-prompt.ts` 产品无关、`WorkspaceAction` 100% 零幻影对齐、交付尾句单一定义、零运行时依赖与测试目录洁净守卫 |
| `13-autopilot-ingest-quality.test.mjs` | Quality v2 双轨诊断与段落补丁、互斥技法卡、三阶段非标准材料重写入、分级自治五步流水线回滚、可调上下文参数与一键恢复默认 |
| `14-dsh-agent-cocreation.test.mjs` | `focus.set` / `zhizhang_read_focus`、`ctx.systemPrompt` 渐进披露、Skill 索引→加载→挂载、审慎暂存审批、共创直写与快照回滚、`final`/`已验收` 硬锁与头条规则守护 |

---

## 3. 安全防护、备份恢复与运行时诊断

### 3.1 内置安全边界

- **目录与路径约束**：交付写入（`src/host/delivery-io.ts`）、整书导出（`src/storage/local-io.ts`）与备份恢复（`src/storage/backup.ts`）均校验合法文件名并锁定目标根目录，阻断路径穿越与误覆写。
- **HTTP 与浏览器头防护**：全站启用 `Content-Security-Policy`（`default-src 'self'`）、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer` 与 `Cache-Control: no-store`；所有写入型 `POST` 接口强制校验 `application/json` 与 `<= 2 MiB` 体积上限。
- **脱敏异常与诊断**：非预期错误仅返回 `diagnosticId`；`GET /api/zhizhang/diag` 返回版本（`3.1.0`）、Schema ID（`zhizhang/3.0`）、作业对账统计、`agentToolCount` 与 `systemPrompt` 注册状态，严禁输出密钥、本机路径或正文原文。

### 3.2 热冷备份与安全恢复（`src/storage/backup.ts`）

- **在线热备份（`createHotBackup`）**：基于活跃 SQLite 连接执行在线备份并生成 SHA-256 清单，不阻塞读操作。
- **离线冷备份（`createBackup`）**：对关闭态数据库执行 WAL 检查点校验与流式 SHA-256 备份。
- **安全恢复（`restoreBackup` / `restoreWorkspace`）**：逐文件校验 SHA-256 与路径边界，强制拒绝向非空目录静默覆盖（`restore-target-not-empty`）。
- **保留修剪（`planRetention` / `pruneBackups`）**：按保留份数清理旧备份，并始终保留最后一份有效备份。


## 4. 更新与备份

更新时停止 Web profile，再用 `dsh plugin --profile web add <新包.tgz>` 安装新产物。重启后检查作品、候选、Agent 工具和设置。卸载使用 `dsh plugin --profile web remove @zhizhang/dsh-workbench`，工作区保留在配置的 `dataDirectory`。

停止 profile 后，使用安装包中的 `scripts/workspace-data.mjs backup <工作区> <备份目录>`。恢复到新目录使用 `scripts/workspace-data.mjs restore <备份目录> <新工作区>`，随后将插件 `dataDirectory` 指向恢复后的目录。当前支持 `zhizhang/3.0`，启动会补齐当前版本所需的表。
