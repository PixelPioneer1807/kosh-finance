import {
  LayoutDashboard, ArrowLeftRight, CalendarDays, PieChart, Repeat, Target, Landmark, TrendingUp, BarChart3, ClipboardCheck,
  FileBarChart, Sparkles, Settings, Shield, Upload, type LucideIcon,
} from "lucide-react";

export type NavItem = { href: string; label: string; icon: LucideIcon; adminOnly?: boolean; ai?: boolean };
export type NavGroup = { label?: string; items: NavItem[] };

export const NAV: NavGroup[] = [
  {
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { href: "/transactions", label: "Transactions", icon: ArrowLeftRight },
      { href: "/calendar", label: "Calendar", icon: CalendarDays },
    ],
  },
  {
    label: "Plan",
    items: [
      { href: "/budgets", label: "Budgets", icon: PieChart },
      { href: "/recurring", label: "Bills & recurring", icon: Repeat },
      { href: "/goals", label: "Goals", icon: Target },
    ],
  },
  {
    label: "Wealth",
    items: [
      { href: "/accounts", label: "Accounts", icon: Landmark },
      { href: "/net-worth", label: "Net worth", icon: TrendingUp },
    ],
  },
  {
    label: "Insights",
    items: [
      { href: "/analytics", label: "Analytics", icon: BarChart3 },
      { href: "/review", label: "Monthly review", icon: ClipboardCheck },
      { href: "/reports", label: "Reports", icon: FileBarChart },
      { href: "/assistant", label: "Assistant", icon: Sparkles, ai: true },
    ],
  },
];

export const NAV_FOOTER: NavItem[] = [
  { href: "/import", label: "Import", icon: Upload },
  { href: "/settings", label: "Settings", icon: Settings },
  { href: "/admin", label: "Admin", icon: Shield, adminOnly: true },
];

export function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(href + "/");
}
