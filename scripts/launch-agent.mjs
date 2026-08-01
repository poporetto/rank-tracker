#!/usr/bin/env node
/**
 * Generates a macOS launch agent that keeps the dashboard running at login,
 * so the daily scheduled check actually fires.
 *
 * The plist is generated rather than committed because it must contain absolute
 * paths for this machine — publishing those would leak your home directory and
 * username into the repo.
 *
 *   node scripts/launch-agent.mjs            # write ./com.ranktracker.server.plist
 *   node scripts/launch-agent.mjs --install  # also copy into ~/Library/LaunchAgents
 */

import { writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

const LABEL = 'com.ranktracker.server';
const root = resolve(import.meta.dirname, '..');
const plistPath = join(root, `${LABEL}.plist`);
const install = process.argv.includes('--install');

const xml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>--no-warnings</string>
    <string>${xml(join(root, 'server.mjs'))}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(root)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(join(root, 'data', 'server.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(root, 'data', 'server.log'))}</string>
</dict>
</plist>
`;

mkdirSync(join(root, 'data'), { recursive: true });
writeFileSync(plistPath, plist);
console.log(`Wrote ${plistPath}`);

if (install) {
  const dest = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  copyFileSync(plistPath, dest);
  try {
    execFileSync('launchctl', ['unload', dest], { stdio: 'ignore' });
  } catch {
    /* not loaded yet — fine */
  }
  execFileSync('launchctl', ['load', dest]);
  console.log(`Installed and loaded ${dest}`);
  console.log('The dashboard will now start automatically at login.');
  console.log(`To undo:  launchctl unload ${dest} && rm ${dest}`);
} else {
  console.log('Run with --install to copy it into ~/Library/LaunchAgents and load it.');
}
