/**
 * Numeric inputs accept exponent signs and other temporary invalid states. Workspace limits do not,
 * so keep the draft deliberately narrower: blank while editing, or a bounded positive integer.
 */
export function isBoundedIntegerDraft(value: string, minimum: number, maximum: number): boolean {
  if (value === "") return true;
  if (!/^[1-9]\d*$/.test(value)) return false;

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum;
}
