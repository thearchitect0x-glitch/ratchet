// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Keep credentials out of the output.
 *
 * This runs on a schedule, in CI, holding a live vendor credential — and
 * vendors echo the key back in their own error messages. Stripe answers a bad
 * key with `Invalid API Key provided: sk_test_...`, and passing that through
 * verbatim writes it into a build log that is often more widely readable than
 * the secret store the key came from.
 *
 * Nothing here is clever. It is the difference between a tool that is safe to
 * put in someone's CI and one that quietly widens the blast radius of the
 * credential it was given.
 */

/*
 * Credential-shaped prefixes, and deliberately NOT `rtk_`.
 *
 * The rtk_ keys are the subject of the report — they are what the vendor
 * recorded and what Ratchet is asked about, and an ungated one is the finding
 * the operator has to act on. Redacting those would produce a tool that reports
 * a problem and refuses to say which one.
 */
const SECRETISH = /\b((?:sk|rk|pk|whsec|re|tsec|tid|cfat|ghp|gho|ghs|shpat|xoxb|xoxp|SG)_[A-Za-z0-9_-]{4,}|github_pat_[A-Za-z0-9_]{10,}|AKIA[0-9A-Z]{12,})/g;

/** Replace anything credential-shaped with its prefix and a length. */
export function redact(text) {
  if (typeof text !== 'string') return text;
  return text.replace(SECRETISH, (m) => {
    const cut = m.indexOf('_');
    const prefix = cut === -1 ? m.slice(0, 4) : m.slice(0, cut + 1);
    return `${prefix}[redacted ${m.length} chars]`;
  });
}

/**
 * Also strip the credential we were handed, whatever shape it is.
 *
 * The pattern above catches the well-known prefixes. A vendor with an
 * unrecognised key format would sail straight through it, and we always know
 * our own credential — so remove that exactly, as well as by pattern.
 */
export function redactWith(text, ...secrets) {
  let out = redact(text);
  for (const s of secrets) {
    if (typeof s === 'string' && s.length >= 8) {
      out = out.split(s).join(`[redacted ${s.length} chars]`);
    }
  }
  return out;
}
