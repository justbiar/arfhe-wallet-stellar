/// <reference types="vitest/globals" />
import en from '../en.json';
import tr from '../tr.json';

/**
 * Locale key-parity check.
 *
 * i18next's `fallbackLng: 'en'` (see src/i18n.ts) means a key missing from tr.json silently
 * renders the English string with no error, warning, or visual signal — exactly the failure
 * mode that let "Amount"/"Recipient"/"Transaction" etc. slip through untranslated in a past
 * session. This test catches that class of bug at CI time instead of manual QA: every key that
 * exists in one locale file must exist in the other, and no value may be an empty string (an
 * empty i18next resource also silently falls back to English).
 *
 * This does NOT check translation quality/accuracy — just presence. A wrong-but-non-empty
 * Turkish string still passes; that's still a huge improvement over "missing entirely".
 */

type LocaleTree = { [key: string]: string | LocaleTree };

/** Flattens a nested locale object into dotted paths, e.g. "agent.txResultAmountLabel". */
function flattenKeys(obj: LocaleTree, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === 'string' ? [path] : flattenKeys(value, path);
  });
}

function getAtPath(obj: LocaleTree, path: string): string | LocaleTree {
  return path.split('.').reduce<string | LocaleTree>((node, segment) => {
    if (typeof node === 'string') return node;
    return node[segment];
  }, obj);
}

describe('locale key parity (en.json <-> tr.json)', () => {
  const enKeys = new Set(flattenKeys(en as LocaleTree));
  const trKeys = new Set(flattenKeys(tr as LocaleTree));

  it('en.json\'da olup tr.json\'da olmayan anahtar yok (fallbackLng bunları sessizce İngilizce gösterir)', () => {
    const missingFromTr = [...enKeys].filter((k) => !trKeys.has(k)).sort();
    expect(missingFromTr).toEqual([]);
  });

  it('tr.json\'da olup en.json\'da olmayan anahtar yok (ölü/yetim anahtar ya da typo işareti)', () => {
    const missingFromEn = [...trKeys].filter((k) => !enKeys.has(k)).sort();
    expect(missingFromEn).toEqual([]);
  });

  it('hiçbir anahtarın değeri boş string değil (boş değer de fallbackLng\'i sessizce tetikler)', () => {
    const emptyInEn = [...enKeys].filter((k) => getAtPath(en as LocaleTree, k) === '');
    const emptyInTr = [...trKeys].filter((k) => getAtPath(tr as LocaleTree, k) === '');
    expect({ emptyInEn, emptyInTr }).toEqual({ emptyInEn: [], emptyInTr: [] });
  });

  it('interpolation parametreleri ({{x}}) her iki dilde de aynı anahtar için eşleşir', () => {
    const placeholderPattern = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
    const extractPlaceholders = (value: string): string[] =>
      [...value.matchAll(placeholderPattern)].map((m) => m[1]).sort();

    const mismatches: Array<{ key: string; en: string[]; tr: string[] }> = [];
    for (const key of enKeys) {
      if (!trKeys.has(key)) continue; // already reported by the parity test above
      const enValue = getAtPath(en as LocaleTree, key);
      const trValue = getAtPath(tr as LocaleTree, key);
      if (typeof enValue !== 'string' || typeof trValue !== 'string') continue;
      const enPlaceholders = extractPlaceholders(enValue);
      const trPlaceholders = extractPlaceholders(trValue);
      if (JSON.stringify(enPlaceholders) !== JSON.stringify(trPlaceholders)) {
        mismatches.push({ key, en: enPlaceholders, tr: trPlaceholders });
      }
    }
    expect(mismatches).toEqual([]);
  });
});
