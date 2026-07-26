import { NextRequest, NextResponse } from "next/server";

const CANONICAL_HOST = "dashboard-production-cf83.up.railway.app";
const COOKIE = "private_dashboard_session";

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function expectedSession(password: string): Promise<string> {
  const secret = process.env.DASHBOARD_SESSION_SECRET?.trim() || password;
  return sha256(`private-dashboard-v1:${password}:${secret}`);
}

function privateHeaders(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "no-store, private");
  response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

export async function middleware(request: NextRequest) {
  const host = request.headers.get("host")?.toLowerCase() ?? "";

  if (host.endsWith(".vercel.app")) {
    const canonicalUrl = new URL(request.nextUrl.pathname + request.nextUrl.search, `https://${CANONICAL_HOST}`);
    return NextResponse.redirect(canonicalUrl, 308);
  }

  const pathname = request.nextUrl.pathname;
  if (pathname === "/login" || pathname === "/api/auth/login") {
    return privateHeaders(NextResponse.next());
  }

  const password = process.env.DASHBOARD_ADMIN_PASSWORD?.trim();
  const suppliedSession = request.cookies.get(COOKIE)?.value;
  const validSession = Boolean(password && suppliedSession && suppliedSession === await expectedSession(password));

  if (!validSession) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = "";
    loginUrl.searchParams.set("next", pathname + request.nextUrl.search);
    return privateHeaders(NextResponse.redirect(loginUrl, 303));
  }

  let response: NextResponse;
  if (pathname === "/platform") {
    const dashboardUrl = request.nextUrl.clone();
    dashboardUrl.pathname = "/";
    dashboardUrl.searchParams.set("__platform", "1");
    response = NextResponse.rewrite(dashboardUrl);
  } else if (pathname === "/" && request.nextUrl.searchParams.get("__platform") !== "1") {
    const storefrontUrl = request.nextUrl.clone();
    storefrontUrl.pathname = "/storefront";
    response = NextResponse.rewrite(storefrontUrl);
  } else {
    response = NextResponse.next();
  }

  return privateHeaders(response);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
