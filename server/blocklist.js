// Small word blocklist for holder sentences. Matched on whole words (plus simple plural/verb
// endings) after cleaning, so normal words that merely contain these letters still pass.
const WORDS = [
  // slurs
  'nigger', 'nigga', 'niggas', 'faggot', 'fag', 'fags', 'dyke', 'tranny', 'retard', 'retarded',
  'spic', 'chink', 'gook', 'kike', 'wetback', 'coon', 'paki', 'raghead', 'towelhead', 'beaner',
  // profanity / sexual
  'fuck', 'fucker', 'fucking', 'motherfucker', 'shit', 'bullshit', 'cunt', 'bitch', 'whore',
  'slut', 'cock', 'dick', 'pussy', 'porn', 'rape', 'rapist', 'cum', 'twat', 'wanker', 'asshole',
  // hate
  'nazi', 'hitler', 'kkk',
];

const SET = new Set(WORDS);
const SUFFIXES = ['', 's', 'es', 'ed', 'er', 'ers', 'ing', 'in', 'y'];

function blockedWord(w) {
  for (const suf of SUFFIXES) {
    if (suf && !w.endsWith(suf)) continue;
    const stem = suf ? w.slice(0, -suf.length) : w;
    if (SET.has(stem)) return true;
  }
  return false;
}

// Returns true when the cleaned text contains a blocked word.
export function isBlocked(text) {
  const plain = String(text).toLowerCase().replace(/'/g, '');
  const words = plain.split(/[^a-z]+/).filter(Boolean);
  if (words.some(blockedWord)) return true;
  // catch words split by spaces or dots like "f u c k" or "s.h.i.t"
  const letters = plain.replace(/[^a-z]+/g, ' ').split(' ');
  for (let i = 0; i < letters.length; i++) {
    if (letters[i].length !== 1) continue;
    let j = i;
    let joined = '';
    while (j < letters.length && letters[j].length === 1) joined += letters[j++];
    if (joined.length >= 3 && blockedWord(joined)) return true;
    i = j;
  }
  return false;
}
