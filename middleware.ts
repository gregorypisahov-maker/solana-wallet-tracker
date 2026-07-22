import { NextRequest, NextResponse } from "next/server";

export function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  if (pathname === "/platform") {
    const dashboardUrl = request.nextUrl.clone();
    dashboardUrl.pathname = "/";
    dashboardUrl.searchParams.set("__platform", "1");
    return NextResponse.rewrite(dashboardUrl);
  }

  if (pathname === "/" && request.nextUrl.searchParams.get("__platform") !== "1") {
    const storefrontUrl = request.nextUrl.clone();
    storefrontUrl.pathname = "/storefront";
    return NextResponse.rewrite(storefrontUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/platform"],
};
