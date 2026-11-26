# 开发与运维

## 本地开发

使用 Node.js 24.9+ 和 npm 10+。依赖按锁文件安装。

| 命令 | 用途 |
| --- | --- |
| `npm run preflight` | 核对 Node.js、SQLite 和依赖配置 |
| `npm run verify` | 类型检查及本地回归测试 |
| `npm run dev` | 构建并启动工作台预览 |
| `npm run bench:strict` | 工作台负载、长篇导航、全文搜索和保存性能门槛 |
| `npm run docs:schema` | 从当前建表逻辑生成数据库文档 |
| `npm pack` | 构建并生成 DsH 可安装包 |

回归测试按业务入口组织，重点覆盖作者修订与锁定、候选采纳、自治暂停与续跑、提案版本校验、交付和备份恢复。模型调用使用固定回执。真实 DsH 验收检查安装、侧栏、会话与工具注册。

## 备份与恢复

关闭 DsH Web profile 后执行以下命令。备份目标和恢复目标均使用新目录。恢复后在插件设置中把 `dataDirectory` 指向新工作区。

```sh
node scripts/workspace-data.mjs backup <工作区> <备份目录>
node scripts/workspace-data.mjs restore <备份目录> <恢复目录>
```

备份包含 SQLite 数据与已导出的文件。恢复会检查 SHA-256 和数据库完整性。项目资产包和纯文本的使用场景见 [作者工作流](01-overview.md)。

## 发布

按一个版本更新包清单、运行时诊断和安装示例。运行 `verify`、`bench:strict` 和 `npm pack`，用隔离的 DsH Web profile 安装产物。验收后合入主分支，将发布标签指向合并提交。在 GitHub Release 提供可安装包和对应的 SHA-256。上传附件接口不可用时，可从绑定到固定提交的发布产物分支下载两者。
