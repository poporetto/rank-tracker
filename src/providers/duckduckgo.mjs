import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { STATUS } from '../db.mjs';
import { urlMatchesDomain } from '../domain.mjs';

/**
 * DuckDuckGo SERP provider.
 *
 * Why a real (non-headless) Chrome window: DuckDuckGo's plain-HTML endpoints
 * return a 202 "anomaly" page to scripted clients, and headless Chrome renders
 * an empty result list. A visible Chrome window returns the real SERP. We do
 * NOT patch fingerprints or solve challenges - if DuckDuckGo decides to serve a
 * challenge page, this provider reports `blocked` and the tracker stores that
 * as "we learned nothing", never as a rank drop.
 */

const PROFILE_DIR = resolve(process.cwd(), 'data', 'browser-profile');
const RESULTS_PER_PAGE = 10;
const MAX_MORE_CLICKS = 6; // 10 + 6 pages is comfortably past depth 50

let contextPromise = null;

/** One persistent Chrome profile, reused across every query in a run. */
async function getContext() {
  if (!contextPromise) {
    contextPromise = chromium.launchPersistentContext(PROFILE_DIR, {
      channel: 'chrome',
      headless: false,
      viewport: { width: 1280, height: 900 },
    });
  }
  return contextPromise;
}

export async function closeBrowser() {
  if (!contextPromise) return;
  const ctx = await contextPromise.catch(() => null);
  contextPromise = null;
  if (ctx) await ctx.close().catch(() => {});
}

const BLOCK_SIGNS = [
  /unusual traffic/i,
  /solve the challenge/i,
  /are you a robot/i,
  /verifying your browser/i,
  /captcha/i,
  /access denied/i,
];

/** Pull the ordered organic results currently rendered on the page. */
function extractResults() {
  const out = [];
  const seen = new Set();
  for (const article of document.querySelectorAll('[data-testid="result"]')) {
    const link =
      article.querySelector('[data-testid="result-title-a"]') || article.querySelector('a[href^="http"]');
    if (!link) continue;

    let href = link.href;
    let host;
    try {
      host = new URL(href).hostname;
    } catch {
      continue;
    }
    // duckduckgo.com/y.js is the ad redirector; internal links are never organic.
    if (/(^|\.)duckduckgo\.com$/i.test(host)) continue;
    // Explicit ad badging.
    if (article.querySelector('[data-testid="result-extras-badge"]')) continue;
    if (/^\s*ad\b/i.test(article.innerText || '')) continue;

    if (seen.has(href)) continue;
    seen.add(href);
    out.push({ url: href, title: (link.innerText || '').trim().slice(0, 300) });
  }
  return out;
}

/**
 * @param {object} opts
 * @param {string} opts.keyword
 * @param {string} opts.domain
 * @param {boolean} opts.matchSubdomains
 * @param {string} opts.country  DuckDuckGo region country, e.g. "us", "id", "uk"
 * @param {string} opts.language e.g. "en", "id"
 * @param {number} opts.depth    how deep to look before concluding "absent"
 * @param {(m:string)=>void} [opts.log]
 */
export async function search({ keyword, domain, matchSubdomains, country, language, depth, log = () => {} }) {
  const ctx = await getContext();
  const page = await ctx.newPage();

  try {
    const region = country === 'wt' ? 'wt-wt' : `${country}-${language}`;
    const url =
      `https://duckduckgo.com/?q=${encodeURIComponent(keyword)}` +
      `&kl=${encodeURIComponent(region)}&ia=web`;

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // Results render client-side. The container element is zero-height until
    // populated, so wait on the node count rather than on visibility.
    try {
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="result"]').length > 0,
        null,
        { timeout: 25000 },
      );
    } catch {
      const body = await page.evaluate(() => document.body.innerText.slice(0, 600)).catch(() => '');
      const landed = page.url();
      if (BLOCK_SIGNS.some((re) => re.test(body)) || /\/sorry\/|challenge|captcha/i.test(landed)) {
        return { status: STATUS.BLOCKED, message: `DuckDuckGo served a challenge page (${landed.slice(0, 120)})` };
      }
      // A genuinely zero-result query is rare but possible.
      const noResults = /no results|not many great matches/i.test(body);
      if (noResults) {
        return { status: STATUS.ABSENT, resultsParsed: 0, serp: [], message: 'DuckDuckGo returned no results for this query' };
      }
      return { status: STATUS.BLOCKED, message: 'No results rendered within 25s - treating as blocked, not as a rank drop' };
    }

    let results = await page.evaluate(extractResults);
    let clicks = 0;

    // Click "More results" until we have enough depth or DuckDuckGo runs out.
    while (results.length < depth && clicks < MAX_MORE_CLICKS) {
      const more = await page.$('#more-results, [data-testid="more-results"], button#more-results');
      if (!more) break;
      const before = results.length;
      await more.click().catch(() => {});
      try {
        await page.waitForFunction(
          (n) => document.querySelectorAll('[data-testid="result"]').length > n,
          before,
          { timeout: 12000 },
        );
      } catch {
        break; // no growth: SERP exhausted or load stalled
      }
      clicks += 1;
      results = await page.evaluate(extractResults);
      log(`  depth ${results.length} after ${clicks} "more results" click(s)`);
      if (results.length === before) break;
    }

    const serp = results.slice(0, Math.max(depth, RESULTS_PER_PAGE)).map((r, i) => ({
      position: i + 1,
      url: r.url,
      title: r.title,
    }));

    const hit = serp.find((r) => urlMatchesDomain(r.url, domain, matchSubdomains));
    if (hit) {
      return { status: STATUS.FOUND, position: hit.position, url: hit.url, resultsParsed: serp.length, serp };
    }

    const partial = serp.length < depth;
    return {
      status: STATUS.ABSENT,
      resultsParsed: serp.length,
      serp,
      message: partial
        ? `Not found. DuckDuckGo only returned ${serp.length} results (target depth was ${depth}).`
        : null,
    };
  } catch (err) {
    return { status: STATUS.ERROR, message: err?.message?.split('\n')[0] || String(err) };
  } finally {
    await page.close().catch(() => {});
  }
}
