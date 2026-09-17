/**
 * 终词表噪声扫描脚本
 *
 * 目的：对 final-noun-index-unified.json 做一次系统性的噪声体检，
 * 列出各类可疑词条供人工判断是否需要加入过滤规则。
 *
 * 检查维度：
 *   1. 极短词（<=2字符，可能是残留字母/缩写碎片）
 *   2. 纯数字/编号/页码类
 *   3. 单字母+点缩写、罗马数字、希腊字母残留
 *   4. 含特殊符号（非字母重音符号）的词条
 *   5. 全大写短词（可能是缩写，也可能是OCR噪声）
 *   6. 高频虚词残留（法语/英语常见功能词，双重确认过滤规则是否有漏网）
 *   7. 重复字符/明显乱码（如 "aaaa"、"xxx"）
 *   8. 含数字+字母混合的编号型词条（如 "p39"、"figure1"）
 *   9. 极低频词（出现1次，可能是OCR噪声，但也可能是正常低频词，仅统计不过滤）
 *
 * 用法：
 *   node scan-noise.js
 */

import fs from 'fs';

const INPUT_PATH = 'C:\\Users\\Administrator\\Desktop\\decide-design-v2-main\\final-noun-index-unified.json';

const data = JSON.parse(fs.readFileSync(INPUT_PATH, 'utf-8'));
const nouns = data.nouns;

console.log(`========== 终词表噪声体检 ==========`);
console.log(`总词条数: ${nouns.length}\n`);

function report(title, list, limit = 30) {
  console.log(`\n---------- ${title} (${list.length} 个) ----------`);
  list.slice(0, limit).forEach((n) => {
    console.log(`  ${n.surface} (${n.offsets.length}次) [${n.source}]`);
  });
  if (list.length > limit) console.log(`  ... 还有 ${list.length - limit} 个`);
}

// 1. 极短词（<=2字符）
const shortWords = nouns.filter((n) => n.surface.trim().length <= 2);
report('极短词（<=2字符）', shortWords);

// 2. 纯数字/编号
const pureNumberRe = /^\d+[.)]?$/;
const pureNumbers = nouns.filter((n) => pureNumberRe.test(n.surface.trim()));
report('纯数字/编号', pureNumbers);

// 3. 单字母+点缩写、罗马数字、希腊字母
const abbrevRe = /^[A-Za-zΑ-Ωα-ω]\.?$|^[IVXLCDM]{1,4}\.?$/;
const abbrevs = nouns.filter((n) => abbrevRe.test(n.surface.trim()));
report('单字母/罗马数字/希腊字母缩写', abbrevs);

// 4. 含特殊符号（排除正常法语重音符号 àâäéèêëïîôöùûüÿçœæ）
const specialCharRe = /[#*/\\|@%^&+=~<>\[\]{}_]/;
const specialChars = nouns.filter((n) => specialCharRe.test(n.surface));
report('含特殊符号', specialChars);

// 5. 全大写短词（<=4字符，排除常见专有名词首字母缩写模式判断，仅列出供人工看）
const allCapsShortRe = /^[A-Z]{2,4}$/;
const allCapsShort = nouns.filter((n) => allCapsShortRe.test(n.surface.trim()));
report('全大写短词（2-4字符，可能是缩写或噪声）', allCapsShort);

// 6. 重复字符（如 aaaa, xxxx，同一字符连续>=4次）
const repeatCharRe = /(.)\1{3,}/;
const repeatChars = nouns.filter((n) => repeatCharRe.test(n.surface));
report('重复字符（疑似乱码）', repeatChars);

// 7. 数字+字母混合编号型（如 p39, fig1, ch2）
const numAlphaMixRe = /^[a-zA-Z]{1,4}\d+$|^\d+[a-zA-Z]{1,4}$/;
const numAlphaMix = nouns.filter((n) => numAlphaMixRe.test(n.surface.trim()));
report('数字字母混合编号型', numAlphaMix);

// 8. 含空白但很短的词组（可能是断词错误，如 "l a" ）
const shortWithSpaceRe = /^.{1,2}\s.{1,2}$/;
const shortWithSpace = nouns.filter((n) => shortWithSpaceRe.test(n.surface.trim()));
report('短且含空格（疑似断词错误）', shortWithSpace);

// 9. 极低频统计（仅统计，不列出全部，因为数量可能很大）
const freq1 = nouns.filter((n) => n.offsets.length === 1);
console.log(`\n---------- 极低频词统计（仅统计） ----------`);
console.log(`  出现1次的词条: ${freq1.length} 个（占比 ${(freq1.length/nouns.length*100).toFixed(1)}%）`);
console.log(`  样例（前20个）:`);
freq1.slice(0, 20).forEach((n) => console.log(`    ${n.surface} [${n.source}]`));

// 汇总
console.log(`\n\n========== 汇总 ==========`);
const allSuspects = new Set([
  ...shortWords, ...pureNumbers, ...abbrevs, ...specialChars,
  ...allCapsShort, ...repeatChars, ...numAlphaMix, ...shortWithSpace,
].map((n) => n.id));
console.log(`可疑词条总数（去重）: ${allSuspects.size} / ${nouns.length} (${(allSuspects.size/nouns.length*100).toFixed(2)}%)`);
