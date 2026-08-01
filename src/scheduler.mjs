import * as db from './db.mjs';
import * as tracker from './tracker.mjs';

/**
 * Daily automatic checks.
 *
 * This runs inside the dashboard server rather than as a cron job, for one
 * practical reason: DuckDuckGo checks need a visible Chrome window, so they
 * only make sense while you are logged in with the server running. A cron job
 * firing into a logged-out session would just record `blocked` rows.
 *
 * The schedule fires at most once per calendar day. The last fired date is
 * stored, so restarting the server does not re-trigger a run that already
 * happened, and a server that was off at the scheduled time will catch up the
 * next time it is running past that hour.
 */

const KEY = {
  enabled: 'schedule.enabled',
  time: 'schedule.time',          // "HH:MM" local
  lastDate: 'schedule.last_date', // "YYYY-MM-DD" local
  lastResult: 'schedule.last_result',
  catchUp: 'schedule.catch_up',
};

const TICK_MS = 30_000;
let timer = null;

const pad = (n) => String(n).padStart(2, '0');
const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

export function getSchedule() {
  return {
    enabled: db.getSetting(KEY.enabled) === '1',
    time: db.getSetting(KEY.time, '07:00'),
    catchUp: db.getSetting(KEY.catchUp, '1') === '1',
    lastDate: db.getSetting(KEY.lastDate),
    lastResult: db.getSetting(KEY.lastResult),
  };
}

export function setSchedule({ enabled, time, catchUp }) {
  if (enabled !== undefined) db.setSetting(KEY.enabled, enabled ? '1' : '0');
  if (time !== undefined) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Time must be in 24-hour HH:MM format');
    db.setSetting(KEY.time, time);
  }
  if (catchUp !== undefined) db.setSetting(KEY.catchUp, catchUp ? '1' : '0');
  return getSchedule();
}

/** Wait for the current run to finish, with a ceiling so we never wedge. */
async function waitForIdle(maxMs = 6 * 60 * 60 * 1000) {
  const started = Date.now();
  while (tracker.isRunning() && Date.now() - started < maxMs) {
    await new Promise((r) => setTimeout(r, 5000));
  }
  return !tracker.isRunning();
}

/**
 * Check every project that has active keywords, one after another.
 * Engines are left unrestricted, so each project checks everything available.
 */
export async function runAllProjects(reason = 'scheduled') {
  const projects = db.listProjects();
  const summary = [];

  for (const project of projects) {
    const keywords = db.listKeywords(project.id).filter((k) => k.active);
    if (!keywords.length) continue;

    if (!(await waitForIdle())) {
      summary.push(`${project.domain}: skipped (another run never finished)`);
      continue;
    }

    try {
      await tracker.runProject(project.id);
      await waitForIdle();
      const run = db.listRuns(project.id, 1)[0];
      summary.push(`${project.domain}: ${run?.message ?? 'done'}`);
    } catch (err) {
      summary.push(`${project.domain}: ${err.message}`);
    }
  }

  const result = summary.length ? summary.join(' · ') : 'nothing to check';
  db.setSetting(KEY.lastDate, localDate());
  db.setSetting(KEY.lastResult, `${new Date().toISOString()} (${reason}) — ${result}`);
  return result;
}

async function tick() {
  const { enabled, time, lastDate, catchUp } = getSchedule();
  if (!enabled) return;

  const today = localDate();
  if (lastDate === today) return; // already ran today
  if (tracker.isRunning()) return; // never interrupt a manual run

  // Fire at the scheduled minute, or later the same day if the machine was
  // asleep or the server was off when that minute passed.
  const due = catchUp ? localTime() >= time : localTime() === time;
  if (!due) return;

  // Claim the day up front so a slow run can't be started twice.
  db.setSetting(KEY.lastDate, today);
  try {
    const result = await runAllProjects('scheduled');
    console.log(`[schedule] daily run finished — ${result}`);
  } catch (err) {
    console.error('[schedule] daily run failed:', err.message);
    db.setSetting(KEY.lastResult, `${new Date().toISOString()} (scheduled) — failed: ${err.message}`);
  }
}

export function start() {
  if (timer) return;
  timer = setInterval(() => {
    tick().catch((err) => console.error('[schedule] tick error:', err.message));
  }, TICK_MS);
  timer.unref?.();
  const s = getSchedule();
  if (s.enabled) console.log(`  Daily check scheduled for ${s.time} (local)\n`);
}

export function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}
