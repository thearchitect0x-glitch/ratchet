// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * One version, declared once.
 *
 * There were five declarations and four different answers: the repository said
 * 0.1.0, the bridge package 0.2.0, the registry manifest 0.2.0 for the server
 * and 0.1.1 for its package, and npm had published 0.1.1. A client calling
 * `initialize` was told 0.1.0 while the registry advertised 0.2.0.
 *
 * Nothing broke. That is why it survived — every consumer read a different
 * field and each was internally consistent. It is the kind of drift a directory
 * notices before you do, and it makes a listing look unmaintained.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const json = (p: string) =>
  JSON.parse(readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8'));

describe('version consistency', () => {
  const repo = json('package.json').version as string;

  test('the repository version is a plain semver', () => {
    assert.match(repo, /^\d+\.\d+\.\d+$/);
  });

  /*
   * Every published package, not just the first one. ratchet-reconcile shipped
   * without being added here, so it could have drifted to its own version and
   * nothing would have said so — which is exactly the five-declarations,
   * four-answers state this file was written to end.
   */
  test('every published package declares the same version', () => {
    for (const pkg of ['ratchet-mcp', 'ratchet-reconcile']) {
      assert.equal(json(`packages/${pkg}/package.json`).version, repo,
        `packages/${pkg} has drifted from the repository version`);
    }
  });

  test('the MCP registry manifest agrees, for the server and its package', () => {
    const manifest = json('server.json');
    assert.equal(manifest.version, repo, 'server.json server version has drifted');
    for (const pkg of manifest.packages ?? []) {
      assert.equal(pkg.version, repo,
        `server.json packages[].version has drifted (${pkg.identifier ?? 'package'})`);
    }
  });

  test('what the server tells a client on initialize is the same number', async () => {
    const { SERVER_INFO } = await import('../../src/mcp/protocol.js');
    assert.equal(SERVER_INFO.version, repo,
      'serverInfo.version must not be typed by hand — it is read from package.json');
  });

  /**
   * The published API contract, which was the one nobody checked.
   *
   * `info.version` in the OpenAPI document read '0.1.0' while the package, the
   * registry manifest and `initialize` all said 0.3.0 — two minor versions
   * behind, on the document integrators generate clients from. It is the same
   * failure this file exists for, in the one place it had not looked, and
   * 0.1.0 is literally the number from the story at the top.
   */
  /**
   * Every version a client can actually fetch, asserted through the real route.
   *
   * Reading the source would prove the literal is gone; only serving the
   * request proves what a client is told. Both of these were typed by hand and
   * both read '0.1.0' while the package said 0.3.0 — the OpenAPI document that
   * integrators generate clients from, and the agent manifest an agent reads to
   * decide how to talk to us at all.
   */
  test('every version a client can fetch is the same number', async () => {
    const { buildApp } = await import('../../src/api/app.js');
    const app = await buildApp({ logger: false });
    try {
      await app.ready();
      const surfaces: Array<[string, (b: any) => unknown]> = [
        ['/openapi.json', (b) => b.info.version],
        ['/.well-known/agent-manifest.json', (b) => b.version],
      ];
      for (const [url, pick] of surfaces) {
        const res = await app.inject({ method: 'GET', url });
        assert.equal(res.statusCode, 200, `${url} did not answer`);
        assert.equal(pick(JSON.parse(res.payload)), repo,
          `${url} declares a different version — derive it from package.json, do not type it`);
      }
    } finally {
      await app.close();
    }
  });
});

/**
 * The MCP registry rejects a description over 100 characters at submission.
 * That is a bad time to find out: the manifest is edited by hand, the limit is
 * in a schema nobody opens, and the natural instinct when improving copy is to
 * add words. It is cheaper to fail here.
 */
describe('listing copy', () => {
  test('the registry description is within the schema limit', () => {
    const d = json('server.json').description as string;
    assert.ok(d.length > 0, 'server.json needs a description');
    assert.ok(d.length <= 100,
      `server.json description is ${d.length} chars — the MCP registry schema caps it at 100`);
  });

  test('every declared description is non-empty', () => {
    assert.ok((json('package.json').description as string)?.length > 20);
    assert.ok((json('packages/ratchet-mcp/package.json').description as string)?.length > 20);
    assert.ok((json('packages/ratchet-reconcile/package.json').description as string)?.length > 20);
  });
});

/**
 * The repository's package.json had no `license` field at all, while the
 * LICENSE file said Apache-2.0 and the published bridge declared Apache-2.0.
 * Directories and package tooling read the field, not the file, so the project
 * was one lookup away from being reported as unlicensed — which for anything
 * a company might depend on is the same as being unusable.
 */
describe('licensing', () => {
  test('every package declares the licence, and the same one', () => {
    const root = json('package.json').license as string;
    const bridge = json('packages/ratchet-mcp/package.json').license as string;
    assert.ok(root, 'the repository package.json must declare a license');
    assert.equal(root, bridge, 'the repo and the published bridge disagree on the licence');
  });

  test('the declared licence matches the LICENSE file', () => {
    const text = readFileSync(new URL('../../LICENSE', import.meta.url), 'utf8');
    const declared = json('package.json').license as string;
    const family = declared.split('-')[0]!;   // Apache-2.0 → Apache
    assert.ok(text.includes(family),
      `package.json says ${declared} but LICENSE does not mention ${family}`);
  });
});
