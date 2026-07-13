import { NextRequest, NextResponse } from "next/server";

const VIEWER_COOKIE = "swt_viewer";

export function middleware(request: NextRequest) {
  const expected = process.env.VIEWER_SHARE_TOKEN;

  if (!expected || expected.length < 32) {
    return new NextResponse("Dashboard is not configured", { status: 503 });
  }

  const supplied = request.nextUrl.searchParams.get("token");
  if (supplied === expected) {
    const cleanUrl = request.nextUrl.clone();
    cleanUrl.searchParams.delete("token");
    const response = NextResponse.redirect(cleanUrl);
    response.cookies.set(VIEWER_COOKIE, expected, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 60 * 60 * 24 * 30,
      path: "/",
    });
    response.headers.set("Cache-Control", "no-store");
    return response;
  }

  if (request.cookies.get(VIEWER_COOKIE)?.value !== expected) {
    return new NextResponse(
      "This is a private, view-only dashboard. Open the complete share link.",
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }

  const response = NextResponse.next();
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

export const config = {
  matcher: ["/", "/api/:path*"],
};
