import type { Metadata } from "next";
import { requireUserPage } from "@/server/auth/current";
import { listPaymentMethods } from "@/server/services/taxonomy";
import { listAccounts } from "@/server/services/accounts";
import { PaymentMethodsManager } from "./payment-methods-manager";

export const metadata: Metadata = { title: "Payment methods" };

export default async function PaymentMethodsPage() {
  const { user } = await requireUserPage();
  const [methods, accounts] = await Promise.all([listPaymentMethods(user.id, { includeArchived: true }), listAccounts(user.id)]);
  return (
    <PaymentMethodsManager
      methods={methods.map((m) => ({ id: m.id, name: m.name, type: m.type, defaultAccountId: m.defaultAccountId, isArchived: m.isArchived }))}
      accounts={accounts.map((a) => ({ id: a.id, name: a.name }))}
    />
  );
}
