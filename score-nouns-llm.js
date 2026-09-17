/**
 * 相关词LLM打分（一步到位：LLM直接扫描全部名词，边选边打分）
 *
 * 不做任何关键词子串预筛——子串匹配本身就是一种关键词命中逻辑，
 * 会在LLM判断之前先丢词，等于还是被关键词污染，不是"LLM独立判断相关性"。
 *
 * 做法：把final-noun-index.json的18378个唯一名词分批喂给LLM
 * (分批纯粹是因为一次prompt塞不下所有词，是工程限制，不是判断上的两阶段)，
 * 让LLM对每一批词逐一打分0-10，表示"该词对回答这个问题的相关程度/能否帮助解决问题"。
 * 高分词 = LLM判断的核心相关词；低分/0分 = 不相关。
 * 打分结果本身就是选择结果，不需要额外的候选筛选步骤。
 *
 * 输出：noun-scores-llm.json
 *   { questionId, question, totalNouns, scores: [{id, surface, df, score}], tokenCost }
 */

import fs from 'fs';

const LLM_PROVIDER = process.env.LLM_PROVIDER || (process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'openai');
const API_KEY = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.LLM_MODEL || (LLM_PROVIDER === 'anthropic' ? 'claude-3-5-haiku-20241022' : 'deepseek-chat');
const BASE_URL = process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.deepseek.com';
const CONCURRENCY = parseInt(process.env.LLM_CONCURRENCY || '6', 10);
const BATCH_SIZE = parseInt(process.env.NOUN_BATCH_SIZE || '80', 10);

// 只跑这几个问题ID（成本控制用），不传则跑全部15个
const QUESTION_IDS = process.env.QUESTION_IDS ? process.env.QUESTION_IDS.split(',') : null;

async function callLLM(prompt, retryCount = 0) {
  const MAX_RETRIES = 3;
  const BASE_DELAY = 2000;
  try {
    let response, data;
    if (LLM_PROVIDER === 'anthropic') {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: MODEL, max_tokens: 1024, temperature: 0, messages: [{ role: 'user', content: prompt }] }),
      });
      if (response.status === 429 && retryCount < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, BASE_DELAY * Math.pow(2, retryCount)));
        return callLLM(prompt, retryCount + 1);
      }
      if (!response.ok) throw new Error(`Anthropic API ${response.status}`);
      data = await response.json();
      return { text: data.content[0]?.text || '', usage: data.usage ? { prompt_tokens: data.usage.input_tokens, completion_tokens: data.usage.output_tokens } : null };
    } else {
      response = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({ model: MODEL, temperature: 0, max_tokens: 1024, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: prompt }] }),
      });
      if (response.status === 429 && retryCount < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, BASE_DELAY * Math.pow(2, retryCount)));
        return callLLM(prompt, retryCount + 1);
      }
      if (!response.ok) throw new Error(`OpenAI API ${response.status}`);
      data = await response.json();
      return { text: data.choices[0]?.message?.content || '', usage: data.usage || null };
    }
  } catch (err) {
    if (retryCount < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, BASE_DELAY * Math.pow(2, retryCount)));
      return callLLM(prompt, retryCount + 1);
    }
    console.error('LLM调用失败:', err.message);
    return null;
  }
}

function buildBatchPrompt(question, words) {
  const list = words.map((w, i) => `${i + 1}. ${w}`).join('\n');
  return `问题: ${question}

下面是编号的词语列表，请判断每个词是否对"回答这个问题"有帮助（即是否是回答该问题需要用到的相关概念）。

- 只挑出你判断为相关的词，不相关的词完全不要出现在输出里(不要打0分占位，直接跳过)。
- 对挑出的每个相关词，给出编号和分数(1-10整数)：
  1-3 = 弱相关，泛泛提及话题领域
  4-6 = 较相关，是问题涉及的具体概念
  7-10 = 核心概念，直接决定能否回答问题

词语列表：
${list}

只输出一个JSON数组，数组元素是{"i": 编号, "score": 分数}，只包含你判断为相关的词，不要输出任何其他文字。例如: [{"i":3,"score":8},{"i":17,"score":4}]
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
        picks.push({ index: Math.round(i) - 1, score: Math.max(1, Math.min(10, Math.round(score))) });
      }
    }
    return picks;
  } catch {
    return null;
  }
}

async function main() {
  if (!API_KEY) {
    console.error('缺少API密钥');
    process.exit(1);
  }

  const nounIndex = JSON.parse(fs.readFileSync('final-noun-index.json', 'utf-8'));
  const questions = JSON.parse(fs.readFileSync('test-questions.json', 'utf-8'));
  const qList = (Array.isArray(questions) ? questions : questions.questions).filter(
    (q) => !QUESTION_IDS || QUESTION_IDS.includes(q.id)
  );

  console.log('========== 相关词LLM打分（一步到位：LLM扫描全部名词，只留相关词+分数） ==========');
  console.log(`全量唯一名词数: ${nounIndex.nouns.length}`);
  console.log(`问题数: ${qList.length}`);
  console.log(`批量大小: ${BATCH_SIZE}, 并发: ${CONCURRENCY}`);
  console.log(`每题批次数: ${Math.ceil(nounIndex.nouns.length / BATCH_SIZE)}\n`);

  const allResults = [];

  for (const q of qList) {
    console.log(`--- 问题 [${q.id}] ${q.question} ---`);

    const batches = [];
    for (let i = 0; i < nounIndex.nouns.length; i += BATCH_SIZE) {
      batches.push(nounIndex.nouns.slice(i, i + BATCH_SIZE));
    }

    const picked = new Map(); // globalIndex -> score
    let promptTokens = 0;
    let completionTokens = 0;
    let failedBatches = 0;

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
        process.stdout.write(`\r  批次进度: ${myIdx + 1}/${batches.length} (已选中 ${picked.size} 词)`);
      }
    });
    await Promise.all(workers);
    console.log(`\n  失败批次: ${failedBatches}/${batches.length}, tokens: prompt=${promptTokens} completion=${completionTokens}`);

    const nounScores = [...picked.entries()]
      .map(([globalIdx, score]) => {
        const n = nounIndex.nouns[globalIdx];
        return { id: n.id, surface: n.surface, df: n.offsets.length, offsets: n.offsets, score };
      })
      .sort((a, b) => b.score - a.score);

    console.log(`  LLM选中相关词: ${nounScores.length}/${nounIndex.nouns.length}`);

    allResults.push({
      questionId: q.id,
      question: q.question,
      zone: q.zone,
      totalNouns: nounIndex.nouns.length,
      selectedCount: nounScores.length,
      scores: nounScores,
      tokenCost: { promptTokens, completionTokens },
      failedBatches,
    });

    // 增量写盘，避免长跑中途失败丢全部结果
    fs.writeFileSync('noun-scores-llm.json', JSON.stringify(allResults, null, 2), 'utf-8');
  }

  console.log('\n完成，已保存: noun-scores-llm.json');
}

main().catch(console.error);
