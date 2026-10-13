// i18n.js — dictionaries in /i18n/<code>.json, listed in /i18n/languages.json.
// Add a language: drop in a JSON file with any subset of keys (missing keys fall back to English)
// and add it to languages.json. Object names: constellations come from data/constellations.json
// ("names" per language), others from keys like "planet.mars", "ast.ST", "obj.LMC".

let dict = {}, fallback = {}, langs = [], current = 'en';

export async function initI18n(preferred) {
  const get = (f) => fetch('i18n/' + f).then((r) => r.json());
  const list = await get('languages.json');
  langs = list.languages;
  const codes = langs.map((l) => l.code);
  current = pickLanguage(preferred, codes);
  fallback = await get(`${list.fallback}.json`);
  dict = current === list.fallback ? fallback : await get(`${current}.json`).catch(() => ({}));
  document.documentElement.lang = current;
  return current;
}

export function pickLanguage(preferred, codes) {
  if (preferred && preferred !== 'auto' && codes.includes(preferred)) return preferred;
  for (const l of navigator.languages || [navigator.language || 'en']) {
    const lc = l.toLowerCase();
    if (lc.startsWith('zh')) {
      const hant = /hant|tw|hk|mo/.test(lc);
      if (codes.includes(hant ? 'zh-Hant' : 'zh-Hans')) return hant ? 'zh-Hant' : 'zh-Hans';
    }
    const base = lc.split('-')[0];
    const hit = codes.find((c) => c.toLowerCase() === lc) || codes.find((c) => c.toLowerCase() === base);
    if (hit) return hit;
  }
  return 'en';
}

export const lang = () => current;
export const languages = () => langs;
export const has = (key) => key in dict || key in fallback;

/** Translate with {name} parameters. */
export function t(key, params) {
  let s = key in dict ? dict[key] : key in fallback ? fallback[key] : key;
  if (params && typeof s === 'string') s = s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? params[k] : m));
  return s;
}
/** Raw value (arrays/objects). */
export function tv(key) { return key in dict ? dict[key] : fallback[key]; }

/** Apply translations to elements with data-i18n / data-i18n-html / data-i18n-attr="attr:key". */
export function applyDOM(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of root.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of el.dataset.i18nAttr.split(';')) {
      const [attr, key] = pair.split(':');
      el.setAttribute(attr, t(key));
    }
  }
  document.title = t('appName');
}

// ---- Intl helpers
export function fmtDateTime(d) {
  return new Intl.DateTimeFormat(current, { month: 'short', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(d);
}
export function fmtTime(d) { return new Intl.DateTimeFormat(current, { hour: '2-digit', minute: '2-digit' }).format(d); }
export function fmtMonthDay(m, d) { return new Intl.DateTimeFormat(current, { month: 'long', day: 'numeric' }).format(new Date(2001, m - 1, d)); }
export function fmtNum(n, digits = 0) { return new Intl.NumberFormat(current, { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(n); }
