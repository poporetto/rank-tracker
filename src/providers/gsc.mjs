import { STATUS } from '../db.mjs';
import { getSetting, setSetting, deleteSetting } from '../db.mjs';

/**
 * Google Search Console provider.
 *
 * This is the only source of *real Google* positions available for free, and it
 * is official rather than scraped - it is never blocked or rate-limited into a
 * CAPTCHA. The trade-offs are inherent to the API, not to this implementation:
 *
 *   - It only covers properties you own and have verified in Search Console.
 *   - `position` is the AVERAGE position over the requested date window, so it
 *     is a decimal (e.g. 7.4) and lags live rankings by ~2-3 days.
 *   - A keyword with zero impressions returns no row. That means "nobody saw
 *     you for this query in this window", which is close to but not identical
 *     to "not ranking" - the tracker records it as `absent` and says so.
 */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://searchconsole.googleapis.com/webmasters/v3';
const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

const KEY = {
  clientId: 'gsc.client_id',
  clientSecret: 'gsc.client_secret',
  refreshToken: 'gsc.refresh_token',
  connectedAt: 'gsc.connected_at',
};

export function getCredentials() {
  return {
    clientId: getSetting(KEY.clientId),
    clientSecret: getSetting(KEY.clientSecret),
    refreshToken: getSetting(KEY.refreshToken),
    connectedAt: getSetting(KEY.connectedAt),
  };
}

export function saveClient(clientId, clientSecret) {
  setSetting(KEY.clientId, clientId.trim());
  setSetting(KEY.clientSecret, clientSecret.trim());
}

export function disconnect() {
  deleteSetting(KEY.refreshToken);
  deleteSetting(KEY.connectedAt);
}

export function isConfigured() {
  const c = getCredentials();
  return Boolean(c.clientId && c.clientSecret);
}

export function isConnected() {
  return Boolean(getCredentials().refreshToken);
}

export function buildAuthUrl(redirectUri, state) {
  const { clientId } = getCredentials();
  if (!clientId) throw new Error('No Google OAuth client configured');
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent', // force a refresh_token even on re-authorisation
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH_URL}?${p}`;
}

async function postForm(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error_description || body.error || `Google returned HTTP ${res.status}`);
  }
  return body;
}

export async function exchangeCode(code, redirectUri) {
  const { clientId, clientSecret } = getCredentials();
  const tok = await postForm(TOKEN_URL, {
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  if (!tok.refresh_token) {
    throw new Error(
      'Google did not return a refresh token. Revoke this app at myaccount.google.com/permissions and connect again.',
    );
  }
  setSetting(KEY.refreshToken, tok.refresh_token);
  setSetting(KEY.connectedAt, new Date().toISOString());
  return tok;
}

let cachedAccessToken = null;
let cachedExpiry = 0;

async function getAccessToken() {
  if (cachedAccessToken && Date.now() < cachedExpiry - 60_000) return cachedAccessToken;
  const { clientId, clientSecret, refreshToken } = getCredentials();
  if (!clientId || !clientSecret) throw new Error('Search Console is not configured (missing OAuth client)');
  if (!refreshToken) throw new Error('Search Console is not connected (no refresh token) - connect it in Settings');

  const tok = await postForm(TOKEN_URL, {
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  cachedAccessToken = tok.access_token;
  cachedExpiry = Date.now() + (tok.expires_in ?? 3600) * 1000;
  return cachedAccessToken;
}

export function invalidateTokenCache() {
  cachedAccessToken = null;
  cachedExpiry = 0;
}

async function apiGet(path) {
  const token = await getAccessToken();
  const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message || `Search Console API HTTP ${res.status}`);
  return body;
}

async function apiPost(path, payload) {
  const token = await getAccessToken();
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message || `Search Console API HTTP ${res.status}`);
  return body;
}

/** Verified properties this account can read, e.g. "sc-domain:example.com". */
export async function listSites() {
  const body = await apiGet('/sites');
  return (body.siteEntry || [])
    .filter((s) => s.permissionLevel !== 'siteUnverifiedUser')
    .map((s) => ({ siteUrl: s.siteUrl, permissionLevel: s.permissionLevel }));
}

const isoDaysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

/**
 * Unfiltered Search Analytics call. Used by the "what does Google actually have
 * for this property?" diagnostic — when a keyword comes back with no
 * impressions, this is how you tell "genuinely no impressions" apart from
 * "wrong property or wrong filter".
 */
export async function rawQuery(siteUrl, payload) {
  return apiPost(`/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, payload);
}

/**
 * @param {object} opts
 * @param {string} opts.keyword
 * @param {string} opts.siteUrl   Search Console property, e.g. sc-domain:example.com
 * @param {string} opts.country   ISO-3166-1 alpha-2 ("us"); "wt" means worldwide
 * @param {number} [opts.windowDays=28]
 */
export async function search({ keyword, siteUrl, country, windowDays = 28 }) {
  if (!siteUrl) {
    return {
      status: STATUS.ERROR,
      message: 'No Search Console property selected for this project (set one in project settings)',
    };
  }

  // `contains`, not `equals`. Real search traffic arrives on longer phrases than
  // the one you track: a site can have zero impressions for the exact string
  // "line marking south coast" while "car park line marking south coast" pulls
  // thousands. Exact matching reports "no impressions" and hides the traffic.
  // Matching is case-insensitive on Google's side.
  const filters = [{ dimension: 'query', operator: 'contains', expression: keyword }];
  if (country && country !== 'wt') {
    // GSC wants ISO-3166-1 alpha-3; map the common alpha-2 codes the UI offers.
    const alpha3 = ALPHA2_TO_ALPHA3[country.toLowerCase()];
    if (alpha3) filters.push({ dimension: 'country', operator: 'equals', expression: alpha3 });
  }

  const path = `/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  const window = {
    startDate: isoDaysAgo(windowDays + 2), // GSC data lags ~2 days
    endDate: isoDaysAgo(2),
    dimensionFilterGroups: [{ filters }],
    dataState: 'final',
  };

  try {
    // Headline numbers come from Google's own aggregate over the filter, with no
    // dimensions — so the position is exactly what Search Console would show,
    // not something reconstructed here. (Verified: this matches an
    // impression-weighted average of the per-row data to within 0.01.)
    const agg = await apiPost(path, { ...window, dimensions: [], rowLimit: 1 });
    const total = agg.rows?.[0];

    if (!total || !total.impressions) {
      return {
        status: STATUS.ABSENT,
        resultsParsed: 0,
        serp: [],
        message: `No impressions for any query containing “${keyword}” in the last ${windowDays} days`,
      };
    }

    // Second call is purely for transparency: which queries matched, and where.
    let rows = [];
    try {
      const detail = await apiPost(path, { ...window, dimensions: ['query', 'page'], rowLimit: 200 });
      rows = detail.rows || [];
    } catch {
      /* breakdown is optional — never fail the check over it */
    }

    // Collapse query+page rows into one entry per matching query.
    const byQuery = new Map();
    for (const r of rows) {
      const q = r.keys?.[0] ?? '';
      const entry = byQuery.get(q) ?? { query: q, impressions: 0, clicks: 0, weighted: 0, pages: new Map() };
      entry.impressions += r.impressions ?? 0;
      entry.clicks += r.clicks ?? 0;
      entry.weighted += (r.position ?? 0) * (r.impressions ?? 0);
      entry.pages.set(r.keys?.[1] ?? '', (entry.pages.get(r.keys?.[1] ?? '') ?? 0) + (r.impressions ?? 0));
      byQuery.set(q, entry);
    }
    const matched = [...byQuery.values()].sort((a, b) => b.impressions - a.impressions);

    // The page carrying the most impressions is the one that actually ranks.
    const pageTotals = new Map();
    for (const r of rows) {
      const page = r.keys?.[1] ?? '';
      pageTotals.set(page, (pageTotals.get(page) ?? 0) + (r.impressions ?? 0));
    }
    const topPage = [...pageTotals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;

    const exact = matched.length === 1 && matched[0].query.toLowerCase() === keyword.toLowerCase();
    return {
      status: STATUS.FOUND,
      position: Math.round(total.position * 10) / 10,
      url: topPage,
      resultsParsed: matched.length,
      impressions: total.impressions,
      clicks: total.clicks,
      ctr: total.ctr ?? (total.impressions ? total.clicks / total.impressions : 0),
      // Each matching query, most impressions first. The `url` is that query's
      // best-performing page; metrics live in their own columns.
      serp: matched.slice(0, 25).map((m, i) => ({
        position: i + 1,
        url: [...m.pages.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '',
        title: `${m.query} — avg pos ${(m.weighted / (m.impressions || 1)).toFixed(1)} · ${m.impressions.toLocaleString()} impr · ${m.clicks} clicks`,
      })),
      message: exact
        ? `Google’s ${windowDays}-day average for this exact query`
        : `Google’s ${windowDays}-day average across ${matched.length} quer${matched.length === 1 ? 'y' : 'ies'} containing “${keyword}”`,
    };
  } catch (err) {
    invalidateTokenCache();
    return { status: STATUS.ERROR, message: err?.message || String(err) };
  }
}

const ALPHA2_TO_ALPHA3 = {
  us: 'usa', gb: 'gbr', uk: 'gbr', ca: 'can', au: 'aus', nz: 'nzl', ie: 'irl',
  id: 'idn', sg: 'sgp', my: 'mys', ph: 'phl', th: 'tha', vn: 'vnm', in: 'ind',
  jp: 'jpn', kr: 'kor', cn: 'chn', hk: 'hkg', tw: 'twn',
  de: 'deu', fr: 'fra', es: 'esp', it: 'ita', nl: 'nld', be: 'bel', ch: 'che',
  at: 'aut', se: 'swe', no: 'nor', dk: 'dnk', fi: 'fin', pl: 'pol', pt: 'prt',
  br: 'bra', mx: 'mex', ar: 'arg', cl: 'chl', co: 'col',
  za: 'zaf', ng: 'nga', ke: 'ken', eg: 'egy', ae: 'are', sa: 'sau', tr: 'tur',
  ru: 'rus', ua: 'ukr', il: 'isr',
};
