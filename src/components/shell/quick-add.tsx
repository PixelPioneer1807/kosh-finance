"use client";

import * as React from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { TransactionForm } from "@/components/app/transaction-form";
import { useShell } from "./shell-context";

export function QuickAdd() {
  const { quickAdd, closeQuickAdd } = useShell();
  const p = quickAdd.preset;
  const title = p?.type === "income" ? "Add income" : p?.type === "transfer" ? "Transfer money" : "Add transaction";
  return (
    <Dialog open={quickAdd.open} onOpenChange={(o) => !o && closeQuickAdd()}>
      <DialogContent title={title} size="md">
        <TransactionForm
          // Remount the form each time the sheet opens so it starts fresh.
          key={quickAdd.nonce}
          initialText={p?.text}
          initial={{
            ...(p?.type ? { type: p.type } : {}),
            ...(p?.amount ? { amount: p.amount } : {}),
            ...(p?.categoryId ? { categoryId: p.categoryId } : {}),
            ...(p?.accountId ? { accountId: p.accountId } : {}),
            ...(p?.merchant ? { merchant: p.merchant } : {}),
            ...(p?.date ? { date: p.date } : {}),
            ...(p?.notes ? { notes: p.notes } : {}),
            ...(p?.paymentMethodId ? { paymentMethodId: p.paymentMethodId } : {}),
            ...(p?.receipt ? { receipt: p.receipt } : {}),
          }}
          onDone={closeQuickAdd}
        />
      </DialogContent>
    </Dialog>
  );
}
