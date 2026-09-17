import { readFileSync } from 'fs';
const s1 = JSON.parse(readFileSync('./s1-nouns-with-offsets.json', 'utf-8'));

console.log('========== s1 补缺的 40 个新词 (按命中数排序) ==========\n');

s1.nouns
  .sort((a, b) => b.offsets.length - a.offsets.length)
  .forEach((n, i) => {
    const count = n.offsets.length;
    const conf = n.offsets[0].confidence;
    const num = (i + 1).toString().padStart(2);
    const word = n.surface.padEnd(20);
    console.log(`${num}. ${word} (${count}次, ${conf})`);
  });

console.log('\n========== s1 元数据 ==========');
console.log(`处理截断数: ${s1.meta.inputTruncations}`);
console.log(`补缺名词数: ${s1.meta.outputNouns}`);
console.log(`总位置数: ${s1.meta.totalOffsets}`);
console.log(`平均每词: ${(s1.meta.totalOffsets / s1.meta.outputNouns).toFixed(1)} 处`);
console.log(`耗时: ${s1.meta.elapsedSeconds}s`);
console.log(`置信度: 高=${s1.meta.confidenceStats.high}, 中=${s1.meta.confidenceStats.medium}, 低=${s1.meta.confidenceStats.low}`);
