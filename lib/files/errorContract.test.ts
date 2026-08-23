// The file surface is the newest part of the public API and the one an external client reaches first,
// so this is a source-level guard on how it is allowed to fail.
//
// Every file failure used to be `NextResponse.json({ error: err.message }, { status: 400 })`. That has
// two costs a behavioural test cannot see the shape of. A program gets nothing to branch on — a full
// disk, a permission failure and a malformed request all read as INVALID_REQUEST — and `err.message`
// is written by libuv, which appends the host path it failed on, so the response leaks the server's
// directory layout on a surface whose whole point is that the layout is private.
//
// Both rules below exist because that pattern is easy to reintroduce: the fix reads as more work than
// the mistake, and nothing about a new `NextResponse.json({ error })` call looks wrong on its own.
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import ts from "typescript";

const ROOT = path.resolve(__dirname, "../..");

/** The file surface: everything that serves, writes, moves, archives or lists workspace files. */
const SCANNED = [
  "lib/files",
  "lib/uploads",
  "lib/operations/files",
  "lib/api/fileContentRoutes.ts",
  "lib/api/fileTreeRoutes.ts",
  "lib/api/fileTransferRoutes.ts",
  "app/api/workspaces/[id]/files",
  "app/api/drives/[id]/files",
];

function scannedFiles(): string[] {
  const files: string[] = [];
  const visit = (target: string) => {
    const stat = fs.statSync(target);
    if (!stat.isDirectory()) {
      if (target.endsWith(".ts") && !target.endsWith(".test.ts")) files.push(target);
      return;
    }
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      visit(path.join(target, entry.name));
    }
  };
  for (const entry of SCANNED) visit(path.join(ROOT, entry));
  return files;
}

function eachNextResponseJson(
  onCall: (call: ts.CallExpression, source: ts.SourceFile, location: string) => void,
): void {
  for (const file of scannedFiles()) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf-8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText(source) === "NextResponse" &&
        node.expression.name.text === "json"
      ) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        onCall(node, source, `${path.relative(ROOT, file)}:${line}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}

describe("file error contract", () => {
  // The status has to be derived from the code, in one place (STATUS_BY_CODE), or the two drift: this is
  // how a disk-full answer ended up as a 507 that no code named, and a lost save as a 409 with none.
  it("never sets a failure status directly — errorResponse maps code to status", () => {
    const violations: string[] = [];

    eachNextResponseJson((call, source, location) => {
      const init = call.arguments[1];
      if (!init || !ts.isObjectLiteralExpression(init)) return;
      for (const property of init.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        if (property.name.getText(source).replace(/["']/g, "") !== "status") continue;
        const status = Number(property.initializer.getText(source));
        if (Number.isFinite(status) && status >= 400) {
          violations.push(`${location} returns status ${status} directly — use errorResponse(code, ...)`);
        }
      }
    });

    expect(violations).toEqual([]);
  });

  // `error` without `code` is the shape that gives a program nothing to act on. A response may still
  // carry `error` beside a `code` — the batch move's partial-success body does — which is why this
  // checks for the pairing rather than banning the field.
  it("never returns an error field without a code beside it", () => {
    const violations: string[] = [];

    eachNextResponseJson((call, source, location) => {
      const body = call.arguments[0];
      if (!body || !ts.isObjectLiteralExpression(body)) return;
      const named = new Set(
        body.properties
          .filter((p): p is ts.PropertyAssignment | ts.ShorthandPropertyAssignment => Boolean(p.name))
          .map((p) => p.name!.getText(source).replace(/["']/g, "")),
      );
      if (named.has("error") && !named.has("code")) {
        violations.push(`${location} returns a bare { error } body — use errorResponse(code, message)`);
      }
    });

    expect(violations).toEqual([]);
  });

  // The third thing worth pinning — that a failure message never carries the host path libuv writes
  // into err.message — is deliberately NOT a source rule. A first attempt scanned for `err.message`
  // and flagged four sites that read the message of an error already narrowed to AppError, which is a
  // message we authored and meant to publish. Source text cannot tell those apart from a raw errno,
  // so the guard is behavioural instead: lib/operations/files/errors.test.ts provokes real errnos and
  // asserts the resulting message names only the caller's own relative path.
});
