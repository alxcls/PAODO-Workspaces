import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";

const root = pino({
  level: process.env.LOG_LEVEL ?? (isDev ? "debug" : "info"),
  ...(isDev && {
    transport: {
      target: "pino-pretty",
      options: { colorize: true, singleLine: true },
    },
  }),
});

export function createLogger(context: string) {
  return root.child({ context });
}

export const logger = createLogger("app");
