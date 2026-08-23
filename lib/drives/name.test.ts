import { describe, expect, it } from "vitest";
import { MAX_DRIVE_NAME_LENGTH, validateDriveName } from "./name";

/** Every rejection carries the same code, so a route maps it to a status without reading the message. */
function expectRejected(name: unknown) {
  expect(() => validateDriveName(name as string)).toThrowError(expect.objectContaining({ code: "DRIVE_NAME_INVALID" }));
}

describe("drive name policy", () => {
  it("returns the trimmed name", () => {
    expect(validateDriveName("  Shared assets  ")).toBe("Shared assets");
  });

  it("allows hyphens, underscores and dots inside the name", () => {
    expect(validateDriveName("shared_assets-v2.1")).toBe("shared_assets-v2.1");
  });

  it("refuses an empty or whitespace-only name", () => {
    expectRejected("");
    expectRejected("   ");
  });

  it("refuses a name over the length limit", () => {
    expect(validateDriveName("a".repeat(MAX_DRIVE_NAME_LENGTH))).toHaveLength(MAX_DRIVE_NAME_LENGTH);
    expectRejected("a".repeat(MAX_DRIVE_NAME_LENGTH + 1));
  });

  // The name is used as a path segment under downloads/<drive-name>/.
  it("refuses path separators and the dot names", () => {
    expectRejected("a/b");
    expectRejected("a\\b");
    expectRejected(".");
    expectRejected("..");
  });

  it("refuses control characters, including DEL", () => {
    expectRejected(`tab${String.fromCharCode(9)}name`);
    expectRejected(`nul${String.fromCharCode(0)}name`);
    expectRejected(`del${String.fromCharCode(127)}name`);
  });

  // A name from a JSON body has only claimed to be a string; without this it leaves a TypeError,
  // which no adapter recognizes as expected, so the route answers 500 instead of 400.
  it("refuses a non-string as a name violation rather than a type error", () => {
    expectRejected(42);
    expectRejected(null);
    expectRejected({ name: "nested" });
  });
});
