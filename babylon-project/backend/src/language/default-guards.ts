import type {
  InputClassification,
  InputClassifier,
  InputMode,
  OutputLanguageValidator,
} from './language-agent.js';
import type { SupportedLanguage } from './contracts.js';

const URL_RE = /https?:\/\/\S+|www\.\S+/giu;
const EMAIL_RE = /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/giu;
const PHONE_RE = /(?<!\p{L})\+?[\d\s().-]{7,}(?!\p{L})/gu;
const CODE_RE = /`[^`]*`|```[\s\S]*?```/gu;
const QUOTED_RE = /(["“”„«»'])(?:(?!\1).){1,240}\1/gu;
const TOKEN_RE = /\p{L}+(?:['’-]\p{L}+)?/gu;
const CYRILLIC_RE = /\p{Script=Cyrillic}/u;
const LATIN_RE = /\p{Script=Latin}/u;
const HUNGARIAN_UNIQUE_RE = /[áéíóöőúüű]/iu;
const BELARUSIAN_UNIQUE_RE = /[іў]/iu;

const WORDS: Record<SupportedLanguage, ReadonlySet<string>> = {
  en: new Set([
    'a',
    'about',
    'and',
    'are',
    'as',
    'at',
    'be',
    'but',
    'can',
    'do',
    'for',
    'from',
    'have',
    'hello',
    'how',
    'i',
    'if',
    'in',
    'is',
    'it',
    'me',
    'my',
    'not',
    'of',
    'on',
    'or',
    'please',
    'that',
    'the',
    'this',
    'to',
    'we',
    'what',
    'when',
    'with',
    'you',
    'your',
  ]),
  hu: new Set([
    'a',
    'az',
    'és',
    'egy',
    'hogy',
    'nem',
    'igen',
    'is',
    'van',
    'volt',
    'lesz',
    'vagy',
    'de',
    'ha',
    'mert',
    'mint',
    'meg',
    'már',
    'még',
    'itt',
    'ott',
    'én',
    'te',
    'mi',
    'ti',
    'nekem',
    'neked',
    'szia',
    'helló',
    'kérlek',
    'köszönöm',
    'ezt',
    'azt',
    'ami',
    'akkor',
    'most',
  ]),
  be: new Set([
    'і',
    'ў',
    'я',
    'ты',
    'ён',
    'яна',
    'мы',
    'вы',
    'яны',
    'не',
    'так',
    'гэта',
    'што',
    'як',
    'на',
    'у',
    'ў',
    'з',
    'да',
    'для',
    'але',
    'калі',
    'бо',
    'мой',
    'мая',
    'твой',
    'твая',
    'прывітанне',
    'дзякуй',
    'калі',
    'ласка',
    'ёсць',
    'быў',
    'будзе',
    'цябе',
    'мяне',
  ]),
};

function stripNeutralArtifacts(text: string, stripQuotes: boolean): string {
  let result = text
    .replace(CODE_RE, ' ')
    .replace(URL_RE, ' ')
    .replace(EMAIL_RE, ' ')
    .replace(PHONE_RE, ' ');
  if (stripQuotes) result = result.replace(QUOTED_RE, ' ');
  return result;
}

function tokens(text: string): string[] {
  return [...text.toLocaleLowerCase().matchAll(TOKEN_RE)]
    .map((match) => match[0])
    .filter(Boolean);
}

function isLanguageNeutral(text: string): boolean {
  const remainder = stripNeutralArtifacts(text, false)
    .replace(/[\p{P}\p{S}\p{N}\p{Z}\p{M}_]+/gu, '')
    .trim();
  return remainder.length === 0;
}

function scoreLanguage(text: string): Record<SupportedLanguage, number> {
  const normalized = text.toLocaleLowerCase();
  const words = tokens(normalized);
  const scores: Record<SupportedLanguage, number> = { en: 0, hu: 0, be: 0 };

  for (const word of words) {
    for (const language of ['en', 'hu', 'be'] as const) {
      if (WORDS[language].has(word)) scores[language] += word.length <= 2 ? 1 : 2;
    }
  }

  for (const character of normalized) {
    if (BELARUSIAN_UNIQUE_RE.test(character)) scores.be += 3;
    if (HUNGARIAN_UNIQUE_RE.test(character)) scores.hu += 2;
    if (CYRILLIC_RE.test(character)) scores.be += 0.35;
  }

  return scores;
}

function detectLanguage(text: string): SupportedLanguage | null {
  const cleaned = stripNeutralArtifacts(text, false);
  const wordList = tokens(cleaned);
  if (wordList.length === 0) return null;

  const scores = scoreLanguage(cleaned);
  const ordered = (
    Object.entries(scores) as [SupportedLanguage, number][]
  ).sort((a, b) => b[1] - a[1]);
  const [best, second] = ordered;
  if (!best || !second) return null;

  const hasCyrillic = CYRILLIC_RE.test(cleaned);
  const hasLatin = LATIN_RE.test(cleaned);

  if (hasCyrillic && !hasLatin && scores.be >= 1.4) return 'be';
  if (best[1] >= 3 && best[1] >= second[1] + 1.5) return best[0];

  if (
    wordList.length >= 4 &&
    best[1] >= 2 &&
    best[1] >= second[1] * 1.8
  )
    return best[0];
  return null;
}

export class ConservativeInputClassifier implements InputClassifier {
  classify(
    input: Readonly<{ text: string; inputMode: InputMode }>,
  ): Promise<InputClassification> {
    const text = input.text.trim();
    if (isLanguageNeutral(text)) return Promise.resolve({ kind: 'neutral' });

    const sourceLanguage = detectLanguage(text);
    if (sourceLanguage !== null) return Promise.resolve({ kind: 'language', sourceLanguage });

    return Promise.resolve({
      kind: 'invalid',
      reason:
        input.inputMode === 'voice_transcript'
          ? 'unintelligible_voice_input'
          : 'unintelligible_text',
    });
  }
}

export class ConservativeOutputLanguageValidator implements OutputLanguageValidator {
  matchesTargetLanguage(
    input: Readonly<{ text: string; targetLanguage: SupportedLanguage }>,
  ): Promise<boolean> {
    if (isLanguageNeutral(input.text)) return Promise.resolve(true);

    const assessable = stripNeutralArtifacts(input.text, true).trim();
    if (assessable.length === 0) return Promise.resolve(true);

    const detected = detectLanguage(assessable);
    if (detected !== null) return Promise.resolve(detected === input.targetLanguage);

    const hasCyrillic = CYRILLIC_RE.test(assessable);
    const hasLatin = LATIN_RE.test(assessable);

    if (input.targetLanguage === 'be') {
      if (!hasCyrillic) return Promise.resolve(false);
      return Promise.resolve(scoreLanguage(assessable).be >= 1.4);
    }

    if (hasCyrillic) return Promise.resolve(false);
    if (!hasLatin) return Promise.resolve(true);

    const scores = scoreLanguage(assessable);
    if (input.targetLanguage === 'hu') {
      if (HUNGARIAN_UNIQUE_RE.test(assessable)) return Promise.resolve(true);
      return Promise.resolve(scores.hu >= scores.en && scores.hu >= 2);
    }

    if (HUNGARIAN_UNIQUE_RE.test(assessable) && scores.hu > scores.en) {
      return Promise.resolve(false);
    }
    return Promise.resolve(scores.en >= scores.hu && scores.en >= 2);
  }
}
