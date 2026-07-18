import fs from "node:fs";
import path from "node:path";
import prettier from "prettier";
import ts from "typescript";

const ROOT = process.cwd();
const OUTPUT = path.join(ROOT, "log-inventory.json");
const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
const RETENTIONS = [
  "browser-only",
  "development-only",
  "docker-only",
  "durable-operational",
  "durable-security",
] as const;
type Level = (typeof LEVELS)[number];
type Channel = "operational" | "audit";
type Retention = (typeof RETENTIONS)[number];

type LoggerMeta = {
  context: string | null;
  channel: Channel;
  bindings: string[];
};

type Entry = {
  file: string;
  logger: "pino" | "console";
  channel: Channel | "browser-console" | "process-console";
  receiver: string;
  context: string | null;
  message: string | null;
  messageExpression?: string;
  fields: string[];
  bindings: string[];
  fieldsExpression?: string;
  retention: Retention;
};

function sourceFiles(): string[] {
  const roots = [
    "app",
    "components",
    "lib",
    "server.ts",
    "proxyEntry.ts",
    "instrumentation.ts",
    "instrumentation.node.ts",
  ];
  const out: string[] = [];
  const walk = (target: string) => {
    const absolute = path.join(ROOT, target);
    const stat = fs.statSync(absolute);
    if (stat.isFile()) {
      if (/\.tsx?$/.test(target) && !/\.(test|spec)\.tsx?$/.test(target)) out.push(absolute);
      return;
    }
    for (const item of fs.readdirSync(absolute, { withFileTypes: true })) {
      const relative = path.join(target, item.name);
      if (item.isDirectory()) walk(relative);
      else if (/\.tsx?$/.test(item.name) && !/\.(test|spec)\.tsx?$/.test(item.name))
        out.push(path.join(ROOT, relative));
    }
  };
  for (const root of roots) walk(root);
  return out.sort();
}

function staticText(node: ts.Node | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((span) => `\${…}${span.literal.text}`).join("");
  }
  return null;
}

function objectKeys(node: ts.Node | undefined): string[] {
  if (!node || !ts.isObjectLiteralExpression(node)) return [];
  return node.properties.map((property) => {
    if (ts.isSpreadAssignment(property)) return `...${property.expression.getText()}`;
    if (ts.isShorthandPropertyAssignment(property)) return property.name.getText();
    if ("name" in property && property.name) return property.name.getText().replace(/^['"]|['"]$/g, "");
    return property.getText();
  });
}

const grouped: Record<Level, Entry[]> = {
  trace: [],
  debug: [],
  info: [],
  warn: [],
  error: [],
  fatal: [],
};

for (const absolute of sourceFiles()) {
  const source = ts.createSourceFile(absolute, fs.readFileSync(absolute, "utf8"), ts.ScriptTarget.Latest, true);
  const relative = path.relative(ROOT, absolute);
  const loggerMetadata = new Map<string, LoggerMeta>();

  const metadataFromExpression = (node: ts.Expression): LoggerMeta | undefined => {
    if (ts.isIdentifier(node)) return loggerMetadata.get(node.text);
    if (ts.isPropertyAccessExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ThisKeyword) return loggerMetadata.get(`this.${node.name.text}`);
      return metadataFromExpression(node.expression);
    }
    if (!ts.isCallExpression(node)) return undefined;
    const factory = node.expression.getText();
    if (factory.endsWith("createLogger") || factory.endsWith("createAuditLogger")) {
      return {
        context: staticText(node.arguments[0]),
        channel: factory.endsWith("createAuditLogger") ? "audit" : "operational",
        bindings: [],
      };
    }
    if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "child") {
      const parent = metadataFromExpression(node.expression.expression);
      if (!parent) return undefined;
      return { ...parent, bindings: [...parent.bindings, ...objectKeys(node.arguments[0])] };
    }
    return undefined;
  };

  // Resolve the common `const log = createLogger("context")` and `const wlog = log.child(...)`
  // patterns. Contexts supplied through parameters remain null rather than being guessed.
  const collectContexts = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const metadata = metadataFromExpression(node.initializer);
      if (metadata) loggerMetadata.set(node.name.text, metadata);
    }
    if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const metadata = metadataFromExpression(node.initializer);
      if (metadata) loggerMetadata.set(`this.${node.name.text}`, metadata);
    }
    ts.forEachChild(node, collectContexts);
  };
  collectContexts(source);

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const callee = node.expression;
      const receiver = callee.expression.getText();
      const method = callee.name.text;
      const isConsole = receiver === "console" && ["debug", "info", "log", "warn", "error"].includes(method);
      const metadata = metadataFromExpression(callee.expression);
      // Parameter-injected Pino loggers cannot always be resolved without executing the program.
      // Accept conventional exact receiver names, but avoid the previous broad /log/i heuristic
      // that could classify unrelated objects such as `dialog.error()` as Pino.
      const conventionalLogger = /(^|\.)(?:log|wlog|elog|audit)$/.test(receiver);
      const isPino = LEVELS.includes(method as Level) && (metadata !== undefined || conventionalLogger);

      if (isConsole || isPino) {
        const level = (isConsole && method === "log" ? "info" : method) as Level;
        const first = node.arguments[0];
        const firstIsMessage = isConsole || staticText(first) !== null;
        const messageNode = firstIsMessage ? first : node.arguments[1];
        const fieldsNode = !isConsole && !firstIsMessage ? first : undefined;
        const message = staticText(messageNode);
        const context = !isConsole ? (metadata?.context ?? null) : null;
        const channel = isConsole
          ? relative.startsWith("components/") || relative.startsWith("app/")
            ? "browser-console"
            : "process-console"
          : (metadata?.channel ?? "operational");
        const retention: Retention =
          channel === "browser-console"
            ? "browser-only"
            : channel === "audit" && ["trace", "debug"].includes(level)
              ? "development-only"
              : channel === "audit" && !["trace", "debug"].includes(level)
                ? "durable-security"
                : channel === "operational" && ["warn", "error", "fatal"].includes(level)
                  ? "durable-operational"
                  : "docker-only";

        const entry: Entry = {
          file: relative,
          logger: isConsole ? "console" : "pino",
          channel,
          receiver,
          context,
          message,
          fields: objectKeys(fieldsNode),
          bindings: metadata?.bindings ?? [],
          retention,
        };
        if (!message && messageNode) entry.messageExpression = messageNode.getText();
        if (fieldsNode && !ts.isObjectLiteralExpression(fieldsNode)) entry.fieldsExpression = fieldsNode.getText();
        grouped[level].push(entry);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

// Line numbers are deliberately not recorded so the local inventory does not churn on unrelated
// edits that only shift a call site. Entries are collected in sorted-file, source order, and
// Array#sort is stable, so repeated local generations stay deterministic.
for (const level of LEVELS) grouped[level].sort((a, b) => a.file.localeCompare(b.file));

const counts = Object.fromEntries(LEVELS.map((level) => [level, grouped[level].length])) as Record<Level, number>;
const entries = LEVELS.flatMap((level) => grouped[level]);
const output = {
  $comment:
    "Generated local inventory of runtime log call sites. Counts describe static call sites, not the number of events written. Regenerate with `npm run logs:inventory`; this file is intentionally gitignored.",
  policy: {
    operational: {
      purpose: "Routine application activity and failures emitted through createLogger.",
      dockerStdoutMinLevel: "LOG_LEVEL (info by default in production)",
      durableMinLevel: "warn",
      durableDestination: "OPERATIONAL_LOG_FILE (app.log or credproxy.log in Compose)",
    },
    securityAudit: {
      purpose: "Authentication, authorization, and credential-lifecycle events emitted through createAuditLogger.",
      dockerStdoutMinLevel: "info",
      durableMinLevel: "info",
      durableDestination: "SECURITY_LOG_FILE (security.log in Compose)",
    },
    dockerStdoutRetention: "json-file rotation capped at 10 MB x 5 files per service",
    durableFileRetention: "checked every 15 minutes; rotate daily or above 50 MB; retain 14 compressed files",
    retentionLabels: {
      "browser-only": "Visible only in the browser developer console.",
      "development-only": "Emitted only outside production; it has no production retention.",
      "docker-only": "Written to process stdout/stderr when its level is enabled; retained only by Docker rotation.",
      "durable-operational": "Written to Docker output and the configured durable operational file.",
      "durable-security": "Written to Docker output and the configured durable security audit file.",
    },
  },
  summary: {
    totalCallSites: entries.length,
    pinoCallSites: entries.filter((entry) => entry.logger === "pino").length,
    consoleCallSites: entries.filter((entry) => entry.logger === "console").length,
    durableCallSites: entries.filter((entry) => entry.retention.startsWith("durable-")).length,
    durableOperationalCallSites: entries.filter((entry) => entry.retention === "durable-operational").length,
    durableSecurityAuditCallSites: entries.filter((entry) => entry.retention === "durable-security").length,
    byLevel: counts,
    byRetention: Object.fromEntries(
      RETENTIONS.map((retention) => [retention, entries.filter((entry) => entry.retention === retention).length]),
    ),
  },
  levels: grouped,
};

prettier
  .format(JSON.stringify(output), { parser: "json", printWidth: 120 })
  .then((serialized) => {
    fs.writeFileSync(OUTPUT, serialized);
    console.log(`Wrote ${path.relative(ROOT, OUTPUT)} with ${output.summary.totalCallSites} log call sites.`);
  })
  .catch((err: unknown) => {
    console.error("Failed to format log inventory", err);
    process.exitCode = 1;
  });
