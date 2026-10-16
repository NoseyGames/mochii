export function readMigratedStorage(storage, key, legacyKey) {
  const current = storage.getItem(key);
  if (current !== null && current !== undefined) return current;
  const legacy = storage.getItem(legacyKey);
  if (legacy === null || legacy === undefined) return null;
  try {
    const latest = storage.getItem(key);
    if (latest !== null && latest !== undefined) return latest;
    storage.setItem(key, legacy);
  } catch {}
  return legacy;
}
