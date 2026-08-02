import fs from "node:fs";

const path = "single-bot/server.ts";
const source = fs.readFileSync(path, "utf8");

const before = `app.post(WEBHOOK_PATH, (req: Request, res: Response) => {
  const supplied =
    req.get("authorization") ??
    req.get("x-helius-auth-token") ??
    "";
  if (!safeEqual(supplied, HELIUS_WEBHOOK_AUTH_HEADER)) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
`;

const after = `app.post(WEBHOOK_PATH, (req: Request, res: Response) => {
  const headerCandidates = [
    req.get("authorization"),
    req.get("x-helius-auth-token"),
    req.get("x-api-key"),
    req.get("x-webhook-secret"),
    req.get("auth"),
  ]
    .filter((value): value is string => typeof value === "string")
    .flatMap((value) => {
      const trimmed = value.trim();
      const bearer = trimmed.match(/^Bearer\\s+(.+)$/i)?.[1]?.trim();
      return bearer ? [trimmed, bearer] : [trimmed];
    });

  const authorized = headerCandidates.some((candidate) =>
    safeEqual(candidate, HELIUS_WEBHOOK_AUTH_HEADER)
  );

  if (!authorized) {
    console.warn("[single-bot] unauthorized webhook", {
      presentHeaders: [
        "authorization",
        "x-helius-auth-token",
        "x-api-key",
        "x-webhook-secret",
        "auth",
      ].filter((name) => Boolean(req.get(name))),
    });
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
`;

if (source.includes(after)) {
  console.log("[patch-single-bot-helius-auth] already applied");
  process.exit(0);
}

if (!source.includes(before)) {
  throw new Error("single_bot_auth_anchor_not_found");
}

fs.writeFileSync(path, source.replace(before, after));
console.log("[patch-single-bot-helius-auth] applied");
