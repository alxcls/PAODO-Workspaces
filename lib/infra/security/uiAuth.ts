/**
 * The single seam between "how this deployment identifies a browser" and everything that guards a
 * request. httpAuth.ts consumes a UiAuthenticator and never learns which mode produced it, so a new
 * mode is a case in resolveUiAuth and nothing else.
 *
 * The two modes are mutually exclusive by construction, not layered. A deployment fronted by an
 * identity-aware proxy must not also answer a shared password: that password would sit behind the
 * proxy as a bypass for anyone who reaches the origin directly, which is the failure the proxy was
 * adopted to prevent.
 */
import { timingSafeEqual } from "crypto";
import { readCookie } from "./cookies";
import { JwksCache, verifyAssertion, type AssertionPolicy } from "./iapAssertion";

export type UiAuthMode = "basic" | "iap";

/** "absent" means no credential was offered (challenge); "invalid" means one was, and it failed. */
export type UiAuthOutcome = "ok" | "absent" | "invalid";

/**
 * Only the fields an authenticator may read. Structural, so httpAuth.ts imports nothing from here.
 * `isUpgrade` marks the /ws handshake, the one request a browser cannot put a header on.
 */
export type UiAuthInput = { authorization: string; cookie: string; assertion: string; isUpgrade: boolean };

export type UiAuthenticator = {
  readonly mode: UiAuthMode;
  /** Header this mode reads the assertion from, lowercased; null when it reads no extra header. */
  readonly assertionHeader: string | null;
  /** WWW-Authenticate value for an unauthenticated request, or null when a challenge is meaningless. */
  readonly challenge: string | null;
  /** Warms anything the mode needs before the first request. Rejects to fail startup closed. */
  prime(): Promise<void>;
  verify(req: UiAuthInput): UiAuthOutcome;
};

/**
 * Constant-time string comparison, so a byte-by-byte timing difference cannot be measured to recover
 * the secret.
 */
export function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.byteLength !== bBuf.byteLength) {
    timingSafeEqual(Buffer.alloc(1), Buffer.alloc(1)); // dummy compare: no length-based timing oracle
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

export type BasicCredentials = { user: string; pass: string };

export function basicAuthenticator(credentials: BasicCredentials): UiAuthenticator {
  return {
    mode: "basic",
    assertionHeader: null,
    challenge: 'Basic realm="App"',
    prime: () => Promise.resolve(),
    verify({ authorization }) {
      // safeEqual("", "") is true, so unset credentials must fail before the comparison. resolveUiAuth
      // already refuses to build this, which makes the guard defence in depth rather than the gate.
      if (!credentials.user || !credentials.pass) return "invalid";
      if (!authorization.startsWith("Basic ")) return "absent";

      const decoded = Buffer.from(authorization.slice(6), "base64").toString();
      const colon = decoded.indexOf(":");
      if (colon === -1) return "invalid";

      const userOk = safeEqual(decoded.slice(0, colon), credentials.user);
      const passOk = safeEqual(decoded.slice(colon + 1), credentials.pass);
      return userOk && passOk ? "ok" : "invalid";
    },
  };
}

export type IapSettings = {
  header: string;
  cookie: string | null;
  policy: AssertionPolicy;
};

export function iapAuthenticator(settings: IapSettings): UiAuthenticator {
  return {
    mode: "iap",
    assertionHeader: settings.header,
    /**
     * No challenge. The proxy authenticates before the origin ever sees the request, so a 401 here
     * means the assertion was absent or bad — a browser prompt could not satisfy either, and
     * offering Basic would advertise a scheme this mode does not accept.
     */
    challenge: null,
    prime: () => settings.policy.jwks.refresh(),
    verify({ cookie, assertion, isUpgrade }) {
      // The cookie is the /ws fallback only, for proxies that set no header on a handshake. Reading
      // it on HTTP as well would make the proxy's cookie an ambient credential on every API route,
      // leaving the CSRF guard as the only thing between a cross-site POST and a mutation.
      const fallback = isUpgrade && settings.cookie ? (readCookie(cookie, settings.cookie) ?? "") : "";
      const token = assertion || fallback;
      if (!token) return "absent";
      return verifyAssertion(token, settings.policy) ? "ok" : "invalid";
    },
  };
}

export type UiAuthEnvironment = {
  PAODO_AUTH_MODE?: string;
  USERNAME?: string;
  PASSWORD?: string;
  PAODO_IAP_HEADER?: string;
  PAODO_IAP_COOKIE?: string;
  PAODO_IAP_JWKS_URL?: string;
  PAODO_IAP_ISSUER?: string;
  PAODO_IAP_AUDIENCE?: string;
};

function required(env: UiAuthEnvironment, name: keyof UiAuthEnvironment): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required when PAODO_AUTH_MODE=iap`);
  return value;
}

// Header names are compared against Node's own, which are lowercased, and must be a single token.
function normalizeHeaderName(value: string): string {
  if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(value)) throw new Error(`PAODO_IAP_HEADER is not a valid header name`);
  return value.toLowerCase();
}

function assertHttpsUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("PAODO_IAP_JWKS_URL is not a valid URL");
  }
  if (parsed.protocol !== "https:") throw new Error("PAODO_IAP_JWKS_URL must be https");
  return parsed.toString();
}

/**
 * Builds the authenticator for the configured mode, throwing when that mode is not fully configured
 * so the caller can refuse to start. Defaults to `basic`, which is the mode that needs no external
 * service — an unset variable must never select the one that does.
 *
 * Unconditional by design, and never gated on NODE_ENV: doing that once meant a container flipped to
 * debug logging served every route unauthenticated.
 */
export function resolveUiAuth(
  env: UiAuthEnvironment = {
    PAODO_AUTH_MODE: process.env.PAODO_AUTH_MODE,
    USERNAME: process.env.USERNAME,
    PASSWORD: process.env.PASSWORD,
    PAODO_IAP_HEADER: process.env.PAODO_IAP_HEADER,
    PAODO_IAP_COOKIE: process.env.PAODO_IAP_COOKIE,
    PAODO_IAP_JWKS_URL: process.env.PAODO_IAP_JWKS_URL,
    PAODO_IAP_ISSUER: process.env.PAODO_IAP_ISSUER,
    PAODO_IAP_AUDIENCE: process.env.PAODO_IAP_AUDIENCE,
  },
  jwksFactory = (url: string) => new JwksCache(url),
): UiAuthenticator {
  const mode = env.PAODO_AUTH_MODE?.trim() || "basic";

  if (mode === "basic") {
    const user = env.USERNAME?.trim();
    const pass = env.PASSWORD; // deliberately untrimmed: trailing whitespace is part of a password
    if (!user || !pass) throw new Error("USERNAME and PASSWORD are required when PAODO_AUTH_MODE=basic");
    return basicAuthenticator({ user, pass });
  }

  if (mode === "iap") {
    const cookie = env.PAODO_IAP_COOKIE?.trim();
    return iapAuthenticator({
      header: normalizeHeaderName(required(env, "PAODO_IAP_HEADER")),
      cookie: cookie || null,
      policy: {
        issuer: required(env, "PAODO_IAP_ISSUER"),
        audience: required(env, "PAODO_IAP_AUDIENCE"),
        jwks: jwksFactory(assertHttpsUrl(required(env, "PAODO_IAP_JWKS_URL"))),
      },
    });
  }

  throw new Error(`PAODO_AUTH_MODE must be "basic" or "iap"; received ${JSON.stringify(mode)}`);
}
