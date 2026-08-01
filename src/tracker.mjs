import * as db from './db.mjs';
import { STATUS } from './db.mjs';
import * as ddg from './providers/duckduckgo.mjs';
import * as gsc from './providers/gsc.mjs';

export const ENGINES = {
  duckduckgo: {
    id: 'duckduckgo',
    label: 'DuckDuckGo',
    kind: 'serp',
    note: 'Live SERP position, any domain. Opens a real Chrome window while it runs.',
  },
  gsc: {
    id: 'gsc',
    label: 'Google Search Console',
    kind: 'api',
    note: 'Real Google average position — only for properties you own and have verified.',
  },
};

/** Run order: Search Console first (plain API call), DuckDuckGo second (browser). */
export const ENGINE_ORDER = ['gsc', 'duckduckgo'];

/** Region presets. `country` also drives the GSC country filter. */
export const REGIONS = [
  { country: 'wt', language: 'wt', label: 'No region (worldwide)' },
  { country: 'us', language: 'en', label: 'United States — English' },
  { country: 'uk', language: 'en', label: 'United Kingdom — English' },
  { country: 'ca', language: 'en', label: 'Canada — English' },
  { country: 'au', language: 'en', label: 'Australia — English' },
  { country: 'id', language: 'id', label: 'Indonesia — Indonesian' },
  { country: 'id', language: 'en', label: 'Indonesia — English' },
  { country: 'sg', language: 'en', label: 'Singapore — English' },
  { country: 'my', language: 'en', label: 'Malaysia — English' },
  { country: 'ph', language: 'en', label: 'Philippines — English' },
  { country: 'in', language: 'en', label: 'India — English' },
  { country: 'de', language: 'de', label: 'Germany — German' },
  { country: 'fr', language: 'fr', label: 'France — French' },
  { country: 'es', language: 'es', label: 'Spain — Spanish' },
  { country: 'nl', language: 'nl', label: 'Netherlands — Dutch' },
  { country: 'br', language: 'pt', label: 'Brazil — Portuguese' },
  { country: 'jp', language: 'jp', label: 'Japan — Japanese' },
];

const DEFAULT_DELAY_SECONDS = 8;
const MAX_CONSECUTIVE_BLOCKS = 3;

export function getDelaySeconds() {
  const raw = Number(db.getSetting('crawl.delay_seconds', DEFAULT_DELAY_SECONDS));
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DELAY_SECONDS;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------------- run state */

let active = null; // { runId, projectId, total, done, log, cancelled, current }
const listeners = new Set();

/**
 * Pending runs. Only one run executes at a time — DuckDuckGo drives a single
 * shared Chrome profile, and two concurrent runs would fight over it. Rather
 * than rejecting a second request, we line it up and run it next.
 */
const queue = [];
let queueSeq = 0;

export function getQueue() {
  return queue.map((item) => ({
    id: item.id,
    projectId: item.projectId,
    label: item.label,
  }));
}

/** The currently executing run, or null. Stays null when only the queue has items. */
export function getActiveRun() {
  if (!active) return null;
  const { runId, projectId, total, done, current, cancelled } = active;
  return { runId, projectId, total, done, current, cancelled, log: active.log.slice(-80) };
}

/** Everything the dashboard needs to draw progress: what's running plus what's waiting. */
export function getRunState() {
  return { active: getActiveRun(), queued: getQueue() };
}

export function isRunning() {
  return active !== null;
}

export function clearQueue() {
  const n = queue.length;
  queue.length = 0;
  emit();
  return n;
}

export function cancelQueued(id) {
  const i = queue.findIndex((q) => q.id === Number(id));
  if (i === -1) return false;
  queue.splice(i, 1);
  emit();
  return true;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  const snapshot = getRunState();
  for (const fn of listeners) {
    try {
      fn(snapshot);
    } catch {
      /* a dead SSE client must not break the run */
    }
  }
}

function log(message) {
  if (!active) return;
  active.log.push({ at: new Date().toISOString(), message });
  emit();
}

export function cancelRun() {
  if (!active) return false;
  active.cancelled = true;
  log('Cancellation requested — finishing the current keyword, then stopping.');
  return true;
}

/* ------------------------------------------------------------ single check */

/**
 * Which engines can actually run right now, and why any are sitting out.
 * Search Console needs both an authorised account and a property on the
 * project — without those, skipping beats recording an `error` per keyword.
 */
export function engineAvailability(project) {
  const gscReady = gsc.isConnected() && Boolean(project?.gsc_site);
  let gscReason = null;
  if (!gsc.isConfigured()) gscReason = 'Search Console is not set up yet — add an OAuth client in Settings.';
  else if (!gsc.isConnected()) gscReason = 'Search Console is set up but not connected — click Connect in Settings.';
  else if (!project?.gsc_site) gscReason = 'No Search Console property chosen for this project — pick one in Project settings.';

  return {
    duckduckgo: { available: true, reason: null },
    gsc: { available: gscReady, reason: gscReason },
  };
}

/** Run one keyword through one engine. Never throws — failures become `error`. */
export async function checkKeyword(keywordRow, project, engineId, onLog = () => {}) {
  if (!ENGINES[engineId]) {
    return { status: STATUS.ERROR, message: `Unknown engine "${engineId}"` };
  }

  try {
    if (engineId === 'duckduckgo') {
      return await ddg.search({
        keyword: keywordRow.keyword,
        domain: project.domain,
        matchSubdomains: !!project.match_subdomains,
        country: keywordRow.country,
        language: keywordRow.language,
        depth: keywordRow.depth,
        log: onLog,
      });
    }
    if (engineId === 'gsc') {
      return await gsc.search({
        keyword: keywordRow.keyword,
        siteUrl: project.gsc_site,
        country: keywordRow.country,
      });
    }
    return { status: STATUS.ERROR, message: `Engine "${engineId}" has no implementation` };
  } catch (err) {
    return { status: STATUS.ERROR, message: err?.message?.split('\n')[0] || String(err) };
  }
}

/* --------------------------------------------------------------- full run */

/**
 * @param {number} projectId
 * @param {number[]|null} keywordIds  limit to these keywords
 * @param {string[]|null} engineIds   limit to these engines (per-section buttons)
 */
/**
 * Start a run, or queue it if one is already going.
 * @returns {{runId:number}|{queued:true, position:number, id:number}}
 */
export async function runProject(projectId, keywordIds = null, engineIds = null) {
  const project = db.getProject(projectId);
  if (!project) throw new Error('Project not found');

  if (active) {
    const label = describeRequest(project, keywordIds, engineIds);
    // Don't stack identical requests from an impatient double-click.
    const duplicate = queue.find(
      (q) => q.projectId === projectId && q.label === label,
    );
    if (duplicate) return { queued: true, position: queue.indexOf(duplicate) + 1, id: duplicate.id, duplicate: true };

    const item = { id: ++queueSeq, projectId, keywordIds, engineIds, label };
    queue.push(item);
    log(`Queued: ${label} (position ${queue.length})`);
    emit();
    return { queued: true, position: queue.length, id: item.id };
  }

  return startRun(project, keywordIds, engineIds);
}

function describeRequest(project, keywordIds, engineIds) {
  const engines = (engineIds?.length ? engineIds : ENGINE_ORDER).map((e) => ENGINES[e]?.label ?? e).join(' + ');
  const scope = keywordIds?.length
    ? `${keywordIds.length} keyword${keywordIds.length === 1 ? '' : 's'}`
    : 'all keywords';
  return `${project.domain} · ${scope} · ${engines}`;
}

function startRun(project, keywordIds, engineIds) {
  const projectId = project.id;

  let keywords = db.listKeywords(projectId).filter((k) => k.active);
  if (Array.isArray(keywordIds) && keywordIds.length) {
    const wanted = new Set(keywordIds.map(Number));
    keywords = keywords.filter((k) => wanted.has(k.id));
  }
  if (!keywords.length) throw new Error('No active keywords to check');

  // Search Console first: it is a plain API call, so it needs no browser and no
  // politeness delay. DuckDuckGo second, as one contiguous browser session.
  const availability = engineAvailability(project);
  const requested = Array.isArray(engineIds) && engineIds.length ? engineIds.filter((e) => ENGINES[e]) : ENGINE_ORDER;
  if (!requested.length) throw new Error('No valid engine requested');

  const order = ENGINE_ORDER.filter((e) => requested.includes(e));
  const tasks = [];
  for (const engineId of order) {
    if (!availability[engineId].available) continue;
    for (const kw of keywords) tasks.push({ kw, engineId });
  }

  if (!tasks.length) {
    const blocked = order.map((e) => availability[e].reason).filter(Boolean)[0];
    throw new Error(blocked || 'No engines are available to check right now');
  }

  const engineNames = [...new Set(tasks.map((t) => ENGINES[t.engineId].label))].join(' + ');
  const runId = db.createRun(projectId, tasks.length);
  active = { runId, projectId, total: tasks.length, done: 0, log: [], cancelled: false, current: null };
  log(`Run #${runId} started — ${keywords.length} keyword(s) on ${engineNames} for ${project.domain}`);
  for (const engineId of order) {
    if (!availability[engineId].available) log(`Skipping ${ENGINES[engineId].label}: ${availability[engineId].reason}`);
  }

  // Kick off in the background so the HTTP request that started it can return.
  execute(project, tasks, runId)
    .catch((err) => db.finishRun(runId, 'error', err?.message || String(err)))
    .finally(drainQueue);

  return { runId };
}

/** Start the next queued run, if any. Called once the active run clears. */
function drainQueue() {
  if (active || !queue.length) return;
  const next = queue.shift();
  const project = db.getProject(next.projectId);
  if (!project) return drainQueue(); // project deleted while queued

  try {
    startRun(project, next.keywordIds, next.engineIds);
  } catch (err) {
    // e.g. every keyword was deleted while this sat in the queue — skip it.
    console.error('[queue] skipping queued run:', err.message);
    drainQueue();
  }
}

async function execute(project, tasks, runId) {
  const delayMs = getDelaySeconds() * 1000;
  let consecutiveBlocks = 0;
  let usedBrowser = false;
  const tally = { found: 0, absent: 0, blocked: 0, error: 0 };

  try {
    for (let i = 0; i < tasks.length; i++) {
      if (active.cancelled) {
        log('Run cancelled.');
        break;
      }

      const { kw, engineId } = tasks[i];
      const engineLabel = ENGINES[engineId].label;
      active.current = `${kw.keyword} · ${engineLabel}`;
      log(`[${i + 1}/${tasks.length}] "${kw.keyword}" on ${engineLabel} (${kw.country}-${kw.language})`);
      emit();

      if (engineId === 'duckduckgo') usedBrowser = true;

      const result = await checkKeyword(kw, project, engineId, (m) => log(m));
      const previous = db.latestConclusiveCheck(kw.id, engineId);
      db.recordCheck(kw.id, runId, result, kw, engineId);
      tally[result.status] = (tally[result.status] ?? 0) + 1;

      if (result.status === STATUS.FOUND) {
        const delta = previous?.status === STATUS.FOUND ? previous.position - result.position : null;
        const deltaText =
          delta === null ? '' : delta === 0 ? ' (no change)' : delta > 0 ? ` (up ${Math.abs(delta).toFixed(1)})` : ` (down ${Math.abs(delta).toFixed(1)})`;
        log(`  → position ${result.position}${deltaText} — ${result.url}`);
      } else if (result.status === STATUS.ABSENT) {
        // "Absent" means different things per engine: no SERP placement vs no impressions.
        log(
          engineId === 'gsc'
            ? `  → no Search Console impressions${result.message ? ` — ${result.message}` : ''}`
            : `  → not in top ${result.resultsParsed || kw.depth}${result.message ? ` — ${result.message}` : ''}`,
        );
      } else {
        log(`  → ${result.status.toUpperCase()}: ${result.message ?? 'no detail'} (recorded as "no data", not as a rank change)`);
      }

      if (result.status === STATUS.BLOCKED) {
        consecutiveBlocks += 1;
        if (consecutiveBlocks >= MAX_CONSECUTIVE_BLOCKS) {
          log(`Stopping: ${consecutiveBlocks} consecutive blocked responses. Retry later rather than hammering the engine.`);
          break;
        }
      } else {
        consecutiveBlocks = 0;
      }

      active.done = i + 1;
      db.bumpRun(runId, active.done);
      emit();

      // Only scraped queries need pacing, and only if another one follows.
      const nextIsScraped = tasks[i + 1]?.engineId === 'duckduckgo';
      if (nextIsScraped && !active.cancelled && delayMs > 0) {
        log(`  waiting ${delayMs / 1000}s before the next query`);
        await sleep(delayMs);
      }
    }

    const summary = `${tally.found} found · ${tally.absent} not ranking · ${tally.blocked} blocked · ${tally.error} errored`;
    db.finishRun(runId, active.cancelled ? 'cancelled' : 'done', summary);
    log(`Run finished — ${summary}`);
  } finally {
    if (usedBrowser) await ddg.closeBrowser().catch(() => {});
    active = null;
    emit();
  }
}

export async function shutdown() {
  await ddg.closeBrowser().catch(() => {});
}

/* ------------------------------------------------------------- dashboard  */

/** One engine's latest result, delta and sparkline data for a keyword. */
function engineSummary(keywordId, engineId) {
  const latest = db.latestCheck(keywordId, engineId);
  const prior = latest ? db.latestConclusiveCheck(keywordId, engineId, latest.id) : null;

  let delta = null;
  if (latest?.status === STATUS.FOUND && prior?.status === STATUS.FOUND) {
    // Positive delta = improved (moved toward position 1).
    delta = Math.round((prior.position - latest.position) * 10) / 10;
  }

  let deltaKind = null;
  if (latest?.status === STATUS.FOUND && prior?.status === STATUS.ABSENT) deltaKind = 'entered';
  if (latest?.status === STATUS.ABSENT && prior?.status === STATUS.FOUND) deltaKind = 'dropped-out';

  const history = db
    .checkHistory(keywordId, engineId, 30)
    .filter((c) => c.status === STATUS.FOUND || c.status === STATUS.ABSENT)
    .reverse()
    .map((c) => ({ at: c.checked_at, position: c.status === STATUS.FOUND ? c.position : null }));

  return {
    latest: latest
      ? {
          id: latest.id,
          status: latest.status,
          position: latest.position,
          url: latest.url,
          checked_at: latest.checked_at,
          results_parsed: latest.results_parsed,
          impressions: latest.impressions,
          clicks: latest.clicks,
          ctr: latest.ctr,
          message: latest.message,
        }
      : null,
    previous: prior ? { status: prior.status, position: prior.position, checked_at: prior.checked_at } : null,
    delta,
    deltaKind,
    history,
  };
}

/**
 * Keyword rows with a separate summary per engine. The dashboard renders one
 * tab per engine off this; nothing is ever compared across engines.
 */
export function keywordOverview(projectId) {
  return db.listKeywords(projectId).map((kw) => ({
    ...kw,
    engines: Object.fromEntries(Object.keys(ENGINES).map((id) => [id, engineSummary(kw.id, id)])),
  }));
}
