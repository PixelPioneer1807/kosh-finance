import { NextResponse } from "next/server";
import { userRoute } from "@/server/safe";
import { globalSearch } from "@/server/services/search";

export const GET = userRoute(async (req, { userId }) => {
  const q = new URL(req.url).searchParams.get("q") ?? "";
  const results = await globalSearch(userId, q);
  return NextResponse.json({ results }, { headers: { "Cache-Control": "private, no-store" } });
});
