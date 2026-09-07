// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Which disagreements between the repository, npm and the MCP Registry are
 * faults, and which are the ordinary state of things.
 *
 * The registry is canonical: Glama, mcp.so and Smithery consume its data, so
 * whatever it says is what every marketplace tells people to install.
 * `publish-registry.sh` refuses to publish a listing that disagrees with the
 * package it points at — which protects the moment of publishing and nothing
 * else, because a listing goes stale by the repository moving on rather than by
 * anyone editing it.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

const load = (p: string): Promise<any> => import(p);
const { assessListing } = await load('../../scripts/lib/listing-drift.mjs');

describe('listing drift', () => {
  test('everything agreeing is silent', () => {
    const { problems } = assessListing({
      repo: '0.3.0', npmVersion: '0.3.0', registryVersions: ['0.2.0', '0.3.0'],
    });
    assert.deepEqual(problems, []);
  });

  /**
   * The registry keeps every version it has been told about, so listing an old
   * one alongside the current one is correct, not drift. Firing on "the first
   * entry is not the newest" would make this red for a healthy listing.
   */
  test('an old version listed alongside the current one is fine', () => {
    const { problems } = assessListing({
      repo: '0.3.0', npmVersion: '0.3.0', registryVersions: ['0.1.1', '0.2.0', '0.3.0'],
    });
    assert.deepEqual(problems, []);
  });

  /**
   * The failure this exists for, and the one that actually happened: npm ships
   * a version the registry has never heard of, so every marketplace sends
   * people to an older bridge and nothing says so.
   */
  test('a registry that has never heard of what npm installs is a fault', () => {
    const { problems } = assessListing({
      repo: '0.3.0', npmVersion: '0.2.1', registryVersions: ['0.1.1', '0.2.0'],
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /does not list ratchet-mcp@0\.2\.1/);
    assert.match(problems[0]!, /npm run publish:registry/,
      'the message must say how to fix it, not only that it is broken');
  });

  /**
   * npm behind the repository is NOT a fault. A merge lands the version bump; a
   * release publishes it. Treating that window as broken would leave this check
   * red for the ordinary state of the repository between the two, and a check
   * that is normally red is a check nobody reads.
   */
  test('npm behind the repository is noted, never failed', () => {
    const { problems, notes } = assessListing({
      repo: '0.4.0', npmVersion: '0.3.0', registryVersions: ['0.3.0'],
    });
    assert.deepEqual(problems, [], 'an unreleased version bump must not fail the check');
    assert.ok(notes.some((n: string) => /behind the repository/.test(n)),
      'it should still be said out loud');
  });

  test('an empty listing is a fault, not an absence of information', () => {
    const { problems } = assessListing({
      repo: '0.3.0', npmVersion: '0.3.0', registryVersions: [],
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /It knows nothing/);
  });

  /**
   * A source that could not be read is unknown, not healthy. Reporting "all
   * agree" because two of three answered is the same lie as a monitor that
   * reports zero lag from the one process that cannot see.
   */
  test('an unreachable source produces no verdict rather than a passing one', () => {
    const { problems } = assessListing({
      repo: '0.3.0', npmVersion: null, registryVersions: null,
    });
    assert.deepEqual(problems, [],
      'the fetch failure is reported by the caller; this must not invent a verdict');
  });
});
