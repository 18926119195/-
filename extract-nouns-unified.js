/**
 * 统一名词抽取流程（s0 spaCy + s1 LLM，chunk 级并发，一体式）
 *
 * 核心原则：
 *   1. 纯文表是唯一的全局坐标系（每个 chunk 有 startOffset/endOffset）
 *   2. 所有名词的 offsets 都换算为相对纯文表的全局偏移量（绝对位置）
 *   3. 同一个名词在不同位置保留多个 offset（按 `${start}-${end}` 去重）
 *   4. 不做"覆盖回纯文表"，只记录偏移量，下游召回时直接 slice
 *
 * 流程：
 *   1. 构建 chunk 级纯文表（每个 chunk 独立，含全局偏移量）
 *   2. 并发处理每个 chunk：
 *      a. spaCy 抽取 s0 名词（局部偏移 → 全局偏移）
 *      b. 计算 chunk 内剩余文（s0 未覆盖的区间）
 *      c. LLM 补缺剩余文抽取 s1 名词（在 chunk 内定位 → 全局偏移）
 *   3. 全局去重合并（按 surface 合并，按 offset 去重）
 *   4. 输出最终名词索引（含全局偏移量）
 *
 * 用法：
 *   # 启用 s1 LLM 补缺（默认）
 *   OPENAI_API_KEY=sk-xxx node extract-nouns-unified.js
 *
 *   # 仅 s0 spaCy（跳过 s1）
 *   SKIP_S1=1 node extract-nouns-unified.js
 */

import fs from 'fs';

// ---------- 配置 ----------
const DOCUVERSE_PATH = 'C:\\Users\\Administrator\\Desktop\\docuverse_cartographies_squizoanalythiques_Fe_lix_Guattari_1789114122714.docuverse.json';
const OUTPUT_PATH = 'C:\\Users\\Administrator\\Desktop\\decide-design-v2-main\\final-noun-index-unified.json';
const SPACY_URL = 'http://localhost:5001/extract_nouns';

const CHUNK_CONCURRENCY = parseInt(process.env.CHUNK_CONCURRENCY || '8', 10);
const SKIP_S1 = process.env.SKIP_S1 === '1';
const MIN_RESIDUAL_LEN = 12; // 剩余文最小长度（太短的截断不送 LLM）

// LLM 配置
const LLM_PROVIDER = process.env.LLM_PROVIDER || (process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'openai');
const API_KEY = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.LLM_MODEL || (LLM_PROVIDER === 'anthropic' ? 'claude-3-5-haiku-20241022' : 'gpt-4o-mini');
const BASE_URL = process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';

// ---------- 纯文表构建（与旧版保持一致） ----------
function stripHtmlTags(text) {
  return text
    .replace(/<\/?(?:div|table|tr|td|th|thead|tbody|sup|sub|span|p|br)\b[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '');
}

function stripLatexResidue(text) {
  return text
    .replace(/\$\$[^$]*\$\$/g, ' ')
    .replace(/\$[^$\n]*\$/g, ' ')
    .replace(/\\[a-zA-Z]+(?:\{[^{}]*\})*/g, ' ')
    .replace(/\\+/g, ' ')
    .replace(/[\^_]\{[^{}]*\}/g, ' ')
    .replace(/\s{2,}/g, ' ');
}

function atomSearchText(chunk) {
  const text = chunk.faces?.text?.content?.trim();
  if (text && text.length >= 8) return stripLatexResidue(stripHtmlTags(text));
  const raw = (chunk.content || '').trim();
  if (raw && !raw.startsWith('[FIG:') && raw.length >= 8) return stripLatexResidue(stripHtmlTags(raw));
  if (text) return stripLatexResidue(stripHtmlTags(text));
  const note = (chunk.faces?.fig?.note || '').trim();
  return stripLatexResidue(stripHtmlTags(
    note
      .replace(/请依据可见版面回答[^。]*。?/g, '')
      .replace(/勿编造未提供的文字[^。]*。?/g, '')
      .replace(/无文字层\/未OCR[^。]*。?/g, '')
      .trim(),
  ));
}

function isRetrievableAtom(chunk) {
  const t = atomSearchText(chunk);
  if (t.length < 4) return false;
  if (chunk.kind === 'fig' && t.length < 24 && !chunk.faces?.text) return false;
  if (chunk.kind === 'fig' && !chunk.faces?.text) {
    const rawNote = chunk.faces?.fig?.note || '';
    if (/无文字层|未OCR/.test(rawNote)) return false;
  }
  return true;
}

function buildChunkEntries(bookIndex) {
  const entries = [];
  let offset = 0;
  for (const chunk of bookIndex.chunks) {
    if (!isRetrievableAtom(chunk)) continue;
    const text = atomSearchText(chunk).trim();
    if (!text) continue;
    const startOffset = offset;
    const endOffset = offset + text.length;
    entries.push({ chunkKey: chunk.key, page: chunk.page, text, startOffset, endOffset });
    offset = endOffset + 1;
  }
  return entries;
}

// ---------- 噪声过滤 ----------
const FRENCH_FUNCTION_WORDS = new Set([
  'de', 'la', 'le', 'les', 'un', 'une', 'des', 'du', 'et', 'en', 'au', 'aux',
  'ce', 'ces', 'cet', 'cette', 'son', 'sa', 'ses', 'il', 'elle', 'ils', 'elles',
  'on', 'qui', 'que', 'quoi', 'dans', 'pour', 'par', 'sur', 'pas', 'plus',
  'tout', 'tous', 'toute', 'toutes', 'ne', 'se', 'sont', 'est', 'ont', 'a',
  'ou', 'mais', 'donc', 'or', 'ni', 'car', 'si', 'y', 'lui', 'leur', 'leurs',
  'nous', 'vous', 'je', 'tu', 'mon', 'ma', 'mes', 'ton', 'ta', 'tes', 'notre',
  'votre', 'nos', 'vos', 'avec', 'sans', 'sous', 'vers', 'chez', 'entre',
]);

const OCR_JUNK_RE = /^[A-Za-zΦΣ]\.$|^\d+\)?\.?$|^##+$|^[a-zA-Z]\/$|^p\.$/;

function isJunkSurface(surface) {
  const trimmed = surface.trim();
  if (OCR_JUNK_RE.test(trimmed)) return true;
  if (FRENCH_FUNCTION_WORDS.has(trimmed.toLowerCase())) return true;
  return false;
}

function normalizeId(surface) {
  return surface.toLowerCase().trim().replace(/\s+/g, '_');
}

// ---------- s0: spaCy 抽取（返回全局偏移量） ----------
async function callSpacy(text) {
  const res = await fetch(SPACY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      include_proper_nouns: true,
      include_nouns: true,
      min_length: 2,
    }),
  });
  if (!res.ok) throw new Error(`spaCy error ${res.status}`);
  return res.json();
}

function extractS0FromChunk(entry, spacyResult) {
  const localTokens = [
    ...(spacyResult.nouns || []),
    ...(spacyResult.noun_phrases || []),
  ];
  // 局部偏移 → 全局偏移
  return localTokens.map((t) => ({
    surface: t.surface,
    start: entry.startOffset + t.start, // 全局坐标
    end: entry.startOffset + t.end,
    localStart: t.start,
    localEnd: t.end,
  }));
}

// ---------- 计算 chunk 内剩余文（s0 未覆盖的区间） ----------
function extractResiduals(entry, s0Tokens) {
  const len = entry.text.length;
  const hitMask = new Array(len).fill(false);
  for (const t of s0Tokens) {
    for (let i = Math.max(0, t.localStart); i < Math.min(len, t.localEnd); i++) {
      hitMask[i] = true;
    }
  }

  const residuals = [];
  let i = 0;
  while (i < len) {
    if (!hitMask[i]) {
      let j = i;
      while (j < len && !hitMask[j]) j++;
      const text = entry.text.slice(i, j).trim();
      if (text.length >= MIN_RESIDUAL_LEN) {
        residuals.push({
          localStart: i,
          localEnd: j,
          text,
        });
      }
      i = j;
    } else {
      i++;
    }
  }
  return residuals;
}

// ---------- s1: LLM 补缺（chunk 内剩余文） ----------
async function callLLM(prompt, retryCount = 0) {
  const MAX_RETRIES = 3;
  const BASE_DELAY = 2000;

  try {
    if (LLM_PROVIDER === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 2048,
          temperature: 0.1,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (res.status === 429 && retryCount < MAX_RETRIES) {
        const delay = BASE_DELAY * Math.pow(2, retryCount);
        await new Promise((r) => setTimeout(r, delay));
        return callLLM(prompt, retryCount + 1);
      }
      if (!res.ok) throw new Error(`Anthropic error ${res.status}`);
      const data = await res.json();
      return data.content[0]?.text || '';
    } else {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0.1,
          max_tokens: 2048,
          thinking: { type: 'disabled' },
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (res.status === 429 && retryCount < MAX_RETRIES) {
        const delay = BASE_DELAY * Math.pow(2, retryCount);
        await new Promise((r) => setTimeout(r, delay));
        return callLLM(prompt, retryCount + 1);
      }
      if (!res.ok) throw new Error(`OpenAI error ${res.status}`);
      const data = await res.json();
      return data.choices[0]?.message?.content || '';
    }
  } catch (err) {
    if (retryCount < MAX_RETRIES) {
      const delay = BASE_DELAY * Math.pow(2, retryCount);
      await new Promise((r) => setTimeout(r, delay));
      return callLLM(prompt, retryCount + 1);
    }
    throw err;
  }
}

function buildS1Prompt(residuals) {
  if (residuals.length === 0) return null;
  const sections = residuals.map((r, i) => `[片段${i + 1}]\n${r.text}`).join('\n\n');
  return `提取以下文本片段中的所有名词（名词、专有名词、名词短语）。只提取名词，不要动词/形容词/连词。保持原文形式（含重音符号）。

输出格式（严格JSON）：
\`\`\`json
[
  {"fragment_id": 1, "nouns": ["名词1", "名词2"]},
  {"fragment_id": 2, "nouns": ["名词3"]}
]
\`\`\`

文本：

${sections}

只返回JSON，不要其他文字：`;
}

function parseS1Output(rawOutput) {
  let jsonText = '';
  const match = rawOutput.match(/```json\s*([\s\S]*?)\s*```/) || rawOutput.match(/\[[\s\S]*\]/);
  if (match) jsonText = match[1] || match[0];
  if (!jsonText) return [];

  try {
    let fixed = jsonText.trim();
    const openBrackets = (fixed.match(/\[/g) || []).length;
    const closeBrackets = (fixed.match(/\]/g) || []).length;
    const openBraces = (fixed.match(/\{/g) || []).length;
    const closeBraces = (fixed.match(/\}/g) || []).length;
    if (openBrackets > closeBrackets) {
      if (openBraces > closeBraces) fixed += '}';
      fixed += ']';
    }
    const parsed = JSON.parse(fixed);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => ({
      fragment_id: item.fragment_id || 0,
      nouns: (item.nouns || []).filter((n) => typeof n === 'string' && n.trim().length >= 2),
    }));
  } catch {
    return [];
  }
}

// 在 chunk 内定位 LLM 返回的名词 → 转换为全局偏移量
function locateS1NounInChunk(noun, entry, residual) {
  const needle = noun.toLowerCase().trim();
  const chunkTextLower = entry.text.toLowerCase();
  const offsets = [];

  // 优先在对应残余片段 ±20 字符范围内搜索
  const searchStart = Math.max(0, residual.localStart - 20);
  const searchEnd = Math.min(entry.text.length, residual.localEnd + 20);
  const searchRegion = entry.text.slice(searchStart, searchEnd);
  const searchRegionLower = searchRegion.toLowerCase();

  let from = 0;
  while (from < searchRegionLower.length) {
    const at = searchRegionLower.indexOf(needle, from);
    if (at < 0) break;
    const localStart = searchStart + at;
    const localEnd = localStart + needle.length;
    // 转换为全局偏移
    offsets.push({
      start: entry.startOffset + localStart,
      end: entry.startOffset + localEnd,
    });
    from = at + needle.length;
  }

  // 如果在附近没找到，回退到全 chunk 搜索（但限制数量避免误匹配）
  if (offsets.length === 0) {
    let from = 0;
    while (from < chunkTextLower.length && offsets.length < 3) {
      const at = chunkTextLower.indexOf(needle, from);
      if (at < 0) break;
      offsets.push({
        start: entry.startOffset + at,
        end: entry.startOffset + at + needle.length,
      });
      from = at + needle.length;
    }
  }

  return offsets;
}

async function extractS1FromChunk(entry, residuals) {
  if (residuals.length === 0) return [];
  const prompt = buildS1Prompt(residuals);
  if (!prompt) return [];

  try {
    const rawOutput = await callLLM(prompt);
    const parsed = parseS1Output(rawOutput);
    const s1Tokens = [];

    for (const item of parsed) {
      const fragmentIdx = item.fragment_id - 1;
      if (fragmentIdx < 0 || fragmentIdx >= residuals.length) continue;
      const residual = residuals[fragmentIdx];
      for (const noun of item.nouns) {
        const offsets = locateS1NounInChunk(noun, entry, residual);
        for (const offset of offsets) {
          s1Tokens.push({ surface: noun, start: offset.start, end: offset.end });
        }
      }
    }
    return s1Tokens;
  } catch (err) {
    console.warn(`  [s1 失败] chunk ${entry.chunkKey.slice(0, 12)}...: ${err.message}`);
    return [];
  }
}

// ---------- 单个 chunk 处理（s0 + s1 一体化） ----------
async function processChunk(entry) {
  // s0: spaCy 抽取
  const spacyResult = await callSpacy(entry.text);
  const s0Tokens = extractS0FromChunk(entry, spacyResult);

  // s1: LLM 补缺（如果启用）
  let s1Tokens = [];
  if (!SKIP_S1 && API_KEY) {
    const residuals = extractResiduals(entry, s0Tokens);
    if (residuals.length > 0) {
      s1Tokens = await extractS1FromChunk(entry, residuals);
    }
  }

  return { entry, s0Tokens, s1Tokens };
}

// ---------- 并发调度 ----------
async function mapConcurrent(items, concurrency, worker) {
  const results = [];
  let cursor = 0;
  let completed = 0;

  async function run() {
    while (cursor < items.length) {
      const idx = cursor++;
      const item = items[idx];
      try {
        results[idx] = await worker(item);
      } catch (err) {
        results[idx] = { error: err, item };
      }
      completed++;
      if (completed % 50 === 0 || completed === items.length) {
        console.log(`  进度: ${completed}/${items.length} chunks`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
  return results;
}

// ---------- 主流程 ----------
async function main() {
  console.log('========== 统一名词抽取流程 ==========\n');
  console.log(`spaCy: ${SPACY_URL}`);
  console.log(`LLM: ${SKIP_S1 ? '跳过 s1' : `${LLM_PROVIDER}/${MODEL}`}`);
  console.log(`并发数: ${CHUNK_CONCURRENCY}\n`);

  const docuverse = JSON.parse(fs.readFileSync(DOCUVERSE_PATH, 'utf-8'));
  const chunkEntries = buildChunkEntries(docuverse.bookIndex);
  const totalLen = chunkEntries.reduce((s, e) => s + e.text.length, 0) + Math.max(0, chunkEntries.length - 1);
  console.log(`chunk 数: ${chunkEntries.length}，纯文表长度: ${totalLen} 字符\n`);

  console.log('开始并发处理（s0 spaCy + s1 LLM）...');
  const startTime = Date.now();
  const perChunkResults = await mapConcurrent(chunkEntries, CHUNK_CONCURRENCY, processChunk);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`处理完成，耗时 ${elapsed}s\n`);

  // 全局去重合并
  const mergedNouns = new Map();
  let s0RawCount = 0, s0JunkSkipped = 0;
  let s1RawCount = 0, s1JunkSkipped = 0;
  let failedChunks = 0;

  for (const r of perChunkResults) {
    if (r.error) {
      failedChunks++;
      continue;
    }

    // 合并 s0
    for (const t of r.s0Tokens) {
      s0RawCount++;
      const id = normalizeId(t.surface);
      if (id.length < 2) continue;
      if (isJunkSurface(t.surface)) { s0JunkSkipped++; continue; }

      if (!mergedNouns.has(id)) {
        mergedNouns.set(id, { id, surface: t.surface, offsets: [], source: 's0-spacy' });
      }
      mergedNouns.get(id).offsets.push({ start: t.start, end: t.end });
    }

    // 合并 s1
    for (const t of r.s1Tokens) {
      s1RawCount++;
      const id = normalizeId(t.surface);
      if (id.length < 2) continue;
      if (isJunkSurface(t.surface)) { s1JunkSkipped++; continue; }

      if (!mergedNouns.has(id)) {
        mergedNouns.set(id, { id, surface: t.surface, offsets: [], source: 's1-llm' });
      }
      const entry = mergedNouns.get(id);
      if (entry.source === 's0-spacy') entry.source = 's0+s1';
      entry.offsets.push({ start: t.start, end: t.end });
    }
  }

  // 每个词条内部按 offset 去重（同一位置只保留一个）
  for (const entry of mergedNouns.values()) {
    const unique = new Map();
    for (const off of entry.offsets) {
      unique.set(`${off.start}-${off.end}`, off);
    }
    entry.offsets = [...unique.values()].sort((a, b) => a.start - b.start);
  }

  console.log(`s0 原始: ${s0RawCount}，噪声跳过: ${s0JunkSkipped}`);
  console.log(`s1 原始: ${s1RawCount}，噪声跳过: ${s1JunkSkipped}`);
  console.log(`失败 chunks: ${failedChunks}\n`);

  const finalEntries = [...mergedNouns.values()].sort(
    (a, b) => b.offsets.length - a.offsets.length || a.id.localeCompare(b.id),
  );

  const s0Count = finalEntries.filter((e) => e.source === 's0-spacy').length;
  const s1Count = finalEntries.filter((e) => e.source === 's1-llm').length;
  const s0s1Count = finalEntries.filter((e) => e.source === 's0+s1').length;
  const totalOffsets = finalEntries.reduce((sum, e) => sum + e.offsets.length, 0);

  console.log('========== 完成 ==========');
  console.log(`最终名词数: ${finalEntries.length}`);
  console.log(`  - 纯 s0: ${s0Count}`);
  console.log(`  - 纯 s1: ${s1Count}`);
  console.log(`  - s0+s1: ${s0s1Count}`);
  console.log(`总位置数: ${totalOffsets}\n`);

  const output = {
    meta: {
      source: '统一抽取（chunk 级 s0+s1 并发）',
      chunkCount: chunkEntries.length,
      concurrency: CHUNK_CONCURRENCY,
      elapsedSeconds: parseFloat(elapsed),
      fullTextLength: totalLen,
      totalNouns: finalEntries.length,
      s0Count,
      s1Count,
      s0s1Count,
      totalOffsets,
      timestamp: new Date().toISOString(),
    },
    nouns: finalEntries,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`输出: ${OUTPUT_PATH}`);

  console.log(`\n前20个高频名词:`);
  finalEntries.slice(0, 20).forEach((e, i) => {
    console.log(`  ${i + 1}. ${e.surface} (${e.offsets.length}次) [${e.source}]`);
  });
}

main().catch((err) => {
  console.error('失败:', err);
  process.exit(1);
});
