import { randomInt } from "node:crypto";

/**
 * Every caller of these helpers produces a bearer secret — OTP codes (merchant
 * and admin) and payment-link tokens, which are the only thing standing
 * between the public and a payable link. They must be unpredictable, so they
 * come from the CSPRNG (`crypto.randomInt`, unbiased). `Math.random` is a
 * seeded PRNG whose output can be recovered from a handful of samples; a DB
 * uniqueness constraint stops collisions, not guessing.
 */

/** Generates a string of `n` random decimal digits (e.g. "042817"). */
export function randomDigits(n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) {
    out += String(randomInt(10));
  }
  return out;
}

/** Generates a string of `n` characters drawn uniformly from `alphabet`. */
export function randomFromAlphabet(alphabet: string, n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) {
    out += alphabet[randomInt(alphabet.length)];
  }
  return out;
}

/** Short display-only reference for receipts and logs (e.g. "FP-A7K2M3"). */
export function displayReference(): string {
  return `FP-${randomFromAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 6)}`;
}
