export function normalizeCatalogTitle(value) {
  if (typeof value !== 'string') return '';
  return value.slice(0, 500).normalize('NFKD').toLowerCase()
    .replace(/\p{M}/gu, '')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
    .replace(/&/g, 'and')
    .replace(/\.(?!\d)|(?<!\d)\./g, '')
    .replace(/[^\p{L}\p{N}+.]/gu, '');
}

export function deduplicateCatalog(entries, { key = entry => normalizeCatalogTitle(entry?.name), merge = first => first } = {}) {
  const unique = new Map();
  for (const entry of entries || []) {
    const identity = key(entry);
    if (!identity) continue;
    if (unique.has(identity)) unique.set(identity, merge(unique.get(identity), entry, identity));
    else unique.set(identity, entry);
  }
  return [...unique.values()];
}
