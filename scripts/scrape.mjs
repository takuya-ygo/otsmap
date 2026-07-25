import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  dedupeStores,
  extractStoreId,
  findStoreCandidates,
  normalizeSpace,
  officialUrl,
  prefectureFromAddress,
  readJson,
  writeJson
} from './lib.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const config = await readJson(path.join(ROOT, 'config/scrape.json'));
const minimumStoreCount = Number(process.env.MINIMUM_STORE_COUNT ?? config.minimumStoreCount ?? 50);
const headless = process.env.HEADLESS !== 'false';
const browser = await chromium.launch({ headless });
const context = await browser.newContext({
  locale: 'ja-JP',
  timezoneId: 'Asia/Tokyo',
  viewport: { width: 1440, height: 1100 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36'
});
const page = await context.newPage();
const stores = [];
const networkLog = [];

page.on('response', async (response) => {
  try {
    const contentType = response.headers()['content-type'] ?? '';
    if (!contentType.includes('json')) return;
    const body = await response.body();
    if (body.length > 8_000_000) return;
    const json = JSON.parse(body.toString('utf8'));
    const found = findStoreCandidates(json, response.url());
    if (found.length) stores.push(...found);
    networkLog.push({ url: response.url(), status: response.status(), candidates: found.length });
  } catch {
    // Some endpoints label non-JSON content as JSON. Ignore them.
  }
});

try {
  const startUrls = config.startUrls ?? [config.startUrl].filter(Boolean);
  if (!startUrls.length) throw new Error('開始URLが設定されていません。');

  for (const startUrl of startUrls) {
    console.log(`取得を試行: ${startUrl}`);
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await settle(page, Number(config.settleMilliseconds ?? 4000));
    await dismissDialogs(page);
    await chooseJapan(page);
    await triggerSearch(page);
    await settle(page, Number(config.settleMilliseconds ?? 4000));
    await collectDomStores(page, stores, Number(config.maxPaginationSteps ?? 250));
    if (dedupeStores(stores).length >= minimumStoreCount) break;
  }

  const unique = dedupeStores(stores).filter((store) => store.storeId.endsWith('JP') || store.address);
  if (unique.length < minimumStoreCount) {
    await saveDiagnostics(page, networkLog, unique, `取得件数が安全基準未満です: ${unique.length} < ${minimumStoreCount}`);
    throw new Error(
      `店舗を${unique.length}件しか取得できませんでした。空データで上書きしないため停止しました。` +
      ` artifacts/ の画面・HTML・通信候補を確認してください。`
    );
  }

  const now = new Date().toISOString();
  const output = {
    meta: {
      source: startUrls,
      fetchedAt: now,
      count: unique.length,
      note: 'KONAMI CARD GAME NETWORKの公開検索画面から自動取得。公開・転載は権利者の許可条件を確認してください。'
    },
    stores: unique.map((store) => ({
      ...store,
      prefecture: store.prefecture || prefectureFromAddress(store.address),
      officialUrl: store.officialUrl || officialUrl(store.storeId),
      updatedAt: now
    }))
  };

  await writeJson(path.join(ROOT, 'data/raw-stores.json'), output);
  await writeJson(path.join(ROOT, 'artifacts/network-summary.json'), networkLog);
  console.log(`取得完了: ${unique.length}店舗`);
} finally {
  await browser.close();
}

async function dismissDialogs(page) {
  const labels = [
    '同意する','確認しました','閉じる','OK','次へ','日本','Japan',
    'Agree','Accept','Confirm','Close','Continue'
  ];
  for (let round = 0; round < 8; round += 1) {
    let clicked = false;
    for (const label of labels) {
      const locator = page.getByRole('button', { name: new RegExp(`^${escapeRegex(label)}$`, 'i') });
      const count = await locator.count();
      for (let index = 0; index < Math.min(count, 3); index += 1) {
        const button = locator.nth(index);
        if (await button.isVisible().catch(() => false)) {
          await button.click({ timeout: 3000 }).catch(() => {});
          clicked = true;
          await page.waitForTimeout(500);
        }
      }
    }
    if (!clicked) break;
  }
}

async function chooseJapan(page) {
  const selects = page.locator('select');
  for (let index = 0; index < await selects.count(); index += 1) {
    const select = selects.nth(index);
    const options = await select.locator('option').allTextContents().catch(() => []);
    const japanIndex = options.findIndex((text) => /日本|Japan/i.test(text));
    if (japanIndex >= 0) {
      const option = select.locator('option').nth(japanIndex);
      const value = await option.getAttribute('value');
      if (value !== null) await select.selectOption(value).catch(() => {});
    }
  }

  const japanText = page.getByText(/^(日本|Japan)$/i, { exact: true });
  for (let index = 0; index < Math.min(await japanText.count(), 5); index += 1) {
    const target = japanText.nth(index);
    if (await target.isVisible().catch(() => false)) {
      await target.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(700);
    }
  }
}

async function triggerSearch(page) {
  const patterns = [/検索/, /Search/i, /この条件/, /絞り込/];
  for (const pattern of patterns) {
    const buttons = page.getByRole('button', { name: pattern });
    for (let index = 0; index < await buttons.count(); index += 1) {
      const button = buttons.nth(index);
      if (await button.isVisible().catch(() => false)) {
        await button.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(1000);
        return;
      }
    }
  }
}

async function collectDomStores(page, stores, maxSteps) {
  let unchanged = 0;
  let lastSignature = '';

  for (let step = 0; step < maxSteps; step += 1) {
    await extractLinksAndCards(page, stores);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(800);
    await extractLinksAndCards(page, stores);

    const hrefs = await page.locator('a[href*="/store/detail/"]').evaluateAll((links) =>
      links.map((link) => link.href).sort()
    ).catch(() => []);
    const signature = `${hrefs.length}:${hrefs.at(-1) ?? ''}:${stores.length}`;
    unchanged = signature === lastSignature ? unchanged + 1 : 0;
    lastSignature = signature;

    const next = await findNextControl(page);
    if (!next || unchanged >= 3) break;
    await next.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1200);
  }
}

async function extractLinksAndCards(page, stores) {
  const domStores = await page.locator('a[href*="/store/detail/"]').evaluateAll((links) => links.map((link) => {
    const href = link.href;
    const container = link.closest('li, article, tr, .store, .shop, .result, [class*="store"], [class*="shop"]') || link.parentElement;
    return {
      href,
      text: (container?.innerText || link.innerText || '').trim()
    };
  })).catch(() => []);

  for (const item of domStores) {
    const storeId = extractStoreId(item.href);
    const lines = String(item.text).split(/\n+/).map(normalizeSpace).filter(Boolean);
    const address = lines.find((line) => /(?:〒?\d{3}-?\d{4}|都|道|府|県)/.test(line) && line.length > 5) ?? '';
    const phone = lines.find((line) => /(?:TEL|電話)?\s*0\d{1,4}-\d{1,4}-\d{3,4}/i.test(line)) ?? '';
    const name = lines.find((line) => line !== address && line !== phone && line.length <= 100) ?? '';
    stores.push({
      storeId,
      name,
      address,
      prefecture: prefectureFromAddress(address),
      phone,
      officialUrl: item.href,
      sourceUrl: page.url()
    });
  }
}

async function findNextControl(page) {
  const selectors = [
    page.getByRole('button', { name: /^(次へ|次|Next|›|»)/i }),
    page.getByRole('link', { name: /^(次へ|次|Next|›|»)/i }),
    page.locator('[rel="next"]'),
    page.locator('[aria-label*="次"], [aria-label*="Next"]')
  ];
  for (const locator of selectors) {
    for (let index = 0; index < await locator.count(); index += 1) {
      const candidate = locator.nth(index);
      const disabled = await candidate.isDisabled().catch(() => false);
      if (!disabled && await candidate.isVisible().catch(() => false)) return candidate;
    }
  }
  return null;
}

async function settle(page, milliseconds) {
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(milliseconds);
}

async function saveDiagnostics(page, networkLog, stores, reason) {
  await fs.mkdir(path.join(ROOT, 'artifacts'), { recursive: true });
  await page.screenshot({ path: path.join(ROOT, 'artifacts/store-search.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(ROOT, 'artifacts/store-search.html'), await page.content(), 'utf8').catch(() => {});
  await writeJson(path.join(ROOT, 'artifacts/network-summary.json'), networkLog);
  await writeJson(path.join(ROOT, 'artifacts/partial-stores.json'), { reason, count: stores.length, stores });
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
