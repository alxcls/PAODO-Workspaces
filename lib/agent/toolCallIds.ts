// Mistral rejects replayed tool-call ids unless they are exactly 9 alphanumeric characters.
// The provider adapter owns history translation; this module only validates and mints individual ids.

const MISTRAL_TOOL_CALL_ID = /^[A-Za-z0-9]{9}$/;
const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export function isMistralToolCallId(id: string): boolean {
  return MISTRAL_TOOL_CALL_ID.test(id);
}

export function newMistralToolCallId(taken: Set<string> = new Set()): string {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(9));
    let id = "";
    for (const byte of bytes) id += ALPHABET[byte % ALPHABET.length];
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
}
