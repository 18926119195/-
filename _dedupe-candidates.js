/**
 * 去重候选chunk（同一个chunk会在threshold=3,5,8,10重复出现）
 * 输出每个questionId下，唯一chunk列表 + 该chunk在哪些阈值下会被选中
 * 供人工/LLM判断chunk是否真的能回答问题
 */
import fs from 'fs';

const data = JSON.parse(fs.readFileSync('candidate-texts-for-judging.json', 'utf-8'));

const byQuestion = new Map();
for (const entry of data) {
  if (!byQuestion.has(entry.questionId)) {
    byQuestion.set(entry.questionId, { question: entry.question, zone: entry.zone, chunkMap: new Map() });
  }
  const q = byQuestion.get(entry.questionId);
  for (const c of entry.candidates) {
    if (!q.chunkMap.has(c.chunkKey)) {
      q.chunkMap.set(c.chunkKey, { ...c, thresholds: [] });
    }
    q.chunkMap.get(c.chunkKey).thresholds.push(entry.threshold);
  }
}

const output = [];
for (const [questionId, q] of byQuestion.entries()) {
  const chunks = [...q.chunkMap.values()].sort((a, b) => b.nounCount - a.nounCount);
  output.push({
    questionId,
    question: q.question,
    zone: q.zone,
    uniqueChunks: chunks.length,
    chunks: chunks.map((c) => ({
      page: c.page,
      nounCount: c.nounCount,
      minThresholdSelected: Math.min(...c.thresholds),
      text: c.text,
    })),
  });
}

fs.writeFileSync('candidate-texts-deduped.json', JSON.stringify(output, null, 2), 'utf-8');
console.log(`去重完成，共 ${output.length} 个问题`);
for (const o of output) {
  console.log(`  [${o.questionId}] ${o.uniqueChunks} 个唯一候选chunk`);
}
