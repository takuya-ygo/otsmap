import path from 'node:path';
import { readJson, writeJson } from './lib.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const raw = await readJson(path.join(ROOT, 'data/raw-stores.json'));
const cachePath = path.join(ROOT, 'data/geocode-cache.json');
const cache = await readJson(cachePath, {});
const apiKey = process.env.GEOCODING_API_KEY ?? '';
const refreshAfterDays = 25;
let geocoded = 0;
let unresolved = 0;

for (const store of raw.stores) {
  if (validCoordinate(store.latitude, store.longitude)) continue;
  if (!store.address) {
    unresolved += 1;
    continue;
  }

  const key = store.address;
  const cached = cache[key];
  if (cached && isFresh(cached.checkedAt, refreshAfterDays) && validCoordinate(cached.latitude, cached.longitude)) {
    store.latitude = cached.latitude;
    store.longitude = cached.longitude;
    store.geocodeSource = cached.source;
    continue;
  }

  if (!apiKey) {
    unresolved += 1;
    continue;
  }

  const result = await geocodeAddress(store.address, apiKey);
  cache[key] = {
    ...result,
    checkedAt: new Date().toISOString(),
    source: 'Google Geocoding API'
  };
  if (validCoordinate(result.latitude, result.longitude)) {
    store.latitude = result.latitude;
    store.longitude = result.longitude;
    store.geocodeSource = 'Google Geocoding API';
    geocoded += 1;
  } else {
    unresolved += 1;
  }
  await delay(120);
}

const visibleStores = raw.stores.filter((store) => validCoordinate(store.latitude, store.longitude));
const output = {
  meta: {
    ...raw.meta,
    mapReadyAt: new Date().toISOString(),
    mappableCount: visibleStores.length,
    unresolvedCount: raw.stores.length - visibleStores.length
  },
  stores: visibleStores
};

await writeJson(cachePath, cache);
await writeJson(path.join(ROOT, 'docs/stores.json'), output);
console.log(`地図用データ: ${visibleStores.length}件 / 新規ジオコード: ${geocoded}件 / 未解決: ${unresolved}件`);

async function geocodeAddress(address, key) {
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address', address);
  url.searchParams.set('region', 'jp');
  url.searchParams.set('language', 'ja');
  url.searchParams.set('key', key);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`Geocoding API HTTP ${response.status}`);
    const json = await response.json();
    if (json.status === 'OK') {
      const location = json.results?.[0]?.geometry?.location;
      return { latitude: location?.lat, longitude: location?.lng, status: json.status };
    }
    if (!['OVER_QUERY_LIMIT', 'UNKNOWN_ERROR'].includes(json.status)) {
      return { latitude: null, longitude: null, status: json.status };
    }
    await delay(1000 * (attempt + 1));
  }
  return { latitude: null, longitude: null, status: 'RETRY_EXHAUSTED' };
}

function validCoordinate(latitude, longitude) {
  return Number.isFinite(Number(latitude)) && Number.isFinite(Number(longitude)) &&
    Number(latitude) >= 20 && Number(latitude) <= 50 && Number(longitude) >= 120 && Number(longitude) <= 155;
}

function isFresh(isoDate, days) {
  const timestamp = Date.parse(isoDate ?? '');
  return Number.isFinite(timestamp) && Date.now() - timestamp < days * 86_400_000;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
