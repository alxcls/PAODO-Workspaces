// A rejection audited by server.ts's auditRejection sets `audited = true`, which suppresses the
// http_request access line that would otherwise have carried the method and pathname. So the audit
// record is the ONLY place a denied request's route is ever written down, and any call site that
// omits those fields produces a log line an operator cannot act on: auth_unauthorized used to read
// {ip, requestId} only, so 40 refused platform tokens named no route at all.
//
// Source-level rather than behavioral because server.ts binds a live listener at import time.
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import ts from "typescript";

const SERVER = path.resolve(__dirname, "../../server.ts");
const REQUIRED_FIELDS = ["method", "pathname"];

/** Field names in the bindings object literal passed as auditRejection's second argument. */
function bindingNames(object: ts.ObjectLiteralExpression, source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
      const name = property.name?.getText(source).replace(/["']/g, "");
      if (name) names.add(name);
    }
  }
  return names;
}

describe("auditRejection contract", () => {
  it("names the method and pathname on every rejection audit in server.ts", () => {
    const source = ts.createSourceFile(SERVER, fs.readFileSync(SERVER, "utf-8"), ts.ScriptTarget.Latest, true);
    const violations: string[] = [];
    let callSites = 0;

    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "auditRejection") {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        const location = `server.ts:${line}`;
        const bindings = node.arguments[1];
        if (!bindings || !ts.isObjectLiteralExpression(bindings)) {
          violations.push(`${location} must pass an object literal of audit fields`);
        } else {
          callSites++;
          const names = bindingNames(bindings, source);
          for (const field of REQUIRED_FIELDS) {
            if (!names.has(field)) violations.push(`${location} omits "${field}"`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);

    expect(violations).toEqual([]);
    // Guards against the definition being renamed out from under this test, which would leave it
    // scanning for a call site that no longer exists and passing vacuously.
    expect(callSites).toBeGreaterThanOrEqual(4);
  });
});
