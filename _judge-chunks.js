/**
 * LLM评判脚本：判断每个候选chunk是否真的能回答问题
 *
 * 对每个问题的候选chunk，调用LLM判断：
 * - 0: 完全无关，chunk不包含回答问题所需的信息
 * - 1: 部分相关，chunk包含一些相关信息但不完整
 * - 2: 完全相关，chunk包含足够信息回答问题
 *
 * 输出：精确率/召回率/F1 随阈值变化的曲线数据
 */

import fs from 'fs';

const LLM_PROVIDER = process.env.LLM_PROVIDER || (process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'openai');
const API_KEY = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.LLM_MODEL || (LLM_PROVIDER === 'anthropic' ? 'claude-3-5-haiku-20241022' : 'deepseek-chat');
const BASE_URL = process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.deepseek.com';
const CONCURRENCY = parseInt(process.env.LLM_CONCURRENCY || '3', 10);

const candidates = JSON.parse(fs.readFileSync('candidate-texts-deduped.json', 'utf-8'));

async function callLLM(prompt, retryCount = 0) {
  const MAX_RETRIES = 3;
  const BASE_DELAY = 2000;
  try {
    if (LLM_PROVIDER === 'anthropic') {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 16,
          temperature: 0,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (response.status === 429 && retryCount < MAX_RETRIES) {
        const delay = BASE_DELAY * Math.pow(2, retryCount);
        await new Promise((r) => setTimeout(r, delay));
        return callLLM(prompt, retryCount + 1);
      }
      if (!response.ok) throw new Error(`Anthropic API ${response.status}`);
      const data = await response.json();
      return data.content[0]?.text || '';
    } else {
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
      if (!response.ok) throw new Error(`OpenAI API ${response.status}`);
      const data = await response.json();
      return data.choices[0]?.message?.content || '';
    }
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

  console.log('========== LLM评判开始 ==========');
  console.log(`LLM: ${LLM_PROVIDER} / ${MODEL}\n`);

  const results = [];
  const queue = [];
  for (const q of candidates) {
    for (let i = 0; i < q.chunks.length; i++) {
      const chunk = q.chunks[i];
      queue.push({ question: q.question, questionId: q.questionId, zone: q.zone, chunk, idx: i });
    }
  }
  const total = queue.length;

  let idx = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (true) {
      const item = queue.shift();
      if (!item) break;

      const prompt = buildJudgmentPrompt(item.question, item.chunk.text, item.chunk.page, item.chunk.nounCount);
      const response = await callLLM(prompt);
      const judgment = parseJudgment(response);

      results.push({
        questionId: item.questionId,
        zone: item.zone,
        page: item.chunk.page,
        nounCount: item.chunk.nounCount,
        minThreshold: item.chunk.minThresholdSelected,
        judgment,
      });

      idx++;
      process.stdout.write(`\r进度: ${idx}/${total} (${(idx / total * 100).toFixed(1)}%)`);
    }
  });

  await Promise.all(workers);
  console.log('\n');

  const thresholds = [3, 5, 8, 10];
  console.log('========== 各阈值精确率/召回率分析 ==========\n');

  const statsByThreshold = {};
  // 每个问题的“完整候选集合”= threshold=3时的候选（最宽松，代表全部可能相关chunk的近似真值集）
  // 用于计算召回率：某阈值下选出的相关chunk / 该问题在threshold=3时判定为相关的全部chunk
  const relevantSetByQuestion = new Map();
  for (const r of results) {
    if (r.minThreshold <= 3 && r.judgment !== null && r.judgment >= 1) {
      if (!relevantSetByQuestion.has(r.questionId)) relevantSetByQuestion.set(r.questionId, 0);
      relevantSetByQuestion.set(r.questionId, relevantSetByQuestion.get(r.questionId) + 1);
    }
  }

  for (const th of thresholds) {
    const chunksAtThreshold = results.filter((r) => r.minThreshold <= th);

    const zoneStats = {};
    for (const zone of [1, 2, 3, 4]) {
      const zoneChunks = chunksAtThreshold.filter((r) => r.zone === zone);
      const judged = zoneChunks.filter((r) => r.judgment !== null);
      const relevant = judged.filter((r) => r.judgment >= 1).length;
      const fullyRelevant = judged.filter((r) => r.judgment === 2).length;
      const precision = judged.length > 0 ? relevant / judged.length : 0;

      zoneStats[zone] = {
        total: zoneChunks.length,
        judged: judged.length,
        relevant,
        fullyRelevant,
        precision: precision.toFixed(3),
      };
    }

    // 按问题计算召回率，再取平均
    const questionIds = [...new Set(chunksAtThreshold.map((r) => r.questionId))];
    const recalls = [];
    for (const qid of questionIds) {
      const totalRelevant = relevantSetByQuestion.get(qid) || 0;
      if (totalRelevant === 0) continue; // 无真值相关chunk（如控制组问题），跳过
      const recalledAtTh = results.filter(
        (r) => r.questionId === qid && r.minThreshold <= th && r.judgment !== null && r.judgment >= 1
      ).length;
      recalls.push(Math.min(1, recalledAtTh / totalRelevant));
    }
    const avgRecall = recalls.length > 0 ? recalls.reduce((s, v) => s + v, 0) / recalls.length : null;

    statsByThreshold[th] = zoneStats;

    const totalJudged = Object.values(zoneStats).reduce((s, z) => s + z.judged, 0);
    const totalRelevant = Object.values(zoneStats).reduce((s, z) => s + z.relevant, 0);
    const overallPrecision = totalJudged > 0 ? (totalRelevant / totalJudged).toFixed(3) : 'N/A';
    const f1 =
      avgRecall !== null && totalJudged > 0
        ? ((2 * (totalRelevant / totalJudged) * avgRecall) / (totalRelevant / totalJudged + avgRecall)).toFixed(3)
        : 'N/A';

    console.log(`阈值 >= ${th}词 (候选数=${chunksAtThreshold.length}):`);
    console.log(`  Zone1(简单): ${zoneStats[1].relevant}/${zoneStats[1].judged} 相关, 精确率=${zoneStats[1].precision}`);
    console.log(`  Zone2(中等): ${zoneStats[2].relevant}/${zoneStats[2].judged} 相关, 精确率=${zoneStats[2].precision}`);
    console.log(`  Zone3(困难): ${zoneStats[3].relevant}/${zoneStats[3].judged} 相关, 精确率=${zoneStats[3].precision}`);
    console.log(`  Zone4(极难): ${zoneStats[4].relevant}/${zoneStats[4].judged} 相关, 精确率=${zoneStats[4].precision}`);
    console.log(`  总体精确率: ${overallPrecision}`);
    console.log(`  平均召回率: ${avgRecall !== null ? avgRecall.toFixed(3) : 'N/A'}`);
    console.log(`  F1: ${f1}\n`);
  }

  fs.writeFileSync(
    'judgment-results.json',
    JSON.stringify(
      {
        rawResults: results,
        statsByThreshold,
        meta: { totalCandidates: total, judged: results.filter((r) => r.judgment !== null).length },
      },
      null,
      2
    ),
    'utf-8'
  );

  console.log('详细结果已保存: judgment-results.json');
}

main().catch(console.error);
