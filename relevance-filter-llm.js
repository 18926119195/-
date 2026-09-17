/**
 * 相关性筛选 LLM 脚本（基于终词表）
 *
 * 策略：
 * 1. 从 final-noun-index-unified.json 读取所有唯一名词（19,409个）
 * 2. **批量合并**：将多个名词合并到一个LLM请求中（减少网络往返）
 * 3. **并行批处理**：多个批次同时调用LLM（提速）
 * 4. **严格prompt控制**：确保LLM只输出终词表中的名词（防止幻觉）
 * 5. **注意力窗口优化**：根据DeepSeek窗口大小（64K tokens）动态调整批量大小
 *
 * 用法：
 *   node relevance-filter-llm.js --query "用户问题" [--threshold 0.7]
 */

import fs from 'fs';

const FINAL_NOUN_INDEX_PATH = 'C:\\Users\\Administrator\\Desktop\\decide-design-v2-main\\final-noun-index-unified.json';

// ---------- LLM 配置 ----------
const LLM_PROVIDER = process.env.LLM_PROVIDER || (process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'openai');
const API_KEY = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.LLM_MODEL || (LLM_PROVIDER === 'anthropic' ? 'claude-3-5-haiku-20241022' : 'deepseek-chat');
const BASE_URL = process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.deepseek.com/v1';

// ---------- 并行控制 ----------
// DeepSeek 注意力窗口: 64K tokens（约25-30万字符）
// 保守估计: 每个名词平均14字符，1个名词≈3.5 tokens
// 每批最多放入3000个名词（约10.5K tokens），留50K给系统提示词+输出
const MAX_TOKENS_PER_BATCH = 10000; // 每批最多10K tokens（输入）
const AVG_CHARS_PER_NOUN = 14; // 根据check-unique-nouns.js统计结果
const AVG_TOKENS_PER_NOUN = Math.ceil(AVG_CHARS_PER_NOUN / 4); // ≈3.5 tokens/词
const BATCH_SIZE = Math.floor(MAX_TOKENS_PER_BATCH / AVG_TOKENS_PER_NOUN); // ≈2857个名词/批

const CONCURRENCY = parseInt(process.env.LLM_CONCURRENCY || '3', 10); // 降低并发（DeepSeek限流）

// ---------- 命令行参数解析 ----------
function parseArgs() {
  const args = process.argv.slice(2);
  let query = '';
  let outputPath = 'relevance-result.json';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--query' && i + 1 < args.length) {
      query = args[++i];
    } else if (args[i] === '--output' && i + 1 < args.length) {
      outputPath = args[++i];
    }
  }

  if (!query) {
    console.error('错误：缺少 --query 参数');
    console.error('用法：node relevance-filter-llm.js --query "用户问题" [--output output.json]');
    process.exit(1);
  }

  return { query, outputPath };
}

// ---------- LLM 调用封装（带429限流重试+指数退避） ----------
async function callLLM(prompt, signal, retryCount = 0) {
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
          max_tokens: 4096,
          temperature: 0,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal,
      });

      if (response.status === 429 && retryCount < MAX_RETRIES) {
        const delay = BASE_DELAY * Math.pow(2, retryCount);
        console.warn(`[429限流] 等待 ${delay}ms 后重试 (${retryCount + 1}/${MAX_RETRIES})...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return callLLM(prompt, signal, retryCount + 1);
      }

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Anthropic API 错误 ${response.status}: ${text}`);
      }

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
          max_tokens: 4096,
          thinking: { type: 'disabled' },
          messages: [{ role: 'user', content: prompt }],
        }),
        signal,
      });

      if (response.status === 429 && retryCount < MAX_RETRIES) {
        const delay = BASE_DELAY * Math.pow(2, retryCount);
        console.warn(`[429限流] 等待 ${delay}ms 后重试 (${retryCount + 1}/${MAX_RETRIES})...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return callLLM(prompt, signal, retryCount + 1);
      }

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`OpenAI API 错误 ${response.status}: ${text}`);
      }

      const data = await response.json();
      return data.choices[0]?.message?.content || '';
    }
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    if (retryCount < MAX_RETRIES) {
      const delay = BASE_DELAY * Math.pow(2, retryCount);
      console.warn(`[网络错误] ${err.message}，等待 ${delay}ms 后重试...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return callLLM(prompt, signal, retryCount + 1);
    }
    throw err;
  }
}

// ---------- 批量提示词构建（紧凑格式，严格控制token） ----------
function buildBatchPrompt(query, nouns) {
  // 关键优化：用机器符号【【N】】代替完整JSON，减少token消耗，避免碰撞
  const nounList = nouns.map((n, idx) => `【【${idx + 1}】】${n}`).join('\n');

  return `问题: ${query}

从下列名词中选出所有与问题相关的词（可解决问题或提供线索）：

${nounList}

只返回相关名词的机器符号（逗号分隔，如：【【1】】,【【5】】），不解释：`;
}

// ---------- 解析批量LLM输出 ----------
function parseBatchLLMOutput(rawOutput, nouns, batchIdForDebug) {
  // 提取机器符号【【N】】（支持 "【【1】】,【【2】】" 或换行分隔）
  const symbolMatches = rawOutput.match(/【【(\d+)】】/g);
  if (!symbolMatches) {
    console.warn(`LLM输出无法解析机器符号，返回空结果 (批次 ${batchIdForDebug})`);
    console.warn('原始输出:', rawOutput.slice(0, 200));
    return [];
  }

  const selectedNouns = [];
  for (const symbol of symbolMatches) {
    const numMatch = symbol.match(/【【(\d+)】】/);
    if (!numMatch) continue;
    
    const idx = parseInt(numMatch[1], 10) - 1; // 编号从1开始，数组从0开始
    if (idx >= 0 && idx < nouns.length) {
      selectedNouns.push(nouns[idx]);
    }
  }

  return selectedNouns;
}

// ---------- 并行批处理 ----------
async function processBatchesParallel(batches, concurrency, query) {
  const results = [];
  const queue = [...batches];
  let completed = 0;

  const workers = Array.from({ length: concurrency }, async (_, workerId) => {
    while (queue.length > 0) {
      const batch = queue.shift();
      if (!batch) break;

      try {
        const prompt = buildBatchPrompt(query, batch.nouns);
        const rawOutput = await callLLM(prompt);
        const selectedNouns = parseBatchLLMOutput(rawOutput, batch.nouns, batch.batchId);

        completed++;
        console.log(`[Worker ${workerId}] 批次 ${batch.batchId}/${batches.length} 完成，筛选出 ${selectedNouns.length}/${batch.nouns.length} 个相关词`);

        results.push({ batchId: batch.batchId, selectedNouns, ok: true });
      } catch (err) {
        console.error(`[Worker ${workerId}] 批次 ${batch.batchId} 失败:`, err.message);
        results.push({ batchId: batch.batchId, ok: false, error: err.message });
      }
    }
  });

  await Promise.all(workers);
  return results;
}

// ---------- 主流程 ----------
async function main() {
  if (!API_KEY) {
    console.error('缺少API密钥，请设置环境变量 OPENAI_API_KEY 或 ANTHROPIC_API_KEY');
    process.exit(1);
  }

  const { query, outputPath } = parseArgs();

  console.log('========== 相关性筛选 LLM ==========');
  console.log(`用户问题: "${query}"`);
  console.log(`LLM: ${LLM_PROVIDER} / ${MODEL}`);
  console.log(`批量大小: ${BATCH_SIZE} 个名词/批（基于${MAX_TOKENS_PER_BATCH} tokens限制）`);
  console.log(`并发数: ${CONCURRENCY}\n`);

  // 1. 读取终词表
  const finalNounIndex = JSON.parse(fs.readFileSync(FINAL_NOUN_INDEX_PATH, 'utf-8'));
  const allNouns = finalNounIndex.nouns;

  console.log(`加载终词表: ${allNouns.length} 个唯一名词\n`);

  // 2. 提取唯一surface（去重）
  const uniqueSurfaces = [...new Set(allNouns.map(n => n.surface))];
  console.log(`去重后: ${uniqueSurfaces.length} 个唯一名词（重复率 ${((1 - uniqueSurfaces.length / allNouns.length) * 100).toFixed(2)}%）\n`);

  // 3. 分批（每批BATCH_SIZE个名词）
  const batches = [];
  for (let i = 0; i < uniqueSurfaces.length; i += BATCH_SIZE) {
    const batchNouns = uniqueSurfaces.slice(i, i + BATCH_SIZE);
    batches.push({
      batchId: Math.floor(i / BATCH_SIZE) + 1,
      nouns: batchNouns,
    });
  }

  console.log(`分批完成: ${batches.length} 批 (每批最多${BATCH_SIZE}个名词)\n`);
  console.log('开始并行调用LLM筛选...\n');

  // 4. 并行处理
  const startTime = Date.now();
  const batchResults = await processBatchesParallel(batches, CONCURRENCY, query);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`\nLLM筛选完成，耗时 ${elapsed}s\n`);

  // 5. 聚合结果
  const allSelectedNouns = new Set();
  for (const batchResult of batchResults) {
    if (!batchResult.ok) continue;
    for (const noun of batchResult.selectedNouns) {
      allSelectedNouns.add(noun);
    }
  }

  const selectedNouns = [...allSelectedNouns].sort();

  // 6. 回终词表捞出完整位置信息
  const selectedEntries = [];
  for (const surface of selectedNouns) {
    const entries = allNouns.filter(n => n.surface === surface);
    if (entries.length > 0) {
      selectedEntries.push(...entries);
    }
  }

  // 7. 输出报告
  const output = {
    meta: {
      query,
      llmProvider: LLM_PROVIDER,
      model: MODEL,
      totalNouns: uniqueSurfaces.length,
      selectedNouns: selectedNouns.length,
      selectionRate: `${(selectedNouns.length / uniqueSurfaces.length * 100).toFixed(2)}%`,
      totalPositions: selectedEntries.reduce((sum, e) => sum + e.offsets.length, 0),
      elapsedSeconds: parseFloat(elapsed),
      batchSize: BATCH_SIZE,
      batches: batches.length,
      concurrency: CONCURRENCY,
    },
    selectedNouns: selectedEntries,
  };

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf-8');

  console.log('========== 筛选完成 ==========');
  console.log(`相关名词数: ${selectedNouns.length} / ${uniqueSurfaces.length} (${output.meta.selectionRate})`);
  console.log(`总位置数: ${output.meta.totalPositions} 处`);
  console.log(`输出文件: ${outputPath}`);
  console.log(`\n前20个相关名词:`);
  selectedNouns.slice(0, 20).forEach((n, i) => {
    const entry = selectedEntries.find(e => e.surface === n);
    console.log(`  ${i + 1}. ${n} (${entry?.offsets.length || 0}处)`);
  });
}

main().catch((err) => {
  console.error('执行失败:', err);
  process.exit(1);
});
