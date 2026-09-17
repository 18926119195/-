import fs from 'fs';

const report = JSON.parse(fs.readFileSync('s0-quality-report.json', 'utf-8'));
const allResiduals = [...report.residualSamples, ...report.residualLongest];

function classifyResidual(text) {
  if (/<\/?(td|tr|tbody|table|th)>/i.test(text)) return 'html_noise';
  const contentWordMatch = text.match(/[a-zA-ZÀ-ÿ]{4,}/g) || [];
  const hasLongContentWord = contentWordMatch.some((w) => w.length >= 6);
  if (contentWordMatch.length === 0) return 'pure_function_word';
  if (hasLongContentWord) return 'possible_missed_noun';
  return 'short_function_word';
}

const candidates = allResiduals.filter((r) => classifyResidual(r.text) === 'possible_missed_noun');
console.log('疑似漏词样本 (available in samples/longest, not all 360):', candidates.length);
candidates.slice(0, 15).forEach((r, i) => {
  console.log(`${i + 1}. [${r.start}] ${r.text.slice(0, 80)}`);
});

// Also check: are any of these candidate texts containing words that ARE already in s0?
const final = JSON.parse(fs.readFileSync('final-noun-index.json', 'utf-8'));
const s0Surfaces = new Set(
  final.nouns.filter((n) => n.source === 's0-spacy').map((n) => n.surface.toLowerCase()),
);

console.log('\n检查这些"疑似漏词"截断里，是否包含 s0 已有的词面作为子串:');
let foundOverlap = 0;
for (const r of candidates) {
  const words = r.text.match(/[a-zA-ZÀ-ÿ]{3,}/g) || [];
  for (const w of words) {
    if (s0Surfaces.has(w.toLowerCase())) {
      console.log(`  截断[${r.start}] "${r.text.slice(0,60)}" 包含 s0 已有词 "${w}"`);
      foundOverlap++;
      break;
    }
  }
}
console.log('\n重叠计数:', foundOverlap, '/', candidates.length);
