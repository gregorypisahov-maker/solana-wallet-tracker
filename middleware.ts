import { NextRequest, NextResponse } from "next/server";

const CANONICAL_HOST = "dashboard-production-cf83.up.railway.app";

function unauthorized(): NextResponse {
  return new NextResponse("Private dashboard — owner authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Private Trading Dashboard", charset="UTF-8"',
      "Cache-Control": "no-store, private",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    },
  });
}

function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

export function middleware(request: NextRequest) {
  const host = request.headers.get("host")?.toLowerCase() ?? "";

  // The old Vercel deployment does not share Railway's owner password.
  // Send every legacy Vercel link to the single canonical private dashboard.
  if (host.endsWith(".vercel.app")) {
    const canonicalUrl = new URL(request.nextUrl.pathname + request.nextUrl.search, `https://${CANONICAL_HOST}`);
    return NextResponse.redirect(canonicalUrl, 308);
  }

  const password = process.env.DASHBOARD_ADMIN_PASSWORD?.trim();

  // Fail closed: without an owner password, nothing on the public domain is served.
  if (!password) return unauthorized();

  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Basic ")) return unauthorized();

  try {
    const decoded = atob(authorization.slice(6));
    const separator = decoded.indexOf(":");
    const suppliedPassword = separator >= 0 ? decoded.slice(separator + 1) : "";
    if (!safeEqual(suppliedPassword, password)) return unauthorized();
  } catch {
    return unauthorized();
  }

  const pathname = request.nextUrl.pathname;
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

  response.headers.set("Cache-Control", "no-store, private");
  response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};