// Plural forms for the message tables (lib/i18n.mjs).
export const plural = {
  ru: (n, one, few, many) => {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many;
  },
  en: (n, one, other) => (n === 1 ? one : other),
};
