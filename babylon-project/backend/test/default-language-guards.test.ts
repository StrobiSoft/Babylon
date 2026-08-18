import { describe, expect, it } from 'vitest';
import {
  ConservativeInputClassifier,
  ConservativeOutputLanguageValidator,
} from '../src/language/default-guards.js';

const classifier = new ConservativeInputClassifier();
const validator = new ConservativeOutputLanguageValidator();

describe('ConservativeInputClassifier', () => {
  it.each([
    ['https://example.com/a?b=1', 'text'],
    ['+36 30 123 4567', 'text'],
    ['🙂🚚✅', 'text'],
    ['`const answer = 42;`', 'text'],
  ] as const)('passes neutral content unchanged: %s', async (text, inputMode) => {
    await expect(classifier.classify({ text, inputMode })).resolves.toEqual({ kind: 'neutral' });
  });

  it('detects Hungarian without trusting sender metadata', async () => {
    await expect(
      classifier.classify({ text: 'Szia, kérlek mondd meg, hogy mikor lesz kész.', inputMode: 'text' }),
    ).resolves.toEqual({ kind: 'language', sourceLanguage: 'hu' });
  });

  it('detects English', async () => {
    await expect(
      classifier.classify({ text: 'Hello, please tell me when this will be ready.', inputMode: 'text' }),
    ).resolves.toEqual({ kind: 'language', sourceLanguage: 'en' });
  });

  it('detects Belarusian', async () => {
    await expect(
      classifier.classify({ text: 'Прывітанне, калі ласка, скажы мне, калі гэта будзе гатова.', inputMode: 'text' }),
    ).resolves.toEqual({ kind: 'language', sourceLanguage: 'be' });
  });

  it('does not reject ordinary Hungarian spelling noise when the language signal remains clear', async () => {
    await expect(
      classifier.classify({ text: 'Sziaa, kérlek mondd meg hogy mikor lesz késsz.', inputMode: 'text' }),
    ).resolves.toEqual({ kind: 'language', sourceLanguage: 'hu' });
  });

  it('fails safely when apparent text has insufficient reliable signal', async () => {
    await expect(classifier.classify({ text: 'blorx zzqv nmp', inputMode: 'text' })).resolves.toEqual({
      kind: 'invalid',
      reason: 'unintelligible_text',
    });
  });

  it('uses the voice-specific invalid reason', async () => {
    await expect(
      classifier.classify({ text: 'blorx zzqv nmp', inputMode: 'voice_transcript' }),
    ).resolves.toEqual({ kind: 'invalid', reason: 'unintelligible_voice_input' });
  });
});

describe('ConservativeOutputLanguageValidator', () => {
  it('accepts Hungarian output for a Hungarian target', async () => {
    await expect(
      validator.matchesTargetLanguage({ text: 'Szia, ez már magyarul van.', targetLanguage: 'hu' }),
    ).resolves.toBe(true);
  });

  it('rejects English output for a Hungarian target', async () => {
    await expect(
      validator.matchesTargetLanguage({ text: 'Hello, this is still in English.', targetLanguage: 'hu' }),
    ).resolves.toBe(false);
  });

  it('accepts Belarusian output for a Belarusian target', async () => {
    await expect(
      validator.matchesTargetLanguage({ text: 'Прывітанне, гэта ўжо па-беларуску.', targetLanguage: 'be' }),
    ).resolves.toBe(true);
  });

  it('rejects Belarusian output for an English target', async () => {
    await expect(
      validator.matchesTargetLanguage({ text: 'Прывітанне, гэта не англійская.', targetLanguage: 'en' }),
    ).resolves.toBe(false);
  });

  it('tolerates quoted foreign text inside otherwise clear target-language output', async () => {
    await expect(
      validator.matchesTargetLanguage({
        text: 'A felirat pontosan ez volt: “Hello world”. Kérlek, ezt hagyd változatlanul.',
        targetLanguage: 'hu',
      }),
    ).resolves.toBe(true);
  });

  it('tolerates links and code fragments', async () => {
    await expect(
      validator.matchesTargetLanguage({
        text: 'Please open https://example.com and run `npm test` when you are ready.',
        targetLanguage: 'en',
      }),
    ).resolves.toBe(true);
  });
});
