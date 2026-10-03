import { NextResponse } from "next/server";
import { z } from "zod";
import { userRoute } from "@/server/safe";
import { deleteReceipt, getReceiptFile } from "@/server/services/receipts";

export const GET = userRoute<{ id: string }>(async (_req, { userId, params }) => {
  const id = z.uuid().parse(params.id);
  const file = await getReceiptFile(userId, id);
  return new NextResponse(new Uint8Array(file.data), {
    headers: {
      "Content-Type": file.mimeType,
      "Content-Length": String(file.sizeBytes),
      "Content-Disposition": `inline; filename="${file.filename.replace(/"/g, "")}"`,
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      // Even a crafted PDF can't run script in our origin.
      "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
    },
  });
});

export const DELETE = userRoute<{ id: string }>(async (_req, { userId, params }) => {
  await deleteReceipt(userId, z.uuid().parse(params.id));
  return NextResponse.json({ ok: true });
});
