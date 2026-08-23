// The vocabulary of connection ids, in one place: a prefix minted in one module and recognised in
// another is two spellings waiting to disagree.
//
// A connection id says which graph it belongs to, because everything else in a connection is a UUID
// too. One listed link prints three of them — the link's, the workspace's, the drive's — and an
// unprefixed id is one a caller can only tell apart by remembering where it read it. Prefixed, a
// wrong one is refused where it is typed, by name, instead of coming back as a lookup that found
// nothing.
const PREFIX = {
  link: "link_",
  call: "call_",
} as const;

/** `link` is a drive↔workspace link; `call` is a one-way agent call between workspaces. */
export type ConnectionKind = keyof typeof PREFIX;

const KINDS = Object.keys(PREFIX) as ConnectionKind[];

export function mintConnectionId(kind: ConnectionKind): string {
  return `${PREFIX[kind]}${crypto.randomUUID()}`;
}

/** The graph an id belongs to, or null for anything that is not a connection id — a bare prefix
 *  included, since it names a kind without naming a connection. */
export function connectionKind(id: string): ConnectionKind | null {
  return KINDS.find((kind) => id.startsWith(PREFIX[kind]) && id.length > PREFIX[kind].length) ?? null;
}
