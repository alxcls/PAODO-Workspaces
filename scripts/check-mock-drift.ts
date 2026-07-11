// Flags "dead test code" caused by vi.mock factories drifting from the real module they stub.
//
// The failure mode: `vi.mock("./x", () => ({ foo, bar }))` returns a hand-written module shape that
// TypeScript never checks against the real ./x. When ./x renames or removes `foo`, the mock keeps
// exporting a stale `foo`, the test still passes, and the assertions no longer exercise real code —
// silent rot. This script parses every *.test.ts, extracts each mock factory's exported keys, and
// diffs them against the real module's actual exports (via the TS type checker). A key the mock
// provides that the module no longer exports is a stale mock → reported. Exits non-zero if any found,
// so it can gate CI.
//
// Run:  npx tsx scripts/check-mock-drift.ts

import * as ts from "typescript";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..");

function loadProgram(): ts.Program {
  const configPath = ts.findConfigFile(ROOT, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) throw new Error("tsconfig.json not found");
  const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, path.dirname(configPath));
  return ts.createProgram(parsed.fileNames, parsed.options);
}

// Collect the property names a mock factory's returned object literal defines, plus whether it
// spreads another object (e.g. ...(await vi.importActual(...))) — a spread means unknown keys may be
// intentional passthrough, so we downgrade those findings to a warning.
interface MockShape {
  keys: string[];
  hasSpread: boolean;
}

function objectLiteralShape(obj: ts.ObjectLiteralExpression): MockShape {
  const keys: string[] = [];
  let hasSpread = false;
  for (const prop of obj.properties) {
    if (ts.isSpreadAssignment(prop)) { hasSpread = true; continue; }
    const name = prop.name;
    if (name && (ts.isIdentifier(name) || ts.isStringLiteral(name))) keys.push(name.text);
  }
  return { keys, hasSpread };
}

// The factory is arg[1] of vi.mock. Pull the object literal it returns, whether the body is a
// concise `() => ({...})` or a block `() => { return {...} }` (incl. `async` variants).
function factoryReturnObject(factory: ts.Expression): ts.ObjectLiteralExpression | null {
  if (!ts.isArrowFunction(factory) && !ts.isFunctionExpression(factory)) return null;
  const body = factory.body;
  if (ts.isParenthesizedExpression(body) && ts.isObjectLiteralExpression(body.expression)) return body.expression;
  if (ts.isObjectLiteralExpression(body)) return body;
  if (ts.isBlock(body)) {
    for (const stmt of body.statements) {
      if (ts.isReturnStatement(stmt) && stmt.expression) {
        const e = stmt.expression;
        if (ts.isParenthesizedExpression(e) && ts.isObjectLiteralExpression(e.expression)) return e.expression;
        if (ts.isObjectLiteralExpression(e)) return e;
      }
    }
  }
  return null;
}

interface Finding {
  testFile: string;
  line: number;
  specifier: string;
  staleKeys: string[];
  hasSpread: boolean;
  realExports: string[];
}

function run(): number {
  const program = loadProgram();
  const checker = program.getTypeChecker();
  const findings: Finding[] = [];

  for (const sf of program.getSourceFiles()) {
    if (sf.fileName.includes("node_modules")) continue;
    if (!sf.fileName.endsWith(".test.ts") && !sf.fileName.endsWith(".test.tsx")) continue;

    const visit = (node: ts.Node) => {
      // Match `vi.mock("specifier", factory)`.
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "vi" &&
        node.expression.name.text === "mock" &&
        node.arguments.length >= 2 &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        const specifier = node.arguments[0].text;
        const obj = factoryReturnObject(node.arguments[1]);
        if (obj) {
          // Resolve the specifier to the real source file (handles @/ alias + relative paths).
          const resolved = ts.resolveModuleName(
            specifier, sf.fileName, program.getCompilerOptions(), ts.sys,
          ).resolvedModule;
          // Only diff project modules; a stub of `fs` or another dependency has no local source to
          // compare against and isn't the drift class we care about.
          if (resolved && !resolved.resolvedFileName.includes("node_modules")) {
            const target = program.getSourceFile(resolved.resolvedFileName);
            const moduleSymbol = target && checker.getSymbolAtLocation(target);
            if (moduleSymbol) {
              const realExports = checker.getExportsOfModule(moduleSymbol).map((s) => s.getName());
              const realSet = new Set(realExports);
              const { keys, hasSpread } = objectLiteralShape(obj);
              const staleKeys = keys.filter((k) => !realSet.has(k));
              if (staleKeys.length > 0) {
                const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
                findings.push({
                  testFile: path.relative(ROOT, sf.fileName),
                  line: line + 1,
                  specifier, staleKeys, hasSpread, realExports,
                });
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  if (findings.length === 0) {
    console.log("✓ No stale mock exports found — every vi.mock factory matches its real module.");
    return 0;
  }

  console.log(`✗ ${findings.length} stale mock(s) found:\n`);
  let hardErrors = 0;
  for (const f of findings) {
    const tag = f.hasSpread ? "WARN (factory also spreads a module)" : "STALE";
    if (!f.hasSpread) hardErrors++;
    console.log(`  [${tag}] ${f.testFile}:${f.line}`);
    console.log(`    mocks "${f.specifier}" but it no longer exports: ${f.staleKeys.join(", ")}`);
    console.log(`    real exports: ${f.realExports.join(", ") || "(none)"}\n`);
  }
  // Spread-based factories are advisory only; a clean key mismatch fails the check.
  return hardErrors > 0 ? 1 : 0;
}

process.exit(run());
