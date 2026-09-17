/**
 * 提取候选chunk原文 v2：分层抽样版
 *
 * 上一版的问题：每个阈值都只取"该阈值下nounCount最高的前5个chunk"，
 * 导致threshold=3/5/8/10选出的Top5其实是同一批全局最密的chunk（因为它们本来就≥10），
 * 阈值之间没有区分度。
 *
 * v2修正：对每个问题的全部命中chunk，按nounCount分箱（1,2,3,...,9,10+），
 * 每个箱子里随机抽样最多SAMPLES_PER_BIN个，覆盖从低密度到高密度的完整区间。
 * 这样minThresholdSelected才能真实反映"这个chunk在哪个阈值下会被选中"，
 * 阈值间的precision/recall/token成本对比才有意义。
 */

import fs from 'fs';

const DOCUVERSE_PATH = 'C:\\Users\\Administrator\\Desktop\\docuverse_cartographies_squizoanalythiques_Fe_lix_Guattari_1789114122714.docuverse.json';
const SAMPLES_PER_BIN = 3;
const SEED = 42;

function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

function binOf(nounCount) {
  return nounCount >= 10 ? '10+' : String(nounCount);
}

function main() {
  const rand = mulberry32(SEED);
  const questions = JSON.parse(fs.readFileSync('test-questions.json', 'utf-8'));
  const topology = JSON.parse(fs.readFileSync('topology-chains.json', 'utf-8'));
  const docuverse = JSON.parse(fs.readFileSync(DOCUVERSE_PATH, 'utf-8'));
  const pureText = buildPureTextTable(docuverse.bookIndex);

  const textByKey = new Map(pureText.map((e) => [e.chunkKey, e.text]));

  const questionList = Array.isArray(questions) ? questions : questions.questions;
  const output = [];

  for (const q of questionList) {
    const kw = q.keywords;
    const matched = topology.chains.filter((c) =>
      c.nouns.some((n) => kw.some((k) => n.toLowerCase().includes(k.toLowerCase()) || k.toLowerCase().includes(n.toLowerCase())))
    );

    // 分箱
    const bins = new Map();
    for (const c of matched) {
      const b = binOf(c.nounCount);
      if (!bins.has(b)) bins.set(b, []);
      bins.get(b).push(c);
    }

    // 每箱抽样
    const sampled = [];
    for (const [, list] of bins.entries()) {
      const shuffled = [...list];
      // Fisher-Yates 用固定种子随机数，保证可复现
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      sampled.push(...shuffled.slice(0, SAMPLES_PER_BIN));
    }

    const chunks = sampled.map((c) => ({
      page: c.page,
      nounCount: c.nounCount,
      chunkKey: c.chunkKey,
      text: textByKey.get(c.chunkKey) || '(未找到原文)',
    }));

    output.push({
      questionId: q.id,
      question: q.question,
      zone: q.zone,
      totalMatched: matched.length,
      binsCovered: [...bins.keys()].sort(),
      sampledCount: chunks.length,
      chunks,
    });
  }

  fs.writeFileSync('candidate-texts-deduped-v2.json', JSON.stringify(output, null, 2), 'utf-8');
  const total = output.reduce((s, o) => s + o.chunks.length, 0);
  console.log(`分层抽样完成，共 ${output.length} 个问题, 总候选chunk数 ${total}`);
  for (const o of output) {
    console.log(`  [${o.questionId}] 命中总数=${o.totalMatched}, 覆盖箱=${o.binsCovered.join(',')}, 抽样=${o.sampledCount}`);
  }
}

main();
