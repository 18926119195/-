/**
 * 基于词表拓扑链的召回引擎
 *
 * 流程：
 * 1. LLM 扫描名词表，选出与问题相关的词，并按重要性打分(1-100)
 *    - 未被选中的词：完全不出现（不做零分占位）
 *    - 分数仅在已选词之间相对排序
 * 2. 高分词（默认TOP 100，可配置）→ 构建拓扑链 → 映射到 bookKey → 召回原文
 * 3. 中低分词 → 仅拓扑链分析，不召回原文
 *
 * 用法：
 *   node recall-nouns-llm.js                            # 所有问题
 *   node recall-nouns-llm.js Z1-Q1 Z1-Q2              # 指定问题ID
 *   QUESTION_IDS=Z1-Q1 NOUN_BATCH_SIZE=60 LLM_CONCURRENCY=4 node recall-nouns-llm.js
 */

import fs from 'fs';
import path from 'path';

// ============ 配置（环境变量覆盖）============
const DOCUVERSE_PATH = process.env.DOCUVERSE_PATH || 'C:\\Users\\Administrator\\Desktop\\docuverse_cartographies_squizoanalythiques_Fe_lix_Guattari_1789114122714.docuverse.json';
const NOUN_INDEX_PATH = process.env.NOUN_INDEX_PATH || path.join(process.cwd(), 'final-noun-index.json');
const QUESTIONS_PATH = process.env.QUESTIONS_PATH || path.join(process.cwd(), 'test-questions.json');
const OUTPUT_PATH = process.env.OUTPUT_PATH || path.join(process.cwd(), 'noun-recall-results.json');

const LLM_PROVIDER = process.env.LLM_PROVIDER || 'openai';
const API_KEY = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '';
const BASE_URL = process.env.LLM_BASE_URL || 'https://api.deepseek.com';
const MODEL = process.env.LLM_MODEL || 'deepseek-flash';
const CONCURRENCY = parseInt(process.env.LLM_CONCURRENCY || '4', 10);
const BATCH_SIZE = parseInt(process.env.NOUN_BATCH_SIZE || '60', 10);
const TOP_N = parseInt(process.env.TOP_N || '100', 10); // 召回原文的高分词数量
const TOPOLOGY_WINDOW = parseInt(process.env.TOPOLOGY_WINDOW || '5', 10); // 拓扑窗口大小
const QUESTION_IDS = (process.env.QUESTION_IDS || '').split(',').filter(Boolean);

if (!API_KEY) {
  console.error('缺少 API 密钥，设置 LLM_API_KEY 环境变量');
  process.exit(1);
}

// ============ 加载数据 ============
console.log('加载数据...');
const docuverse = JSON.parse(fs.readFileSync(DOCUVERSE_PATH, 'utf-8'));
const nounIndex = JSON.parse(fs.readFileSync(NOUN_INDEX_PATH, 'utf-8'));
const questions = JSON.parse(fs.readFileSync(QUESTIONS_PATH, 'utf-8'));

// 构建 chunk 偏移表（与 extract-nouns-unified.js 的 buildChunkEntries 一致）
const chunkEntries = [];
let globalOffset = 0;
for (const chunk of docuverse.bookIndex.chunks) {
  if (!isRetrievableAtom(chunk)) continue;
  const text = atomSearchText(chunk).trim();
  if (!text || text.length < 8) continue;
  chunkEntries.push({
    chunkKey: chunk.key,
    page: chunk.page,
    text,
    startOffset: globalOffset,
    endOffset: globalOffset + text.length,
  });
  globalOffset = globalOffset + text.length + 1; // +1 为分隔符
}
const totalTextLen = globalOffset;
console.log(`  文档总长度: ${totalTextLen} 字符, chunk 数: ${chunkEntries.length}`);
console.log(`  名词数: ${nounIndex.nouns.length}, 问题数: ${questions.length}`);

// ============ 辅助函数 ============
function isRetrievableAtom(chunk) {
  const t = atomSearchText(chunk);
  if (t.length < 4) return false;
  if (chunk.kind === 'fig' && t.length < 24 && !chunk.faces?.text) return false;
  if (chunk.kind === 'fig' && !chunk.faces?.text) {
    const rawNote = (chunk.faces?.fig?.note || '').trim();
    if (/无文字层|未OCR/.test(rawNote)) return false;
  }
  return true;
}

function stripHtmlTags(text) {
  return text.replace(/<[^>]+>/g, '').trim();
}

function stripLatexResidue(text) {
  return text.replace(/\$\$?[^$]*\$?/g, (m) => (m.startsWith('$$') ? '' : m.replace(/\$/g, ''))).trim();
}

function atomSearchText(chunk) {
  const text = chunk.faces?.text?.content?.trim();
  if (text && text.length >= 8) return stripLatexResidue(stripHtmlTags(text));
  const raw = (chunk.content || '').trim();
  if (raw && !raw.startsWith('[FIG:') && raw.length >= 8) return stripLatexResidue(stripHtmlTags(raw));
  if (text) return stripLatexResidue(stripHtmlTags(text));
  const note = (chunk.faces?.fig?.note || '').trim();
  return stripLatexResidue(stripHtmlTags(
    note.replace(/请依据可见版面回答[^。]*。?/g, '').replace(/勿编造未提供的文字[^。]*。?/g, '')
  ));
}

/**
 * 二分查找：将字符偏移映射到 chunk 条目
 */
function offsetToChunk(offset) {
  let lo = 0, hi = chunkEntries.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const e = chunkEntries[mid];
    if (offset < e.startOffset) hi = mid - 1;
    else if (offset >= e.endOffset) lo = mid + 1;
    else return e;
  }
  return null;
}

/**
 * 在原始文本中取名词的上下文窗口
 */
function getNounContext(nounEntry, window = TOPOLOGY_WINDOW) {
  const results = [];
  const fullText = null; // 延迟获取，按需拼接
  for (const { start, end } of nounEntry.offsets) {
    const entry = offsetToChunk(start);
    if (!entry) {
      // 不在任何 chunk 内，尝试直接查找
      results.push({
        start,
        end,
        text: null,
        chunkKey: null,
        page: null,
        neighbors: [],
        raw: `offset:${start}-${end}`,
      });
      continue;
    }
    // 取 chunk 内相对偏移的上下文
    const relStart = start - entry.startOffset;
    const relEnd = end - entry.startOffset;
    const before = entry.text.slice(Math.max(0, relStart - window * 10), relStart);
    const after = entry.text.slice(relEnd, Math.min(entry.text.length, relEnd + window * 10));
    const beforeWords = before.split(/[\s\n.,;:!?]+/).filter((w) => w.length > 1).slice(-window);
    const afterWords = after.split(/[\s\n.,;:!?]+/).filter((w) => w.length > 1).slice(0, window);
    results.push({
      start,
      end,
      chunkKey: entry.chunkKey,
      page: entry.page,
      neighbors: [...beforeWords, ...afterWords],
    });
  }
  return results;
}

/**
 * 基于名词表构建全局拓扑链（全局名词 → 位置 → 相邻词）
 */
function buildGlobalTopology(nounSurfaceSet) {
  const surfaceToNoun = new Map();
  for (const n of nounIndex.nouns) {
    surfaceToNoun.set(n.surface.toLowerCase(), n);
  }
  const result = new Map();
  for (const entry of chunkEntries) {
    const words = entry.text.split(/[\s\n.,;:!?]+/).filter((w) => w.length > 1);
    const indices = [];
    // 找出这批词中哪些是名词表中的词
    for (let i = 0; i < words.length; i++) {
      if (surfaceToNoun.has(words[i].toLowerCase())) {
        indices.push(i);
      }
    }
    // 构建相邻关系
    for (const ni of indices) {
      const w = words[ni];
      const noun = surfaceToNoun.get(w.toLowerCase());
      if (!result.has(noun.id)) {
        result.set(noun.id, []);
      }
      const neighbors = [];
      for (let j = Math.max(0, ni - TOPOLOGY_WINDOW); j < ni; j++) neighbors.push(words[j]);
      for (let j = ni + 1; j < Math.min(words.length, ni + TOPOLOGY_WINDOW + 1); j++) neighbors.push(words[j]);
      result.get(noun.id).push({
        chunkKey: entry.chunkKey,
        page: entry.page,
        offset: entry.startOffset + entry.text.indexOf(w),
        neighbors: [...new Set(neighbors)],
      });
    }
  }
  return result;
}

// ============ LLM 调用 ============
async function callLLM(prompt, retryCount = 0) {
  const MAX_RETRIES = 3;
  const BASE_DELAY = 2000;
  try {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        max_tokens: 1024,
        thinking: { type: 'disabled' },
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (response.status === 429 && retryCount < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, BASE_DELAY * Math.pow(2, retryCount)));
      return callLLM(prompt, retryCount + 1);
    }
    if (!response.ok) throw new Error(`OpenAI API ${response.status}`);
    const data = await response.json();
    return { text: data.choices[0]?.message?.content || '', usage: data.usage || null };
  } catch (err) {
    if (retryCount < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, BASE_DELAY * Math.pow(2, retryCount)));
      return callLLM(prompt, retryCount + 1);
    }
    console.error('LLM调用失败:', err.message);
    return null;
  }
}

/**
 * 核心 prompt：两步走——先选相关词，再在已选词之间打分
 */
function buildBatchPrompt(question, words) {
  const list = words.map((w, i) => `${i + 1}. ${w}`).join('\n');
  return `问题: ${question}

你是名词相关性分析专家。下面是编号的词语列表，每个词都来自一本法文哲学/精神分析著作的索引词表。

第一步——判断相关性：
仔细判断每个词是否对"回答这个问题"有帮助。只标记你真正认为有作用的词。

第二步——打分（仅对第一步选中的词）：
在你选中的词中，按"对解决问题的重要程度"从 1 到 100 打分：
  1-30   弱相关：领域相关但非核心，仅提及
  31-60  中等相关：问题涉及的具体概念，对答案有一定贡献
  61-80  强相关：重要概念，显著影响答案质量
  81-100 核心概念：没有这个词就无法准确回答问题

词语列表：
${list}

只输出一个 JSON 数组，数组元素格式：
{"i": 编号, "score": 分数}

只包含你选中的相关词（不要出现 i 在列表中但未选中的词）。例如：
[{"i":3,"score":85},{"i":17,"score":45},{"i":42,"score":20}]

如果这一批里没有任何相关词，输出空数组 []。`;
}

function parseScores(text) {
  if (!text) return null;
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return null;
  try {
    const arr = JSON.parse(match[0]);
    if (!Array.isArray(arr)) return null;
    const picks = [];
    for (const item of arr) {
      const i = Number(item?.i);
      const score = Number(item?.score);
      if (Number.isFinite(i) && Number.isFinite(score)) {
        picks.push({ index: Math.round(i) - 1, score: Math.max(1, Math.min(100, Math.round(score))) });
      }
    }
    return picks;
  } catch {
    return null;
  }
}

// ============ 拓扑链召回 ============
/**
 * 为单个名词构建拓扑链（相邻的表内名词）
 */
function buildNounTopology(nounId) {
  const nounEntry = nounIndex.nouns.find((n) => n.id === nounId);
  if (!nounEntry) return [];
  const results = [];
  for (const { start, end } of nounEntry.offsets) {
    const entry = offsetToChunk(start);
    if (!entry) continue;
    const relStart = start - entry.startOffset;
    const relEnd = end - entry.startOffset;
    const before = entry.text.slice(Math.max(0, relStart - TOPOLOGY_WINDOW * 12), relStart);
    const after = entry.text.slice(relEnd, Math.min(entry.text.length, relEnd + TOPOLOGY_WINDOW * 12));
    const beforeWords = before.split(/[\s\n.,;:!?]+/).filter((w) => w.length > 1).slice(-TOPOLOGY_WINDOW);
    const afterWords = after.split(/[\s\n.,;:!?]+/).filter((w) => w.length > 1).slice(0, TOPOLOGY_WINDOW);
    results.push({
      chunkKey: entry.chunkKey,
      page: entry.page,
      offset: start,
      neighbors: [...new Set([...beforeWords, ...afterWords])],
    });
  }
  return results;
}

/**
 * 获取高分词的拓扑链，并汇总出现过的 bookKey
 */
function getTopologyBookKeys(nounId) {
  const chains = buildNounTopology(nounId);
  const bookKeys = new Set();
  for (const c of chains) {
    if (c.chunkKey) bookKeys.add(c.chunkKey);
  }
  return { chains, bookKeys: [...bookKeys] };
}

/**
 * 从 bookKey 召回原文文本
 */
function recallByBookKey(chunkKey) {
  const entry = chunkEntries.find((e) => e.chunkKey === chunkKey);
  return entry ? entry.text : null;
}

// ============ 主流程 ============
async function main() {
  const qList = questions.filter((q) => !QUESTION_IDS.length || QUESTION_IDS.includes(q.id));
  console.log(`========== 拓扑链召回引擎 ==========`);
  console.log(`全量名词: ${nounIndex.nouns.length}, 问题数: ${qList.length}`);
  console.log(`批量大小: ${BATCH_SIZE}, 并发: ${CONCURRENCY}, TOP召回: ${TOP_N}\n`);

  const allResults = [];

  for (const q of qList) {
    console.log(`\n--- [${q.id}] ${q.question} ---`);
    const t0 = Date.now();

    // ---- 第一步：LLM 扫描全量名词，选出相关词并打分 ----
    const batches = [];
    for (let i = 0; i < nounIndex.nouns.length; i += BATCH_SIZE) {
      batches.push(nounIndex.nouns.slice(i, i + BATCH_SIZE));
    }

    const picked = new Map(); // globalIndex -> score
    let promptTokens = 0, completionTokens = 0, failedBatches = 0;

    let batchIdx = 0;
    const workers = Array.from({ length: CONCURRENCY }, async () => {
      while (true) {
        const myIdx = batchIdx++;
        if (myIdx >= batches.length) break;
        const batch = batches[myIdx];
        const words = batch.map((n) => n.surface);
        const prompt = buildBatchPrompt(q.question, words);
        const res = await callLLM(prompt);
        if (res?.usage) {
          promptTokens += res.usage.prompt_tokens || 0;
          completionTokens += res.usage.completion_tokens || 0;
        }
        const parsed = res ? parseScores(res.text) : null;
        if (parsed === null) {
          failedBatches++;
          continue;
        }
        for (const { index, score } of parsed) {
          if (index < 0 || index >= words.length) continue;
          picked.set(myIdx * BATCH_SIZE + index, score);
        }
        process.stdout.write(`\r  LLM选中: ${picked.size} 词, 批次: ${myIdx + 1}/${batches.length}`);
      }
    });
    await Promise.all(workers);

    // ---- 第二步：按分数排序 ----
    const scored = [...picked.entries()]
      .map(([globalIdx, score]) => {
        const n = nounIndex.nouns[globalIdx];
        return { id: n.id, surface: n.surface, df: n.offsets.length, score };
      })
      .sort((a, b) => b.score - a.score);

    console.log(`\n  选中 ${scored.length}/${nounIndex.nouns.length} 个相关词 (失败批次: ${failedBatches}/${batches.length})`);
    console.log(`  tokens: prompt=${promptTokens} completion=${completionTokens}`);

    // Top 10 预览
    console.log('  Top 10:', scored.slice(0, 10).map((s) => `${s.surface}(${s.score})`).join(', '));

    // ---- 第三步：拓扑链 + 召回 ----
    const TOP_RECALL = Math.min(TOP_N, scored.length);

    // 高分段：召回原文
    const recallItems = [];
    const recalledBookKeys = new Set();

    for (let i = 0; i < TOP_RECALL; i++) {
      const item = scored[i];
      const { chains, bookKeys } = getTopologyBookKeys(item.id);
      for (const bk of bookKeys) recalledBookKeys.add(bk);

      recallItems.push({
        rank: i + 1,
        id: item.id,
        surface: item.surface,
        score: item.score,
        df: item.df,
        bookKeys,
        chainCount: chains.length,
        // 拓扑链示例（前3个）
        chainSample: chains.slice(0, 3).map((c) => ({
          page: c.page,
          neighbors: c.neighbors,
        })),
      });
    }

    // 低分段：仅拓扑链，不召回原文
    const lowItems = scored.slice(TOP_RECALL).map((item) => {
      const { chains } = getTopologyBookKeys(item.id);
      return {
        id: item.id,
        surface: item.surface,
        score: item.score,
        df: item.df,
        chainCount: chains.length,
        chainSample: chains.slice(0, 2).map((c) => ({ page: c.page, neighbors: c.neighbors })),
      };
    });

    // 根据 bookKey 召回原文（去重，每 key 只召回一次）
    const recalledTexts = [];
    for (const bk of [...recalledBookKeys]) {
      const text = recallByBookKey(bk);
      if (text) {
        recalledTexts.push({ chunkKey: bk, text: text.slice(0, 2000) }); // 限制长度
      }
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const result = {
      questionId: q.id,
      question: q.question,
      zone: q.zone,
      totalNouns: nounIndex.nouns.length,
      selectedCount: scored.length,
      topRecallCount: TOP_RECALL,
      failedBatches,
      tokenCost: { promptTokens, completionTokens },
      elapsedSecs: parseFloat(elapsed),
      scoredNouns: scored,
      recallItems,
      lowItems,
      recalledTexts,
    };

    allResults.push(result);
    console.log(`  召回 bookKey 数: ${recalledBookKeys.size}, 低分词: ${lowItems.length}, 耗时: ${elapsed}s`);

    // 增量写盘
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(allResults, null, 2), 'utf-8');
  }

  console.log(`\n完成，结果已保存: ${OUTPUT_PATH}`);
}

main().catch(console.error);
