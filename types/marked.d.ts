// Manual type declaration for marked v2, which ships no bundled TypeScript types.
// Typed here so ChatPanel can call marked() to render agent markdown responses as HTML.
declare module "marked" {
  export default function marked(src: string): string;
}
