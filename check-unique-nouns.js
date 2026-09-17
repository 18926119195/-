/**
 * 统计去重后的唯一名词数量
 * 
 * 目的：确认传给相关性LLM的实际词条数，评估噪声占比
 */

import fs from 'fs';

const INPUT_PATH = 'C:\\Users\\Administrator\\Desktop\\decide-design-v2-main\\final-noun-index-unified.json';

const data = JSON.parse(fs.readFileSync(INPUT_PATH, 'utf-8'));
const nouns = data.nouns;

console.log(`========== 终词表去重统计 ==========\n`);
console.log(`原始词条数: ${nouns.length}`);

// 按 surface 去重
const uniqueSurfaces = new Set(nouns.map(n => n.surface));
console.log(`唯一 surface 数: ${uniqueSurfaces.size}`);
console.log(`重复率: ${((1 - uniqueSurfaces.size / nouns.length) * 100).toFixed(2)}%\n`);

// 统计去重后的噪声占比
const uniqueNouns = Array.from(uniqueSurfaces);

// 使用之前扫描出的噪声规则
function isNoise(s) {
  // 连续重复字符
  if (/(.)\1{2,}/.test(s)) return true;
  // 极短词（<=2字符）
  if (s.trim().length <= 2) return true;
  // 含特殊符号
  if (/[#*/\\|@%^&+=~<>\[\]{}_]/.test(s)) return true;
  // 短且含空格
  if (s.length <= 6 && /\s/.test(s)) return true;
  // 数字字母混合编号
  if (/^[a-zA-Z]{1,4}\d+$|^\d+[a-zA-Z]{1,4}$/.test(s.trim())) return true;
  
  return false;
}

const noiseCount = uniqueNouns.filter(isNoise).length;
console.log(`去重后噪声词数: ${noiseCount} / ${uniqueSurfaces.size} (${(noiseCount/uniqueSurfaces.size*100).toFixed(2)}%)`);

// 显示去重后的噪声样例
const noiseSamples = uniqueNouns.filter(isNoise).slice(0, 30);
console.log(`\n去重后噪声样例（前30个）:`);
noiseSamples.forEach(s => console.log(`  "${s}"`));

// 统计token预算（粗略估算：平均每个词4个字符 = 1个token）
const avgCharsPerNoun = uniqueNouns.reduce((sum, s) => sum + s.length, 0) / uniqueNouns.length;
const estimatedTokens = Math.ceil(uniqueNouns.length * avgCharsPerNoun / 4);

console.log(`\n========== Token预算估算 ==========`);
console.log(`平均每词字符数: ${avgCharsPerNoun.toFixed(1)}`);
console.log(`估算token数（去重后）: ~${estimatedTokens} tokens`);
console.log(`（假设平均4字符=1token，实际可能更少）`);
