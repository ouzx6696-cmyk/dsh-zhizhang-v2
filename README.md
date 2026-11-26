# 织章

织章是 DeepSeek Harness Web 的写作插件，支持番茄长篇与今日头条。作者在书房管理正文、章纲和设定，也可以在 DsH 对话里交办写作，再回工作台逐段采纳。

## 安装与更新

兼容 DsH Web `0.2.2-rc.5` 和 Node.js 24.9+。从 [GitHub Releases](https://github.com/ouzx6696-cmyk/dsh-zhizhang-v2/releases/latest) 下载 `zhizhang-dsh-workbench-*.tgz` 和 `SHA256SUMS`。在安装包所在目录执行下列命令。更新前先停止 Web profile。

```sh
sha256sum -c SHA256SUMS
dsh --profile web --dump-config
dsh plugin --profile web add ./zhizhang-dsh-workbench-3.3.0.tgz
dsh --profile web --host 127.0.0.1 --port 3080
```

启动后从 DsH 侧栏进入「织章」。在对话里打开织章面板，选定作品和稿件，再将交办指令送入当前会话。默认工作区是 `$DSH_HOME/zhizhang-v3`，也可以在插件设置中指定 `dataDirectory`。

## 文档

| 要做的事 | 入口 |
| --- | --- |
| 创建作品、开始共同写作、接续和采纳 | [作者工作流](docs/01-overview.md) |
| 了解目录职责、数据读写和作业恢复 | [架构与数据](docs/02-architecture.md) |
| 对接 DsH、了解命令和 Agent 工具 | [宿主与接口](docs/03-workflow-and-protocol.md) |
| 判断番茄上下文、设定和头条规则 | [创作规则](docs/04-methodology-and-rules.md) |
| 找到工作台页面和交互约定 | [工作台导航](docs/05-ui-and-design-system.md) |
| 开发、备份、恢复、打包和发布 | [开发与运维](docs/06-development-and-ops.md) |
| 查询 SQLite 表、字段和索引 | [数据库结构](docs/schema.md) |

本地开发使用 `npm ci`、`npm run verify` 和 `npm run dev`。本地预览可操作稿件和手动演练候选采纳，模型作业由 DsH 宿主提供。
