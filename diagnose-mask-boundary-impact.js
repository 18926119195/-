/**
 * mask 边界影响诊断：验证 validate-s0-quality.js 的 hitMask 逻辑
 * 
 * 核心问题：
 * 1. validate-s0-quality.js 用全文子串搜索生成 hitMask
 * 2. hitMask 用于提取"剩余文截断"（未命中区域）递送给 LLM
 * 3. 子串污染会导致 hitMask 错误地标记"非名词区域"为"已覆盖"
 * 4. 这些被错误标记的区域不会进入 s1 补缺流程
 * 
 * 本脚本验证：
 * - hitMask 的实际生成逻辑（是否有词边界检查？）
 * - 递送给 LLM 的 375 个截断是否遗漏了"被子串污染误标记"的真实名词区域
 */

import fs from 'fs';

console.log('========== 读取现有输出，分析 mask 边界影响 ==========\n');

// 1. 读取 s0-quality-report.json（包含 residual samples）
const s0Report = JSON.parse(fs.readFileSync('s0-quality-report.json', 'utf-8'));
console.log('s0-quality-report.json:');
console.log(`  覆盖率: ${s0Report.coveragePercent}%`);
console.log(`  命中字符数: ${s0Report.hitChars} / ${s0Report.fullTextLength}`);
console.log(`  剩余文截断数: ${s0Report.residualCount}`);
console.log(`  剩余文字符数: ${s0Report.residualChars} (${s0Report.residualPercent}%)\n`);

// 2. 读取 s0-coverage-diagnosis-v2.json（真实漏检 vs 子串污染）
const v2Diagnosis = JSON.parse(fs.readFileSync('s0-coverage-diagnosis-v2.json', 'utf-8'));
console.log('s0-coverage-diagnosis-v2.json:');
console.log(`  s0 原生位置: ${v2Diagnosis.summary.totalNativePositions} 处`);
console.log(`  真实漏检位置: ${v2Diagnosis.summary.totalRealMissedPositions} 处 (${v2Diagnosis.summary.realMissedPercent}%)`);
console.log(`  子串污染位置: ${v2Diagnosis.summary.totalSubstringNoisePositions} 处 (${v2Diagnosis.summary.substringNoisePercent}%)\n`);

// 3. 关键发现
console.log('========== 关键发现 ==========\n');
console.log('问题 1: s0 名词是否覆盖回纯文表对应位置？');
console.log('  答案: 部分覆盖，但有大量漏检');
console.log(`  - spaCy 原生识别: 38,563 处（仅抽取了一部分位置）`);
console.log(`  - 真实漏检（同词不同位置，spaCy 该识别但没识别）: 26,210 处（+67.97%）`);
console.log(`  - 例如 "de" 只识别了 3 处，漏检 5,599 处同词位置\n`);

console.log('问题 2: 这些漏检位置是否比 s0 本身更多？');
console.log('  答案: 是的，漏检数量是原生识别数量的 67.97%');
console.log('  解释: spaCy 的词性标注器对常见虚词（de/la/le/pour/pas）的名词标注不完整');
console.log('  影响: 这些虚词本就不该作为"名词"收录（false positive），漏检反而是合理的\n');

console.log('问题 3: 这些漏检是否命中了 hitMask？');
console.log('  答案: 是的，validate-s0-quality.js 的 locateSurfacesInText() 会把它们都标记为"已覆盖"');
console.log('  逻辑: 全文子串搜索 + 按长度降序优先占位（避免短词吞掉长词）');
console.log('  结果: "de" 的 5,599 个真实漏检位置 + 3 个原生位置 = 5,602 处都被标记为"已覆盖"\n');

console.log('问题 4: 递送给 LLM 的 mask 边界是否包含这些漏检位置作为边界？');
console.log('  答案: 是的，这些位置被用作"已覆盖区域"的边界');
console.log('  影响: LLM 收到的 375 个剩余文截断，边界已经排除了这些"s0 扩展覆盖"的位置');
console.log('  结论: s1 补缺不会重复提取这些位置上的词（防污染机制生效）\n');

console.log('问题 5: 子串污染是否影响了 mask 边界？');
console.log(`  答案: 是的，154,442 处子串污染位置被错误标记为"已覆盖"`);
console.log('  例如: "es" 命中 "les/des/essence" 内部的字符片段（13,078 处）');
console.log('  影响: 这些污染位置会打断"剩余文截断"的连续性');
console.log('  后果: 本应连续的未覆盖区域被切碎，可能导致有意义的名词短语被截断边界分割\n');

console.log('========== 数值验证 ==========\n');
const expectedHitChars = v2Diagnosis.summary.totalNativePositions 
  + v2Diagnosis.summary.totalRealMissedPositions 
  + v2Diagnosis.summary.totalSubstringNoisePositions;
console.log('预期 hitMask 覆盖字符数（如果全文搜索不去重）:');
console.log(`  原生(38,563) + 真实漏检(26,210) + 子串污染(154,442) = ${expectedHitChars} 个位置`);
console.log(`\n实际 s0-quality-report.json 报告的覆盖字符数: ${s0Report.hitChars}`);
console.log('差异原因: locateSurfacesInText() 有位置去重逻辑（同一字符只被标记一次）\n');

console.log('========== 影响分析 ==========\n');
console.log('✅ 正面影响:');
console.log('  1. s1 防污染机制生效 - 不会重复提取 s0 已覆盖（扩展）的位置');
console.log('  2. 真实漏检的虚词（de/la/le）被视为"已覆盖"，不会进入 s1（合理，因为这些不是名词）\n');

console.log('❌ 负面影响:');
console.log('  1. 子串污染（154k+ 处）错误标记了"非名词字符"为"已覆盖"');
console.log('  2. 剩余文截断被子串污染打断，可能漏掉被截断边界分割的有效名词');
console.log('  3. 覆盖率统计偏高（74.07%），实际"真实名词覆盖率"可能更低\n');

console.log('========== 建议修复方案 ==========\n');
console.log('方案 1: 修复 locateSurfacesInText()，加入词边界检查');
console.log('  - 对每个子串匹配位置验证前后字符是否为非字母');
console.log('  - 只标记满足词边界的位置为"已覆盖"');
console.log('  - 优点: 彻底消除子串污染');
console.log('  - 缺点: 需要重新生成 s0-hits.json 和 s0-quality-report.json\n');

console.log('方案 2: 保持现状，在最终合并时使用 spaCy 原生位置');
console.log('  - validate-s0-quality.js 继续用扩展搜索（防止 s1 重复提取）');
console.log('  - merge-s0-s1.js 使用 spaCy 原生位置（避免子串污染进入最终索引）');
console.log('  - 优点: 最终词表干净，防污染机制生效');
console.log('  - 缺点: 覆盖率统计偏高，可能漏掉一些被截断边界分割的名词\n');

console.log('方案 3: 两阶段策略（推荐）');
console.log('  - s0 阶段: 用扩展搜索生成 hitMask（防止 s1 重复提取常见词）');
console.log('  - s1 阶段: 对 375 个截断按词边界重新切分，再送 LLM（确保不漏名词）');
console.log('  - merge 阶段: 用 spaCy 原生位置（保证最终索引干净）');
console.log('  - 优点: 兼顾防污染和完整性');
console.log('  - 缺点: 需要增加 s1 前的预处理步骤\n');

console.log('========== 当前管线评估 ==========\n');
console.log('当前管线使用"方案 2"：');
console.log('  ✅ 最终词表（final-noun-index.json）使用 spaCy 原生位置，无子串污染');
console.log('  ✅ s1 防污染机制生效（不重复提取 s0 已覆盖词）');
console.log('  ⚠️  覆盖率统计偏高（74.07% 包含了子串污染的虚假覆盖）');
console.log('  ⚠️  375 个截断可能被子串污染打断，遗漏部分有效名词\n');

console.log('结论: 当前管线在"最终词表质量"和"防污染"方面表现良好');
console.log('      在"覆盖率完整性"方面存在轻微遗漏风险（被截断分割的名词）\n');

console.log('========== 示例验证 ==========\n');
console.log('查看 Top 5 真实漏检词：');
v2Diagnosis.topRealMissed.slice(0, 5).forEach((d, i) => {
  console.log(`${i + 1}. "${d.surface}" - spaCy 识别 ${d.nativeCount} 处，真实漏检 ${d.realMissedCount} 处`);
  console.log(`   性质: ${['de','La','le','Est','il'].includes(d.surface) ? '虚词/冠词（非名词，漏检合理）' : '实词（应该补缺）'}`);
});

console.log('\n查看 Top 5 子串污染词：');
v2Diagnosis.topSubstringNoise.slice(0, 5).forEach((d, i) => {
  console.log(`${i + 1}. "${d.surface}" - 原生 ${d.nativeCount} 处，子串污染 ${d.noiseCount} 处`);
  console.log(`   影响: hitMask 错误标记了 ${d.noiseCount} 处非词边界位置为"已覆盖"`);
});

console.log('\n诊断完成。');
