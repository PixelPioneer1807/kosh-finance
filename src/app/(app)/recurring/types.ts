export type RecurringKindId = "expense" | "bill" | "subscription" | "income" | "transfer";
export type FrequencyId = "daily" | "weekly" | "biweekly" | "monthly" | "quarterly" | "yearly" | "custom";
export type UnitId = "day" | "week" | "month" | "year";
export type Deduction = { label: string; amount: string; kind: "tax" | "deduction" | "bonus" };

/** Serialisable recurring item as passed from the page to client components. */
export type RecurringItem = {
  id: string;
  kind: RecurringKindId;
  name: string;
  amount: string;
  currency: string;
  accountId: string | null;
  toAccountId: string | null;
  categoryId: string | null;
  paymentMethodId: string | null;
  merchant: string | null;
  notes: string | null;
  frequency: FrequencyId;
  interval: number;
  intervalUnit: UnitId;
  startDate: string;
  endDate: string | null;
  nextDate: string | null;
  autoPost: boolean;
  remindDaysBefore: number;
  status: "active" | "paused" | "cancelled" | "ended";
  serviceUrl: string | null;
  trialEndsAt: string | null;
  cancelledAt: string | null;
  employer: string | null;
  grossAmount: string | null;
  deductions: Deduction[];
  /** Normalised cost in the item's currency. */
  monthly: string;
  yearly: string;
  lastPaid: { date: string; amount: string } | null;
};

export type OccurrenceRow = {
  recurringId: string;
  name: string;
  kind: RecurringKindId;
  date: string;
  amount: string;
  currency: string;
  baseAmount: string | null;
  accountId: string | null;
  categoryId: string | null;
  autoPost: boolean;
  status: "overdue" | "due" | "upcoming";
};

export type CostSummary = {
  count: number;
  monthly: string;
  yearly: string;
  currency: string;
  unconvertedCurrencies: string[];
};

export type Suggestion = {
  merchantId: string;
  merchantName: string;
  categoryId: string | null;
  accountId: string;
  currency: string;
  typicalAmount: string;
  fixedAmount: boolean;
  frequency: "weekly" | "biweekly" | "monthly" | "quarterly" | "yearly";
  lastDate: string;
  nextExpected: string;
  count: number;
};

export type PriceChangeRow = {
  recurringId: string;
  name: string;
  currency: string;
  expected: string;
  charged: string;
  difference: string;
  changePct: number;
  date: string;
};

export const KIND_LABEL: Record<RecurringKindId, string> = {
  bill: "Bill",
  subscription: "Subscription",
  income: "Income",
  expense: "Recurring expense",
  transfer: "Transfer",
};
