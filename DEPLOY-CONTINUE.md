# 🚀 明天继续 - 一键部署与任务续接指南

> 2026-09-17 结束时创建。clone 仓库后按本指南操作，可从中断节点立即续接。

---

## 一、环境总览

| 依赖 | 用途 | 当前值 |
|------|------|--------|
| **Python ≥ 3.9** | 运行 spaCy sidecar（法语名词抽取服务） | `fr_core_news_sm` 模型 |
| **Node.js ≥ 18** | 运行 recall-nouns-llm.js 等脚本 | v24.19.0 验证通过 |
| **DeepSeek API** | LLM 关键词选择、打分、相关词判断 | `https://api.deepseek.com`，模型 `deepseek-chat` |
| **spaCy** | s0 阶段法语名词抽取（仅 s0 管道需用，召回引擎不需要） | s0 产物已缓存，无需每次重跑 |

---

## 二、一键部署（克隆后首次）

### 2.1 克隆仓库

```bash
git clone https://github.com/18926119195/-.git
cd -
```

> 仓库描述为"明天继续"，URL slug 为 `-`（GitHub 不支持中文仓库名 slug）

### 2.2 安装 Python 依赖（spaCy sidecar）

```powershell
# PowerShell / CMD
cd spacy-sidecar
pip install -r requirements.txt

# 首次自动下载法语模型（如果还没装）
python -c "import spacy; spacy.load('fr_core_news_sm')"
```

> **提示**：如果 `pip install` 速度慢，换用国内镜像：
> ```bash
> pip install -r requirements.txt -i https://mirrors.aliyun.com/pypi/simple/
> ```

### 2.3 安装 Node.js 依赖（如果需要）

```bash
npm install
```

> `node_modules` 未提交到仓库，需要这一步。如果 Node ≥ 18 已可用，此步通常可跳过（package-lock.json 已提交）。

### 2.4 恢复 .env（API 密钥）

```bash
cp .env.example .env
```

然后编辑 `.env`，填入以下值：

```env
# DeepSeek API（必填）
LLM_API_KEY=sk-394ccbbd9af545619d8cbb9ed0f4426c
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-chat
LLM_THINKING=disabled

# spaCy sidecar（s0 管道需用，召回引擎不需要）
SPACY_MODEL=fr_core_news_sm
PORT=5001
```

> `.env` 已在 `.gitignore` 中排除，不会被意外提交。

---

## 三、任务续接：立即执行明天任务

### 3.1 当前任务节点

```
✅ 今天完成：
  - recall-nouns-llm.js 从零写完
  - 烟雾测试通过（Z1-Q1 单题，252 个 bookKey 召回，耗时 ~9s）
  - 所有调用 LLM 的脚本已关闭 thinking（避免 token 爆炸）
  - 词表：final-noun-index.json（18,343 词 + 38,568 位置）

❌ 待完成：
  - 跑全部 15 题召回（当前只有 Z1-Q1 结果）
  - 人工抽检 noun-recall-results.json 里的 recalledTexts 是否真的相关
  - 边缘词 / 低分词的拓扑链质量检查
```

### 3.2 步骤一：启动 spaCy sidecar（仅 s0 管道需要，召回引擎不需要）

```powershell
cd spacy-sidecar
python server.py
# 输出：Starting spaCy sidecar on http://localhost:5001
```

> **召回引擎（recall-nouns-llm.js）不依赖 spaCy，可以跳过此步直接执行步骤三。**

### 3.3 步骤二：确认 docuverse 语料路径

recall-nouns-llm.js 依赖本地语料文件，检查路径：

```powershell
Get-Content recall-nouns-llm.js | Select-String "DOCUVERSE_PATH" -Context 0,1
```

预期路径：
```
C:\Users\Administrator\Desktop\docuverse_cartographies_squizoanalythiques_Fe_lix_Guattari_1789114122714.docuverse.json
```

如果路径不对，编辑 recall-nouns-llm.js 顶部 `DOCUVERSE_PATH`，或设置环境变量：

```powershell
$env:DOCUVERSE_PATH = "C:\完整\正确\路径\docuverse.json"
```

### 3.4 步骤三：跑全部 15 题召回（明天第一件事）

```powershell
# 直接运行，不限制问题ID，跑全部 15 题
node recall-nouns-llm.js
```

预期耗时：15 题 × ~9s/题 ≈ 2~3 分钟（取决于 API 限速）

**输出文件**：`noun-recall-results.json`（增量写盘，每题跑完立即保存）

**指定特定问题**（调试用）：
```powershell
$env:QUESTION_IDS = "Z1-Q2,Z1-Q3"
node recall-nouns-llm.js
```

**调整并发数**（默认 4，降低避免 429 限速）：
```powershell
$env:LLM_CONCURRENCY = "2"
node recall-nouns-llm.js
```

---

## 四、关键脚本速查

| 脚本 | 用途 | 是否依赖 spaCy |
|------|------|--------------|
| `recall-nouns-llm.js` | **召回引擎核心**：LLM 选词 → 拓扑链 → 召回原文 | ❌ 不需要 |
| `noun-recall-results.json` | 召回结果（**跑完 15 题后重点看这个**） | — |
| `validate-s0-quality.js` | s0 阶段：spaCy 抽取名词 | ✅ 需要 sidecar |
| `s1-llm-fill.js` | s1 阶段：LLM 补缺 spaCy 漏抽的词 | ❌ 不需要 |
| `merge-s0-s1.js` | 合并 s0 + s1 结果 → final-noun-index.json | ❌ 不需要 |
| `score-nouns-llm.js` | 旧的全量打分方案（已被 recall-nouns-llm.js 取代，保留作对比） | ❌ 不需要 |
| `relevance-filter-llm.js` | 对候选词做相关词判断（内部被 recall-nouns-llm.js 调用） | ❌ 不需要 |

---

## 五、召回引擎工作流详解

```
用户问题（如 "Pierre Janet和Freud对无意识的观点有何不同？"）
    │
    ▼
① LLM 选词：扫描 18,343 个词，选出相关词并打分（1-100）
    │ 仅 TOP 100 高分词 → 进入步骤②
    │ 中低分词 → 仅拓扑链分析（不召回原文）
    │
    ▼
② 拓扑链构建：每个高分词在语料中找 ±5 词上下文邻居
    │
    ▼
③ bookKey 召回：拓扑链节点 → bookKey 映射 → 去重
    │
    ▼
④ 输出：noun-recall-results.json（每题含 recalledTexts 列表）
```

---

## 六、人工验收要点

跑完全部 15 题后，重点检查：

### 6.1 召回精度（精度测试）
- 随机抽 5 题，每题随机看 10 条 recalledTexts
- 人工判断：这条文本是否真的回答了用户问题？
- 计算精度 = 相关条数 / 总条数

### 6.2 召回率（召回率测试）
- 选 3 题有"预期答案"的问题（见 test-questions.json）
- 对比 recall 结果是否包含预期答案关键词所在的 chunk

### 6.3 Zone4 控制组（不应召回）
- Z4-Q4（"拉康派临床技术手册在哪里下载？"）
- 预期：召回 0 条（因为文档里根本没有下载地址）
- 如果被召回了 → 说明阈值策略有误报

### 6.4 边缘词质量
- 查询 s1 补缺的 5 个词（`aborigèn`, `optique`, `Patrie*`, `robotique`, `SCRIPT`）
- 验证低频词召回的上下文是否相关

---

## 七、阈值策略参考

当前设计（阈值测试报告详见 `archive/03-召回引擎设计与测试.md`）：

| 阈值 | 效果 | 风险 |
|------|------|------|
| `TOP_N=100`（默认） | LLM 选出最多 100 个高分词 | 可能漏掉需要 100+ 词覆盖的复杂问题 |
| `TOPOLOGY_WINDOW=5` | 每个词抓前后各 5 词上下文 | 窗口太小可能截断语义链 |
| `BATCH_SIZE=60` | 每批送 60 个词给 LLM | 太小拖慢速度，太大可能触发限速 |

---

## 八、常见问题

### Q1: 报 `缺少 API 密钥`
```bash
# 确保 .env 里有 LLM_API_KEY=sk-...
# 或直接设置环境变量
$env:LLM_API_KEY = "sk-394ccbbd9af545619d8cbb9ed0f4426c"
```

### Q2: 报 `Failed to connect to api.deepseek.com`
网络问题，检查代理或 VPN。也可以换用其他 OpenAI-compatible API：
```powershell
$env:LLM_BASE_URL = "https://api.openai.com/v1"
$env:LLM_API_KEY = "sk-your-key"
```

### Q3: spaCy sidecar 报 `Model fr_core_news_sm not found`
```bash
python -c "from spacy.cli import download; download('fr_core_news_sm')"
```

### Q4: recall 结果和预期不符，想重跑某一题
```powershell
# 删除对应条目后重新运行
# 或设置环境变量限制问题范围
$env:QUESTION_IDS = "Z1-Q1"
node recall-nouns-llm.js
```

### Q5: 429 Too Many Requests
```powershell
$env:LLM_CONCURRENCY = "1"   # 从 4 降到 1
$env:BATCH_SIZE = "30"        # 从 60 降到 30
node recall-nouns-llm.js
```

---

## 九、今天的对话记录

今天 2026-09-17 的三段完整对话（含所有工具调用与结果）已归档在：

```
archive/03-召回引擎设计与测试.md
```

包含：
- recall-nouns-llm.js 从 0 到烟雾测试通过的全过程
- 8 个 LLM 调用脚本关闭 `thinking` 的操作记录
- 所有脚本语法检查通过的完整输出
- GitHub 私有仓库创建与推送全过程

---

*最后更新：2026-09-17 18:55（UTC+8）*
