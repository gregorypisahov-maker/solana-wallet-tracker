import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import {
  createViewerSessionToken,
  getViewerSecret,
  getViewerSecrets,
  VIEWER_COOKIE,
  VIEWER_SESSION_TTL_SECONDS,
} from "@/lib/dashboardAuth";
import { getSupabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const BLOCK_MS = 30 * 60 * 1000;

type LoginAttempt = {
  identifier: string;
  attempts: number;
  window_started_at: string;
  blocked_until: string | null;
};

function safeEqual(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requestFingerprint(request: NextRequest, secret: string): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || request.headers.get("x-real-ip")?.trim() || "unknown";
  const agent = request.headers.get("user-agent")?.slice(0, 180) || "unknown";
  return createHmac("sha256", secret).update(`${ip}|${agent}`).digest("hex");
}

function jsonError(message: string, status: number, retryAfterSeconds?: number) {
  const response = NextResponse.json(
    { error: message },
    { status, headers: { "Cache-Control": "no-store" } }
  );
  if (retryAfterSeconds && retryAfterSeconds > 0) {
    response.headers.set("Retry-After", String(Math.ceil(retryAfterSeconds)));
  }
  return response;
}

export async function POST(request: NextRequest) {
  const acceptedPasswords = getViewerSecrets();
  const fingerprintSecret = getViewerSecret();
  if (!fingerprintSecret || acceptedPasswords.length === 0) {
    return jsonError("Dashboard login is not configured", 503);
  }

  const identifier = requestFingerprint(request, fingerprintSecret);
  const supabase = getSupabaseAdmin({ noStore: true });
  const { data: attemptData, error: attemptError } = await supabase
    .from("dashboard_login_attempts")
    .select("identifier,attempts,window_started_at,blocked_until")
    .eq("identifier", identifier)
    .maybeSingle();

  if (attemptError) {
    console.error("[viewer-login] rate-limit lookup failed:", attemptError.message);
    return jsonError("Login temporarily unavailable", 503);
  }

  const attempt = (attemptData ?? null) as LoginAttempt | null;
  const now = Date.now();
  const blockedUntil = attempt?.blocked_until ? Date.parse(attempt.blocked_until) : 0;
  if (blockedUntil > now) {
    return jsonError("Too many login attempts. Try again later.", 429, (blockedUntil - now) / 1000);
  }

  let password = "";
  try {
    const body = await request.json();
    password = typeof body?.password === "string" ? body.password.trim() : "";
  } catch {
    return jsonError("Invalid request", 400);
  }

  const passwordMatches = acceptedPasswords.some((expected) => safeEqual(password, expected));
  if (!passwordMatches) {
    const existingWindowStart = attempt?.window_started_at ? Date.parse(attempt.window_started_at) : 0;
    const insideWindow = existingWindowStart > 0 && now - existingWindowStart < WINDOW_MS;
    const attempts = insideWindow ? Number(attempt?.attempts ?? 0) + 1 : 1;
    const windowStartedAt = insideWindow ? attempt!.window_started_at : new Date(now).toISOString();
    const nextBlockedUntil = attempts >= MAX_ATTEMPTS ? new Date(now + BLOCK_MS).toISOString() : null;

    const { error: writeError } = await supabase.from("dashboard_login_attempts").upsert({
      identifier,
      attempts,
      window_started_at: windowStartedAt,
      blocked_until: nextBlockedUntil,
      updated_at: new Date(now).toISOString(),
    });

    if (writeError) console.error("[viewer-login] rate-limit write failed:", writeError.message);
    if (nextBlockedUntil) return jsonError("Too many login attempts. Try again later.", 429, BLOCK_MS / 1000);
    return jsonError("Incorrect dashboard key", 401);
  }

  await supabase.from("dashboard_login_attempts").delete().eq("identifier", identifier);

  const sessionToken = createViewerSessionToken(now);
  if (!sessionToken) return jsonError("Dashboard session is not configured", 503);

  const response = NextResponse.json({ ok: true });
  response.cookies.set(VIEWER_COOKIE, sessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: VIEWER_SESSION_TTL_SECONDS,
    path: "/",
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
