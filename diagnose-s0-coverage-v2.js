/**
 * s0 覆盖诊断 v2：区分"真实漏检同词位置" vs "子串污染误报"
 *
 * 问题：
 *   validate-s0-quality.js 的 locateSurfacesInText() 做全文子串搜索，
 *   "ame" 会命中 "madame"/"dame"/"programme" 内部的字符片段，
 *   这些不是"spaCy 漏检的同词"，而是子串误报。
 *
 * 本脚本对"扩展位置"（extended - native）做词边界检查：
 *   - 边界合法（前后是非字母字符或文本边界）→ 视为真实漏检的同词位置
 *   - 边界不合法（前后仍是字母）→ 视为子串污染误报
 */

import fs from 'fs';

const DOCUVERSE_PATH = 'C:\\Users\\Administrator\\Desktop\\docuverse_cartographies_squizoanalythiques_Fe_lix_Guattari_1789114122714.docuverse.json';
const SPACY_URL = 'http://localhost:5001/extract_nouns';

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

// 判断字符是否为"词组成字符"（字母，含重音符号）
function isWordChar(ch) {
  if (!ch) return false;
  return /[a-zA-ZÀ-ÿ]/.test(ch);
}

async function main() {
  console.log('========== s0 覆盖率诊断 v2（区分真实漏检 vs 子串污染）==========\n');

  const docuverse = JSON.parse(fs.readFileSync(DOCUVERSE_PATH, 'utf-8'));
  const pureTextTable = buildPureTextTable(docuverse.bookIndex);
  const fullText = pureTextTable.fullText;
  const fullTextLower = fullText.toLowerCase();
  console.log(`纯文表: ${fullText.length} 字符\n`);

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

  const s0RawTokens = [
    ...spacyResult.nouns.map((n) => ({ surface: n.surface, start: n.start, end: n.end })),
    ...spacyResult.noun_phrases.map((p) => ({ surface: p.surface, start: p.start, end: p.end })),
  ];
  console.log(`spaCy 原生返回: ${s0RawTokens.length} 个 token 位置\n`);

  // 按 surface（小写标准化）分组：spaCy 实际抽到的每个"词形"及其原生位置
  const nativeBySurface = new Map(); // lowerSurface -> Set of "start-end"
  const surfaceDisplay = new Map(); // lowerSurface -> 原始大小写形式（取第一次出现）
  for (const t of s0RawTokens) {
    const key = t.surface.toLowerCase().trim();
    if (key.length < 2) continue;
    if (!nativeBySurface.has(key)) {
      nativeBySurface.set(key, new Set());
      surfaceDisplay.set(key, t.surface);
    }
    nativeBySurface.get(key).add(`${t.start}-${t.end}`);
  }

  console.log(`去重后词形数: ${nativeBySurface.size}\n`);
  console.log('对每个词形做全文搜索，按词边界过滤子串污染...\n');

  let totalNative = 0;
  let totalRealMissed = 0; // 真实漏检：同词形但不同位置，且满足词边界
  let totalSubstringNoise = 0; // 子串污染：满足子串匹配但不满足词边界

  const realMissedDetails = [];
  const substringNoiseDetails = [];

  let processed = 0;
  for (const [lowerSurface, nativeSet] of nativeBySurface) {
    processed++;
    if (processed % 3000 === 0) console.log(`  处理进度: ${processed}/${nativeBySurface.size}`);

    totalNative += nativeSet.size;
    if (lowerSurface.length < 2) continue;

    let from = 0;
    let realMissedForWord = [];
    let noiseForWord = [];

    while (from < fullTextLower.length) {
      const at = fullTextLower.indexOf(lowerSurface, from);
      if (at < 0) break;
      const end = at + lowerSurface.length;
      const key = `${at}-${end}`;
      from = at + 1;

      if (nativeSet.has(key)) continue; // 已经是 spaCy 原生命中的位置，跳过

      // 检查词边界：前一个字符和后一个字符不能是词组成字符
      const prevChar = at > 0 ? fullText[at - 1] : '';
      const nextChar = end < fullText.length ? fullText[end] : '';
      const validBoundary = !isWordChar(prevChar) && !isWordChar(nextChar);

      if (validBoundary) {
        realMissedForWord.push({ start: at, end });
      } else {
        noiseForWord.push({ start: at, end, prevChar, nextChar });
      }
    }

    if (realMissedForWord.length > 0) {
      totalRealMissed += realMissedForWord.length;
      realMissedDetails.push({
        surface: surfaceDisplay.get(lowerSurface),
        nativeCount: nativeSet.size,
        realMissedCount: realMissedForWord.length,
        examples: realMissedForWord.slice(0, 3),
      });
    }
    if (noiseForWord.length > 0) {
      totalSubstringNoise += noiseForWord.length;
      substringNoiseDetails.push({
        surface: surfaceDisplay.get(lowerSurface),
        nativeCount: nativeSet.size,
        noiseCount: noiseForWord.length,
        examples: noiseForWord.slice(0, 3),
      });
    }
  }

  console.log('\n========== 关键结论 ==========\n');
  console.log(`s0 原生位置总数: ${totalNative} 处`);
  console.log(`真实漏检位置（同词形+合法词边界，spaCy未标注但确实是同词): ${totalRealMissed} 处`);
  console.log(`子串污染位置（满足字符串匹配但违反词边界，如 "ame" 命中 "madame" 内部): ${totalSubstringNoise} 处`);
  console.log(`\n真实漏检占比: ${(totalRealMissed / totalNative * 100).toFixed(2)}%`);
  console.log(`子串污染占比: ${(totalSubstringNoise / totalNative * 100).toFixed(2)}%`);

  realMissedDetails.sort((a, b) => b.realMissedCount - a.realMissedCount);
  substringNoiseDetails.sort((a, b) => b.noiseCount - a.noiseCount);

  console.log('\n========== Top 15 真实漏检词（spaCy 该识别但没识别全的同词位置）==========\n');
  realMissedDetails.slice(0, 15).forEach((d, i) => {
    console.log(`${i + 1}. "${d.surface}" - 原生${d.nativeCount}处, 真实漏检${d.realMissedCount}处`);
    console.log(`   漏检位置示例: ${JSON.stringify(d.examples)}`);
  });

  console.log('\n========== Top 15 子串污染词（不应计入覆盖率的假命中）==========\n');
  substringNoiseDetails.slice(0, 15).forEach((d, i) => {
    console.log(`${i + 1}. "${d.surface}" - 原生${d.nativeCount}处, 子串污染${d.noiseCount}处`);
    console.log(`   污染位置示例: ${JSON.stringify(d.examples)}`);
  });

  const output = {
    summary: {
      fullTextLength: fullText.length,
      totalWordForms: nativeBySurface.size,
      totalNativePositions: totalNative,
      totalRealMissedPositions: totalRealMissed,
      totalSubstringNoisePositions: totalSubstringNoise,
      realMissedPercent: Number((totalRealMissed / totalNative * 100).toFixed(2)),
      substringNoisePercent: Number((totalSubstringNoise / totalNative * 100).toFixed(2)),
    },
    topRealMissed: realMissedDetails.slice(0, 100),
    topSubstringNoise: substringNoiseDetails.slice(0, 100),
  };

  fs.writeFileSync('s0-coverage-diagnosis-v2.json', JSON.stringify(output, null, 2), 'utf-8');
  console.log('\n完整报告已保存: s0-coverage-diagnosis-v2.json');
}

main().catch((err) => {
  console.error('执行失败:', err);
  process.exit(1);
});
