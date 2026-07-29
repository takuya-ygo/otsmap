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
    const request = response.request();
    networkLog.push({
      method: request.method(),
      url: response.url(),
      status: response.status(),
      candidates: found.length,
      postData: sanitizePostData(request.postData())
    });
  } catch {
    // Some endpoints label non-JSON content as JSON. Ignore them.
  }
});

try {
  const startUrls = config.startUrls ?? [config.startUrl].filter(Boolean);
  if (!startUrls.length) throw new Error('開始URLが設定されていません。');

  for (const startUrl of startUrls) {
    console.log(`取得を試行: ${startUrl}`);
    await openStoreSearch(page, startUrl, Number(config.settleMilliseconds ?? 4000));
    await triggerSearch(page);
    await settle(page, Number(config.settleMilliseconds ?? 4000));
    await collectDomStores(page, stores, Number(config.maxPaginationSteps ?? 250));
    console.log(`現在の取得件数: ${dedupeStores(stores).length}`);
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

async function openStoreSearch(page, startUrl, settleMilliseconds) {
  await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await settle(page, settleMilliseconds);
  await dismissCookieBanner(page);

  if (await isCountrySelectionPage(page)) {
    console.log(`サービス対応地域選択画面を検出: ${page.url()}`);
    await chooseJapan(page);
    await settle(page, 2500);
    await dismissDialogs(page);

    // 国・地域の設定は同じブラウザーコンテキストのCookie等へ保存される。
    // 設定後に検索URLを明示的に開き直さないと、worldmap画面に残る場合がある。
    console.log('日本を設定後、店舗検索画面を開き直します。');
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await settle(page, settleMilliseconds);
    await dismissCookieBanner(page);
    await dismissDialogs(page);
  } else {
    await dismissDialogs(page);
  }

  if (await isCountrySelectionPage(page)) {
    throw new Error(
      `日本の地域設定後も店舗検索へ進めませんでした。現在URL: ${page.url()}`
    );
  }
  console.log(`店舗検索画面を表示: ${page.url()}`);
}

async function isCountrySelectionPage(page) {
  const japanButton = page.locator('#jpn a.area-btn').filter({ hasText: /日本|Japan/i }).first();
  if (await japanButton.isVisible().catch(() => false)) return true;
  return /\/worldmap(?:$|[?#])/i.test(new URL(page.url()).pathname + new URL(page.url()).search + new URL(page.url()).hash);
}

async function dismissCookieBanner(page) {
  // OneTrustのバナーがクリックを遮るため、まず「すべて拒否」を選ぶ。
  // 表示言語等により拒否ボタンがない場合だけ許可ボタンも候補にする。
  const patterns = [
    /^(すべて拒否|全て拒否|Reject All|Reject all)$/i,
    /^(すべて許可|全て許可|Accept All|Accept all)$/i
  ];
  for (const pattern of patterns) {
    const buttons = page.getByRole('button', { name: pattern });
    for (let index = 0; index < await buttons.count(); index += 1) {
      const button = buttons.nth(index);
      if (await button.isVisible().catch(() => false)) {
        await button.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(700);
        return;
      }
    }
  }
}

async function dismissDialogs(page) {
  const labels = [
    '確認しました','閉じる','OK','次へ',
    'Agree','Accept','Confirm','Close','Continue',
    '同意する'
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
          await page.waitForTimeout(700);
        }
      }
    }
    if (!clicked) break;
  }
}

async function chooseJapan(page) {
  const selector = page.locator('#jpn a.area-btn').filter({ hasText: /日本|Japan/i }).first();
  if (!await selector.isVisible().catch(() => false)) {
    throw new Error('サービス対応地域選択画面で「日本」ボタンが見つかりませんでした。');
  }

  const settingResponse = page.waitForResponse((response) =>
    response.url().includes('/mt/user/rest/user-setting/') && response.status() >= 200 && response.status() < 300,
  { timeout: 15_000 }).catch(() => null);

  await selector.scrollIntoViewIfNeeded().catch(() => {});
  await selector.click({ timeout: 10_000, force: true });
  await page.waitForTimeout(800);

  // 初回アクセス時に規約・プライバシー確認が開く場合がある。
  await dismissDialogs(page);
  const response = await settingResponse;
  console.log(response
    ? `日本の地域設定レスポンス: HTTP ${response.status()}`
    : '日本ボタンをクリックしました（地域設定レスポンスは待機時間内に確認できませんでした）。');
  await page.waitForTimeout(1800);
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

function sanitizePostData(value) {
  if (!value) return null;
  const text = String(value);
  // 診断に必要な範囲だけ保存し、長大なデータや認証情報らしき値を避ける。
  return text
    .replace(/("?(?:token|password|authorization|secret|apiKey)"?\s*[:=]\s*)"?[^",&\s]+/gi, '$1"***"')
    .slice(0, 2000);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
