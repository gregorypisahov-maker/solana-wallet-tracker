import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
const COOKIE = "private_dashboard_session";
const MAX_AGE = 60 * 60 * 12;

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sessionValue(password: string): string {
  const secret = process.env.DASHBOARD_SESSION_SECRET?.trim() || password;
  return createHash("sha256").update(`private-dashboard-v1:${password}:${secret}`).digest("hex");
}

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const supplied = String(form.get("password") ?? "");
  const expected = process.env.DASHBOARD_ADMIN_PASSWORD?.trim() ?? "";
  const requestedNext = String(form.get("next") ?? "/live");
  const next = requestedNext.startsWith("/") && !requestedNext.startsWith("//") ? requestedNext : "/live";

  if (!expected || !safeEqual(supplied, expected)) {
    const url = new URL("/login", request.url);
    url.searchParams.set("error", "1");
    url.searchParams.set("next", next);
    return NextResponse.redirect(url, 303);
  }

  const response = NextResponse.redirect(new URL(next, request.url), 303);
  response.cookies.set(COOKIE, sessionValue(expected), {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: MAX_AGE,
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
