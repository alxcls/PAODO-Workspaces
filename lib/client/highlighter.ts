// Re-exports the highlight.js instance used by FileViewer for syntax highlighting.
// Centralised here so the heavy hljs bundle is only imported from one place.

import hljs from "highlight.js";
export default hljs;
