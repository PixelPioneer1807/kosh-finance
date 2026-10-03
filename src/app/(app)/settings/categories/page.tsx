import type { Metadata } from "next";
import { requireUserPage } from "@/server/auth/current";
import { listCategories } from "@/server/services/taxonomy";
import { categoryUsage } from "@/server/services/settings";
import { CategoriesManager } from "./categories-manager";

export const metadata: Metadata = { title: "Categories" };

export default async function CategoriesSettingsPage() {
  const { user } = await requireUserPage();
  const [cats, usage] = await Promise.all([listCategories(user.id, { includeArchived: true }), categoryUsage(user.id)]);
  return (
    <CategoriesManager
      categories={cats.map((c) => ({
        id: c.id,
        name: c.name,
        kind: c.kind,
        parentId: c.parentId,
        icon: c.icon,
        color: c.color,
        isArchived: c.isArchived,
        excludeFromReports: c.excludeFromReports,
        sortOrder: c.sortOrder,
      }))}
      usage={usage}
    />
  );
}
