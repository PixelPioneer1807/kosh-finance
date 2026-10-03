export const ACCOUNT_TYPES_CLIENT = [
  { id: "checking", label: "Bank", icon: "landmark", placeholder: "e.g. Main bank account" },
  { id: "savings", label: "Savings", icon: "piggy-bank", placeholder: "e.g. Savings account" },
  { id: "cash", label: "Cash", icon: "banknote", placeholder: "e.g. Wallet cash" },
  { id: "wallet", label: "Wallet", icon: "wallet", placeholder: "e.g. Digital wallet" },
  { id: "credit_card", label: "Credit card", icon: "credit-card", placeholder: "e.g. Travel card" },
  { id: "investment", label: "Investment", icon: "trending-up", placeholder: "e.g. Brokerage" },
  { id: "loan", label: "Loan", icon: "hand-coins", placeholder: "e.g. Car loan" },
  { id: "asset", label: "Asset", icon: "gem", placeholder: "e.g. Gold, property" },
  { id: "other", label: "Other", icon: "circle-dashed", placeholder: "Account name" },
] as const;
