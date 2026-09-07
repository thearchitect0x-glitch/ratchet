// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Does the world still say about us what we say about ourselves?
 *
 * The MCP Registry is canonical: Glama, mcp.so and Smithery consume its data,
 * so whatever it says is what every marketplace tells people to install.
 *
 * `scripts/publish-registry.sh` already refuses to publish a listing that
 * disagrees with the package it points at. That protects the moment of
 * publishing and nothing else — a listing goes stale by the repository moving
 * on, not by anyone editing the listing. Its own header records the cost:
 *
 *   "On 6 Sep 2026 it said ratchet-mcp@0.1.1 while npm shipped 0.2.1 — every
 *    visitor arriving through a marketplace installed a bridge two versions
 *    old, and nothing anywhere would ever have said so."
 *
 * This is the thing that says so. It compares three numbers that are supposed
 * to be one, and exits non-zero when they are not:
 *
 *   the repository   package.json
 *   npm              what `npx ratchet-mcp` actually installs
 *   the registry     what every marketplace repeats
 *
 * Deliberately NOT part of the 15-minute uptime probe. This drifts on the
 * timescale of releases, and a check that runs ninety-six times a day to watch
 * something that changes monthly is how a mailbox gets muted.
 */
import { readFileSync } from 'node:fs';

const REGISTRY = 'https://registry.modelcontextprotocol.io/v0/servers?search=ratchetgate';
const SERVER = 'com.ratchetgate/ratchet';
const PKG = 'ratchet-mcp';

import { assessListing } from './lib/listing-drift.mjs';

const fetched = [];
const get = async (url, what) => {
  try {
    const r = await fetch(url, { headers: { accept: 'application/json' } });
    if (!r.ok) { fetched.push(`${what} answered HTTP ${r.status}`); return null; }
    return await r.json();
  } catch (e) {
    fetched.push(`${what} could not be read: ${e.message}`);
    return null;
  }
};

const repo = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const npm = await get(`https://registry.npmjs.org/${PKG}/latest`, 'npm');
const reg = await get(REGISTRY, 'the MCP registry');

const registryVersions = reg
  ? (reg.servers ?? []).map((e) => e.server ?? e)
      .filter((s) => s.name === SERVER).map((s) => s.version).filter(Boolean)
  : null;

const { problems, notes } = assessListing({
  repo, npmVersion: npm?.version ?? null, registryVersions,
});
problems.push(...fetched);

console.log(notes.map((n) => `  ${n}`).join('\n'));
if (problems.length === 0) {
  console.log('\nOK  the registry, npm and the repository agree on what to install.');
  process.exit(0);
}
console.log('');
for (const p of problems) console.log(`FAILED  ${p}`);
process.exit(1);
