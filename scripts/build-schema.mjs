// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Generate the structured data that Google reads, from the pages themselves.
 *
 * Hand-written JSON-LD drifts. The FAQ answers change, nobody remembers the
 * schema block at the top of the file, and Google carries on showing a rich
 * result that quotes an answer the page no longer gives — which is worse than
 * having no rich result, because it is wrong in public and attributed to us.
 *
 * So it is derived. Run this after editing the FAQ or publishing a note, and a
 * test asserts the output is in sync with the page it came from.
 *
 *   node scripts/build-schema.mjs         # write
 *   node scripts/build-schema.mjs --check # fail if stale (CI)
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { strip, decode, jsonForScriptBlock } from './lib/html-text.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const SITE = 'https://ratchetgate.com';
const check = process.argv.includes('--check');

// Text extraction and script-block escaping live in ./lib/html-text.mjs,
// where they can be tested against hostile input. Both had defects that no
// test could reach while they were locals in a script that runs on import.
const MARK = {
  open: '<!-- schema:auto -->',
  close: '<!-- /schema:auto -->',
};

/** Replace the generated block, or insert it just before </head>. */
function inject(html, block) {
  const wrapped = `${MARK.open}\n${block}\n${MARK.close}`;
  const existing = new RegExp(`${MARK.open}[\\s\\S]*?${MARK.close}`);
  if (existing.test(html)) return html.replace(existing, wrapped);
  return html.replace('</head>', `${wrapped}\n</head>`);
}

const ld = (obj) =>
  `<script type="application/ld+json">\n${jsonForScriptBlock(obj)}\n</script>`;

// ---------------------------------------------------------------- FAQ
function faq() {
  const path = join(WEB, 'faq.html');
  const html = readFileSync(path, 'utf8');
  const pairs = [...html.matchAll(
    /<summary>(.*?)<\/summary>\s*<div class="faq-body">\s*<p>(.*?)<\/p>/gs)];
  if (pairs.length < 5) throw new Error(`only ${pairs.length} FAQ pairs parsed — the markup changed`);

  const block = ld({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: pairs.map(([, q, a]) => ({
      '@type': 'Question',
      name: strip(q),
      acceptedAnswer: { '@type': 'Answer', text: strip(a) },
    })),
  });
  return [path, inject(html, block), `FAQPage · ${pairs.length} questions`];
}

// ---------------------------------------------------------------- notes
/** Filled in by note(), so the feed is built from the same parse as the schema. */
const PARSED = [];
function note(file) {
  const path = join(WEB, 'notes', file);
  const html = readFileSync(path, 'utf8');
  const slug = file.replace(/\.html$/, '');
  const title = strip(html.match(/<title>(.*?)<\/title>/s)?.[1] ?? '')
    .replace(/\s*[—|]\s*Ratchet\s*$/, '');
  const desc = decode(html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? '');
  /*
   * Prefer the date the page already shows over one invented here.
   *
   * It used to fall through to a hardcoded '2026-09-01', and three notes had no
   * <time> element at all — they print the date as prose in <p class="meta">.
   * They were not in the generator's input list, so the fallback never fired
   * and nobody noticed; the moment they were included it would have stamped all
   * three with a publication date five days before they were written, in the
   * structured data Google reads. A default that quietly produces a wrong
   * answer is worse than no default, so the last resort now throws.
   */
  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
                  'august', 'september', 'october', 'november', 'december'];
  const prose = strip(html.match(/<p class="meta">([^<]*)<\/p>/)?.[1] ?? '')
    .match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  const fromProse = prose
    ? `${prose[3]}-${String(MONTHS.indexOf(prose[2].toLowerCase()) + 1).padStart(2, '0')}`
      + `-${prose[1].padStart(2, '0')}`
    : undefined;

  const date = html.match(/datetime="(\d{4}-\d{2}-\d{2})"/)?.[1] ?? fromProse;
  if (!date) {
    throw new Error(
      `${file}: cannot determine a publication date. Give the page a <time datetime="YYYY-MM-DD">`
      + ' or a <p class="meta">D Month YYYY</p>. Guessing would put a wrong date in the'
      + ' structured data Google reads, attributed to us, in public.');
  }

  const block = ld({
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: title,
    description: desc,
    datePublished: date,
    dateModified: date,
    url: `${SITE}/notes/${slug}`,
    mainEntityOfPage: { '@type': 'WebPage', '@id': `${SITE}/notes/${slug}` },
    image: `${SITE}/assets/og.png`,
    author: { '@type': 'Organization', name: 'Deimos AI LLC', url: 'https://deimoscore.com' },
    publisher: {
      '@type': 'Organization', name: 'Ratchet', url: SITE,
      logo: { '@type': 'ImageObject', url: `${SITE}/assets/mark.svg` },
    },
  });
  PARSED.push({ slug, title, desc, date });
  return [path, inject(html, block), `BlogPosting · ${slug}`];
}

// ---------------------------------------------------------------- home
function home() {
  const path = join(WEB, 'index.html');
  const html = readFileSync(path, 'utf8');
  const block = [
    ld({
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: 'Ratchet',
      url: SITE,
      logo: `${SITE}/assets/mark.svg`,
      description: 'An effect gate for AI agents. Ask before you act, so the same '
        + 'real-world side effect is attempted at most once.',
      parentOrganization: { '@type': 'Organization', name: 'Deimos AI LLC', url: 'https://deimoscore.com' },
      // Claiming the social profiles as the same entity is what lets Google
      // show them together and stops a lookalike account outranking the real one.
      sameAs: [
        'https://x.com/ratchetgate',
        'https://www.instagram.com/ratchetgate',
        'https://github.com/thearchitect0x-glitch/ratchet',
      ],
    }),
    ld({
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: 'Ratchet',
      url: SITE,
      publisher: { '@type': 'Organization', name: 'Ratchet', url: SITE },
    }),
  ].join('\n');
  return [path, inject(html, block), 'Organization + WebSite'];
}

/*
 * Every note, found by looking rather than by remembering.
 *
 * This list used to be written out by hand, and it had drifted to two of the
 * five notes that existed — so three of them carried structured data nobody was
 * regenerating, which is precisely the failure this script was written to
 * prevent. A generator with a hand-maintained input list is a hand-maintained
 * list with extra steps.
 *
 * index.html and feed.xml live in the same directory and are not posts.
 */
const NOT_A_POST = new Set(['index.html']);
const notes = readdirSync(join(WEB, 'notes'))
  .filter((f) => f.endsWith('.html') && !NOT_A_POST.has(f))
  .sort();

const jobs = [home(), faq(), ...notes.map(note)];

/*
 * The feed, from the same parse.
 *
 * It was written by hand, which means it was one forgotten edit away from
 * advertising a set of notes that no longer matched the ones on the site — the
 * same drift this script exists to prevent, in the file most likely to be read
 * by something that never visits the page.
 */
const rfc822 = (d) => new Date(`${d}T09:00:00Z`).toUTCString();
const xml = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const items = [...PARSED].sort((a, b) => b.date.localeCompare(a.date)).map((n) => `    <item>
      <title>${xml(n.title)}</title>
      <link>${SITE}/notes/${n.slug}</link>
      <guid isPermaLink="true">${SITE}/notes/${n.slug}</guid>
      <pubDate>${rfc822(n.date)}</pubDate>
      <description>${xml(n.desc)}</description>
    </item>`).join('\n');

jobs.push([join(WEB, 'notes', 'feed.xml'),
`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Ratchet — engineering notes</title>
    <link>${SITE}/notes</link>
    <description>Notes from building an effect gate for AI agents.</description>
    <language>en</language>
    <atom:link href="${SITE}/notes/feed.xml" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>
`, `RSS · ${PARSED.length} notes`]);

let stale = 0;
for (const [path, next, label] of jobs) {
  const current = readFileSync(path, 'utf8');
  if (current === next) { console.log(`  ok     ${label}`); continue; }
  stale++;
  if (check) { console.log(`  STALE  ${label}`); continue; }
  writeFileSync(path, next);
  console.log(`  wrote  ${label}`);
}

if (check && stale) {
  console.error(`\n${stale} page(s) have structured data that no longer matches the page.`);
  console.error('Run: npm run schema');
  process.exit(1);
}
