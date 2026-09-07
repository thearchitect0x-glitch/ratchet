// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Every note is reachable, listed, and dated the same way in all four places.
 *
 * `npm run schema:check` proves the generator's output is current. It cannot
 * prove the generator was pointed at everything, and that is exactly what went
 * wrong: the input list was written by hand and held two of the five notes that
 * existed, so three carried structured data nobody regenerated and one
 * published a date five days before it was written. These assert the
 * relationships the generator cannot check about itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const NOTES = join(ROOT, 'web', 'notes');
const read = (p: string) => readFileSync(p, 'utf8');

const slugs = readdirSync(NOTES)
  .filter((f) => f.endsWith('.html') && f !== 'index.html')
  .map((f) => f.replace(/\.html$/, ''))
  .sort();

test('there are notes to check', () => {
  assert.ok(slugs.length >= 5, `expected several notes, found ${slugs.length}`);
});

/**
 * A note the router does not serve is a 404 with a sitemap entry pointing at it,
 * which is worse than an unpublished note: it is a broken promise to a crawler.
 */
test('every note is served by the router', () => {
  const app = read(join(ROOT, 'src', 'api', 'app.ts'));
  const list = app.match(/const POSTS = \[([\s\S]*?)\];/)?.[1] ?? '';
  for (const slug of slugs) {
    assert.match(list, new RegExp(`'${slug}'`),
      `/notes/${slug} exists on disk but is not in POSTS, so it would 404`);
  }
});

test('every note is in the sitemap, the index, and the feed', () => {
  const sitemap = read(join(ROOT, 'web', 'sitemap.xml'));
  const index = read(join(NOTES, 'index.html'));
  const feed = read(join(NOTES, 'feed.xml'));
  for (const slug of slugs) {
    assert.match(sitemap, new RegExp(`/notes/${slug}<`), `${slug} missing from sitemap.xml`);
    assert.match(index, new RegExp(`/notes/${slug}"`), `${slug} missing from the notes index`);
    assert.match(feed, new RegExp(`/notes/${slug}<`), `${slug} missing from feed.xml`);
  }
});

/**
 * The bug this file exists for.
 *
 * The generator fell through to a hardcoded date when a page had no <time>
 * element, so the date a reader sees and the date Google reads could disagree
 * — silently, in public, attributed to us.
 */
test('the date a reader sees is the date the machines are told', () => {
  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
    'august', 'september', 'october', 'november', 'december'];

  for (const slug of slugs) {
    const html = read(join(NOTES, `${slug}.html`));

    const prose = html.match(/<p class="meta">\s*(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\s*<\/p>/);
    assert.ok(prose, `${slug} does not print a date a human can read`);
    const month = MONTHS.indexOf(prose[2]!.toLowerCase());
    assert.notEqual(month, -1, `${slug}: "${prose[2]}" is not a month`);
    const shown = `${prose[3]}-${String(month + 1).padStart(2, '0')}-${prose[1]!.padStart(2, '0')}`;

    const published = html.match(/"datePublished": "(\d{4}-\d{2}-\d{2})"/)?.[1];
    assert.ok(published, `${slug} has no datePublished in its structured data`);
    assert.equal(published, shown,
      `${slug} shows ${shown} to a reader and tells Google ${published}`);

    const feedDate = read(join(NOTES, 'feed.xml'))
      .match(new RegExp(`/notes/${slug}</guid>\\s*<pubDate>([^<]+)</pubDate>`))?.[1];
    assert.ok(feedDate, `${slug} has no pubDate in the feed`);
    assert.equal(new Date(feedDate).toISOString().slice(0, 10), shown,
      `${slug} is dated ${shown} on the page and ${feedDate} in the feed`);
  }
});

/**
 * An unescaped entity in a title reaches a feed reader as literal `&lsquo;`.
 * The generator now decodes before it re-escapes; this is the assertion that
 * says so, because the symptom only shows up in somebody else's reader.
 */
test('no double-escaped entities survive into the feed', () => {
  const feed = read(join(NOTES, 'feed.xml'));
  assert.ok(!/&amp;(lsquo|rsquo|mdash|ndash|quot|hellip|#\d+);/.test(feed),
    'feed.xml contains a double-escaped entity — decode before re-escaping');
  assert.ok(!/<title>[^<]*— Ratchet<\/title>/.test(feed),
    'a feed title kept its "— Ratchet" suffix, so the entity was not decoded before stripping');
});
