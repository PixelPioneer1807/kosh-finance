import type { Metadata } from "next";
import { requireUserPage } from "@/server/auth/current";
import { listImportBatches } from "@/server/services/import";
import { dataCounts } from "@/server/services/backup";
import { DataManager } from "./data-manager";

export const metadata: Metadata = { title: "Data & backup" };

export default async function DataSettingsPage() {
  const { user } = await requireUserPage();
  const [batches, counts] = await Promise.all([listImportBatches(user.id, 20), dataCounts(user.id)]);
  return (
    <DataManager
      counts={counts}
      batches={batches.map((b) => ({
        id: b.id,
        filename: b.filename,
        rowCount: b.rowCount,
        importedCount: b.importedCount,
        skippedCount: b.skippedCount,
        createdAt: b.createdAt.toISOString(),
        undoneAt: b.undoneAt?.toISOString() ?? null,
      }))}
    />
  );
}
