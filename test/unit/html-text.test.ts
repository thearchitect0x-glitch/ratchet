// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Turning HTML into text, and putting text back inside a <script> block.
 *
 * Both of these had defects, and neither was reachable by a test while they
 * were locals in a script that runs on import — which is why CodeQL found them
 * and we did not. They are a module now so hostile input can be handed to them
 * directly.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

const load = (p: string): Promise<any> => import(p);
const { strip, stripTags, decode, jsonForScriptBlock } =
  await load('../../scripts/lib/html-text.mjs');

describe('stripping tags', () => {
  test('removes ordinary markup', () => {
    assert.equal(stripTags('<p>hello <em>there</em></p>'), 'hello there');
  });

  /**
   * The property callers actually depend on: nothing tag-shaped survives.
   *
   * Asserted rather than the stronger "produces clean prose", because it does
   * not. `<scr<b>ipt>` leaves `ipt>` — the match runs from the first `<` to the
   * first `>`, so `<scr<b>` goes as one unit. That output is safe (no `<`
   * remains) and it is not pretty, and the test should say the true thing.
   */
  test('no tag-shaped substring survives, whatever the nesting', () => {
    for (const input of [
      '<scr<b>ipt>alert(1)</scr<b>ipt>',
      '<<b>script>',
      '<scr<i></i>ipt>x',
      '<a href="<b>">',
      '<b<b>>',
    ]) {
      assert.ok(!/<[^>]*>/.test(stripTags(input)),
        `a tag survived stripping of ${JSON.stringify(input)}`);
    }
  });

  /**
   * The honest scope of the loop, recorded so nobody "simplifies" it back on
   * the belief it is load-bearing today — and nobody claims it fixed a bug.
   *
   * For this regex a single pass is already a fixpoint. Verified exhaustively
   * here rather than asserted in a comment, because a comment cannot fail.
   */
  test('for this regex one pass already equals the fixpoint', () => {
    const onePass = (x: string) => x.replace(/<[^>]*>/g, '');
    const alphabet = ['<', '>', 'a', 'b', '/', '"', ' '];
    let checked = 0;
    const walk = (depth: number, acc: string) => {
      if (depth === 0) {
        checked += 1;
        assert.equal(onePass(acc), stripTags(acc),
          `single pass and fixpoint disagree on ${JSON.stringify(acc)} — the loop `
          + 'is now load-bearing, and its comment saying otherwise is wrong');
        return;
      }
      for (const c of alphabet) walk(depth - 1, acc + c);
    };
    for (let len = 1; len <= 5; len += 1) walk(len, '');
    assert.ok(checked > 19_000, `expected a real sweep, checked ${checked}`);
  });

  test('an unclosed tag does not swallow the rest of the document', () => {
    // <[^>]*> rather than <[^>]+>: `<>` is still a tag-shaped thing.
    assert.equal(stripTags('a<>b'), 'ab');
  });
});

describe('decoding entities', () => {
  test('named and numeric entities both decode', () => {
    assert.equal(decode('a &amp; b'), 'a & b');
    assert.equal(decode('&lsquo;q&rsquo;'), '‘q’');
    assert.equal(decode('&#8212;'), '—');
  });

  test('an unknown entity is left alone rather than mangled', () => {
    assert.equal(decode('&notanentity;'), '&notanentity;');
  });

  /**
   * The two live symptoms. A title written with `&mdash;` kept its
   * "— Ratchet" suffix because the regex that strips it wants a literal em
   * dash; and `&lsquo;` reached the RSS feed re-escaped as `&amp;lsquo;`.
   */
  test('strip decodes, so a title suffix written as an entity is still stripped', () => {
    const title = strip('The dedupe key &mdash; Ratchet').replace(/\s*[—|]\s*Ratchet\s*$/, '');
    assert.equal(title, 'The dedupe key');
  });
});

describe('embedding JSON inside a script block', () => {
  /**
   * The one that mattered. `strip` produces TEXT, and text may legitimately
   * contain `<` and `/` — a note about HTML will. JSON.stringify does not
   * escape either, and the result is written straight into
   * `<script type="application/ld+json">`, so a title containing `</script>`
   * would close the block and spill the rest into the document as markup.
   */
  test('a closing script tag in the data cannot close the block', () => {
    const out = jsonForScriptBlock({ headline: 'Why </script> breaks your page' });
    assert.ok(!out.includes('</script>'),
      'the payload closed the script block it was being embedded in');
    assert.ok(out.includes('\\u003c'), 'the < should be escaped as \\u003c');
  });

  test('and it is still valid JSON that round-trips', () => {
    const original = { headline: 'a </script> b', description: '<b>x</b> & y' };
    const parsed = JSON.parse(jsonForScriptBlock(original));
    assert.deepEqual(parsed, original,
      '\\u003c must decode back to < — escaping may not change the data');
  });

  test('every < is escaped, not only the ones next to a slash', () => {
    const out = jsonForScriptBlock({ a: '<img>', b: '<<<' });
    assert.ok(!out.includes('<'), 'a bare < survived into the script block');
  });
});
