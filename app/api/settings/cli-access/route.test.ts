// The UI-administrator endpoint for the CLI/platform credential. Runs against the real
// credentialStore rather than a vi.mock so the shared credential handlers, the store, and this
// route's wire shape are all exercised together — a hand-written mock of the store would be free to
// drift from it and keep passing.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";

const { ROOT } = vi.hoisted(() => {
  const os = require("os");
  const fs = require("fs");
  const path = require("path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cli-access-route-test-"));
  process.env.WORKSPACES_ROOT = root;
  return { ROOT: root };
});

import { DELETE, GET, PATCH, POST } from "./route";
import { remove, validate } from "@/lib/infra/security/credentialStore";

const originalPublicDomain = process.env.WORKSPACE_API_DOMAIN;

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  if (originalPublicDomain === undefined) delete process.env.WORKSPACE_API_DOMAIN;
  else process.env.WORKSPACE_API_DOMAIN = originalPublicDomain;
});

// The platform credential is instance-wide, so every test shares one record. Clear it between tests.
beforeEach(() => {
  remove("platform");
  process.env.WORKSPACE_API_DOMAIN = "api.example.com";
});

// The handlers take Next's route context; this endpoint has no params because it has no subject.
const context = { params: Promise.resolve({}) };

function patch(body: unknown) {
  return PATCH(
    new Request("http://x/api/settings/cli-access", { method: "PATCH", body: JSON.stringify(body) }),
    context,
  );
}

function post(operation: "generate" | "rotate") {
  return POST(
    new Request("http://x/api/settings/cli-access", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation }),
    }),
    context,
  );
}

describe("/api/settings/cli-access", () => {
  it("reports the default state as off with no secret", async () => {
    expect(await GET().json()).toEqual({
      enabled: false,
      hasKey: false,
      createdAt: null,
      lastUsedAt: null,
      publicBaseUrl: "https://api.example.com",
    });
  });

  it("never exposes the stored hash", async () => {
    await post("generate");
    const body = (await GET().json()) as Record<string, unknown>;
    // Assert on the key set: a future field carrying hash material fails here rather than shipping.
    expect(Object.keys(body).sort()).toEqual(["createdAt", "enabled", "hasKey", "lastUsedAt", "publicBaseUrl"]);
  });

  it("mints a working token on POST and returns the plaintext once", async () => {
    await patch({ enabled: true });
    const { plain } = (await (await post("generate")).json()) as {
      plain: string;
    };
    expect(plain.startsWith("cli_")).toBe(true);
    expect(validate("platform", null, plain)).toBe(true);
  });

  it("rotates on a second POST, invalidating the previous token", async () => {
    await patch({ enabled: true });
    const first = (await (await post("generate")).json()) as {
      plain: string;
    };
    const second = (await (await post("rotate")).json()) as {
      plain: string;
    };
    expect(validate("platform", null, first.plain)).toBe(false);
    expect(validate("platform", null, second.plain)).toBe(true);
  });

  it("PATCH toggles the channel without rotating the token", async () => {
    await patch({ enabled: true });
    const { plain } = (await (await post("generate")).json()) as {
      plain: string;
    };

    expect(await (await patch({ enabled: false })).json()).toEqual({ ok: true });
    expect(validate("platform", null, plain)).toBe(false);

    await patch({ enabled: true });
    // Same secret still works — toggling is not rotation.
    expect(validate("platform", null, plain)).toBe(true);
  });

  it("PATCH can enable the channel before any token exists", async () => {
    await patch({ enabled: true });
    expect(await GET().json()).toMatchObject({ enabled: true, hasKey: false });
  });

  // The other order, and the one that would be dangerous to get wrong: minting must not open the
  // channel behind the operator's back. A token issued in advance is inert until they say otherwise.
  it("POST can mint a token without opening the channel", async () => {
    const { plain } = (await (await post("generate")).json()) as { plain: string };

    expect(await GET().json()).toMatchObject({ enabled: false, hasKey: true });
    expect(validate("platform", null, plain)).toBe(false);

    await patch({ enabled: true });
    expect(validate("platform", null, plain)).toBe(true);
  });

  it("DELETE revokes the token immediately — the PRD's revocation requirement", async () => {
    // The old bespoke platform-token store had no revoke at all; it could only be disabled, leaving
    // the hash on disk. This pins that revocation now exists and takes effect at once.
    await patch({ enabled: true });
    const { plain } = (await (await post("generate")).json()) as {
      plain: string;
    };
    expect(validate("platform", null, plain)).toBe(true);

    expect(await (await DELETE(new Request("http://x", { method: "DELETE" }), context)).json()).toEqual({ ok: true });
    expect(validate("platform", null, plain)).toBe(false);
    expect(await GET().json()).toMatchObject({ hasKey: false });
  });

  it("rejects a non-boolean toggle", async () => {
    expect((await patch({ enabled: "yes" })).status).toBe(400);
  });

  it("rejects a malformed body", async () => {
    const response = await PATCH(
      new Request("http://x/api/settings/cli-access", { method: "PATCH", body: "not json" }),
      context,
    );
    expect(response.status).toBe(400);
  });
});
