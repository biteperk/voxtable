/**
 * ABN (Australian Business Number) checksum validation — the ATO's published
 * modulus-89 algorithm: subtract 1 from the first digit, multiply each digit
 * by its weight, and the sum must divide evenly by 89. Catches typos and
 * made-up numbers; it does NOT verify the ABN is registered or belongs to the
 * named entity (that's the ABR lookup, out of scope here).
 */

const ABN_WEIGHTS = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19] as const;

export function isValidAbn(input: string): boolean {
  const digits = input.replace(/\s+/g, "");
  if (!/^\d{11}$/.test(digits)) return false;

  let sum = 0;
  for (let i = 0; i < ABN_WEIGHTS.length; i += 1) {
    const digit = digits.charCodeAt(i) - 48 - (i === 0 ? 1 : 0);
    sum += digit * ABN_WEIGHTS[i]!;
  }
  return sum % 89 === 0;
}
