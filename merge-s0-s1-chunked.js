/**
 * s0 + s1 合并流程（chunk 并发版）
 *
 * 与 merge-s0-s1.js 的区别：
 *   旧版：把所有 chunk 拼接成一个 580809 字符的大 fullText，一次性调用 spaCy。
 *   新版：按 chunk（对应 bookKey/chunk.key）独立处理——
 *     1. 每个 chunk 的文本单独送入 spaCy 抽取 s0 名词（局部偏移量）
 *     2. 局部偏移量 + chunk 的全局起始偏移 = 全局偏移量（与旧版最终格式兼容）
 *     3. chunk 内部计算 s0 未覆盖的"剩余文"（残余截断），作为 s1 候选
 *     4. 多个 chunk 并发处理（利用 spaCy 服务的并发能力，提速）
 *
 * 好处：
 *   - s1 候选截断天然是"chunk 内部"的，不会夹带前后无关 chunk 的内容，
 *     LLM 拿到的上下文边界更干净。
 *   - chunk 级并发，处理 1447 个 chunk 比一次性调用大文本更快。
 *   - 为多文档扩展打好基础：外层加一层 docId 循环即可复用。
 *
 * 注意：
 *   本脚本不解决"子串污染"问题——那个 bug 的根源是 locateSurfacesInText()
 *   做无边界检查的子串搜索，跟处理粒度（整篇 vs 按 chunk）无关。子串污染已经
 *   通过给 validate-s0-quality.js 的 locateSurfacesInText() 加词边界检查解决。
 *   本脚本延续 merge-s0-s1.js 的做法：直接使用 spaCy 返回的原生偏移量，不重新
 *   做全文子串搜索，所以本身就不受该 bug 影响。
 *
 * 用法：
 *   node merge-s0-s1-chunked.js
 */

import fs from 'fs';

const DOCUVERSE_PATH = 'C:\\Users\\Administrator\\Desktop\\docuverse_cartographies_squizoanalythiques_Fe_lix_Guattari_1789114122714.docuverse.json';
const S1_PATH = 'C:\\Users\\Administrator\\Desktop\\decide-design-v2-main\\s1-nouns-with-offsets.json';
const OUTPUT_PATH = 'C:\\Users\\Administrator\\Desktop\\decide-design-v2-main\\final-noun-index-chunked.json';
const RESIDUAL_REPORT_PATH = 'C:\\Users\\Administrator\\Desktop\\decide-design-v2-main\\s0-quality-report-chunked.json';
const SPACY_URL = 'http://localhost:5001/extract_nouns';

// chunk 并发调用 spaCy 的并发数（spaCy 服务本身是单进程同步处理，
// 并发数太高只是排队等待，不会真正提速；但仍能重叠网络往返耗时）
const CHUNK_CONCURRENCY = parseInt(process.env.CHUNK_CONCURRENCY || '8', 10);
const MIN_RESIDUAL_LEN = 10;

// ---------- 复刻 pureTextTable 构建逻辑（与 merge-s0-s1.js 保持一致） ----------
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

// 按 chunk 分组构建条目（每条 = 一个 bookKey/chunk.key），并计算全局偏移量
// （全局偏移量用于跟旧版 final-noun-index.json 的偏移量体系保持兼容，
//  不改变 fullText 的拼接方式，只改变"抽取时的处理粒度"）
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
    offset = endOffset + 1; // +1 换行分隔，与 pureTextTable.ts 保持一致
  }
  return entries;
}

// ---------- 噪声词条过滤（与 merge-s0-s1.js 保持一致） ----------
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

// ---------- 单个 chunk 调用 spaCy，返回带全局偏移量的 token 列表 ----------
async function extractS0ForChunk(entry) {
  if (entry.text.length < 2) return { entry, tokens: [] };

  const res = await fetch(SPACY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: entry.text,
      include_proper_nouns: true,
      include_nouns: true,
      min_length: 2,
    }),
  });
  const result = await res.json();

  const localTokens = [
    ...(result.nouns || []).map((n) => ({ surface: n.surface, start: n.start, end: n.end })),
    ...(result.noun_phrases || []).map((p) => ({ surface: p.surface, start: p.start, end: p.end })),
  ];

  // 局部偏移量 → 全局偏移量
  const tokens = localTokens.map((t) => ({
    surface: t.surface,
    start: entry.startOffset + t.start,
    end: entry.startOffset + t.end,
    localStart: t.start,
    localEnd: t.end,
  }));

  return { entry, tokens };
}

// ---------- 并发调度：限制同时在途的 chunk 请求数 ----------
async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  let completed = 0;

  async function run() {
    while (cursor < items.length) {
      const idx = cursor++;
      try {
        results[idx] = await worker(items[idx], idx);
      } catch (err) {
        results[idx] = { error: err, item: items[idx] };
      }
      completed++;
      if (completed % 100 === 0 || completed === items.length) {
        console.log(`  进度: ${completed}/${items.length} chunks`);
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => run());
  await Promise.all(workers);
  return results;
}

// ---------- chunk 内部计算 s0 未覆盖的残余截断（局部坐标） ----------
function extractResidualsForChunk(entry, localTokens) {
  const len = entry.text.length;
  const hitMask = new Array(len).fill(false);
  for (const t of localTokens) {
    for (let i = Math.max(0, t.localStart); i < Math.min(len, t.localEnd); i++) hitMask[i] = true;
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
          chunkKey: entry.chunkKey,
          page: entry.page,
          // 全局偏移量：与旧版 s0-quality-report.json 的 residualSamples 格式兼容
          start: entry.startOffset + i,
          length: text.length,
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

// ---------- 主流程 ----------
async function main() {
  console.log('========== s0 + s1 合并流程（chunk 并发版） ==========\n');

  const docuverse = JSON.parse(fs.readFileSync(DOCUVERSE_PATH, 'utf-8'));
  const chunkEntries = buildChunkEntries(docuverse.bookIndex);
  const totalTextLength = chunkEntries.reduce((sum, e) => sum + e.text.length, 0) + Math.max(0, chunkEntries.length - 1);
  console.log(`chunk 数: ${chunkEntries.length} 个，全文等效长度: ${totalTextLength} 字符\n`);

  console.log(`并发调用 spaCy（并发数=${CHUNK_CONCURRENCY}）...`);
  const startTime = Date.now();
  const perChunkResults = await mapWithConcurrency(chunkEntries, CHUNK_CONCURRENCY, extractS0ForChunk);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`spaCy 调用完成，耗时 ${elapsed}s\n`);

  // 合并去重 s0（跨 chunk 用全局偏移量，逻辑与旧版一致）
  const mergedNouns = new Map();
  let s0JunkSkipped = 0;
  let s0RawCount = 0;
  const residualsAll = [];

  for (const r of perChunkResults) {
    if (r.error) {
      console.warn(`chunk ${r.item?.chunkKey?.slice(0, 12)}... 处理失败: ${r.error.message}`);
      continue;
    }
    const { entry, tokens } = r;
    s0RawCount += tokens.length;

    for (const token of tokens) {
      const id = normalizeId(token.surface);
      if (id.length < 2) continue;
      if (isJunkSurface(token.surface)) { s0JunkSkipped++; continue; }

      if (!mergedNouns.has(id)) {
        mergedNouns.set(id, { id, surface: token.surface, offsets: [], source: 's0-spacy' });
      }
      mergedNouns.get(id).offsets.push({ start: token.start, end: token.end });
    }

    // chunk 内部计算残余截断（s1 候选，天然不跨 chunk）
    residualsAll.push(...extractResidualsForChunk(entry, tokens.map((t) => ({ localStart: t.localStart, localEnd: t.localEnd }))));
  }

  // 每个词条内部按 offset 去重
  for (const entry of mergedNouns.values()) {
    const unique = new Map();
    for (const off of entry.offsets) unique.set(`${off.start}-${off.end}`, off);
    entry.offsets = [...unique.values()].sort((a, b) => a.start - b.start);
  }

  console.log(`s0 原始 token 数: ${s0RawCount}（去重前），噪声跳过: ${s0JunkSkipped}`);
  console.log(`s0 去重后名词数: ${mergedNouns.size}`);
  console.log(`残余截断数（s1 候选，chunk 内隔离）: ${residualsAll.length}\n`);

  // 读取已有 s1 结果（如果存在），合并去重同时过滤噪声
  let s1Data = { nouns: [] };
  let s1JunkSkipped = 0;
  if (fs.existsSync(S1_PATH)) {
    s1Data = JSON.parse(fs.readFileSync(S1_PATH, 'utf-8'));
    console.log(`s1 补缺名词: ${s1Data.nouns.length} 个`);
  } else {
    console.log('s1 文件不存在，跳过补缺合并');
  }

  for (const s1Entry of s1Data.nouns) {
    if (mergedNouns.has(s1Entry.id)) continue;
    if (isJunkSurface(s1Entry.surface)) { s1JunkSkipped++; continue; }
    mergedNouns.set(s1Entry.id, {
      id: s1Entry.id,
      surface: s1Entry.surface,
      offsets: s1Entry.offsets,
      source: 's1-llm',
    });
  }
  console.log(`s1 噪声跳过: ${s1JunkSkipped}\n`);

  const finalEntries = [...mergedNouns.values()].sort(
    (a, b) => b.offsets.length - a.offsets.length || a.id.localeCompare(b.id),
  );

  const s0Count = finalEntries.filter((e) => e.source === 's0-spacy').length;
  const s1Count = finalEntries.filter((e) => e.source === 's1-llm').length;
  const totalOffsets = finalEntries.reduce((sum, e) => sum + e.offsets.length, 0);

  console.log('========== 合并完成 ==========');
  console.log(`最终名词数: ${finalEntries.length} 个`);
  console.log(`  - s0 (spaCy, chunk并发): ${s0Count} 个`);
  console.log(`  - s1 (LLM补缺): ${s1Count} 个`);
  console.log(`总位置数: ${totalOffsets} 处\n`);

  const output = {
    meta: {
      source: 's0 + s1 合并（chunk 并发版）',
      chunkCount: chunkEntries.length,
      chunkConcurrency: CHUNK_CONCURRENCY,
      spacyElapsedSeconds: parseFloat(elapsed),
      fullTextLength: totalTextLength,
      totalNouns: finalEntries.length,
      s0Count,
      s1Count,
      totalOffsets,
      residualCount: residualsAll.length,
      timestamp: new Date().toISOString(),
    },
    nouns: finalEntries,
  };
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`输出文件: ${OUTPUT_PATH}`);

  // 输出残余截断报告，格式对齐旧版 s0-quality-report.json 的 missedNounSamples，
  // 供 s1-llm-fill.js 直接复用（该脚本读取 report.missedNounSamples）
  const residualReport = {
    source: 'chunk 并发版残余截断（chunk 内隔离，天然无跨 chunk 污染）',
    residualCount: residualsAll.length,
    missedNounSamples: residualsAll.map((r) => ({ start: r.start, length: r.length, text: r.text, chunkKey: r.chunkKey, page: r.page })),
  };
  fs.writeFileSync(RESIDUAL_REPORT_PATH, JSON.stringify(residualReport, null, 2), 'utf-8');
  console.log(`残余截断报告: ${RESIDUAL_REPORT_PATH}`);

  console.log(`\n前20个高频名词:`);
  finalEntries.slice(0, 20).forEach((e, i) => {
    console.log(`  ${i + 1}. ${e.surface} (${e.offsets.length}次) [${e.source}]`);
  });
}

main().catch((err) => {
  console.error('执行失败:', err);
  process.exit(1);
});
