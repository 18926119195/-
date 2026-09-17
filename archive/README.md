# 归档索引

本目录归档了 2026-09-16 ~ 2026-09-17 期间名词抽取管道搭建、词表清洗、召回引擎设计与测试相关的全部文档。原始的零散 md 文件已合并到以下三个主题文档中，内容全部保留、未做摘要精简。

| 文档 | 主题 | 原始文件来源 |
|---|---|---|
| `01-名词抽取管道与s0-s1测试.md` | s0(spaCy)规则抽取 + s1(LLM)补缺 + 数据清理的设计、实现、测试验证 | README-s1-improvements.md, README-s1-llm-fill.md, SUMMARY-s1-quality-filter.md, SUMMARY-s1-fixes.md, VERIFICATION-REPORT-s1.md, ANALYSIS-s1-validation.md, README-complete-workflow.md, docs/EXPERIMENT-2026-09-16-data-cleaning.md, ARCHITECTURE_v2.md |
| `02-执行报告与项目状态归档.md` | 每次全量/增量跑管道后的执行报告、任务完成总结、项目状态快照 | FINAL-EXECUTION-REPORT.md, EXECUTION-REPORT-2026-09-17.md, TASK-COMPLETION-SUMMARY.md, COMPLETION-NOTICE.md, PROJECT-STATUS.md |
| `03-召回引擎设计与测试.md` | 召回引擎（拓扑链召回）设计起点、阈值测试设计、2026-09-17 当天完整对话记录（含 thinking 关闭修复、recall-nouns-llm.js 从0到烟雾测试通过、GitHub 私有仓库推送全过程） | QUICKSTART-RECALL.md, THRESHOLD-TEST-DESIGN.md, 当天三段完整聊天记录（未摘要，含全部工具调用与结果） |

## 明天继续时怎么看

1. 先看 `03-召回引擎设计与测试.md` 末尾的"当天完整对话记录"，了解 `recall-nouns-llm.js` 现在做到哪一步（已跑通 Z1-Q1 单题烟雾测试，252 个 bookKey 召回，未跑全部15题）。
2. 核心待做事项：
   - 跑全部 15 题的召回（`node recall-nouns-llm.js`，去掉 `QUESTION_IDS` 限制）
   - 人工抽检 `noun-recall-results.json` 里的 `recalledTexts` 是否真的相关
   - 边缘词/低分词的拓扑链质量检查
3. 关键脚本：`recall-nouns-llm.js`（新写的召回引擎）、`score-nouns-llm.js`（旧的全量打分方案，已被 recall-nouns-llm.js 取代但保留作对比）。
4. 关键数据：`final-noun-index.json`（18378词终词表）、`noun-recall-results.json`（召回结果，目前只有 Z1-Q1）。

原始 md 文件仍保留在项目根目录，未删除，本归档只是把内容按主题聚合方便阅读。
