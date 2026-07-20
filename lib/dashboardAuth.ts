import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";

export const VIEWER_COOKIE = "swt_viewer";

export function getViewerSecret(): string | undefined {
  return (
    process.env.VIEWER_SHARE_TOKEN?.trim() ||
    process.env.DASHBOARD_KEY?.trim() ||
    process.env.DASHBOARD_ADMIN_PASSWORD?.trim()
  );
}

function safeEqual(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function hasViewerAccess(request: NextRequest): boolean {
  return safeEqual(request.cookies.get(VIEWER_COOKIE)?.value, getViewerSecret());
}

export function hasAdminAccess(request: NextRequest): boolean {
  // Prefer a dedicated owner password when configured. If the deployment only
  // has the normal dashboard key/share token, allow that same key to control
  // the paper bots so the Resume/Pause buttons do not fail unexpectedly.
  const expected =
    process.env.DASHBOARD_ADMIN_PASSWORD?.trim() ||
    process.env.DASHBOARD_KEY?.trim() ||
    process.env.VIEWER_SHARE_TOKEN?.trim();
  const authorization = request.headers.get("authorization");
  if (!expected || !authorization?.startsWith("Basic ")) return false;

  try {
    const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    const password = separator >= 0 ? decoded.slice(separator + 1) : "";
    return safeEqual(password, expected);
  } catch {
    return false;
  }
}

export function unauthorized(message = "Unauthorized"): NextResponse {
  return NextResponse.json(
    { error: message },
    { status: 401, headers: { "Cache-Control": "no-store" } }
  );
}
