export function normalizeUtcOffsetToken(token: string): string | null {
  if (token === "GMT" || token === "UTC") return "UTC +0";
  const m = token.match(/(?:GMT|UTC)([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!m) return null;
  const hh = String(parseInt(m[2], 10));
  const mm = m[3] ? `:${m[3]}` : "";
  return `UTC ${m[1]}${hh}${mm}`;
}

export function utcOffsetTokenToMinutes(token: string): number | null {
  if (token === "GMT" || token === "UTC") return 0;
  const m = token.match(/(?:GMT|UTC)([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!m) return null;
  const sign = m[1] === "+" ? 1 : -1;
  const hours = parseInt(m[2], 10);
  const minutes = m[3] ? parseInt(m[3], 10) : 0;
  return sign * (hours * 60 + minutes);
}

export function timezoneOffsetLabel(tz: string, now: Date = new Date()): string | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "shortOffset",
      hour: "2-digit",
    }).formatToParts(now);
    const token = parts.find((p) => p.type === "timeZoneName")?.value;
    if (!token) return null;
    return normalizeUtcOffsetToken(token);
  } catch {
    return null;
  }
}

export function timezoneOffsetMinutes(tz: string, now: Date = new Date()): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "shortOffset",
      hour: "2-digit",
    }).formatToParts(now);
    const token = parts.find((p) => p.type === "timeZoneName")?.value;
    if (!token) return null;
    return utcOffsetTokenToMinutes(token);
  } catch {
    return null;
  }
}

export function timezoneOptionLabel(tz: string, now: Date = new Date()): string {
  const offset = timezoneOffsetLabel(tz, now);
  return offset ? `${offset} - ${tz}` : tz;
}
