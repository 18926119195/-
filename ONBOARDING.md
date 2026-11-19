# 名词抽取与召回实验入库指南

[一分钟定位](#一分钟定位) · [沿聊天时间线看灵感](#沿聊天时间线看灵感) · [从代码反查来由](#从代码反查来由) · [走读与维护记录](#走读与维护记录)

## 一分钟定位

这是 9 月 16–17 日从 Docuverse 纯文表、S0/S1 名词抽取过渡到首个可运行召回原型的快照。旧设计、执行报告和开发会话聚合在 `archive/`，最近的运行脉络在 `DEPLOY-CONTINUE.md`。[归档索引](archive/README.md) · [`18926119195/-` 的 `main @ 2d54c36`](https://github.com/18926119195/-/commit/2d54c36a95a4271a494d9daac1a5d824827fc457)

- 要明白名词和位置如何进入词表，读 [S0/S1 工作流](README-complete-workflow.md)与 [`final-noun-index.json`](final-noun-index.json)。文档有多个历史计数，此提交中的 `nouns` 是 18,378 条。
- 要明白怎样用词表找正文，从 [`recall-nouns-llm.js`](recall-nouns-llm.js)进入。仓库有 [15 道测试题](test-questions.json)，现存召回 JSON 只有 Z1-Q1，含 252 个 `recalledTexts` 条目。[运行产物](noun-recall-results.json)
- [架构说明](ARCHITECTURE_v2.md)的规则和方案范围大于此版本的独立 JS 召回原型。先确认读的是规划、脚本还是某次输出。

用钱学森工程控制论的观察与反馈组织阅读：把作者要看的效果作为观察目标，用选定版本的代码和运行档案校验理解，有出入时返回聊天原处。

## 沿聊天时间线看灵感

**如何读状态。** 已实现表示在所列版本找到与灵感相符的代码路径。部分实现表示已有其中一段。未实现表示已查的入口尚无对应实现。证据不足时标待确认。归档与设计文稿按资料本身的状态描述。

清理会话由 `docs/chat-transcripts/session-913ee55a-data-cleaning.jsonl` 定位，下列行号是 JSONL 行。9 月 17 日的会话由 `archive/03-召回引擎设计与测试.md` 第三部分定位，下列行号对应用户发言。时间均为北京时间。

| ID | 聊天位置（2026 年） | 当时的灵感或要求 | 当前状态 | 实现证据 |
| --- | --- | --- | --- | --- |
| <a name="idea-i01"></a>I01 | 09-16 18:29，JSONL 第 274 行 | 把 S0 候选逐位和纯文表对照，据此判断能否进入 LLM 兜底。 | 已有验证入口 | S0 脚本在全文定位词形，统计命中并生成残文截断；会话把报告用于判断是否继续。 [验证脚本](validate-s0-quality.js) |
| <a name="idea-i02"></a>I02 | 09-16 18:36，JSONL 第 278 行 | 让兜底 LLM 并发提速，同时保留词在纯文表的位置。 | 已实现 | S1 脚本有并发批处理，并以截断、全文和 S0 区间回查偏移。 [S1 脚本](s1-llm-fill.js#L300) |
| <a name="idea-i03"></a>I03 | 09-16 21:04–21:18，JSONL 第 492、505、523 行 | 清理纯文表的占位提示和公式噪声，保留真正正文。 | 已实现 | 原子筛选和清洗代码、实验记录以及终词表还在。 [过滤代码](src/core/text.ts#L44) · [清理实验](docs/EXPERIMENT-2026-09-16-data-cleaning.md) |
| <a name="idea-i04"></a>I04 | 09-17 15:44 与 17:06，归档第 8362、9905 行 | 一个 bookKey 命中词多时用整块，命中稀疏时走局部拓扑链。 | 部分落地 | 原型能按单词拓扑取 bookKey、去重并回到全文块。该入口未见“命中数高用整块、低用局部链”的分流。 [Top-N 召回循环](recall-nouns-llm.js#L389) |
| <a name="idea-i05"></a>I05 | 09-17 15:46–15:53，归档第 8507、8600 行 | 设计由单块到多步推理、再到控制组的约 15 道题，用结果决定阈值。 | 有评测设计，存档只体现单题 | [阈值试验设计](THRESHOLD-TEST-DESIGN.md)定义分区和候选方案。实际归档只见 Z1-Q1，不能从它回推出所有分区的综合阈值。 [题库](test-questions.json) · [结果](noun-recall-results.json) |
| <a name="idea-i06"></a>I06 | 09-17 18:01，归档第 11200 行 | 调用 LLM 时关闭 thinking，并弄清下一步的召回测试。 | 有召回请求配置 | 召回客户端请求体设置禁用 thinking 的选项，续接文档保留一题的冒烟结果。 [召回请求](recall-nouns-llm.js#L193) |

## 从代码反查来由

| 当前文件或入口 | 回读聊天 | 应理解的问题 |
| --- | --- | --- |
| [`validate-s0-quality.js`](validate-s0-quality.js) 与 [`s1-llm-fill.js`](s1-llm-fill.js#L300) | [I01](#idea-i01)、[I02](#idea-i02) | 先确认规则命中坐标，再把未覆盖片段交给 LLM；S1 结果仍要回纯文表找位置。 |
| [`src/core/text.ts`](src/core/text.ts#L44) | [I03](#idea-i03) | 过滤改变进入纯文表的原子及文字，词表与位置都受它影响。 |
| [`recall-nouns-llm.js`](recall-nouns-llm.js#L325) 与 [`noun-recall-results.json`](noun-recall-results.json) | [I04](#idea-i04)–[I06](#idea-i06) | 议定的整块/局部分流、现有 Top-N 召回与实际存下的一题是三个可独立核查的事实。 |

## 走读与维护记录

从既有召回 JSON 查 Z1-Q1 的 `recalledTexts`，回到 [I04](#idea-i04) 与 [I05](#idea-i05)。应能解释 252 的含义、题目为什么只有一个结果，以及作者讨论的阈值分流有没有进入这份代码。如发现同日有额外批次或入口，给指南补条目 ID、保存位置与提交，并修订与聊天的对应关系。

**指南如何更新。** 以仓库和版本划定范围，从聊天提取原始目标，再用代码与产物校正对当时决策的理解。新证据出现时，回到原编号修订记录。这种读法借鉴了钱学森的系统工程和工程控制论。 [《组织管理的技术——系统工程》](https://doi.org/10.13255/j.cnki.jusst.2011.06.020) · [《工程控制论》](https://openlibrary.org/books/OL49218199M/Engineering_cybernetics)
