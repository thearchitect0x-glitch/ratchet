// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Turning HTML into text, and putting text back into a <script> block.
 *
 * Split out of build-schema.mjs so these can be tested against hostile input
 * directly. Both had defects that no test could reach while they were locals in
 * a script that runs on import, and both were found by CodeQL rather than by us.
 */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
};

export const decode = (s) => s
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&([a-zA-Z]+);/g, (m, name) => ENTITIES[name] ?? m);

/**
 * Remove tags until the string stops changing.
 *
 * BE HONEST ABOUT WHAT THIS FIXES. CodeQL flags the single-pass form as
 * "incomplete multi-character sanitization", on the theory that removing an
 * inner tag can splice an outer one back together — `<scr<b>ipt>` becoming
 * `<script>`. For THIS regex that cannot happen: a global replace scans left to
 * right, and every match runs from a `<` to the first `>` after it, so no `<`
 * with a `>` following it survives the first pass. Checked exhaustively over
 * every string up to length 7 in the alphabet that matters (`< > a b / " space`)
 * — 960,799 of them — and a single pass equals the fixpoint in all of them, and
 * leaves a tag-shaped substring in none. The loop never runs twice today.
 *
 * It is kept anyway, for one reason that is not "the scanner said so": it makes
 * the invariant the callers rely on — nothing tag-shaped survives — true BY
 * CONSTRUCTION rather than as a property of one particular regex. Narrow that
 * pattern later (to `<script>`, say, as people do) and the single-pass version
 * silently becomes exploitable while this one does not.
 *
 * The defence that actually matters is jsonForScriptBlock below. That one was
 * a real hole.
 */export const stripTags = (s) => stripTagsCounted(s).text;

/**
 * The same thing, reporting how many passes it took.
 *
 * Exists so a test can assert "one pass is enough for this regex" without
 * writing the single-pass form out again — which is the unsafe pattern, and
 * putting it in a test file only moves it. The claim stays continuously
 * verified instead of living in a comment that cannot fail.
 */
export const stripTagsCounted = (s) => {
  let prev;
  let out = s;
  let passes = 0;
  do { prev = out; out = out.replace(/<[^>]*>/g, ''); passes += 1; } while (out !== prev);
  // The final pass is the one that changed nothing; it is confirmation, not work.
  return { text: out, passes: passes - 1 };
};

/**
 * Tags out, entities decoded, whitespace collapsed.
 *
 * Decoding is not cosmetic. A title written with `&mdash;` kept its
 * "— Ratchet" suffix, because the regex that strips it expects a literal em
 * dash; and an undecoded `&lsquo;` was escaped a second time on the way into
 * the RSS feed and would have reached subscribers as `&amp;lsquo;`.
 *
 * Note the order: decoding happens AFTER tags are stripped, so `&lt;b&gt;`
 * correctly survives as the TEXT `<b>` rather than being removed as markup.
 * That is right, and it is exactly why the embedding below has to escape.
 */
export const strip = (s) => decode(stripTags(s)).replace(/\s+/g, ' ').trim();

/**
 * Serialise for embedding inside a <script> block.
 *
 * `JSON.stringify` does not escape `<`, and this lands directly inside
 * `<script type="application/ld+json">`. A page whose title contained
 * `</script>` would close the block early and spill the rest of the JSON into
 * the document as markup. `<` is the standard defence and stays valid
 * JSON — a parser reads it back as `<`.
 *
 * This is the layer that must be right. `strip` produces TEXT, and text is
 * allowed to contain `<` and `/`; it is the embedding that must not treat them
 * as markup. Fixing it in the extractor instead would be fixing the symptom in
 * the wrong place, and would silently corrupt any title that legitimately
 * mentions a tag.
 */
export const jsonForScriptBlock = (obj) =>
  JSON.stringify(obj, null, 1).replace(/</g, '\\u003c');
