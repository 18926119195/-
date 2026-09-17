/**
 * LLM评判脚本 v2：对分层抽样后的候选chunk（candidate-texts-deduped-v2.json）
 * 逐个调用LLM判断相关性（0/1/2），然后按nounCount门槛线(3/5/8/10)
 * 重新切割统计 precision/recall/F1，同时记录token消耗用于成本分析。
 */

import fs from 'fs';

const LLM_PROVIDER = process.env.LLM_PROVIDER || (process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'openai');
const API_KEY = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.LLM_MODEL || (LLM_PROVIDER === 'anthropic' ? 'claude-3-5-haiku-20241022' : 'deepseek-chat');
const BASE_URL = process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.deepseek.com';
const CONCURRENCY = parseInt(process.env.LLM_CONCURRENCY || '5', 10);

const candidates = JSON.parse(fs.readFileSync('candidate-texts-deduped-v2.json', 'utf-8'));

async function callLLM(prompt, retryCount = 0) {
  const MAX_RETRIES = 3;
  const BASE_DELAY = 2000;
  try {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        max_tokens: 16,
        thinking: { type: 'disabled' },
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (response.status === 429 && retryCount < MAX_RETRIES) {
      const delay = BASE_DELAY * Math.pow(2, retryCount);
      await new Promise((r) => setTimeout(r, delay));
      return callLLM(prompt, retryCount + 1);
    }
    if (!response.ok) throw new Error(`API ${response.status}`);
    const data = await response.json();
    return {
      text: data.choices[0]?.message?.content || '',
      promptTokens: data.usage?.prompt_tokens || 0,
      completionTokens: data.usage?.completion_tokens || 0,
    };
  } catch (err) {
    if (retryCount < MAX_RETRIES) {
      const delay = BASE_DELAY * Math.pow(2, retryCount);
      await new Promise((r) => setTimeout(r, delay));
      return callLLM(prompt, retryCount + 1);
    }
    console.error('LLM调用失败:', err.message);
    return null;
  }
}

function buildJudgmentPrompt(question, chunkText, page, nounCount) {
  const text = chunkText.slice(0, 500);
  return `问题: ${question}

候选文本 (来自p.${page}, nounCount=${nounCount}):
${text}

请判断这个候选文本是否能回答上述问题。只需回复数字：
0 = 完全无关，不包含回答所需信息
1 = 部分相关，包含一些相关信息但不完整
2 = 完全相关，包含足够信息回答问题

回复（只回复0、1或2）：`;
}

function parseJudgment(response) {
  if (!response) return null;
  const match = response.match(/\b([012])\b/);
  return match ? parseInt(match[1], 10) : null;
}

async function main() {
  if (!API_KEY) {
    console.error('缺少API密钥');
    process.exit(1);
  }

  console.log('========== LLM评判开始 (v2 分层抽样) ==========');
  console.log(`LLM: ${LLM_PROVIDER} / ${MODEL}\n`);

  const results = [];
  const queue = [];
  for (const q of candidates) {
    for (const chunk of q.chunks) {
      queue.push({ question: q.question, questionId: q.questionId, zone: q.zone, chunk });
    }
  }
  const total = queue.length;
  let idx = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (true) {
      const item = queue.shift();
      if (!item) break;

      const prompt = buildJudgmentPrompt(item.question, item.chunk.text, item.chunk.page, item.chunk.nounCount);
      const resp = await callLLM(prompt);
      const judgment = resp ? parseJudgment(resp.text) : null;
      if (resp) {
        totalPromptTokens += resp.promptTokens;
        totalCompletionTokens += resp.completionTokens;
      }

      results.push({
        questionId: item.questionId,
        zone: item.zone,
        page: item.chunk.page,
        nounCount: item.chunk.nounCount,
        chunkKey: item.chunk.chunkKey,
        judgment,
      });

      idx++;
      process.stdout.write(`\r进度: ${idx}/${total} (${(idx / total * 100).toFixed(1)}%)`);
    }
  });

  await Promise.all(workers);
  console.log('\n');

  const thresholds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  console.log('========== 各nounCount门槛 precision/recall/F1/成本 分析 ==========\n');

  // 真值相关集合：以该问题全部抽样候选中judgment>=1的作为近似真值（用于recall分母）
  const relevantSetByQuestion = new Map();
  for (const r of results) {
    if (r.judgment !== null && r.judgment >= 1) {
      relevantSetByQuestion.set(r.questionId, (relevantSetByQuestion.get(r.questionId) || 0) + 1);
    }
  }

  const statsByThreshold = {};
  for (const th of thresholds) {
    const atThreshold = results.filter((r) => r.nounCount >= th);
    const judged = atThreshold.filter((r) => r.judgment !== null);
    const relevant = judged.filter((r) => r.judgment >= 1).length;
    const fullyRelevant = judged.filter((r) => r.judgment === 2).length;
    const precision = judged.length > 0 ? relevant / judged.length : 0;

    const questionIds = [...new Set(atThreshold.map((r) => r.questionId))];
    const recalls = [];
    for (const qid of questionIds) {
      const totalRelevant = relevantSetByQuestion.get(qid) || 0;
      if (totalRelevant === 0) continue;
      const recalledAtTh = results.filter(
        (r) => r.questionId === qid && r.nounCount >= th && r.judgment !== null && r.judgment >= 1
      ).length;
      recalls.push(Math.min(1, recalledAtTh / totalRelevant));
    }
    const avgRecall = recalls.length > 0 ? recalls.reduce((s, v) => s + v, 0) / recalls.length : null;
    const f1 =
      avgRecall !== null && precision > 0
        ? (2 * precision * avgRecall) / (precision + avgRecall)
        : 0;

    statsByThreshold[th] = {
      candidateCount: atThreshold.length,
      judged: judged.length,
      relevant,
      fullyRelevant,
      precision: precision.toFixed(3),
      recall: avgRecall !== null ? avgRecall.toFixed(3) : 'N/A',
      f1: f1.toFixed(3),
      passRate: (atThreshold.length / results.length * 100).toFixed(1) + '%',
    };

    console.log(
      `nounCount>=${th}: 候选=${atThreshold.length} (${statsByThreshold[th].passRate}), 精确率=${statsByThreshold[th].precision}, 召回率=${statsByThreshold[th].recall}, F1=${statsByThreshold[th].f1}`
    );
  }

  console.log(`\n总prompt tokens: ${totalPromptTokens}, 总completion tokens: ${totalCompletionTokens}`);
  console.log(`平均每次判断token: ${((totalPromptTokens + totalCompletionTokens) / total).toFixed(1)}`);

  fs.writeFileSync(
    'judgment-results-v2.json',
    JSON.stringify(
      {
        rawResults: results,
        statsByThreshold,
        tokenCost: { totalPromptTokens, totalCompletionTokens, totalCalls: total },
        meta: { totalCandidates: total, judged: results.filter((r) => r.judgment !== null).length },
      },
      null,
      2
    ),
    'utf-8'
  );

  console.log('详细结果已保存: judgment-results-v2.json');
}

main().catch(console.error);
