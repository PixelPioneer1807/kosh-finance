import type { Metadata } from "next";
import { requireUserPage } from "@/server/auth/current";
import { PageHeader } from "@/components/ui/misc";
import { ImportWizard } from "./import-wizard";

export const metadata: Metadata = { title: "Import" };

export default async function ImportPage() {
  await requireUserPage();
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Import transactions" description="Upload a CSV from your bank or another app. Nothing is saved until you confirm." />
      <ImportWizard />
    </div>
  );
}
