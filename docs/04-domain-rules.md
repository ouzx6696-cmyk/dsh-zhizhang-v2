# 受保护业务规则与领域不变量（Zhizhang 3.0）

本文档记录织章全部作者冻结业务语义及核心领域模型。所有受保护业务常量以 `src/contracts/protected-rules.ts` 为**唯一权威定义点**（浏览器侧 `src/client/contracts/protected-rules.ts` 为其逐字镜像），严禁在未经作者显式授权的情况下放宽、收紧或散落重复定义。

---

## 1. 作者受保护核心常量

| 常量 | 冻结值 | 业务含义 | 强制执行位置 |
| --- | --- | --- | --- |
| `TITLE_MAX` | `34` | 头条长文/短文标题最大 Unicode 字符数（含中文、标点、Emoji 按码点计）；微头条禁止设置标题 | `domain/toutiao/title.ts` + `application/products/toutiao/workflow.ts` |
| `QA_PASS_SCORE` | `84` | 头条文章质检（QA）通过分数线（总分 >= 84 且无硬门禁失败项才可进入「待验收」） | `domain/toutiao/qa.ts` + `application/products/toutiao/workflow.ts` |
| `EDITORIAL_REJECTION_LIMIT` | `2` | 番茄单章审稿最多允许打回 2 次，第 3 次打回返回 `gate.denied` | `domain/fanqie/chapter.ts` + `application/products/fanqie/workflow.ts` |
| `QA_REFINEMENT_LIMIT` | `2` | 头条单次生成运行在 QA 未通过时最多自动回改 2 轮，第 3 轮触发硬熔断 | `domain/toutiao/qa.ts` + `application/products/toutiao/index.ts` |
| `DELIVERY_ENDING` | `——AI 到此止步。是否采用、何时发布由你决定。` | 头条最终交付 Markdown 末尾强制附加的作者主权声明尾句 | `domain/toutiao/delivery.ts` |

---

## 2. 双产品线状态机

### 番茄章节状态（`CHAPTER_STATES`）

| 状态 | 含义 | 允许流转 |
| --- | --- | --- |
| `planned` | 已建章待动笔 | 保存正文 → `drafting` |
| `drafting` | 草稿撰写中 | 保存正文保持 `drafting`；采纳候选或发起审稿 |
| `drafted` | 已有成稿待审 | 审稿通过 → `reviewed`；审稿打回（<= 2 次）保持 `drafted` |
| `reviewed` | 审稿通过待定稿 | 定稿（`draft.finalize`）→ `final`；继续保存正文 → `drafted` |
| `final` | 已定稿锁定 | **终态锁定**：拒绝任何 `draft.save`、`candidate.adopt` 或状态回退 |

### 头条文章状态（`ARTICLE_STATES`）

| 状态 | 含义 | 关键门禁 |
| --- | --- | --- |
| `初稿待改` | 初始成稿阶段 | 需执行 `article.qa` 质检 |
| `质检未过` | QA 分数 < 84 或硬门禁失败 | 禁止进入 `待验收`；可通过编辑/自动回改（<= 2 轮）重新送检 |
| `待验收` | QA 通过（>= 84 且无硬门禁失败） | 等待作者执行 `article.accept` |
| `已验收` | 作者验收通过，锁定终版 `finalRevisionId` | 必须执行 `approval.decide`（`confirmed: true`）后才允许交付 |
| `已交稿` | 已提交交付与导出任务 | **终态锁定**：拒绝一切后续改稿、改标题或重复审批 |

---

## 3. 番茄叙事连续性与时间线模型

- **锚点坐标（`StoryPoint`）**：由 `{ chapterId, point }` 组成，其中 `point` 为 1-based 段落索引；依托项目章节序（`chapterOrder`）构成严格全序比较（`comparePoints`）。
- **设定半开有效区间**：每条事实 `SettingFact` 定义生效区间 `[effectiveFrom, effectiveTo)`，仅在该区间内对章节生效，避免前文已失效设定污染后续生成。
- **角色知情边界（`knownFrom`）**：每条事实可按角色记录首次知情锚点；查询某角色在特定章/段可见的设定时，系统自动过滤所有尚未生效或该角色尚未知晓的事实。
- **章节重排护栏**：移动章节顺序时，`planReorder` 自动扫描所有跨章设定区间与伏笔顺序翻转，生成冲突清单供作者显式确认。
- **伏笔生命周期**：`proposed` → `planted` → `hinted` → `resolved` / `abandoned`；已解决伏笔仅在显式携带 `{ reopen: true }` 时允许重开，已废弃伏笔严禁直接转为已解决。

---

## 4. 离线确定性质量、沙箱与预算规则

1. **AI 腔扫描（`scanAiSlop`）**：基于内置中文网文高频套话词库、项目自定义禁用词与白名单，统计命中频次、每千字密度、句长变异系数（CV）与单调连句段，零 Token 消耗。
2. **黄金三章诊断（`diagnoseGoldenThree`）**：针对开篇前三章评估钩子出现速度、主角处境、冲突密度与爽点兑现度。
3. **技法卡零成本排序（`rankTechniquesForChapter`）**：按挂载作用域优先级（`chapter > act > volume > project`）、置顶/排除模式、写作阶段绑定、节奏标签与大纲关键词重合度进行确定性打分，并配合前缀缓存友好的上下文装配器（`assembleContextBundle`）在预算内裁剪。
4. **纯提示词 Skill 沙箱导入（`skill.import`）**：支持导入标准 `SKILL.md`，在入库前限制文件体积（`<= 128 KiB`）、自动剥离脚本/Hook/外部工具声明，并强制预览确认后再入库。
5. **预算熔断与精确对账**：任何生成作业启动前必须通过预算预检；模型调用产生的 token 用量与取消后晚到回执全部写入 `author_job_calls`，确保账实一致。
