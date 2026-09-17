/**
 * 拓扑链构建脚本（按 chunkKey 合并版）
 *
 * 策略：
 * 1. 读取 relevance-filter-llm.js 的输出（相关名词 + 全局偏移量）
 * 2. 重建 pureTextTable（含每个 chunk 的偏移区间 startOffset/endOffset）
 * 3. 用二分查找把每个命中偏移量映射回它所在的 chunkKey
 * 4. 同一个 chunkKey 内的所有命中名词合并成一条拓扑链（而不是每个词一条链）
 * 5. 输出：链数量、每条链的名词列表、页码，供后续检索/展示使用
 *
 * 用法：
 *   node build-topology-chains.js --input relevance-test-result.json --output topology-chains.json
 */

import fs from 'fs';

const DOCUVERSE_PATH = 'C:\\Users\\Administrator\\Desktop\\docuverse_cartographies_squizoanalythiques_Fe_lix_Guattari_1789114122714.docuverse.json';

// ---------- CLI 参数 ----------
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { input: 'relevance-result.json', output: 'topology-chains.json' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input') opts.input = args[++i];
    if (args[i] === '--output') opts.output = args[++i];
  }
  return opts;
}

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

function buildPureTextTable(bookIndex) {
  const entries = [];
  let offset = 0;
  for (const chunk of bookIndex.chunks) {
    if (!isRetrievableAtom(chunk)) continue;
    const text = atomSearchText(chunk).trim();
    if (!text) continue;
    const startOffset = offset;
    const endOffset = offset + text.length;
    entries.push({ chunkKey: chunk.key, page: chunk.page, startOffset, endOffset });
    offset = endOffset + 1;
  }
  return entries; // 已按 startOffset 升序（构建时天然有序）
}

// ---------- 二分查找：偏移量 -> chunk 条目 ----------
function findChunkForOffset(entries, offset) {
  let lo = 0, hi = entries.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const e = entries[mid];
    if (offset < e.startOffset) hi = mid - 1;
    else if (offset >= e.endOffset) lo = mid + 1;
    else return e; // startOffset <= offset < endOffset
  }
  return null; // 落在 chunk 间隙（分隔符 \n），忽略
}

// ---------- 主流程 ----------
async function main() {
  const { input, output } = parseArgs();

  console.log('========== 拓扑链构建（按chunk合并） ==========\n');

  const relevanceData = JSON.parse(fs.readFileSync(input, 'utf-8'));
  const selectedNouns = relevanceData.selectedNouns || [];
  console.log(`读取相关名词: ${selectedNouns.length} 个\n`);

  const docuverse = JSON.parse(fs.readFileSync(DOCUVERSE_PATH, 'utf-8'));
  const chunkEntries = buildPureTextTable(docuverse.bookIndex);
  console.log(`纯文表: ${chunkEntries.length} 个 chunk\n`);

  // 按 chunkKey 分组：chunkKey -> { page, hits: [{noun, start, end}] }
  const chunkGroups = new Map();
  let unmatchedOffsets = 0;

  for (const nounEntry of selectedNouns) {
    for (const offset of nounEntry.offsets || []) {
      const chunk = findChunkForOffset(chunkEntries, offset.start);
      if (!chunk) { unmatchedOffsets++; continue; }

      if (!chunkGroups.has(chunk.chunkKey)) {
        chunkGroups.set(chunk.chunkKey, { chunkKey: chunk.chunkKey, page: chunk.page, hits: [] });
      }
      chunkGroups.get(chunk.chunkKey).hits.push({
        noun: nounEntry.surface,
        id: nounEntry.id,
        start: offset.start,
        end: offset.end,
      });
    }
  }

  // 每条链内按位置排序 + 去重（同一个词在同一位置只算一次）
  const chains = [...chunkGroups.values()].map((group) => {
    const uniqueHits = new Map();
    for (const hit of group.hits) {
      uniqueHits.set(`${hit.start}-${hit.end}`, hit);
    }
    const hits = [...uniqueHits.values()].sort((a, b) => a.start - b.start);
    return {
      chunkKey: group.chunkKey,
      page: group.page,
      nounCount: hits.length,
      nouns: hits.map((h) => h.noun),
      hits,
    };
  });

  // 按命中数降序排列（命中越多的chunk越可能是核心讨论段落）
  chains.sort((a, b) => b.nounCount - a.nounCount);

  const totalHits = chains.reduce((sum, c) => sum + c.nounCount, 0);

  console.log('========== 构建完成 ==========');
  console.log(`拓扑链数量: ${chains.length} 条（原始相关词: ${selectedNouns.length} 个）`);
  console.log(`压缩比: ${(chains.length / Math.max(selectedNouns.length, 1) * 100).toFixed(1)}%`);
  console.log(`总命中位置: ${totalHits} 处`);
  console.log(`未匹配偏移量: ${unmatchedOffsets} 处（落在chunk间隙）`);
  console.log(`平均每链名词数: ${(totalHits / Math.max(chains.length, 1)).toFixed(1)}\n`);

  console.log('前10条最密集的拓扑链:');
  chains.slice(0, 10).forEach((c, i) => {
    console.log(`  ${i + 1}. [p.${c.page}] ${c.chunkKey} (${c.nounCount}词): ${c.nouns.slice(0, 8).join(', ')}${c.nouns.length > 8 ? '...' : ''}`);
  });

  const outputData = {
    meta: {
      query: relevanceData.meta?.query,
      inputNouns: selectedNouns.length,
      chainCount: chains.length,
      compressionRate: chains.length / Math.max(selectedNouns.length, 1),
      totalHits,
      unmatchedOffsets,
    },
    chains,
  };

  fs.writeFileSync(output, JSON.stringify(outputData, null, 2), 'utf-8');
  console.log(`\n输出文件: ${output}`);
}

main().catch((err) => {
  console.error('执行失败:', err);
  process.exit(1);
});
