/**
 * 提取候选chunk原文，用于人工/LLM判断召回精准度
 *
 * 逻辑：
 * 1. 读取 test-questions.json 里的15个问题及其关键词
 * 2. 读取 topology-chains.json（560条链，每条对应一个chunk）
 * 3. 对每个问题，用关键词匹配出候选chunk（不同阈值下的候选集合不同）
 * 4. 提取每个候选chunk的原文（从docuverse重建pureTextTable按offset切片）
 * 5. 输出：{question, threshold, chunkKey, page, nounCount, text} 列表
 *    供下一步人工/LLM标注"是否真的能回答问题"
 */

import fs from 'fs';

const DOCUVERSE_PATH = 'C:\\Users\\Administrator\\Desktop\\docuverse_cartographies_squizoanalythiques_Fe_lix_Guattari_1789114122714.docuverse.json';

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
    entries.push({ chunkKey: chunk.key, page: chunk.page, startOffset, endOffset, text });
    offset = endOffset + 1;
  }
  return entries;
}

function main() {
  const questions = JSON.parse(fs.readFileSync('test-questions.json', 'utf-8'));
  const topology = JSON.parse(fs.readFileSync('topology-chains.json', 'utf-8'));
  const docuverse = JSON.parse(fs.readFileSync(DOCUVERSE_PATH, 'utf-8'));
  const pureText = buildPureTextTable(docuverse.bookIndex);

  const textByKey = new Map(pureText.map((e) => [e.chunkKey, e.text]));
  const chainByKey = new Map(topology.chains.map((c) => [c.chunkKey, c]));

  const thresholds = [3, 5, 8, 10];
  const results = [];

  const questionList = Array.isArray(questions) ? questions : questions.questions;
  for (const q of questionList) {
    const kw = q.keywords;
    // 找出命中任意关键词的chunk（联合集）
    const matchedChunks = topology.chains.filter((c) =>
      c.nouns.some((n) => kw.some((k) => n.toLowerCase().includes(k.toLowerCase()) || k.toLowerCase().includes(n.toLowerCase())))
    );

    for (const th of thresholds) {
      const highDensity = matchedChunks.filter((c) => c.nounCount >= th);
      const candidates = highDensity
        .sort((a, b) => b.nounCount - a.nounCount)
        .slice(0, 5) // 只取前5个最密集的做人工判断样本
        .map((c) => ({
          chunkKey: c.chunkKey,
          page: c.page,
          nounCount: c.nounCount,
          nouns: c.nouns,
          text: textByKey.get(c.chunkKey) || '(未找到原文)',
        }));

      results.push({
        questionId: q.id,
        question: q.question,
        zone: q.zone,
        threshold: th,
        candidateCount: highDensity.length,
        candidates,
      });
    }
  }

  fs.writeFileSync('candidate-texts-for-judging.json', JSON.stringify(results, null, 2), 'utf-8');
  console.log(`已输出 ${results.length} 组候选（15问题 x 4阈值）`);
  console.log('文件: candidate-texts-for-judging.json');
}

main();
