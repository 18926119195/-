import fs from 'fs';
const data = JSON.parse(fs.readFileSync('final-noun-index.json', 'utf8'));
const nouns = data.nouns;
console.log('total nouns:', nouns.length);

const ART = /^(le|la|les|un|une|des|de|du|au|aux|ce|cet|cette|ces)\s/i;
const PURE_FUNC = new Set(['le','la','les','un','une','des','de','du','et','que','qui','ne','pas','est','sont','dans','pour','par','sur','avec','au','aux','ce','se','son','sa','ses','leur','leurs','elle','il','ils','elles','on','nous','vous','je','tu','a','en','d']);

let pureFuncCount = 0;
let articlePhraseCount = 0;
let punctOnly = 0;

const pureFuncSamples = [];
const punctSamples = [];
const articlePhraseSamples = [];

for (const n of nouns) {
  const id = n.id;
  const surf = n.surface;
  if (PURE_FUNC.has(id)) { 
    pureFuncCount++; 
    if (pureFuncSamples.length<20) pureFuncSamples.push({id, surf, df: n.offsets.length}); 
  }
  if (ART.test(surf)) { 
    articlePhraseCount++; 
    if (articlePhraseSamples.length<30) articlePhraseSamples.push({id, surf, df: n.offsets.length});
  }
  if (/^[^a-zA-ZÀ-ÿ0-9]+$/.test(surf)) { 
    punctOnly++; 
    if (punctSamples.length<20) punctSamples.push({id, surf, df: n.offsets.length}); 
  }
}
console.log('\n=== pure function word standalone entries ===');
console.log('count:', pureFuncCount);
console.log('samples:', JSON.stringify(pureFuncSamples, null, 2));

console.log('\n=== noun_phrase entries starting with article (le/la/les/un/une/des/de/du...) ===');
console.log('count:', articlePhraseCount);
console.log('samples:', JSON.stringify(articlePhraseSamples, null, 2));

console.log('\n=== punctuation-only surface entries ===');
console.log('count:', punctOnly);
console.log('samples:', JSON.stringify(punctSamples, null, 2));

console.log('\n=== summary ===');
console.log('total noun entries:', nouns.length);
console.log('pure function words:', pureFuncCount, `(${(pureFuncCount/nouns.length*100).toFixed(2)}%)`);
console.log('article-led noun phrases:', articlePhraseCount, `(${(articlePhraseCount/nouns.length*100).toFixed(2)}%)`);
console.log('punctuation-only:', punctOnly, `(${(punctOnly/nouns.length*100).toFixed(2)}%)`);
