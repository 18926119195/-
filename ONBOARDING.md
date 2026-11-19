# 名词抽取与召回实验入库指南

审阅基线 [`18926119195/-` 的 `main` 提交 `2d54c36`](https://github.com/18926119195/-/commit/2d54c36a95a4271a494d9daac1a5d824827fc457)，2026-11-19。这里保留 9 月 16–17 日的 S0/S1 清洗及召回原型。若要接手召回，全量 15 题评测是当前最明确的缺口；仓库入库前的运行证据覆盖一题。先看 `DEPLOY-CONTINUE.md` 和 [归档总览](archive/README.md)。

## 人机协作时间线

| 日期 | 讨论与决策 | 到当前基线的状态 |
| --- | --- | --- |
| 09-16 | 清理图脸占位说明和 LaTeX 碎片，确定 spaCy 优先和 LLM 补缺 | 代码与产物已归档，清理和 Git 建库两个会话可回查。先核对纯文表、偏移和截断如何进入词表。[清理实验](docs/EXPERIMENT-2026-09-16-data-cleaning.md) · `docs/chat-transcripts/session-913ee55a-data-cleaning.jsonl` · [建库会话](docs/chat-transcripts/session-1b6503ec-git-setup.jsonl) |
| 09-17 | 从词表扩展到两阶段 LLM 评分、拓扑邻域和段落召回，思考如何限制 thinking 和成本 | `archive/03-召回引擎设计与测试.md`记录从设计到 Z1-Q1 冒烟。[`recall-nouns-llm.js`](recall-nouns-llm.js)包含评分、拓扑与召回实现。归档 JSON 实查为 Z1-Q1 一条，含 252 个 `recalledTexts`；[题库](test-questions.json)有 15 题。[现有召回 JSON](noun-recall-results.json) |
| 09-17 收尾 | 续跑各难度和控制组，人工抽检、选评分阈值 | `DEPLOY-CONTINUE.md`将全题结果和边缘词拓扑抽检列为待办，[阈值设计](THRESHOLD-TEST-DESIGN.md)提供 Zone 1–4 分层。当前库未见其全量执行产物。不同报告的终词表口径相异，实际检查仓库内 JSON 的 `nouns` 数组为 18,378 条，续跑要保存输入哈希与实测数。[现有终词表](final-noun-index.json) |

## 从哪条链路进入

- **只做召回。** 准备获授权的 Docuverse 语料，使用 `DOCUVERSE_PATH` 指向它，`NOUN_INDEX_PATH` 指向冻结词表，`QUESTIONS_PATH` 指向固定题库，`OUTPUT_PATH` 指向独立数据目录。由获批环境注入模型密钥。先通过 `QUESTION_IDS=Z1-Q1` 限定一题，再走 `node recall-nouns-llm.js`。仓库的 Windows 默认语料路径需要覆盖。历史配置以 `DEPLOY-CONTINUE.md` 为入口，使用新签发的凭据。
- **重跑抽取。** [完整工作流](README-complete-workflow.md)给出 spaCy sidecar、S1 补缺与合并脚本。审阅已跑 `node --check recall-nouns-llm.js` 与离线 `node test-s1-dedup-confidence.js`；后者的示例展示重叠过滤和偏移报告，但汇总叙述为预写文本，验收应检查实际输出或断言。
- **阅读评测架构。** [架构](ARCHITECTURE_v2.md)给出纯文表 → S0 → S1 → 终词表 → 拓扑召回的设计。[归档索引](archive/README.md)保留旧报告和设计起点。按实际执行脚本核对架构章节对应的实现和输入。

## 控制目标与交接步骤

1. **固定比较基线。** 先记录语料、词表、15 题、提交、模型和词表来源。用既有 Z1-Q1 归档验证读取、题号和 252 个历史块的结构，随后用小型授权语料作离线回归。真实复跑的相关性需要从标注判断。
2. **定义偏差。** 在每个 Zone 标注目标 chunk、允许的近邻及无答案样例。按题记录召回和误收块数、Precision/Recall@K、空返回原因、token、时延及错误。OCR 误识别、边缘词、同义词和宽邻域会影响结果，先按错误类型定位到输入、评分或拓扑。
3. **受控扩大。** 维护者确认预算和验收阈值，先跑基线中已知的一题，再跑 15 题。建议最小门槛为 15 个题号无重复和缺漏、定位均能回到同版原文、控制题的误召回单独统计。偏离阈值时在隔离目录回到上一个输入/输出快照重新比较。
4. **维护反馈记录。** PR 附影响阶段、原会话证据和逐题差异，Agent 在维护者确认后将失败案例加入测试。阈值或语料选择记录责任人和复核意见。

## 方法依据

本指南把总体设计落实为边界、目标和任务接口，把工程控制中的反馈落实为观测、判据和纠偏。维护者用原始协作记录、代码和固定样本共同核验定性判断与量化结果，据此决定下一轮行动。[《工程控制论》](https://openlibrary.org/books/OL49218199M/Engineering_cybernetics) · [《组织管理的技术——系统工程》](https://doi.org/10.13255/j.cnki.jusst.2011.06.020) · [《一个科学新领域——开放的复杂巨系统及其方法论》](https://cnki.istiz.org.cn/kcms/detail/detail.aspx?dbcode=CPFD&dbname=cpfd1999&filename=ZGXC199008001001)
