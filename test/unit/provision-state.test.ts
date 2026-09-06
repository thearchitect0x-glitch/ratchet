// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * The three words `GET /workerz` publishes about keyless provisioning.
 *
 * The uptime probe branches on them and only one of them sends an email, so
 * the boundaries are a contract rather than a detail. They are asserted here
 * rather than through HTTP because what matters is where `elevated` starts and
 * where `at_ceiling` starts, and that is arithmetic.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { provisionState, PROVISION_WARN_FRACTION } from '../../src/domain/provisioning.js';

describe('provisioning pressure states', () => {
  const at = (thisHour: number, ceiling = 250) => provisionState({ thisHour, ceiling });

  test('an unused hour is ok', () => {
    assert.equal(at(0), 'ok');
  });

  /**
   * Inclusive on the way in, and this is the assertion that would catch a `>`
   * written where a `>=` belongs. One request either side of 200 is the entire
   * difference between hearing about this and not.
   */
  test('elevated begins exactly at the warning fraction', () => {
    assert.equal(at(199), 'ok');
    assert.equal(at(200), 'elevated');
    assert.equal(200, 250 * PROVISION_WARN_FRACTION);
  });

  test('at_ceiling begins exactly at the ceiling, and does not stop there', () => {
    assert.equal(at(249), 'elevated');
    assert.equal(at(250), 'at_ceiling');
    // Over-counting is deliberate: claimProvisionSlot spends the source slot
    // before the global one and never refunds it, so the count can pass the
    // ceiling. That must stay at_ceiling rather than falling off the end.
    assert.equal(at(9_999), 'at_ceiling');
  });

  /**
   * The ceiling is configurable, so the states must be computed from it rather
   * than from the default. A deployment that raised it to 1000 and still warned
   * at 200 would spend most of its life crying wolf.
   */
  test('the boundaries follow the configured ceiling, not the default', () => {
    assert.equal(at(200, 1000), 'ok');
    assert.equal(at(800, 1000), 'elevated');
    assert.equal(at(1000, 1000), 'at_ceiling');
  });

  /**
   * A ceiling of zero means keyless provisioning is switched off. Every request
   * is already being refused, so the honest word is at_ceiling — and 0 >= 0
   * gets there without a special case. Asserted because the alternative, `ok`,
   * would report a permanently closed door as healthy.
   */
  test('a ceiling of zero reads as closed, not as healthy', () => {
    assert.equal(at(0, 0), 'at_ceiling');
  });
});
