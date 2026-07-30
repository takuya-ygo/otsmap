import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  dedupeStores,
  extractStoreId,
  findStoreCandidates,
  normalizeSpace,
  normalizeStoreTypes,
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
    await saveStageDiagnostics(page, `before-search-${safeFilePart(new URL(startUrl).pathname)}`);
    await triggerSearch(page);
    await settle(page, Number(config.settleMilliseconds ?? 4000));
    await saveStageDiagnostics(page, `after-search-${safeFilePart(new URL(startUrl).pathname)}`);
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
  const officialTournamentStoreCount = unique.filter((store) => store.isOfficialTournamentStore).length;
  const satelliteShopCount = unique.filter((store) => store.isSatelliteShop).length;
  const output = {
    meta: {
      source: startUrls,
      fetchedAt: now,
      count: unique.length,
      officialTournamentStoreCount,
      satelliteShopCount,
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
  console.log(`取得完了: ${unique.length}店舗 / OTS: ${officialTournamentStoreCount}店舗 / サテライトショップ: ${satelliteShopCount}店舗`);
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
  // このサイトの同意ボタンは <button> だけでなく <a class="yes-btn"> でも実装される。
  // role=button のみでは初回同意画面を処理できないため、リンクとinputも対象にする。
  const agreeLabels = [
    '同意する', '確認しました', 'OK', '次へ', '閉じる',
    'Agree', 'Accept', 'Confirm', 'Continue', 'Close'
  ];

  for (let round = 0; round < 12; round += 1) {
    let clicked = false;
    for (const label of agreeLabels) {
      const candidates = [
        page.getByRole('button', { name: new RegExp(`^${escapeRegex(label)}$`, 'i') }),
        page.getByRole('link', { name: new RegExp(`^${escapeRegex(label)}$`, 'i') }),
        page.locator(`input[type="button"], input[type="submit"]`).filter({
          has: page.locator(`xpath=.[@value=${xpathLiteral(label)}]`)
        })
      ];

      for (const locator of candidates) {
        const count = await locator.count().catch(() => 0);
        for (let index = 0; index < Math.min(count, 5); index += 1) {
          const control = locator.nth(index);
          if (!await control.isVisible().catch(() => false)) continue;
          await control.scrollIntoViewIfNeeded().catch(() => {});
          const didClick = await control.click({ timeout: 4000, force: true })
            .then(() => true)
            .catch(() => false);
          if (didClick) {
            clicked = true;
            await page.waitForTimeout(900);
            break;
          }
        }
        if (clicked) break;
      }
      if (clicked) break;
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
  await ensureStoreSearchRoute(page);
  await dismissDialogs(page);

  const controls = await describeVisibleControls(page);
  await writeJson(path.join(ROOT, 'artifacts/store-controls.json'), {
    url: page.url(),
    capturedAt: new Date().toISOString(),
    controls
  });

  const exactPatterns = [
    /^(この条件で検索|条件を指定して検索|検索する|検索|Search)$/i
  ];

  const candidateLocators = [];
  for (const pattern of exactPatterns) {
    candidateLocators.push(page.getByRole('button', { name: pattern }));
    candidateLocators.push(page.getByRole('link', { name: pattern }));
  }
  candidateLocators.push(page.locator('input[type="submit"], input[type="button"]').filter({ hasText: /検索|Search/i }));
  candidateLocators.push(page.locator('[ng-click*="search" i], [data-ng-click*="search" i]'));

  for (const locator of candidateLocators) {
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < Math.min(count, 10); index += 1) {
      const candidate = locator.nth(index);
      if (!await candidate.isVisible().catch(() => false)) continue;

      const href = await candidate.getAttribute('href').catch(() => null);
      const aria = await candidate.getAttribute('aria-label').catch(() => null);
      // 左メニューの「店舗検索」は検索実行ボタンではない。
      if (href === '/store_search' || aria === '店舗検索') continue;

      const label = normalizeSpace(
        await candidate.innerText().catch(async () =>
          await candidate.getAttribute('value').catch(() => '')
        )
      );
      console.log(`検索操作を実行: ${label || await candidate.getAttribute('ng-click').catch(() => '')}`);
      await candidate.scrollIntoViewIfNeeded().catch(() => {});
      const clicked = await candidate.click({ timeout: 7000, force: true })
        .then(() => true)
        .catch(() => false);
      if (!clicked) continue;
      await page.waitForTimeout(1800);
      await dismissDialogs(page);
      return;
    }
  }

  throw new Error(
    '店舗検索の実行ボタンが見つかりませんでした。artifacts/store-controls.json と before-search の画面を確認してください。'
  );
}

async function ensureStoreSearchRoute(page) {
  const pathname = new URL(page.url()).pathname;
  if (pathname === '/store_search') return;

  const menuLink = page.locator('a[href="/store_search"]').first();
  if (await menuLink.isVisible().catch(() => false)) {
    await menuLink.click({ timeout: 7000, force: true });
    await page.waitForTimeout(1500);
  } else {
    await page.goto('https://cardgame-network.konami.net/store_search?languageCode=ja', {
      waitUntil: 'domcontentloaded',
      timeout: 90_000
    });
    await settle(page, 2500);
  }
  await dismissDialogs(page);

  if (new URL(page.url()).pathname !== '/store_search') {
    throw new Error(`店舗検索画面へ移動できませんでした。現在URL: ${page.url()}`);
  }
}

async function describeVisibleControls(page) {
  return await page.locator('button, a, input, select, textarea').evaluateAll((elements) =>
    elements
      .filter((element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      })
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        type: element.getAttribute('type'),
        text: (element.innerText || element.value || element.getAttribute('aria-label') || '').trim().slice(0, 240),
        href: element.getAttribute('href'),
        id: element.id || null,
        name: element.getAttribute('name'),
        ngClick: element.getAttribute('ng-click') || element.getAttribute('data-ng-click'),
        model: element.getAttribute('ng-model') || element.getAttribute('data-ng-model')
      }))
  ).catch(() => []);
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
    const container = link.closest('li, article, tr, .store, .shop, .result, [class*="store"], [class*="shop"], .results-btn') || link.parentElement;
    const iconSources = [...(container?.querySelectorAll('img') ?? [])]
      .map((image) => image.getAttribute('src') || image.getAttribute('ng-src') || '')
      .filter(Boolean);
    return {
      href,
      text: (container?.innerText || link.innerText || '').trim(),
      iconSources
    };
  })).catch(() => []);

  for (const item of domStores) {
    const storeId = extractStoreId(item.href);
    const lines = String(item.text).split(/\n+/).map(normalizeSpace).filter(Boolean);
    const address = lines.find((line) => /(?:〒?\d{3}-?\d{4}|都|道|府|県)/.test(line) && line.length > 5) ?? '';
    const phone = lines.find((line) => /(?:TEL|電話)?\s*0\d{1,4}-\d{1,4}-\d{3,4}/i.test(line)) ?? '';
    const name = lines.find((line) => line !== address && line !== phone && line.length <= 100) ?? '';
    const storeTypes = normalizeStoreTypes(item.iconSources);
    stores.push({
      storeId,
      name,
      address,
      prefecture: prefectureFromAddress(address),
      phone,
      ...(storeTypes.length ? { storeTypes } : {}),
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

async function saveStageDiagnostics(page, name) {
  await fs.mkdir(path.join(ROOT, 'artifacts'), { recursive: true });
  const safeName = safeFilePart(name);
  await page.screenshot({
    path: path.join(ROOT, `artifacts/${safeName}.png`),
    fullPage: true
  }).catch(() => {});
  await fs.writeFile(
    path.join(ROOT, `artifacts/${safeName}.html`),
    await page.content(),
    'utf8'
  ).catch(() => {});
}

function safeFilePart(value) {
  return String(value || 'page').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'page';
}

function xpathLiteral(value) {
  if (!String(value).includes("'")) return `'${value}'`;
  if (!String(value).includes('"')) return `"${value}"`;
  return `concat('${String(value).replace(/'/g, `', "'", '`)}')`;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
