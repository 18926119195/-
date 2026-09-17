import fs from 'fs';

const data = JSON.parse(fs.readFileSync('C:\\Users\\Administrator\\Desktop\\decide-design-v2-main\\final-noun-index-unified.json', 'utf-8'));
const docuverse = JSON.parse(fs.readFileSync('C:\\Users\\Administrator\\Desktop\\docuverse_cartographies_squizoanalythiques_Fe_lix_Guattari_1789114122714.docuverse.json', 'utf-8'));

// 重建纯文表
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

const fullTextParts = [];
for (const chunk of docuverse.bookIndex.chunks) {
  if (!isRetrievableAtom(chunk)) continue;
  const text = atomSearchText(chunk).trim();
  if (text) fullTextParts.push(text);
}
const fullText = fullTextParts.join('\n');

console.log(`纯文表: ${fullText.length} 字符\n`);

// 分类名词
const s0Only = data.nouns.filter(n => n.source === 's0-spacy');
const s1Only = data.nouns.filter(n => n.source === 's1-llm');
const s0s1Mix = data.nouns.filter(n => n.source === 's0+s1');

console.log(`名词分类:`);
console.log(`  纯 s0: ${s0Only.length} 个`);
console.log(`  纯 s1: ${s1Only.length} 个`);
console.log(`  s0+s1: ${s0s1Mix.length} 个\n`);

// 验证纯 s1 名词（重点检查）
console.log(`========== 验证纯 s1 名词（LLM 补缺）==========\n`);
const s1Samples = s1Only.slice(0, 10);
let s1Correct = 0;
let s1Total = 0;

for (const noun of s1Samples) {
  console.log(`【${noun.surface}】 (${noun.offsets.length}次) [s1-llm]`);
  const checks = Math.min(2, noun.offsets.length);
  for (let i = 0; i < checks; i++) {
    const off = noun.offsets[i];
    const extracted = fullText.slice(off.start, off.end);
    const match = extracted.toLowerCase() === noun.surface.toLowerCase();
    s1Total++;
    if (match) s1Correct++;
    
    const status = match ? '✓' : '✗';
    console.log(`  [${off.start}, ${off.end}) → "${extracted}" ${status}`);
    if (!match) {
      console.log(`    期望: "${noun.surface}"`);
      console.log(`    上下文: ...${fullText.slice(Math.max(0, off.start - 20), Math.min(fullText.length, off.end + 20))}...`);
    }
  }
}

console.log(`\ns1 验证: ${s1Correct}/${s1Total} 正确 (${(s1Correct/s1Total*100).toFixed(1)}%)\n`);

// 验证 s0+s1 混合名词
console.log(`========== 验证 s0+s1 混合名词 ==========\n`);
const mixSamples = s0s1Mix.slice(0, 5);
let mixCorrect = 0;
let mixTotal = 0;

for (const noun of mixSamples) {
  console.log(`【${noun.surface}】 (${noun.offsets.length}次) [s0+s1]`);
  const checks = Math.min(3, noun.offsets.length);
  for (let i = 0; i < checks; i++) {
    const off = noun.offsets[i];
    const extracted = fullText.slice(off.start, off.end);
    const match = extracted.toLowerCase() === noun.surface.toLowerCase();
    mixTotal++;
    if (match) mixCorrect++;
    
    const status = match ? '✓' : '✓';
    console.log(`  [${off.start}, ${off.end}) → "${extracted}" ${status}`);
  }
}

console.log(`\ns0+s1 验证: ${mixCorrect}/${mixTotal} 正确 (${(mixCorrect/mixTotal*100).toFixed(1)}%)\n`);

// 全局统计
console.log(`========== 全局统计 ==========`);
console.log(`总名词数: ${data.nouns.length}`);
console.log(`总位置数: ${data.meta.totalOffsets}`);
console.log(`平均每个名词: ${(data.meta.totalOffsets / data.nouns.length).toFixed(1)} 个位置`);
console.log(`\ns1 补缺贡献:`);
console.log(`  新增名词: ${s1Only.length} 个`);
console.log(`  增强现有名词: ${s0s1Mix.length} 个`);
console.log(`  s1 总位置数: ${s1Only.reduce((s, n) => s + n.offsets.length, 0) + s0s1Mix.reduce((s, n) => s + n.offsets.length, 0) - s0s1Mix.reduce((s, n) => s + n.offsets.length, 0)} 个（估算）`);
