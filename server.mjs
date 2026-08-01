import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';

import * as db from './src/db.mjs';
import { STATUS } from './src/db.mjs';
import * as tracker from './src/tracker.mjs';
import * as scheduler from './src/scheduler.mjs';
import * as gsc from './src/providers/gsc.mjs';
import { normalizeDomain, isValidDomain } from './src/domain.mjs';

const PORT = Number(process.env.PORT || 4173);
const HOST = '127.0.0.1';

/**
 * Friendly local hostname. macOS (and Chrome, Safari and Firefox) resolve any
 * `*.localhost` name to 127.0.0.1 with no /etc/hosts entry and no sudo, so this
 * is a free readability win over "localhost:4173".
 *
 * Requests are still only ever served from the loopback interface — the name is
 * cosmetic, and the Host check below keeps DNS rebinding out.
 */
const APP_HOST = process.env.APP_HOST || 'ranktracker.localhost';

/** Loopback names we will answer to. Anything else is a rebinding attempt. */
function isLoopbackHost(host) {
  const name = String(host || '').split(':')[0].toLowerCase().replace(/^\[|\]$/g, '');
  return (
    name === 'localhost' ||
    name === '127.0.0.1' ||
    name === '::1' ||
    name.endsWith('.localhost') // rank.localhost, ranktracker.localhost, …
  );
}
const PUBLIC_DIR = resolve(process.cwd(), 'public');

db.openDb();
db.reapStaleRuns();

/* ------------------------------------------------------------------ helpers */

const json = (res, code, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
};

const fail = (res, code, message) => json(res, code, { error: message });

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Invalid JSON body');
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  // Contain everything under public/ — reject any traversal attempt.
  const target = normalize(join(PUBLIC_DIR, rel));
  if (!target.startsWith(PUBLIC_DIR)) return fail(res, 403, 'Forbidden');
  try {
    const data = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[extname(target)] || 'application/octet-stream',
      // The dashboard is served from disk and edited in place; a cached app.js
      // silently hides changes and looks like the feature was never built.
      'cache-control': 'no-cache, must-revalidate',
    });
    res.end(data);
  } catch {
    fail(res, 404, 'Not found');
  }
}

/**
 * Deliberately pinned to `localhost`, NOT to APP_HOST. This exact string is
 * registered as an authorised redirect URI in Google Cloud; pointing it at a
 * prettier hostname would make Google reject the handshake with
 * `redirect_uri_mismatch`. Browsing via ranktracker.localhost still works — the
 * OAuth round trip just lands back on localhost, which is the same server.
 */
const redirectUri = () => `http://localhost:${PORT}/api/gsc/callback`;

/* -------------------------------------------------------------- validation */

function parseKeywordInput(raw) {
  return [
    ...new Set(
      String(raw || '')
        .split(/[\n,]/)
        .map((s) => s.trim().replace(/\s+/g, ' '))
        .filter((s) => s.length > 0 && s.length <= 200),
    ),
  ];
}

const DEFAULT_REGION = { country: 'au', language: 'en' };

function validateRegion(country, language) {
  const match = tracker.REGIONS.find((r) => r.country === country && r.language === language);
  return match ? { country, language } : { ...DEFAULT_REGION };
}

/* ------------------------------------------------------------------ routing */

let oauthState = null;

async function handleApi(req, res, url) {
  const p = url.pathname;
  const m = (pattern) => {
    const re = new RegExp('^' + pattern.replace(/:\w+/g, '(\\d+)') + '$');
    return re.exec(p);
  };

  /* ---- bootstrap ---- */
  if (p === '/api/bootstrap' && req.method === 'GET') {
    return json(res, 200, {
      engines: Object.values(tracker.ENGINES),
      regions: tracker.REGIONS,
      projects: db.listProjects(),
      delaySeconds: tracker.getDelaySeconds(),
      schedule: scheduler.getSchedule(),
      gsc: {
        configured: gsc.isConfigured(),
        connected: gsc.isConnected(),
        connectedAt: gsc.getCredentials().connectedAt,
        redirectUri: redirectUri(),
      },
      activeRun: tracker.getActiveRun(),
    });
  }

  /* ---- settings ---- */
  if (p === '/api/settings' && req.method === 'POST') {
    const body = await readJson(req);
    const delay = Number(body.delaySeconds);
    if (!Number.isFinite(delay) || delay < 0 || delay > 300) return fail(res, 400, 'Delay must be 0–300 seconds');
    db.setSetting('crawl.delay_seconds', delay);
    return json(res, 200, { delaySeconds: tracker.getDelaySeconds() });
  }

  if (p === '/api/schedule' && req.method === 'POST') {
    const body = await readJson(req);
    try {
      return json(res, 200, scheduler.setSchedule(body));
    } catch (err) {
      return fail(res, 400, err.message);
    }
  }

  /* ---- projects ---- */
  if (p === '/api/projects' && req.method === 'GET') return json(res, 200, db.listProjects());

  if (p === '/api/projects' && req.method === 'POST') {
    const body = await readJson(req);
    const domain = normalizeDomain(body.domain);
    if (!isValidDomain(domain)) return fail(res, 400, `"${body.domain ?? ''}" is not a valid domain`);
    if (db.listProjects().some((x) => x.domain === domain)) return fail(res, 409, `A project for ${domain} already exists`);
    const name = String(body.name || '').trim() || domain;
    return json(res, 201, db.createProject({ name, domain, matchSubdomains: body.matchSubdomains !== false }));
  }

  let mm;
  if ((mm = m('/api/projects/:id')) && req.method === 'PATCH') {
    const body = await readJson(req);
    const patch = {};
    if (body.name !== undefined) patch.name = String(body.name).trim();
    if (body.domain !== undefined) {
      const d = normalizeDomain(body.domain);
      if (!isValidDomain(d)) return fail(res, 400, 'Invalid domain');
      patch.domain = d;
    }
    if (body.matchSubdomains !== undefined) patch.matchSubdomains = !!body.matchSubdomains;
    if (body.gscSite !== undefined) patch.gscSite = body.gscSite;
    const updated = db.updateProject(Number(mm[1]), patch);
    return updated ? json(res, 200, updated) : fail(res, 404, 'Project not found');
  }

  if ((mm = m('/api/projects/:id')) && req.method === 'DELETE') {
    db.deleteProject(Number(mm[1]));
    return json(res, 200, { ok: true });
  }

  /* ---- keywords ---- */
  if ((mm = m('/api/projects/:id/keywords')) && req.method === 'GET') {
    const id = Number(mm[1]);
    const project = db.getProject(id);
    if (!project) return fail(res, 404, 'Project not found');
    return json(res, 200, {
      keywords: tracker.keywordOverview(id),
      availability: tracker.engineAvailability(project),
    });
  }

  if ((mm = m('/api/projects/:id/keywords')) && req.method === 'POST') {
    const projectId = Number(mm[1]);
    if (!db.getProject(projectId)) return fail(res, 404, 'Project not found');
    const body = await readJson(req);

    const keywords = parseKeywordInput(body.keywords);
    if (!keywords.length) return fail(res, 400, 'Enter at least one keyword');

    const { country, language } = validateRegion(body.country, body.language);
    let depth = Number(body.depth);
    if (!Number.isFinite(depth)) depth = 30;
    depth = Math.min(100, Math.max(10, Math.round(depth)));

    const added = [];
    const skipped = [];
    for (const keyword of keywords) {
      const { keyword: row, created } = db.createKeyword({ projectId, keyword, country, language, depth });
      (created ? added : skipped).push(row.keyword);
    }
    return json(res, 201, { added, skipped });
  }

  if ((mm = m('/api/projects/:id/keywords/reorder')) && req.method === 'POST') {
    const projectId = Number(mm[1]);
    if (!db.getProject(projectId)) return fail(res, 404, 'Project not found');
    const body = await readJson(req);
    if (!Array.isArray(body.ids) || !body.ids.length) return fail(res, 400, 'Expected a non-empty ids array');
    db.reorderKeywords(projectId, body.ids);
    return json(res, 200, { ok: true });
  }

  if ((mm = m('/api/keywords/:id')) && req.method === 'PATCH') {
    const body = await readJson(req);
    const updated = db.setKeywordActive(Number(mm[1]), !!body.active);
    return updated ? json(res, 200, updated) : fail(res, 404, 'Keyword not found');
  }

  if ((mm = m('/api/keywords/:id')) && req.method === 'DELETE') {
    db.deleteKeyword(Number(mm[1]));
    return json(res, 200, { ok: true });
  }

  if ((mm = m('/api/keywords/:id/history')) && req.method === 'GET') {
    const id = Number(mm[1]);
    const kw = db.getKeyword(id);
    if (!kw) return fail(res, 404, 'Keyword not found');
    // History is per engine — the two engines' numbers are not comparable.
    const engine = tracker.ENGINES[url.searchParams.get('engine')] ? url.searchParams.get('engine') : 'duckduckgo';
    const history = db.checkHistory(id, engine, 200);
    // Show the newest SERP we actually captured. The newest *check* may be a
    // blocked/errored one, which has no snapshot - falling back keeps the
    // last known SERP visible instead of blanking the panel.
    let latestSerp = [];
    let serpCheckedAt = null;
    for (const check of history) {
      const rows = db.serpForCheck(check.id);
      if (rows.length) {
        latestSerp = rows;
        serpCheckedAt = check.checked_at;
        break;
      }
    }
    return json(res, 200, { keyword: kw, engine, history, latestSerp, serpCheckedAt });
  }

  if ((mm = m('/api/checks/:id/serp')) && req.method === 'GET') {
    return json(res, 200, db.serpForCheck(Number(mm[1])));
  }

  /* ---- runs ---- */
  if ((mm = m('/api/projects/:id/run')) && req.method === 'POST') {
    const body = await readJson(req);
    try {
      const runId = await tracker.runProject(Number(mm[1]), body.keywordIds || null, body.engines || null);
      return json(res, 202, { runId });
    } catch (err) {
      return fail(res, 409, err.message);
    }
  }

  if (p === '/api/run/cancel' && req.method === 'POST') {
    return json(res, 200, { cancelled: tracker.cancelRun() });
  }

  if (p === '/api/run/status' && req.method === 'GET') {
    return json(res, 200, { active: tracker.getActiveRun() });
  }

  if ((mm = m('/api/projects/:id/runs')) && req.method === 'GET') {
    return json(res, 200, db.listRuns(Number(mm[1]), 20));
  }

  if (p === '/api/run/stream' && req.method === 'GET') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    const send = (snapshot) => res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    send(tracker.getActiveRun());
    const unsubscribe = tracker.subscribe(send);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
    return;
  }

  /* ---- Google Search Console ---- */
  if (p === '/api/gsc/client' && req.method === 'POST') {
    const body = await readJson(req);
    const id = String(body.clientId || '').trim();
    const secret = String(body.clientSecret || '').trim();
    if (!id || !secret) return fail(res, 400, 'Both client ID and client secret are required');
    gsc.saveClient(id, secret);
    gsc.invalidateTokenCache();
    return json(res, 200, { configured: true, redirectUri: redirectUri() });
  }

  if (p === '/api/gsc/connect' && req.method === 'GET') {
    if (!gsc.isConfigured()) return fail(res, 400, 'Save your OAuth client ID and secret first');
    oauthState = randomUUID();
    res.writeHead(302, { location: gsc.buildAuthUrl(redirectUri(), oauthState) });
    return res.end();
  }

  if (p === '/api/gsc/callback' && req.method === 'GET') {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const err = url.searchParams.get('error');
    const page = (title, detail, ok) => {
      const body = `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:16px system-ui;padding:3rem;max-width:38rem;margin:auto;color:#111">
<h1 style="color:${ok ? '#127c4a' : '#b3261e'}">${title}</h1><p>${detail}</p>
<p><a href="/">← Back to the dashboard</a></p></body>`;
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    };

    if (err) return page('Authorisation failed', `Google returned: ${err}`, false);
    if (!state || state !== oauthState) return page('Authorisation failed', 'State mismatch — start the connection again from Settings.', false);
    oauthState = null;
    try {
      await gsc.exchangeCode(code, redirectUri());
      gsc.invalidateTokenCache();
      return page('Search Console connected', 'You can close this tab and pick a property in project settings.', true);
    } catch (e) {
      return page('Authorisation failed', String(e.message), false);
    }
  }

  if (p === '/api/gsc/disconnect' && req.method === 'POST') {
    gsc.disconnect();
    gsc.invalidateTokenCache();
    return json(res, 200, { connected: false });
  }

  if (p === '/api/gsc/sites' && req.method === 'GET') {
    if (!gsc.isConnected()) return fail(res, 400, 'Search Console is not connected yet');
    try {
      return json(res, 200, await gsc.listSites());
    } catch (e) {
      return fail(res, 502, e.message);
    }
  }

  /* ---- export ---- */
  if ((mm = m('/api/projects/:id/export.csv')) && req.method === 'GET') {
    const projectId = Number(mm[1]);
    const project = db.getProject(projectId);
    if (!project) return fail(res, 404, 'Project not found');
    const rows = [
      ['keyword', 'engine', 'country', 'language', 'checked_at', 'status', 'position', 'url',
       'results_parsed', 'impressions', 'clicks', 'ctr', 'message'],
    ];
    for (const kw of db.listKeywords(projectId)) {
      for (const c of db.allChecks(kw.id)) {
        rows.push([
          kw.keyword, c.engine, c.country, c.language, c.checked_at, c.status,
          c.position ?? '', c.url ?? '', c.results_parsed,
          c.impressions ?? '', c.clicks ?? '', c.ctr ?? '', c.message ?? '',
        ]);
      }
    }
    const csv = rows
      .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${project.domain}-rankings.csv"`,
    });
    return res.end(csv);
  }

  return fail(res, 404, `No route for ${req.method} ${p}`);
}

/* ------------------------------------------------------------------- server */

const server = createServer(async (req, res) => {
  // Guard against DNS rebinding: this server is for loopback names only.
  if (!isLoopbackHost(req.headers.host)) {
    return fail(res, 403, 'This dashboard only accepts local requests');
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return await serveStatic(req, res, url.pathname);
  } catch (err) {
    if (!res.headersSent) fail(res, 500, err?.message || 'Internal error');
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Rank Tracker → http://${APP_HOST}${PORT === 80 ? '' : ':' + PORT}\n`);
  console.log(`  Also at: http://localhost:${PORT}`);
  console.log(`  Data:    ${resolve(process.cwd(), 'data', 'rank-tracker.db')}`);
  console.log(`  Stop:    Ctrl-C\n`);
  scheduler.start();
});

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nShutting down…');
    tracker.cancelRun();
    await tracker.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

export { server, STATUS };
