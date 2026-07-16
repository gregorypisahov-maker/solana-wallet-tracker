import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { VIEWER_COOKIE } from "@/lib/dashboardAuth";

export const dynamic = "force-dynamic";

function safeEqual(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: NextRequest) {
  const viewerToken = process.env.VIEWER_SHARE_TOKEN;
  const expectedPassword =
    process.env.DASHBOARD_KEY?.trim() ||
    process.env.DASHBOARD_ADMIN_PASSWORD?.trim() ||
    viewerToken;

  if (!viewerToken || viewerToken.length < 32 || !expectedPassword) {
    return NextResponse.json(
      { error: "Dashboard login is not configured" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }

  let password = "";
  try {
    const body = await request.json();
    password = typeof body?.password === "string" ? body.password.trim() : "";
  } catch {
    return NextResponse.json(
      { error: "Invalid request" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  if (!safeEqual(password, expectedPassword)) {
    return NextResponse.json(
      { error: "Incorrect dashboard key" },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(VIEWER_COOKIE, viewerToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 60 * 60 * 24 * 30,
    path: "/",
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
