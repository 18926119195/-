# 快速开始指南 - 基于已清洗词表

## 当前状态

✅ **词表已完成清洗**（2026-09-17 12:35 PM）

- **最终词表**: `final-noun-index.json`
  - 总词条: **18,343 个**（s0: 18,338 + s1: 5）
  - 总位置: **38,568 处**
  - 覆盖率: **74.07%**（430,218 / 580,809 字符）
  - 平均每词: **2.1 次出现**

- **质量报告**: 
  - `s0-quality-report.json` - spaCy 抽取质量分析
  - `s1-nouns-with-offsets.json` - LLM 补缺结果（5 个新词）
  - `s0-hits.json` - s0 命中位置表（58,639 条区间）

- **执行报告**: `EXECUTION-REPORT-2026-09-17.md`（完整流程记录）

---

## 下一步：召回引擎实现

基于 `final-noun-index.json` 实现查询召回系统。

### 核心功能

```
用户查询 → 命中词匹配 → 拓扑链构建 → 原文片段召回
```

### 需要实现的模块

1. **词条索引加载器**
   - 读取 `final-noun-index.json`
   - 构建查询词 → 位置偏移的映射
   - 支持模糊匹配（lemma/stem/编辑距离）

2. **拓扑链构建**
   - 输入: 命中词的位置列表
   - 输出: 每个位置的 ±N 相邻词上下文
   - 参数: 窗口大小（如 ±2 词）

3. **段落召回**
   - 输入: 拓扑链位置
   - 输出: 原文片段（chunk-level 或扩展上下文）
   - 需要: 纯文表 + chunk 映射

4. **召回排序**
   - 按命中词数量排序
   - 按拓扑链密度排序
   - 按段落相关性排序（可选：用 LLM 重排序）

---

## 快速测试示例

### 测试查询 1: "flux"（最高频词，216次）

预期结果:
- 命中 216 个位置
- 每个位置返回 ±2 词上下文
- 排序后返回 Top 10 相关段落

### 测试查询 2: "subjectivité"（主体性，107次）

预期结果:
- 命中 107 个位置
- 拓扑链可能包含 "Agencements", "processus", "expression" 等相关词
- 返回理论讨论相关段落

### 测试查询 3: "robotique"（s1 补缺词，1次）

预期结果:
- 命中 1 个位置（低频词）
- 验证 s1 补缺的词是否在真实上下文中有意义
- 测试边缘词召回精度

---

## 代码起点

### 1. 加载词表

```typescript
import fs from 'fs';

interface NounEntry {
  id: string;
  surface: string;
  offsets: Array<{ start: number; end: number }>;
  source: 's0-spacy' | 's1-llm';
}

interface FinalNounIndex {
  meta: {
    totalNouns: number;
    s0Count: number;
    s1Count: number;
    totalOffsets: number;
  };
  nouns: NounEntry[];
}

const nounIndex: FinalNounIndex = JSON.parse(
  fs.readFileSync('final-noun-index.json', 'utf-8')
);

// 构建快速查询映射
const surfaceToEntry = new Map<string, NounEntry>();
for (const noun of nounIndex.nouns) {
  surfaceToEntry.set(noun.surface.toLowerCase(), noun);
}

console.log(`加载 ${nounIndex.meta.totalNouns} 个词条`);
```

### 2. 查询命中

```typescript
function findNounMatches(query: string): NounEntry[] {
  const queryLower = query.toLowerCase();
  const matches: NounEntry[] = [];
  
  // 精确匹配
  const exact = surfaceToEntry.get(queryLower);
  if (exact) matches.push(exact);
  
  // 模糊匹配（包含）
  for (const [surface, entry] of surfaceToEntry) {
    if (surface.includes(queryLower) && !matches.includes(entry)) {
      matches.push(entry);
    }
  }
  
  return matches;
}

// 示例
const hits = findNounMatches('flux');
console.log(`查询 "flux": 命中 ${hits.length} 个词条`);
hits.forEach(hit => {
  console.log(`  - ${hit.surface}: ${hit.offsets.length} 处位置`);
});
```

### 3. 构建拓扑链（简化版）

```typescript
interface TopologyNode {
  offset: number;
  surface: string;
  neighbors: string[]; // ±N 词的表面形式
}

function buildTopologyChain(
  offset: { start: number; end: number },
  fullText: string,
  windowSize: number = 2
): TopologyNode {
  const { start, end } = offset;
  const surface = fullText.slice(start, end);
  
  // 查找前后 N 个词（简化：按空格/标点分割）
  const before = fullText.slice(Math.max(0, start - 100), start);
  const after = fullText.slice(end, Math.min(fullText.length, end + 100));
  
  const beforeWords = before.split(/[\s\n.,;:!?]+/).filter(w => w.length > 2).slice(-windowSize);
  const afterWords = after.split(/[\s\n.,;:!?]+/).filter(w => w.length > 2).slice(0, windowSize);
  
  return {
    offset: start,
    surface,
    neighbors: [...beforeWords, ...afterWords],
  };
}
```

### 4. 段落召回（需要 docuverse 映射）

```typescript
interface PureTextEntry {
  chunkKey: string;
  page: number;
  text: string;
  startOffset: number;
  endOffset: number;
}

function recallParagraph(
  offset: number,
  pureTextTable: PureTextEntry[]
): PureTextEntry | null {
  for (const entry of pureTextTable) {
    if (offset >= entry.startOffset && offset < entry.endOffset) {
      return entry;
    }
  }
  return null;
}
```

---

## 评测基准

使用 `eval-decide.ts`（如果存在）或手工测试：

### 精度测试
- 查询 10 个高频词（如 `flux`, `Univers`, `référence`）
- 人工检查 Top 5 召回片段是否相关
- 计算精度: 相关片段数 / 总召回片段数

### 召回率测试
- 选择 5 个已知段落（包含特定概念）
- 构建查询词
- 检查是否召回目标段落

### 边缘词测试
- 查询 s1 补缺的 5 个词（`aborigèn`, `optique`, `Patrie*`, `robotique`, `SCRIPT`）
- 验证低频词召回质量

---

## 文件清单（供新聊天参考）

```
C:\Users\Administrator\Desktop\decide-design-v2-datacleaning-20260916-2151-main\

核心输出:
├── final-noun-index.json          # 最终词表（18,343词 + 38,568位置）★
├── s0-quality-report.json         # s0 质量报告
├── s1-nouns-with-offsets.json     # s1 补缺结果（5词）
└── s0-hits.json                   # s0 命中区间（58,639条）

执行脚本:
├── validate-s0-quality.js         # s0 验证（调用 spaCy）
├── s1-llm-fill.js                 # s1 补缺（调用 LLM）
├── merge-s0-s1.js                 # 合并去重
└── spacy-sidecar/server.py        # spaCy 服务

文档:
├── PROJECT-STATUS.md              # 项目现状总结
├── EXECUTION-REPORT-2026-09-17.md # 本次执行报告 ★
├── QUICKSTART-RECALL.md           # 本文件 ★
├── README-complete-workflow.md    # 完整流程说明
└── ARCHITECTURE_v2.md             # 架构说明

基础设施:
├── src/core/pureTextTable.ts      # 纯文表构建
├── src/core/text.ts               # 文本工具
└── src/core/types.ts              # 类型定义

语料（桌面）:
└── C:\Users\Administrator\Desktop\docuverse_cartographies_squizoanalythiques_Fe_lix_Guattari_1789114122714.docuverse.json
```

---

## 环境变量（.env）

```bash
# LLM 配置（已验证可用）
LLM_API_KEY=sk-394ccbbd9af545619d8cbb9ed0f4426c
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-chat
LLM_THINKING=disabled

# spaCy 服务
SPACY_MODEL=fr_core_news_sm
PORT=5001  # spaCy sidecar 端口
```

启动 spaCy 服务:
```bash
cd spacy-sidecar
python server.py  # http://localhost:5001
```

---

## 常见问题

### Q1: 如何重新跑完整流程？

```bash
# 1. 启动 spaCy 服务
cd spacy-sidecar
python server.py &

# 2. s0 验证
node validate-s0-quality.js "C:\Users\Administrator\Desktop\docuverse_*.docuverse.json"

# 3. s1 补缺（完整处理 375 个截断，去掉 LIMIT）
unset LIMIT  # 或删除脚本中的 LIMIT 行
node s1-llm-fill.js

# 4. 合并
node merge-s0-s1.js
```

### Q2: 如何只更新 s1（重新补缺）？

直接跑 `node s1-llm-fill.js`，然后 `node merge-s0-s1.js`。  
s0 结果会从 `s0-quality-report.json` 和 `s0-hits.json` 读取（无需重跑 spaCy）。

### Q3: 如何验证词表质量？

```javascript
// 读取 final-noun-index.json
const index = JSON.parse(fs.readFileSync('final-noun-index.json', 'utf-8'));

// 随机抽样 50 个词
const sample = index.nouns
  .sort(() => Math.random() - 0.5)
  .slice(0, 50);

// 打印词 + 首次出现位置的上下文
sample.forEach(noun => {
  const firstOffset = noun.offsets[0];
  console.log(`${noun.surface} (${noun.offsets.length}次):`);
  // 从 fullText 中提取上下文...
});
```

---

**准备好了！** 现在可以：
1. 开启新聊天，要求实现召回引擎
2. 或继续在本聊天中实现召回测试
3. 或先做词表质量抽检

*最后更新: 2026-09-17 12:40 PM*
