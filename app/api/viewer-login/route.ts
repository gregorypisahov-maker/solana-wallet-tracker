import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import {
  createViewerSessionToken,
  getViewerSecrets,
  VIEWER_COOKIE,
  VIEWER_SESSION_TTL_SECONDS,
} from "@/lib/dashboardAuth";

export const dynamic = "force-dynamic";

function safeEqual(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function jsonError(message: string, status: number) {
  return NextResponse.json(
    { error: message },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(request: NextRequest) {
  const acceptedPasswords = getViewerSecrets();
  if (acceptedPasswords.length === 0) {
    return jsonError("Dashboard login is not configured", 503);
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
    return jsonError("Incorrect dashboard key", 401);
  }

  const now = Date.now();
  const sessionToken = createViewerSessionToken(now);
  if (!sessionToken) {
    return jsonError("Dashboard session is not configured", 503);
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(VIEWER_COOKIE, sessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: VIEWER_SESSION_TTL_SECONDS,
    path: "/",
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
