import { NextRequest, NextResponse } from "next/server";

import { hasViewerAccess, unauthorized } from "../../../../lib/dashboardAuth";
import { resumeScalper } from "../../../../worker/scalpResume";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!hasViewerAccess(request)) return unauthorized();

  const result = await resumeScalper();
  return NextResponse.json(result, {
    status: result.success ? 200 : 500,
    headers: { "Cache-Control": "no-store" },
  });
}
