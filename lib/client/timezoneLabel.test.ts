import { describe, expect, it, vi } from "vitest";
import {
  normalizeUtcOffsetToken,
  timezoneOffsetLabel,
  timezoneOffsetMinutes,
  timezoneOptionLabel,
  utcOffsetTokenToMinutes,
} from "./timezoneLabel";

describe("normalizeUtcOffsetToken", () => {
  it("normalizes whole-hour offsets", () => {
    expect(normalizeUtcOffsetToken("GMT+2")).toBe("UTC +2");
    expect(normalizeUtcOffsetToken("UTC-11")).toBe("UTC -11");
  });

  it("normalizes minute offsets", () => {
    expect(normalizeUtcOffsetToken("GMT+05:30")).toBe("UTC +5:30");
    expect(normalizeUtcOffsetToken("UTC-0930")).toBe("UTC -9:30");
  });

  it("maps zero-offset tokens", () => {
    expect(normalizeUtcOffsetToken("UTC")).toBe("UTC +0");
    expect(normalizeUtcOffsetToken("GMT")).toBe("UTC +0");
  });

  it("returns null for unknown token shapes", () => {
    expect(normalizeUtcOffsetToken("CEST")).toBeNull();
    expect(normalizeUtcOffsetToken("+02:00")).toBeNull();
  });
});

describe("utcOffsetTokenToMinutes", () => {
  it("parses whole-hour offsets", () => {
    expect(utcOffsetTokenToMinutes("GMT+2")).toBe(120);
    expect(utcOffsetTokenToMinutes("UTC-11")).toBe(-660);
  });

  it("parses offsets with minutes", () => {
    expect(utcOffsetTokenToMinutes("GMT+05:30")).toBe(330);
    expect(utcOffsetTokenToMinutes("UTC-0930")).toBe(-570);
  });

  it("returns null for invalid tokens", () => {
    expect(utcOffsetTokenToMinutes("CEST")).toBeNull();
  });
});

describe("timezone label helpers", () => {
  it("formats option label with UTC offset", () => {
    const label = timezoneOptionLabel("UTC", new Date("2026-07-12T00:00:00Z"));
    expect(label.startsWith("UTC +0 - UTC")).toBe(true);
  });

  it("returns offset minutes for known timezone", () => {
    const mins = timezoneOffsetMinutes("UTC", new Date("2026-07-12T00:00:00Z"));
    expect(mins).toBe(0);
  });

  it("falls back to timezone name when offset lookup throws", () => {
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation((() => {
      throw new Error("boom");
    }) as unknown as typeof Intl.DateTimeFormat);

    expect(timezoneOffsetLabel("Europe/Paris")).toBeNull();
    expect(timezoneOptionLabel("Europe/Paris")).toBe("Europe/Paris");
    vi.restoreAllMocks();
  });
});
