// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Numbers we publish, checked against the numbers that are true.
 *
 * CLAUDE.md §11 says a change is not done if it has made a claim untrue. Nothing
 * enforced that for *figures*, and on 5 Sep 2026 it showed: two documents said
 * "no coverage tool is configured, so no coverage percentage is claimed
 * anywhere" while the OpenSSF badge claimed 90.87% statement coverage. Both were
 * public, they contradicted each other, and a reader had no way to know which
 * the project stood behind. Three other documents carried test counts stale by
 * hundreds.
 *
 * The rule this encodes: a number in a living document is a claim, and a claim
 * has to be checkable. Where a figure moves faster than anyone will remember to
 * edit it, the document must state a floor ("over 1000 tests") rather than a
 * reading ("1102 tests"), because a floor stays true as the number grows and a
 * reading is wrong the next morning.
 *
 * DATED DOCUMENTS ARE EXCLUDED, deliberately. An incident report from 31 August
 * saying there were 12 vendors is not stale, it is a record of 31 August.
 * Rewriting history to satisfy a linter would destroy the thing those files are
 * for. Only documents that describe the present are held to the present.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VENDOR_PROFILES } from '../../src/domain/vendor-keys.js';
import { EVENT_TYPES } from '../../src/domain/events.js';

const ROOT = new URL('../../', import.meta.url).pathname;

/** A snapshot of a past date is not a claim about today. */
const IS_DATED_RECORD = /_\d{4}-\d{2}-\d{2}/;

function livingDocuments(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (!entry.name.endsWith('.md')) continue;
      if (IS_DATED_RECORD.test(entry.name)) continue;
      out.push(path);
    }
  };
  walk(join(ROOT, 'docs'));
  out.push(join(ROOT, 'README.md'), join(ROOT, 'CLAUDE.md'));
  return out;
}

const rel = (p: string) => p.replace(ROOT, '');

/**
 * Only the two documents that describe the floors are held to them. Elsewhere a
 * percentage is usually a measurement, and a measurement is not a threshold.
 */
const FLOOR_DOCS = ['CLAUDE.md', 'docs/SSDF.md'];

test('published coverage floors match the floors CI actually enforces', () => {
  // The floor is what stops a published percentage quietly becoming false, so a
  // document describing a floor that CI does not enforce is worse than silence.
  const harness = readFileSync(join(ROOT, 'scripts/test.sh'), 'utf8');
  const configured: Record<string, number> = {};
  for (const metric of ['statements', 'branches', 'lines', 'functions']) {
    const m = harness.match(new RegExp(`--${metric}\\s+(\\d+)`));
    assert.ok(m, `scripts/test.sh no longer sets a --${metric} threshold`);
    configured[metric] = Number(m![1]);
  }

  const wrong: string[] = [];
  for (const doc of FLOOR_DOCS.map((d) => join(ROOT, d))) {
    const text = readFileSync(doc, 'utf8');
    // The lookbehind keeps "91.1%" from reading as "1%", which is exactly the
    // false positive the first draft of this test produced.
    for (const [, pct, metric] of text.matchAll(/(?<![\d.])(\d+)%\s+(statements|branches|lines|functions)/g)) {
      if (Number(pct) !== configured[metric!]) {
        wrong.push(`${rel(doc)}: claims ${pct}% ${metric}, CI enforces ${configured[metric!]}%`);
      }
    }
  }
  assert.deepEqual(wrong, [], `Coverage floor claims out of step with scripts/test.sh:\n${wrong.join('\n')}`);
});

test('test counts are either anchored to a file or written as a floor', () => {
  // Two kinds of claim, and only one of them goes stale.
  //
  //   "11 tests, `test/integration/crypto.test.ts`"  — anchored. Verifiable, and
  //       useful: it tells a reader exactly where to look. Checked below.
  //   "442 tests"                                     — a global reading with no
  //       anchor. It was true in week one and is now wrong by 660.
  //
  // Static declarations undercount the runtime total (parameterised tests), so
  // this is a genuine lower bound: a floor at or beneath it cannot go false.
  const declared = countTestDeclarations(join(ROOT, 'test'));
  const offenders: string[] = [];

  for (const doc of livingDocuments()) {
    for (const line of readFileSync(doc, 'utf8').split('\n')) {
      for (const m of line.matchAll(/(\w+\s+)?(\d[\d,]*)\s+tests\b/g)) {
        const preceding = (m[1] ?? '').trim().toLowerCase();
        const claimed = Number(m[2]!.replace(/,/g, ''));
        const anchor = line.match(/(test\/[\w./-]+\.test\.ts)/);

        if (anchor) {
          const actual = countTestDeclarations(join(ROOT, anchor[1]!));
          if (actual < claimed) {
            offenders.push(`${rel(doc)}: claims ${claimed} tests in ${anchor[1]}, which declares ${actual}`);
          }
          continue;
        }
        if (['over', 'than', 'least', 'above', 'exceeds'].includes(preceding)) {
          if (claimed > declared) {
            offenders.push(`${rel(doc)}: floor of ${claimed} tests exceeds the ${declared} declared`);
          }
          continue;
        }
        offenders.push(
          `${rel(doc)}: "${m[2]} tests" is an unanchored reading — name the test file, or write "over N tests"`);
      }
    }
  }
  assert.deepEqual(offenders, [], `Test-count claims that will go stale:\n${offenders.join('\n')}`);
});

test('vendor counts in living documents match the profiles that exist', () => {
  const actual = Object.keys(VENDOR_PROFILES).length;
  const wrong: string[] = [];
  for (const doc of livingDocuments()) {
    const text = readFileSync(doc, 'utf8');
    for (const m of text.matchAll(/(\d+)\s+vendor(?:s| profiles)\b/g)) {
      if (Number(m[1]) !== actual) {
        wrong.push(`${rel(doc)}: claims ${m[1]} vendors, ${actual} profiles exist`);
      }
    }
  }
  assert.deepEqual(wrong, [], `Vendor counts out of step with VENDOR_PROFILES:\n${wrong.join('\n')}`);
});

/**
 * Counts declarations in a file, or recursively in a directory.
 *
 * One stat, at the entry point, because the caller hands over a bare path and
 * something has to ask what it is. Everything below it takes the kind from the
 * readdir that produced the name, so the recursion does not stat every entry
 * and then read it — the check-then-use shape CodeQL names, and N syscalls
 * where one will do.
 */
function countTestDeclarations(path: string): number {
  const countFile = (p: string) =>
    p.endsWith('.ts') ? (readFileSync(p, 'utf8').match(/^\s*(?:test|it)\(/gm) ?? []).length : 0;

  const walk = (dir: string): number => {
    let n = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name);
      n += entry.isDirectory() ? walk(child) : countFile(child);
    }
    return n;
  };

  return statSync(path).isDirectory() ? walk(path) : countFile(path);
}

/**
 * Numbers were the first thing to drift. Lists are the second.
 *
 * API_AND_DATA_CONTRACTS.md published the webhook event types as prose, and by
 * the time anyone looked it named eight of the ten that existed —
 * `circuit.tripped` and `reconciliation.due` had both shipped without the
 * documentation following. A caller reading that list would subscribe to events
 * we send and never learn the others were available.
 *
 * A published enumeration is a claim about a set. It is checkable in exactly the
 * way a published figure is.
 */
test('the published webhook event list matches the events that exist', () => {
  const doc = readFileSync(join(ROOT, 'docs/handoff/API_AND_DATA_CONTRACTS.md'), 'utf8');
  const section = doc.slice(doc.indexOf('## Webhooks'));
  const published = new Set(
    // Underscores appear on BOTH sides of the dot: `effect_type.first_seen` was
    // the first such event, and the original pattern here allowed them only
    // after it — so a correctly documented event read as missing.
    [...section.slice(0, section.indexOf('Headers:')).matchAll(/`([a-z_]+\.[a-z_]+)`/g)]
      .map((m) => m[1]!),
  );

  const actual = new Set<string>(EVENT_TYPES);
  const missing = [...actual].filter((e) => !published.has(e));
  const invented = [...published].filter((e) => !actual.has(e));

  assert.deepEqual(missing, [],
    `Events that exist but are not documented: ${missing.join(', ')}`);
  assert.deepEqual(invented, [],
    `Events documented but not emitted — worse than missing, a caller can subscribe to nothing: ${invented.join(', ')}`);
});

/**
 * /verify is the page that lists what we do NOT claim, which makes it the page
 * most likely to drift the wrong way: gaps get closed, the document that
 * records them gets updated, and the public page keeps confessing to something
 * that is no longer true — or, worse, stops confessing to something that is.
 *
 * These couple the page to the documents that own the facts, so the two cannot
 * disagree quietly. There is no third-party check for "we have not been
 * audited"; a test is the only thing that can hold it.
 */
test('the /verify page agrees with the documents that own its claims', () => {
  const at = (f: string) => readFileSync(join(ROOT, f), 'utf8');
  const verify = at('web/verify.html');
  const policy = at('docs/OPEN_SOURCE_POLICY.md');
  const readme = at('README.md');

  // ISO 5230 / 18974: the policy's conformance tables are the record.
  const unmet = policy.includes('**Not met**');
  assert.equal(unmet, verify.includes('self-assessed and incomplete'),
    unmet
      ? 'OPEN_SOURCE_POLICY.md still records an unmet requirement, so /verify must '
        + 'keep saying conformance is incomplete'
      : 'OPEN_SOURCE_POLICY.md no longer records an unmet requirement — /verify is '
        + 'now confessing to a gap that has been closed, and should be updated');

  // SOC 2 and penetration testing: the README is the record, and it is blunt.
  assert.ok(readme.includes('There is no SOC 2 report'),
    'README.md dropped its SOC 2 disclaimer; /verify repeats it and must follow');
  assert.match(verify, /There is no SOC 2 report/,
    '/verify must say plainly that there is no SOC 2 report');
  assert.match(verify, /no penetration test/i,
    '/verify must say plainly that there has been no penetration test');

  // The word this project cannot use about itself. A badge is not an audit, and
  // the whole value of the badges is that a reader can check them and disagree.
  assert.ok(!/\b(we are|Ratchet is|Deimos[^.]{0,30}is) (SOC 2 )?certified\b/i.test(verify),
    '/verify must never describe Ratchet or Deimos as certified — nothing here is');

  // Exactly-once is the claim the product is built on not making.
  assert.match(verify, /at-most-once/,
    '/verify must state the guarantee that is actually made');
});

/**
 * The published error table must name every code the API can return, and
 * nothing it cannot.
 *
 * Agents branch on `error.code` — that is the contract, and the docs are how a
 * caller learns what to do about each one. When this check was written the
 * table listed 12 codes and the code could emit 26, so more than half the
 * surface was undocumented, including `lease_expired`, which the MCP tool
 * descriptions explicitly tell a model to stop on. A caller cannot handle a
 * code nobody told them exists.
 */
test('every error code the API can return is documented, and no others', () => {
  const at = (f: string) => readFileSync(join(ROOT, f), 'utf8');

  const emitted = new Set<string>();
  const walk = (dir: string) => {
    // withFileTypes, so the kind comes back from the SAME readdir that produced
    // the name. Calling statSync afterwards asks the filesystem a second time
    // about a path that may have changed in between — the race CodeQL names,
    // and one fewer syscall per entry either way.
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (!entry.name.endsWith('.ts')) continue;
      const t = readFileSync(path, 'utf8');
      for (const m of t.matchAll(/new ApiError\(\s*\d{3}\s*,\s*'([a-z_]+)'/g)) emitted.add(m[1]!);
      for (const m of t.matchAll(/errors\.conflict\('([a-z_]+)'/g)) emitted.add(m[1]!);
      if (/errors\.unauthorized\(/.test(t)) emitted.add('unauthorized');
      if (/errors\.forbidden\(/.test(t)) emitted.add('forbidden');
      if (/errors\.invalid\(/.test(t)) emitted.add('invalid_request');
      if (/errors\.internal\(/.test(t)) emitted.add('internal_error');
    }
  };
  walk(join(ROOT, 'src'));
  assert.ok(emitted.size >= 20, `only found ${emitted.size} codes — the extraction broke`);

  const docs = at('web/docs.html');
  const table = docs.slice(docs.indexOf('<th>Worth retrying?</th>'));
  const documented = new Set(
    [...table.matchAll(/<td class="mono small">([a-z_]+)<\/td>/g)].map((m) => m[1]!));

  const undocumented = [...emitted].filter((c) => !documented.has(c)).sort();
  assert.deepEqual(undocumented, [],
    `these codes can be returned and are not in the table on /docs: ${undocumented.join(', ')}`);

  const invented = [...documented].filter((c) => !emitted.has(c)).sort();
  assert.deepEqual(invented, [],
    `the table documents codes nothing can return: ${invented.join(', ')}`);
});

/**
 * Every row must say what to do, and the three answers are the whole point of
 * the column: retry, change something first, or stop. A row with a description
 * and no verdict is the state this table was already in.
 */
test('every documented error code carries a retry verdict', () => {
  const docs = readFileSync(join(ROOT, 'web', 'docs.html'), 'utf8');
  const table = docs.slice(docs.indexOf('<th>Worth retrying?</th>'));
  const rows = [...table.matchAll(/<td class="mono small">([a-z_]+)<\/td>(.*?)<\/tr>/gs)];
  assert.ok(rows.length >= 20, `only parsed ${rows.length} rows`);

  for (const [, code, rest] of rows) {
    assert.match(rest!, /<span class="pill (go|wait|stop)">/,
      `${code} has no retry verdict — say retry, change first, or do not`);
  }

  /*
   * A terminal state cannot be retried into. lease_lost in particular means
   * somebody else holds the lease, and telling a caller to retry it would
   * invite exactly the double-execution the gate exists to prevent.
   */
  for (const terminal of ['lease_lost', 'idempotency_key_reuse', 'transaction_already_used']) {
    const row = rows.find(([, c]) => c === terminal);
    assert.ok(row, `${terminal} is missing from the table`);
    assert.match(row![2]!, /<span class="pill stop">/,
      `${terminal} is terminal and must never be described as retryable`);
  }
});

/**
 * Every current coverage figure in the documentation must agree with every
 * other one.
 *
 * This cannot know whether the numbers are right — a unit test does not run c8.
 * It can stop two documents disagreeing, which is the shape the failure has
 * taken every time: the OpenSSF badge claimed 90.87% while KNOWN_LIMITATIONS
 * said no percentage was claimed anywhere; later the badge said 91.1% while a
 * fresh measurement read 90.03%. In both cases a reader had no way to tell
 * which was true, and the project was wrong somewhere.
 *
 * A figure is treated as historical, and skipped, only when the line marks it —
 * "superseded", "earlier", "previously", "used to". Erasing a corrected number
 * would let this test pass by deleting the evidence, which is the opposite of
 * the point.
 */
test('the documentation does not disagree with itself about coverage', () => {
  /*
   * A floor is not a measurement. "CI fails below 90% statements" and
   * "the criterion asks for 90%" are claims about the threshold, and they are
   * SUPPOSED to differ from the measured figure — that gap is the safety
   * margin. Comparing them to a reading would make this test fire on a project
   * doing exactly the right thing.
   */
  const FLOOR = /floor|fails below|threshold|at least|asks for|criterion|enforced at|minimum|MUST\b|beneath/i;
  /*
   * Historical figures are kept on purpose. A correction that erases the number
   * it corrected reads as if the mistake never happened, so they are skipped
   * rather than banned — and skipping is why the marker list has to include the
   * way each one is actually written.
   */
  const HISTORICAL = /supersede|earlier|previously|used to|was stale|had become|claimed|quoted|understated|flattered/i;
  const METRICS = ['statements?', 'branch(?:es)?', 'functions?', 'lines?'] as const;

  const found = new Map<string, Map<string, string[]>>();   // metric -> value -> where

  for (const file of livingDocuments()) {
    const rel = file.slice(file.indexOf('/ajbs/') + 6);
    const lines = readFileSync(file, 'utf8').split('\n');
    for (const [i, line] of lines.entries()) {
      /*
       * Backwards only, and that direction is load-bearing.
       *
       * Prose wraps FORWARD from its qualifier: "Coverage floors are explicit
       * (90% statements...)" puts the word that makes it a floor on the line
       * above the number, so looking back is what stops a false alarm there.
       *
       * Looking FORWARD as well suppressed a real measurement, because the line
       * after "91.07% statements" happened to say "floors enforced in CI" — so
       * the check quietly stopped comparing the very figure it exists to
       * compare, and passed while two documents disagreed. Found by mutating
       * one document and watching nothing happen.
       */
      const context = `${lines[i - 1] ?? ''} ${line}`;
      if (HISTORICAL.test(context) || FLOOR.test(context)) continue;
      for (const metric of METRICS) {
        // "91.07% statements", "| Statements | **91.07%**", "statements: 91.07%"
        // The pipe must be allowed through: the figures live in markdown
        // tables — `| Statements | **91.07%** (17983/19746) |` — so excluding
        // `|` meant this side of the comparison was never collected and the
        // whole check passed vacuously. Caught by mutating one document to
        // disagree and watching nothing happen.
        const re = new RegExp(
          `(?:(\\d{2}(?:\\.\\d{1,2})?)%\\s*${metric}|${metric}\\b[^\\n]{0,16}?\\*{0,2}(\\d{2}(?:\\.\\d{1,2})?)%)`, 'i');
        const m = re.exec(line);
        if (!m) continue;
        const value = m[1] ?? m[2]!;
        const key = metric.replace(/[^a-z]/g, '');
        if (!found.has(key)) found.set(key, new Map());
        const byValue = found.get(key)!;
        if (!byValue.has(value)) byValue.set(value, []);
        byValue.get(value)!.push(`${rel}:${i + 1}`);
      }
    }
  }

  for (const [metric, byValue] of found) {
    if (byValue.size <= 1) continue;
    const detail = [...byValue].map(([v, where]) => `  ${v}%  ${where.join(', ')}`).join('\n');
    assert.fail(
      `the documentation quotes ${byValue.size} different figures for ${metric} coverage:\n${detail}\n`
      + 'Measure once with `npm run coverage` and make them agree, or mark the older one '
      + 'as superseded rather than deleting it.');
  }
});
