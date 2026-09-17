import fs from 'fs';

const data = JSON.parse(fs.readFileSync('C:\\Users\\Administrator\\Desktop\\decide-design-v2-main\\final-noun-index-unified.json', 'utf-8'));
const docuverse = JSON.parse(fs.readFileSync('C:\\Users\\Administrator\\Desktop\\docuverse_cartographies_squizoanalythiques_Fe_lix_Guattari_1789114122714.docuverse.json', 'utf-8'));

// 重建纯文表（与 extract-nouns-unified.js 保持一致）
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

console.log(`纯文表重建: ${fullText.length} 字符\n`);

// 验证偏移量能否正确切出文本
console.log('偏移量绝对性验证（随机抽样10个名词）:\n');
const samples = [];
for (let i = 0; i < Math.min(10, data.nouns.length); i += Math.floor(data.nouns.length / 10)) {
  samples.push(data.nouns[i]);
}

let correctCount = 0;
let totalChecked = 0;

for (const noun of samples) {
  console.log(`【${noun.surface}】 (${noun.offsets.length}次)`);
  const checksPerNoun = Math.min(3, noun.offsets.length);
  for (let i = 0; i < checksPerNoun; i++) {
    const off = noun.offsets[i];
    const extracted = fullText.slice(off.start, off.end);
    const match = extracted.toLowerCase() === noun.surface.toLowerCase();
    totalChecked++;
    if (match) correctCount++;
    
    const status = match ? '✓' : '✗';
    console.log(`  [${off.start}, ${off.end}) → "${extracted}" ${status}`);
    if (!match) {
      console.log(`    期望: "${noun.surface}"`);
      console.log(`    上下文: ...${fullText.slice(Math.max(0, off.start - 10), Math.min(fullText.length, off.end + 10))}...`);
    }
  }
}

console.log(`\n验证结果: ${correctCount}/${totalChecked} 正确 (${(correctCount/totalChecked*100).toFixed(1)}%)\n`);

// 唯一性验证
const offsetMap = new Map();
let duplicates = 0;
for (const noun of data.nouns) {
  for (const off of noun.offsets) {
    const key = `${off.start}-${off.end}`;
    if (offsetMap.has(key)) {
      duplicates++;
      if (duplicates <= 3) {
        console.log(`重复偏移: [${off.start}, ${off.end}) -> '${offsetMap.get(key)}' 和 '${noun.surface}'`);
      }
    } else {
      offsetMap.set(key, noun.surface);
    }
  }
}

console.log(`偏移量唯一性:`);
console.log(`  总位置数: ${offsetMap.size + duplicates}`);
console.log(`  唯一位置: ${offsetMap.size}`);
console.log(`  重复: ${duplicates}\n`);

console.log(`meta:`, JSON.stringify(data.meta, null, 2));
