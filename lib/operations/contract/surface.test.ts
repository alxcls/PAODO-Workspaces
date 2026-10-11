// The surface a separately shipped client is written against: every route its token may call, and the
// shape of the contract it reads. A client cannot see this repo, so the version number is its only warning.
import { expect, it } from "vitest";
import { PLATFORM_CONTRACT_VERSION, platformRouteRules } from "@/lib/infra/security/platformAccessPolicy";
import { getPlatformContract } from "./fields";

/** Two levels of keys: enough to catch a removed field, setting or section without pinning any wording. */
function shape(value: object): Record<string, string[] | Record<string, string[]>> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, section]) => section !== null && typeof section === "object")
      .map(([name, section]) => {
        const entries = Object.entries(section as object);
        const nested = entries.every(([, item]) => item !== null && typeof item === "object" && !Array.isArray(item));
        return [
          name,
          nested ? Object.fromEntries(entries.map(([key, item]) => [key, Object.keys(item)])) : Object.keys(section),
        ];
      }),
  );
}

/**
 * When this fails, decide which change it is before touching the snapshot. Something added — a route,
 * a field, a limit: update the snapshot and nothing else. Something removed, renamed, or answering in
 * a shape an existing client would misread: raise PLATFORM_CONTRACT_VERSION too, in the same commit.
 */
it("pins the platform routes and the contract's shape to the contract version", () => {
  expect({
    version: PLATFORM_CONTRACT_VERSION,
    routes: platformRouteRules(),
    contract: shape(getPlatformContract()),
  }).toMatchInlineSnapshot(`
    {
      "contract": {
        "channels": [
          "api",
          "mcp",
        ],
        "describe": {
          "call": [
            "input",
            "output",
          ],
          "callSummary": [
            "callId",
            "timestamp",
            "tool",
            "status",
            "inputChars",
            "outputChars",
            "running",
          ],
          "connection": [
            "pairs",
            "agentCalls",
            "driveLinks",
            "idempotent",
            "connectionId",
          ],
          "conversation": [
            "id",
            "title",
            "lastMessageAt",
            "running",
          ],
          "drive": [
            "unique",
          ],
          "key": [
            "workspaceApiKey",
            "workspaceMcpKey",
            "workspaceApiAccess",
            "workspaceApiHasKey",
            "workspaceMcpAccess",
            "workspaceMcpHasKey",
            "internetAccess",
            "usable",
          ],
          "schedule": [
            "lastRun",
            "times",
            "timing",
          ],
          "session": [
            "error",
            "origin",
            "models",
            "inputTokensUncached",
            "inputTokensCacheRead",
            "outputTokensTotal",
            "callCount",
            "costByCurrency",
            "userInput",
            "agentResponse",
          ],
          "sessionSummary": [
            "sessionId",
            "startedAt",
            "status",
            "userInput",
            "agentResponse",
            "userInputChars",
            "agentResponseChars",
            "not listed",
          ],
        },
        "fields": {
          "drive": [
            "name",
            "description",
          ],
          "schedule": [
            "prompt",
            "intervalValue",
            "intervalUnit",
            "startAt",
            "endAt",
            "timezone",
            "enabled",
          ],
          "workspace": [
            "name",
            "description",
            "llmProvider",
            "llmModel",
            "reasoningEffort",
            "maxIterations",
            "maxRunMinutes",
            "internetAccess",
            "workspaceApiAccess",
            "workspaceMcpAccess",
          ],
        },
        "limits": [
          "listingEntries",
          "sessionPreviewChars",
          "sessionListModelCalls",
          "scheduleTickSeconds",
        ],
        "values": {
          "scheduleRunStatus": [
            "ok",
            "error",
          ],
          "sessionOrigin": [
            "chat",
            "api",
            "mcp",
            "scheduled",
            "agent",
            "manual",
          ],
          "sessionStatus": [
            "running",
            "success",
            "failed",
            "cancelled",
            "timeout",
            "limit_reached",
            "incomplete",
          ],
          "toolStatus": [
            "ok",
            "error",
            "needs_input",
          ],
        },
      },
      "routes": [
        "GET ^\\/api\\/status$",
        "GET ^\\/api\\/models$",
        "GET ^\\/api\\/contract$",
        "GET ^\\/api\\/workspaces$",
        "POST ^\\/api\\/workspaces$",
        "GET ^\\/api\\/workspaces\\/[^/]+$",
        "PATCH ^\\/api\\/workspaces\\/[^/]+$",
        "DELETE ^\\/api\\/workspaces\\/[^/]+$",
        "POST ^\\/api\\/workspaces\\/[^/]+\\/api-key$",
        "DELETE ^\\/api\\/workspaces\\/[^/]+\\/api-key$",
        "POST ^\\/api\\/workspaces\\/[^/]+\\/mcp-config$",
        "DELETE ^\\/api\\/workspaces\\/[^/]+\\/mcp-config$",
        "GET ^\\/api\\/workspaces\\/[^/]+\\/files$",
        "GET ^\\/api\\/workspaces\\/[^/]+\\/files\\/content$",
        "DELETE ^\\/api\\/workspaces\\/[^/]+\\/files\\/content$",
        "GET ^\\/api\\/workspaces\\/[^/]+\\/files\\/transfer$",
        "PUT ^\\/api\\/workspaces\\/[^/]+\\/files\\/transfer$",
        "GET ^\\/api\\/workspaces\\/[^/]+\\/schedule$",
        "PUT ^\\/api\\/workspaces\\/[^/]+\\/schedule$",
        "PATCH ^\\/api\\/workspaces\\/[^/]+\\/schedule$",
        "GET ^\\/api\\/workspaces\\/[^/]+\\/conversations$",
        "GET ^\\/api\\/workspaces\\/[^/]+\\/conversations\\/[^/]+\\/sessions$",
        "GET ^\\/api\\/workspaces\\/[^/]+\\/conversations\\/[^/]+\\/sessions\\/[^/]+$",
        "GET ^\\/api\\/workspaces\\/[^/]+\\/conversations\\/[^/]+\\/sessions\\/[^/]+\\/calls$",
        "GET ^\\/api\\/workspaces\\/[^/]+\\/conversations\\/[^/]+\\/sessions\\/[^/]+\\/calls\\/[^/]+$",
        "GET ^\\/api\\/drives$",
        "POST ^\\/api\\/drives$",
        "GET ^\\/api\\/drives\\/[^/]+$",
        "PATCH ^\\/api\\/drives\\/[^/]+$",
        "DELETE ^\\/api\\/drives\\/[^/]+$",
        "GET ^\\/api\\/drives\\/[^/]+\\/files$",
        "GET ^\\/api\\/drives\\/[^/]+\\/files\\/content$",
        "DELETE ^\\/api\\/drives\\/[^/]+\\/files\\/content$",
        "GET ^\\/api\\/drives\\/[^/]+\\/files\\/transfer$",
        "PUT ^\\/api\\/drives\\/[^/]+\\/files\\/transfer$",
        "GET ^\\/api\\/drive-connections$",
        "POST ^\\/api\\/drive-connections$",
        "DELETE ^\\/api\\/drive-connections$",
        "GET ^\\/api\\/workspace-graph$",
        "POST ^\\/api\\/workspace-graph\\/edges$",
        "DELETE ^\\/api\\/workspace-graph\\/edges$",
        "GET ^\\/api\\/connections$",
        "POST ^\\/api\\/connections$",
        "DELETE ^\\/api\\/connections\\/[^/]+$",
      ],
      "version": 1,
    }
  `);
});
