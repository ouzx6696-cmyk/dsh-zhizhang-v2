# 宿主与接口

织章以 DsH Web 插件运行。服务端注册 HTTP 路由、模型作业、Agent 工具和系统提示，客户端挂载侧栏、会话工作台和设置入口。DsH 契约集中在 `src/host/dsh-adapter.ts` 和 `src/host/dsh-tools-adapter.ts`。

## HTTP

接口前缀为 `/api/zhizhang`。成功响应包含 `ok` 和 `result`，错误响应包含稳定的 `code` 与适用的 `details`。非预期错误返回 `diagnosticId` 供日志关联。

| 入口 | 用途 |
| --- | --- |
| `GET /state` | 读取作品和稿件状态。支持 `projectId`、`documentId`、`ifSequence`。 |
| `POST /command` | 执行 JSON 命令，经 `action` 分派。版本敏感写入使用当前 `baseRevisionId`，幂等写入携带 `key`。 |
| `GET /jobs`，`POST /jobs/preview`、`/jobs/start`、`/jobs/cancel` | 限额预览、模型作业调度、取消与回执。 |
| `GET /settings`、`GET /diag` | 查询默认模型配置、宿主注册状态和诊断。 |

在 `project.import_bundle` 中，较小的集成请求可直接发送 `files`。分段上传时各段携带同一个 `uploadId`，加上 `chunkIndex`、`chunkCount` 与 `chunk`。全部到齐后发送 `{uploadId, commit: true}`。工作台将大书拆段以满足单次请求上限，回执可用于重试。项目导出同样使用 `project.export_bundle`，纯正文用 `format: "final_text"`。

## Agent

会话绑定作品后，Agent 按需读当前稿、章节树、设定、上下文与技法。系统提示提供焦点和索引，完整资料通过相应工具取得。

- `zhizhang_read_context` 接收 `previousVersionId`，返回确定的接续来源。
- `zhizhang_submit_draft` 提交正文，可记录所用的上章版本。
- `zhizhang_patch_paragraphs` 按从 1 开始的段落编号局部修稿。传入 `baseCandidateId` 可在当前待审候选上修订，结果仍待作者采纳。
- 头条 Agent 可以读取稿件和规划标题矩阵。验收、批准和交付由作者完成。

工具名称、字段和校验以 `src/application/author-workspace.ts`、各产品线的 `tools.ts` 与 [命令类型](../src/contracts/dto/core.ts) 为准。
