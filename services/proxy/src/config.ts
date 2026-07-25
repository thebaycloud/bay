function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

const PROD = process.env.NODE_ENV === "production";

export const config = {
  port: Number(process.env.PORT ?? 8080),
  authSecret: required("AUTH_SECRET"),
  /** Must match apps/web auth.config.ts exactly — it is also the decode salt. */
  sessionCookieName: PROD ? "__Secure-authjs.session-token" : "authjs.session-token",
  loginUrl: process.env.LOGIN_URL ?? "https://app.supersonic.cv/login",
  rootDomain: process.env.ROOT_DOMAIN ?? "supersonic.cv",
};
