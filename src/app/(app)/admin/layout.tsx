import { requireAdminPage } from "@/server/auth/current";
import { PageHeader } from "@/components/ui/misc";
import { AdminNav } from "./admin-nav";

/** Admin area. Each page also calls requireAdminPage(); actions re-check the role server-side. */
export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  await requireAdminPage();
  return (
    <div>
      <PageHeader title="Admin" description="Run the instance. Admins never see anyone's financial data." className="mb-4" />
      <AdminNav />
      <div className="mt-6">{children}</div>
    </div>
  );
}
