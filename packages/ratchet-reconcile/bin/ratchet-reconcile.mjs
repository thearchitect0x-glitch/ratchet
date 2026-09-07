#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * ratchet-reconcile — find real-world actions that bypassed the gate.
 *
 * Runs in YOUR infrastructure, holds YOUR vendor credential, and pushes to
 * Ratchet. Ratchet never holds a vendor credential and never calls into your
 * systems; this is the shape that keeps that true while still making the check
 * run on a schedule.
 *
 *   STRIPE_API_KEY=rk_live_...  RATCHET_API_KEY=rk_live_... \
 *     npx ratchet-reconcile --vendor stripe --effect-type payment.charge --days 1
 *
 * Exit codes, so this drops into a cron or CI job you already have:
 *   0  every action went through the gate (or a dry run finished)
 *   1  ungated actions found — something acted without asking
 *   2  usage or configuration error
 *   3  inconclusive — the comparison was incomplete; do not read it either way
 *
 * BOTH CREDENTIALS COME FROM THE ENVIRONMENT, NEVER FROM ARGUMENTS. A command
 * line is visible in the process table to every user on the machine, and on a
 * CI runner it lands in logs. This is not hypothetical: `npm` passes its whole
 * environment in argv, so a single `ps` or `pgrep -fl` publishes everything the
 * shell exported. Zero dependencies — Node built-ins only.
 */
import { stripe } from '../lib/connectors/stripe.mjs';
import { reconcile, exitCodeFor, EXIT } from '../lib/reconcile.mjs';
import { redactWith } from '../lib/redact.mjs';

const CONNECTORS = { stripe };

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

const out = (m) => process.stdout.write(`${m}\n`);
const err = (m) => process.stderr.write(`${m}\n`);

if (has('help') || argv.length === 0) {
  out(`ratchet-reconcile — find real-world actions that bypassed the gate

  --vendor <name>        which connector to use (${Object.keys(CONNECTORS).join(', ')})
  --effect-type <type>   the Ratchet effect type these actions correspond to
  --days <n>             how far back to look (default 1)
  --since <iso>          explicit start, overrides --days
  --until <iso>          explicit end (default now)
  --types <a,b>          vendor-side event types to include
  --dry-run              show what would be compared; sends nothing at all
  --quiet                only print the verdict
  --json                 machine-readable summary on stdout

Credentials come from the environment, never from arguments:
  RATCHET_API_KEY        your Ratchet key
  STRIPE_API_KEY         your Stripe key (a restricted read key is enough)
  RATCHET_BASE_URL       defaults to https://ratchetgate.com

Exit: 0 clean · 1 ungated found · 2 usage error · 3 inconclusive`);
  process.exit(argv.length === 0 ? EXIT.USAGE : EXIT.CLEAN);
}

const vendorName = flag('vendor');
const connector = CONNECTORS[vendorName ?? ''];
if (!connector) {
  err(`Unknown --vendor ${vendorName ?? '(missing)'}. Available: ${Object.keys(CONNECTORS).join(', ')}`);
  err('Vendors that never return the key (github, slack, notion, figma) cannot be');
  err('reconciled this way at all: there is nothing to match on. That needs');
  err('action-identity matching, which is a different capability.');
  process.exit(EXIT.USAGE);
}

const effectType = flag('effect-type');
if (!effectType) { err('--effect-type is required.'); process.exit(EXIT.USAGE); }

const apiKey = process.env.RATCHET_API_KEY;
const credential = process.env[connector.credentialEnv];
const dryRun = has('dry-run');

if (!credential) {
  err(`${connector.credentialEnv} is not set. Put it in the environment, not in the`);
  err('command line — arguments are visible in the process table and in CI logs.');
  process.exit(EXIT.USAGE);
}
// A dry run never posts, so it does not need a Ratchet key. Demanding one would
// push people to paste a production key just to rehearse.
if (!apiKey && !dryRun) {
  err('RATCHET_API_KEY is not set. (A --dry-run does not need it.)');
  process.exit(EXIT.USAGE);
}

const days = Number.parseFloat(flag('days', '1'));
if (!Number.isFinite(days) || days <= 0) { err('--days must be a positive number.'); process.exit(EXIT.USAGE); }

const until = flag('until') ? Date.parse(flag('until')) : Date.now();
const since = flag('since') ? Date.parse(flag('since')) : until - days * 86_400_000;
if (!Number.isFinite(since) || !Number.isFinite(until) || since >= until) {
  err('Could not read the window. --since/--until want ISO timestamps and --since must be earlier.');
  process.exit(EXIT.USAGE);
}

const spanDays = (until - since) / 86_400_000;
if (connector.maxWindowDays && spanDays > connector.maxWindowDays) {
  err(`${connector.name} retains only ${connector.maxWindowDays} days of history; asking for`);
  err(`${spanDays.toFixed(1)} would silently return a short read and report actions as absent`);
  err('that the vendor simply no longer remembers. Narrow the window.');
  process.exit(EXIT.USAGE);
}

const quiet = has('quiet');
const asJson = has('json');
const log = quiet || asJson
  ? () => {}
  : (m) => err(`  ${redactWith(String(m), credential, apiKey)}`);

try {
  const summary = await reconcile({
    connector, credential, apiKey, effectType, dryRun,
    baseUrl: (process.env.RATCHET_BASE_URL ?? 'https://ratchetgate.com').replace(/\/+$/, ''),
    since, until,
    types: flag('types') ? flag('types').split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    windowDays: Math.max(1, Math.ceil(spanDays)),
    log,
  });

  if (asJson) { out(JSON.stringify(summary, null, 2)); }
  else {
    if (!quiet) {
      out(`${summary.vendor} → ${summary.effectType}`);
      out(`  window          ${new Date(since).toISOString()} .. ${new Date(until).toISOString()}`);
      out(`  events examined ${summary.eventsExamined}`);
      out(`  keys compared   ${summary.checked || summary.keysFound}`);
      out(`  gated           ${summary.gated}`);
      out(`  unmatched       ${summary.ungated}`);
      if (summary.unattributable > 0) {
        out(`  unattributable  ${summary.unattributable}  (no idempotency key at the vendor —`);
        out('                     cannot be judged either way, and is NOT counted as ungated)');
      }
      if (summary.ungatedKeys.length) {
        out('  first unmatched:');
        for (const k of summary.ungatedKeys.slice(0, 10)) out(`    ${k}`);
      }
      out('');
    }
    out(summary.meaning);
  }
  process.exit(exitCodeFor(summary));
} catch (e) {
  // Vendors echo the key back in their own errors — Stripe answers a bad key
  // with `Invalid API Key provided: sk_...`. This runs in CI, where stderr is a
  // build log, so the message is scrubbed both by pattern and against the exact
  // credentials this process was handed.
  err(`ratchet-reconcile: ${redactWith(e.message, credential, apiKey)}`);
  process.exit(EXIT.USAGE);
}
