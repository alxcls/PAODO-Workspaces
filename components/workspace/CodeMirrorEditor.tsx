// CodeMirror 6 editor used by FileViewer for the source/editing view. CodeMirror virtualises its
// own viewport and highlights incrementally (Lezer), so huge files (10k+ lines) open, scroll, and
// edit cheaply — replacing the previous hand-rolled textarea + highlight overlay. Theme + syntax
// colours are tuned to match the app's GitHub-light palette (app/globals.css).
"use client";

import { useMemo } from "react";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { Prec } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { StreamLanguage, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { json } from "@codemirror/lang-json";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { markdown } from "@codemirror/lang-markdown";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { rust } from "@codemirror/lang-rust";
import { sql } from "@codemirror/lang-sql";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
import { c, cpp, java, csharp, scala, kotlin } from "@codemirror/legacy-modes/mode/clike";
import { go } from "@codemirror/legacy-modes/mode/go";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { r } from "@codemirror/legacy-modes/mode/r";
import { perl } from "@codemirror/legacy-modes/mode/perl";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { clojure } from "@codemirror/legacy-modes/mode/clojure";
import { haskell } from "@codemirror/legacy-modes/mode/haskell";
import { erlang } from "@codemirror/legacy-modes/mode/erlang";
import { elm } from "@codemirror/legacy-modes/mode/elm";
import { groovy } from "@codemirror/legacy-modes/mode/groovy";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { diff } from "@codemirror/legacy-modes/mode/diff";

// Suffixes that wrap another file (e.g. config.json.template, .env.example) — we look past them
// to highlight based on the real extension underneath.
const WRAPPER_EXTS = new Set(["template", "tmpl", "example", "sample", "dist", "bak", "orig", "in"]);

// Map a file extension to its CodeMirror language extension. Unlisted types get no language
// (plain text, still fully editable).
function languageFor(filePath: string): Extension[] {
  const parts = filePath.toLowerCase().split(".");
  let ext = parts.pop() ?? "";
  // `foo.json.template` -> highlight as json; `.env.example` -> use "env" (no lang, still fine).
  if (WRAPPER_EXTS.has(ext) && parts.length > 1) ext = parts.pop() ?? "";
  switch (ext) {
    case "json":
      return [json()];
    case "js":
    case "jsx":
    case "cjs":
    case "mjs":
      return [javascript({ jsx: true })];
    case "ts":
      return [javascript({ typescript: true })];
    case "tsx":
      return [javascript({ typescript: true, jsx: true })];
    case "py":
      return [python()];
    case "html":
    case "htm":
      return [html()];
    case "svg":
    case "xml":
      return [xml()];
    case "css":
      return [css()];
    case "md":
    case "markdown":
      return [markdown()];
    case "yml":
    case "yaml":
      return [yaml()];
    case "rs":
      return [rust()];
    case "sql":
      return [sql()];
    case "scss":
    case "less":
      return [css()];
    case "sh":
    case "bash":
    case "zsh":
      return [StreamLanguage.define(shell)];
    case "rb":
      return [StreamLanguage.define(ruby)];
    case "toml":
      return [StreamLanguage.define(toml)];
    case "ps1":
      return [StreamLanguage.define(powerShell)];
    case "c":
    case "h":
      return [StreamLanguage.define(c)];
    case "cpp":
    case "cc":
    case "cxx":
    case "hpp":
    case "hh":
    case "hxx":
      return [StreamLanguage.define(cpp)];
    case "java":
      return [StreamLanguage.define(java)];
    case "cs":
      return [StreamLanguage.define(csharp)];
    case "scala":
    case "sc":
      return [StreamLanguage.define(scala)];
    case "kt":
    case "kts":
      return [StreamLanguage.define(kotlin)];
    case "go":
      return [StreamLanguage.define(go)];
    case "lua":
      return [StreamLanguage.define(lua)];
    case "r":
      return [StreamLanguage.define(r)];
    case "pl":
    case "pm":
      return [StreamLanguage.define(perl)];
    case "swift":
      return [StreamLanguage.define(swift)];
    case "clj":
    case "cljs":
    case "cljc":
    case "edn":
      return [StreamLanguage.define(clojure)];
    case "hs":
      return [StreamLanguage.define(haskell)];
    case "erl":
    case "hrl":
      return [StreamLanguage.define(erlang)];
    case "elm":
      return [StreamLanguage.define(elm)];
    case "groovy":
    case "gradle":
      return [StreamLanguage.define(groovy)];
    case "dockerfile":
      return [StreamLanguage.define(dockerFile)];
    case "ini":
    case "conf":
    case "cfg":
    case "env":
    case "properties":
      return [StreamLanguage.define(properties)];
    case "diff":
    case "patch":
      return [StreamLanguage.define(diff)];
    default:
      return [];
  }
}

// Editor chrome — pulls from the app's CSS variables so it tracks the workspace theme.
const editorTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "12px", backgroundColor: "var(--color-bg-tint)", color: "var(--color-text)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.5" },
  ".cm-content": { padding: "12px 0", caretColor: "var(--color-text)" },
  ".cm-gutters": { backgroundColor: "var(--color-bg-tint)", color: "var(--color-text-3)", border: "none" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 16px" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--color-primary) 5%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--color-text-2)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--color-text)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "var(--color-primary-soft)",
  },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--color-select) 18%, transparent)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--color-bg-deep)", border: "none", color: "var(--color-text-3)" },
});

// GitHub-light syntax colours (mirrors GitHub's light code theme) to fit the app's light palette.
const githubLight = HighlightStyle.define([
  // Keywords and the literal constants true/false/null share GitHub's red.
  { tag: [t.keyword, t.moduleKeyword, t.controlKeyword, t.operatorKeyword, t.bool, t.null], color: "#d73a49" },
  { tag: [t.string, t.special(t.string), t.character, t.regexp], color: "#032f62" },
  { tag: t.escape, color: "#22863a" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "#6a737d", fontStyle: "italic" },
  // Numbers plus named/builtin constants (e.g. None, NaN, PI).
  { tag: [t.number, t.atom, t.constant(t.variableName), t.standard(t.name)], color: "#005cc5" },
  // Object keys / property names in purple so JSON keys stand out from their (navy) string values.
  { tag: [t.propertyName, t.function(t.propertyName)], color: "#6f42c1" },
  // Function and method names.
  { tag: [t.function(t.variableName), t.macroName], color: "#6f42c1" },
  // Types, classes and namespaces get their own orange so they don't blur into functions/keys.
  { tag: [t.typeName, t.className, t.namespace, t.definition(t.typeName)], color: "#e36209" },
  { tag: t.tagName, color: "#22863a" },
  // HTML/JSX attributes and decorators/annotations.
  { tag: [t.attributeName, t.annotation], color: "#6f42c1" },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: "#24292e" },
  { tag: [t.variableName, t.definition(t.variableName), t.labelName], color: "#24292e" },
  { tag: [t.meta, t.documentMeta], color: "#6a737d" },
  { tag: [t.link, t.url], color: "#032f62", textDecoration: "underline" },
  { tag: t.heading, color: "#005cc5", fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.invalid, color: "#cb2431" },
]);

interface Props {
  value: string;
  onChange: (value: string) => void;
  filePath: string;
}

export default function CodeMirrorEditor({ value, onChange, filePath }: Props) {
  const extensions = useMemo(
    () => [...languageFor(filePath), Prec.highest(syntaxHighlighting(githubLight))],
    [filePath],
  );

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      extensions={extensions}
      theme={editorTheme}
      height="100%"
      style={{ flex: 1, height: "100%", overflow: "hidden" }}
      basicSetup={{ foldGutter: true, highlightActiveLine: true, autocompletion: false }}
    />
  );
}
