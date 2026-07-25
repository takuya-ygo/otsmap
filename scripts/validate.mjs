import path from 'node:path';
import { readJson } from './lib.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const raw = await readJson(path.join(ROOT, 'data/raw-stores.json'));
const mapData = await readJson(path.join(ROOT, 'docs/stores.json'));
const minimum = Number(process.env.MINIMUM_STORE_COUNT ?? 50);

assert(Array.isArray(raw.stores), 'raw-stores.json の stores が配列ではありません。');
assert(raw.stores.length >= minimum, `取得店舗数 ${raw.stores.length} が最低件数 ${minimum} を下回っています。`);
assert(Array.isArray(mapData.stores), 'docs/stores.json の stores が配列ではありません。');
assert(mapData.stores.length > 0, '地図に表示可能な店舗が0件です。座標取得を確認してください。');

const ids = new Set();
for (const store of raw.stores) {
  assert(store.storeId || (store.name && store.address), '識別不能な店舗があります。');
  if (store.storeId) {
    assert(!ids.has(store.storeId), `店舗IDが重複しています: ${store.storeId}`);
    ids.add(store.storeId);
  }
}
console.log(`検証成功: 取得 ${raw.stores.length}件 / 地図表示 ${mapData.stores.length}件`);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
