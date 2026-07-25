import fs from 'node:fs/promises';
import path from 'node:path';

export async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (fallback !== null && error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function normalizeSpace(value) {
  return String(value ?? '')
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function firstValue(object, keys) {
  for (const key of keys) {
    const value = getByPath(object, key);
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return undefined;
}

function getByPath(object, dottedPath) {
  return dottedPath.split('.').reduce((current, key) => current?.[key], object);
}

export function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function extractStoreId(value) {
  const match = String(value ?? '').match(/(?:\/store\/detail\/)?([0-9]{6}[A-Z]{2})(?:\/|$|\?)/i);
  return match ? match[1].toUpperCase() : '';
}

export function officialUrl(storeId) {
  return storeId
    ? `https://cardgame-network.konami.net/store/detail/${encodeURIComponent(storeId)}/ja`
    : '';
}

export function prefectureFromAddress(address) {
  const prefectures = [
    '北海道','青森県','岩手県','宮城県','秋田県','山形県','福島県','茨城県','栃木県','群馬県',
    '埼玉県','千葉県','東京都','神奈川県','新潟県','富山県','石川県','福井県','山梨県','長野県',
    '岐阜県','静岡県','愛知県','三重県','滋賀県','京都府','大阪府','兵庫県','奈良県','和歌山県',
    '鳥取県','島根県','岡山県','広島県','山口県','徳島県','香川県','愛媛県','高知県','福岡県',
    '佐賀県','長崎県','熊本県','大分県','宮崎県','鹿児島県','沖縄県'
  ];
  return prefectures.find((name) => String(address ?? '').includes(name)) ?? '';
}

export function dedupeStores(stores) {
  const byKey = new Map();
  for (const store of stores) {
    const key = store.storeId || `${store.name}|${store.address}`;
    if (!key || key === '|') continue;
    const current = byKey.get(key) ?? {};
    byKey.set(key, mergeStore(current, store));
  }
  return [...byKey.values()].sort((a, b) =>
    `${a.prefecture}${a.address}${a.name}`.localeCompare(`${b.prefecture}${b.address}${b.name}`, 'ja')
  );
}

function mergeStore(left, right) {
  const merged = { ...left };
  for (const [key, value] of Object.entries(right)) {
    if (value !== undefined && value !== null && value !== '') merged[key] = value;
  }
  return merged;
}

export function normalizeStore(candidate, sourceUrl = '') {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;

  const url = normalizeSpace(firstValue(candidate, [
    'url','detailUrl','detail_url','storeUrl','store_url','href','link','links.detail','shopUrl'
  ]) ?? sourceUrl);
  const rawId = firstValue(candidate, [
    'storeId','store_id','storeCode','store_code','shopId','shop_id','shopCode','shop_code',
    'officialStoreId','official_store_id','id','code'
  ]);
  const storeId = extractStoreId(rawId) || extractStoreId(url) || extractStoreId(sourceUrl);

  const name = normalizeSpace(firstValue(candidate, [
    'storeName','store_name','shopName','shop_name','name','title','officialName','official_name'
  ]));

  const postalCode = normalizeSpace(firstValue(candidate, [
    'postalCode','postal_code','zipCode','zip_code','zip','postcode'
  ]));
  const address = normalizeSpace(firstValue(candidate, [
    'address','fullAddress','full_address','storeAddress','store_address','shopAddress','shop_address',
    'addressText','address_text','location.address'
  ]));
  const prefecture = normalizeSpace(firstValue(candidate, [
    'prefecture','prefectureName','prefecture_name','state','region','location.prefecture'
  ])) || prefectureFromAddress(address);
  const phone = normalizeSpace(firstValue(candidate, [
    'phone','phoneNumber','phone_number','telephone','tel','storeTel','store_tel'
  ]));
  const latitude = asNumber(firstValue(candidate, [
    'latitude','lat','location.latitude','location.lat','position.latitude','position.lat','y'
  ]));
  const longitude = asNumber(firstValue(candidate, [
    'longitude','lng','lon','location.longitude','location.lng','location.lon',
    'position.longitude','position.lng','position.lon','x'
  ]));

  const looksJapanese = storeId.endsWith('JP') || /Japan|日本|都|道|府|県/.test(`${address}${prefecture}`);
  const hasIdentity = Boolean(storeId || (name && address));
  if (!looksJapanese || !hasIdentity) return null;

  return {
    storeId,
    name,
    postalCode,
    address,
    prefecture,
    phone,
    latitude,
    longitude,
    officialUrl: storeId ? officialUrl(storeId) : url,
    sourceUrl: sourceUrl || url
  };
}

export function findStoreCandidates(value, sourceUrl = '') {
  const stores = [];
  const seen = new WeakSet();

  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (!Array.isArray(node)) {
      const normalized = normalizeStore(node, sourceUrl);
      if (normalized) stores.push(normalized);
    }

    for (const child of Object.values(node)) walk(child);
  }

  walk(value);
  return stores;
}
