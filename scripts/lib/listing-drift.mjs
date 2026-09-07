// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * The comparison, separated from the fetching so it can be tested.
 *
 * Three numbers that are supposed to be one: what the repository says, what npm
 * installs, and what the MCP Registry tells every marketplace to install. The
 * interesting part is which disagreements are faults and which are normal, and
 * that is a judgement a network call cannot make.
 */

/**
 * @param {{repo: string, npmVersion?: string|null, registryVersions?: string[]|null}} state
 * @returns {{problems: string[], notes: string[]}}
 */
export function assessListing({ repo, npmVersion, registryVersions }) {
  const problems = [];
  const notes = [`repository   ${repo}`];

  if (npmVersion) notes.push(`npm          ${npmVersion}`);
  if (registryVersions) {
    notes.push(`registry     ${registryVersions.length ? registryVersions.join(', ') : '(no listing found)'}`);
  }

  /*
   * npm behind the repository is NOT a fault. A merge lands the version bump;
   * a release publishes it. That window is normal and firing on it would make
   * this check red for the ordinary state of the repository between the two.
   */
  if (npmVersion && npmVersion !== repo) {
    notes.push('npm is behind the repository — expected after a merge, before a release is cut');
  }

  /*
   * The registry keeps every version it has been told about, so the question is
   * whether it knows the one npm actually installs — not what it lists first,
   * and not whether it matches the repository, which it cannot until a release.
   */
  if (npmVersion && registryVersions) {
    if (!registryVersions.includes(npmVersion)) {
      problems.push(
        `the MCP registry does not list ratchet-mcp@${npmVersion}, which is what npm installs. `
        + `It knows ${registryVersions.length ? registryVersions.join(', ') : 'nothing'}. `
        + 'Every marketplace that reads the registry is telling people to install a version '
        + 'that is not current. Fix: npm run publish:registry');
    }
  }

  return { problems, notes };
}
