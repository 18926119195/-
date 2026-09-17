/**
 * s0 覆盖率诊断脚本
 * 
 * 验证三个关键问题：
 * 1. spaCy 原生返回的 token 位置（s0 原生）vs. 全文子串搜索找到的所有位置（s0 扩展）
 * 2. s0 原生位置数 vs. s0 扩展位置数（是否有漏检的同名词）
 * 3. 递送给 LLM 的 mask 边界是否包含了 s0 扩展位置（是否作为"已覆盖"防止重复提取）
 */

import fs from 'fs';

const SPACY_URL = 'http://localhost:5001/extract_nouns';
const DOCUVERSE_PATH = 'C:\\Users\\Administrator\\Desktop\\docuverse_cartographies_squizoanalythiques_Fe_lix_Guattari_1789114122714.docuverse.json';

// ========== 纯文表构建（复用现有逻辑） ==========
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
    entries.push({ chunkKey: chunk.key, page: chunk.page, text, startOffset, endOffset });
    offset = endOffset + 1;
  }
  const fullText = entries.map((e) => e.text).join('\n');
  return { fullText, entries };
}

// ========== 主诊断逻辑 ==========

async function main() {
  console.log('========== s0 覆盖率诊断 ==========\n');

  // 1. 构建纯文表
  const docuverse = JSON.parse(fs.readFileSync(DOCUVERSE_PATH, 'utf-8'));
  const pureTextTable = buildPureTextTable(docuverse.bookIndex);
  const fullText = pureTextTable.fullText;
  console.log(`纯文表: ${fullText.length} 字符\n`);

  // 2. 调用 spaCy 获取原生 token 位置
  console.log('调用 spaCy 抽取名词...');
  const spacyRes = await fetch(SPACY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: fullText,
      include_proper_nouns: true,
      include_nouns: true,
      min_length: 2,
    }),
  });
  const spacyResult = await spacyRes.json();
  
  // s0 原生位置：spaCy 返回的 token 边界
  const s0Native = [
    ...spacyResult.nouns.map(n => ({ surface: n.surface, start: n.start, end: n.end })),
    ...spacyResult.noun_phrases.map(p => ({ surface: p.surface, start: p.start, end: p.end })),
  ];
  
  console.log(`spaCy 原生返回: ${s0Native.length} 个 token 位置\n`);

  // 3. 按词面形式分组，对比原生位置 vs. 全文搜索位置
  const nounGroups = new Map(); // surface_lower -> { native: [], extended: [] }
  
  // 3.1 收集原生位置
  for (const token of s0Native) {
    const key = token.surface.toLowerCase().trim();
    if (!nounGroups.has(key)) {
      nounGroups.set(key, { surface: token.surface, native: [], extended: [] });
    }
    nounGroups.get(key).native.push({ start: token.start, end: token.end });
  }

  // 3.2 对每个词做全文子串搜索，找到所有出现位置（扩展位置）
  const fullTextLower = fullText.toLowerCase();
  for (const [key, group] of nounGroups.entries()) {
    let from = 0;
    while (from < fullTextLower.length) {
      const at = fullTextLower.indexOf(key, from);
      if (at < 0) break;
      const end = at + key.length;
      group.extended.push({ start: at, end });
      from = at + 1;
    }
  }

  // 4. 统计差异
  let totalNative = 0;
  let totalExtended = 0;
  let wordsWithMoreExtended = 0;
  let extraPositions = 0;

  const examples = []; // 保存有差异的示例

  for (const [key, group] of nounGroups.entries()) {
    totalNative += group.native.length;
    totalExtended += group.extended.length;
    
    if (group.extended.length > group.native.length) {
      wordsWithMoreExtended++;
      const diff = group.extended.length - group.native.length;
      extraPositions += diff;
      
      if (examples.length < 20) {
        examples.push({
          surface: group.surface,
          native: group.native.length,
          extended: group.extended.length,
          diff,
          nativePositions: group.native.slice(0, 3),
          extendedPositions: group.extended.slice(0, 5),
        });
      }
    }
  }

  // 5. 输出统计
  console.log('========== 统计结果 ==========\n');
  console.log(`s0 原生位置总数: ${totalNative} 处`);
  console.log(`全文搜索位置总数: ${totalExtended} 处`);
  console.log(`差异: ${totalExtended - totalNative} 处 (${((totalExtended - totalNative) / totalNative * 100).toFixed(2)}%)\n`);
  
  console.log(`有额外位置的词数: ${wordsWithMoreExtended} / ${nounGroups.size} (${(wordsWithMoreExtended / nounGroups.size * 100).toFixed(2)}%)`);
  console.log(`额外位置总数: ${extraPositions} 处\n`);

  // 6. 显示示例
  console.log('========== 示例（前20个有差异的词）==========\n');
  for (const ex of examples) {
    console.log(`"${ex.surface}"`);
    console.log(`  原生: ${ex.native} 处，扩展: ${ex.extended} 处，差异: +${ex.diff}`);
    console.log(`  原生位置示例: ${JSON.stringify(ex.nativePositions.slice(0, 2))}`);
    console.log(`  扩展位置示例: ${JSON.stringify(ex.extendedPositions.slice(0, 3))}`);
    console.log('');
  }

  // 7. 检查 validate-s0-quality.js 里的 hitMask 是用哪种位置
  console.log('========== hitMask 覆盖策略分析 ==========\n');
  console.log('validate-s0-quality.js 的 locateSurfacesInText() 使用的是:');
  console.log('  全文子串搜索（extended）—— 会找到所有同名位置');
  console.log('  ✅ 意味着: s0 扩展位置都被标记为"已覆盖"');
  console.log('  ✅ 意味着: 递送给 LLM 的 mask 边界包含了这些"spaCy 漏检但同字符串"的位置\n');

  console.log('但是 merge-s0-s1.js 使用的是:');
  console.log('  spaCy 原生 token 位置（native）—— 避免子串污染');
  console.log('  ❓ 问题: 最终词表里少了那些"扩展位置"的记录\n');

  // 8. 输出完整报告
  const report = {
    summary: {
      fullTextLength: fullText.length,
      totalNounTypes: nounGroups.size,
      s0NativePositions: totalNative,
      s0ExtendedPositions: totalExtended,
      extraPositions,
      wordsWithExtraPositions: wordsWithMoreExtended,
      extraPositionPercent: ((totalExtended - totalNative) / totalNative * 100).toFixed(2) + '%',
    },
    examples: examples.slice(0, 50),
    conclusion: {
      hitMaskStrategy: 'extended (全文子串搜索)',
      finalIndexStrategy: 'native (spaCy token 边界)',
      consistency: 'INCONSISTENT - hitMask 用扩展位置，最终索引用原生位置',
    },
  };

  fs.writeFileSync(
    'C:\\Users\\Administrator\\Desktop\\decide-design-v2-datacleaning-20260916-2151-main\\s0-coverage-diagnosis.json',
    JSON.stringify(report, null, 2),
    'utf-8'
  );

  console.log('完整报告已保存: s0-coverage-diagnosis.json\n');
}

main().catch(err => {
  console.error('执行失败:', err);
  process.exit(1);
});
