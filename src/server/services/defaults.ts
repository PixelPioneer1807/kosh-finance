import type { Tx } from "@/server/db";
import { categories, paymentMethods } from "@/server/db/schema";

type Def = { name: string; icon: string; color: string; children?: { name: string; icon: string }[] };

/** Starter categories copied into every new account. Users can rename, recolour, reorder or delete them. */
export const DEFAULT_EXPENSE_CATEGORIES: Def[] = [
  { name: "Housing", icon: "house", color: "#8b5cf6", children: [{ name: "Rent", icon: "key-round" }, { name: "Maintenance", icon: "wrench" }] },
  {
    name: "Food & Dining",
    icon: "utensils",
    color: "#f97316",
    children: [{ name: "Groceries", icon: "shopping-basket" }, { name: "Restaurants", icon: "utensils-crossed" }, { name: "Coffee", icon: "coffee" }, { name: "Food delivery", icon: "bike" }],
  },
  {
    name: "Transportation",
    icon: "car",
    color: "#0ea5e9",
    children: [{ name: "Fuel", icon: "fuel" }, { name: "Taxi & rideshare", icon: "car-taxi-front" }, { name: "Public transit", icon: "train-front" }, { name: "Parking & tolls", icon: "square-parking" }],
  },
  {
    name: "Shopping",
    icon: "shopping-bag",
    color: "#ec4899",
    children: [{ name: "Clothing", icon: "shirt" }, { name: "Electronics", icon: "smartphone" }, { name: "Household", icon: "sofa" }],
  },
  { name: "Bills & Utilities", icon: "receipt", color: "#eab308", children: [{ name: "Electricity", icon: "zap" }, { name: "Water", icon: "droplet" }, { name: "Internet", icon: "wifi" }, { name: "Phone", icon: "phone" }, { name: "Gas", icon: "flame" }] },
  { name: "Subscriptions", icon: "repeat", color: "#6366f1" },
  { name: "Entertainment", icon: "clapperboard", color: "#a855f7" },
  { name: "Health", icon: "heart-pulse", color: "#ef4444", children: [{ name: "Medical", icon: "stethoscope" }, { name: "Pharmacy", icon: "pill" }, { name: "Fitness", icon: "dumbbell" }] },
  { name: "Education", icon: "graduation-cap", color: "#14b8a6" },
  { name: "Travel", icon: "plane", color: "#06b6d4" },
  { name: "Personal Care", icon: "sparkles", color: "#f43f5e" },
  { name: "Family", icon: "users", color: "#84cc16" },
  { name: "Gifts & Donations", icon: "gift", color: "#d946ef" },
  {
    name: "Financial",
    icon: "landmark",
    color: "#64748b",
    children: [{ name: "Fees & charges", icon: "badge-alert" }, { name: "Insurance", icon: "shield" }, { name: "Taxes", icon: "file-text" }, { name: "Loan & EMI", icon: "hand-coins" }, { name: "Interest paid", icon: "percent" }],
  },
  { name: "Other", icon: "circle-dashed", color: "#78716c" },
];

export const DEFAULT_INCOME_CATEGORIES: Def[] = [
  { name: "Salary", icon: "briefcase", color: "#10b981" },
  { name: "Freelance", icon: "laptop", color: "#22c55e" },
  { name: "Business", icon: "store", color: "#059669" },
  { name: "Bonus", icon: "award", color: "#16a34a" },
  { name: "Investment income", icon: "trending-up", color: "#0d9488" },
  { name: "Interest", icon: "percent", color: "#15803d" },
  { name: "Cashback & rewards", icon: "badge-percent", color: "#65a30d" },
  { name: "Gifts received", icon: "gift", color: "#4d7c0f" },
  { name: "Other income", icon: "circle-plus", color: "#047857" },
];

export const DEFAULT_PAYMENT_METHODS = [
  { name: "Cash", type: "cash" },
  { name: "Debit card", type: "debit_card" },
  { name: "Credit card", type: "credit_card" },
  { name: "Bank transfer", type: "bank_transfer" },
  { name: "UPI", type: "upi" },
  { name: "Wallet", type: "wallet" },
  { name: "Other", type: "other" },
] as const;

export async function seedUserDefaults(tx: Tx, userId: string) {
  const insertTree = async (defs: Def[], kind: "expense" | "income") => {
    const parents = await tx
      .insert(categories)
      .values(defs.map((d, i) => ({ userId, name: d.name, icon: d.icon, color: d.color, kind, sortOrder: i })))
      .returning({ id: categories.id, name: categories.name });
    const byName = new Map(parents.map((p) => [p.name, p.id]));
    const children = defs.flatMap((d) =>
      (d.children ?? []).map((c, i) => ({ userId, parentId: byName.get(d.name)!, name: c.name, icon: c.icon, color: d.color, kind, sortOrder: i })),
    );
    if (children.length) await tx.insert(categories).values(children);
  };
  await insertTree(DEFAULT_EXPENSE_CATEGORIES, "expense");
  await insertTree(DEFAULT_INCOME_CATEGORIES, "income");
  await tx.insert(paymentMethods).values(DEFAULT_PAYMENT_METHODS.map((p, i) => ({ userId, name: p.name, type: p.type, sortOrder: i })));
}
