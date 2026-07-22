import { NextRequest, NextResponse } from "next/server";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";

export const VIEWER_COOKIE = "swt_viewer";
export const VIEWER_SESSION_TTL_SECONDS = 60 * 60 * 12;
const SESSION_VERSION = "v1";

export function getViewerSecret(): string | undefined {
  return (
    process.env.VIEWER_SHARE_TOKEN?.trim() ||
    process.env.DASHBOARD_KEY?.trim()
  );
}

function getSessionSecret(): string | undefined {
  return process.env.DASHBOARD_SESSION_SECRET?.trim() || getViewerSecret();
}

function safeEqual(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function signViewerPayload(payload: string): string | undefined {
  const secret = getSessionSecret();
  if (!secret) return undefined;
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createViewerSessionToken(nowMs = Date.now()): string | undefined {
  const expiresAt = Math.floor(nowMs / 1000) + VIEWER_SESSION_TTL_SECONDS;
  const nonce = randomBytes(16).toString("hex");
  const payload = `${SESSION_VERSION}.${expiresAt}.${nonce}`;
  const signature = signViewerPayload(payload);
  return signature ? `${payload}.${signature}` : undefined;
}

export function verifyViewerSessionToken(token: string | undefined, nowMs = Date.now()): boolean {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== SESSION_VERSION) return false;

  const expiresAt = Number(parts[1]);
  const nowSeconds = Math.floor(nowMs / 1000);
  if (!Number.isFinite(expiresAt) || expiresAt <= nowSeconds) return false;
  if (expiresAt > nowSeconds + VIEWER_SESSION_TTL_SECONDS + 60) return false;

  const payload = parts.slice(0, 3).join(".");
  return safeEqual(parts[3], signViewerPayload(payload));
}

export function hasViewerAccess(request: NextRequest): boolean {
  return verifyViewerSessionToken(request.cookies.get(VIEWER_COOKIE)?.value);
}

export function hasAdminAccess(request: NextRequest): boolean {
  const expected = process.env.DASHBOARD_ADMIN_PASSWORD?.trim();
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
