import * as React from "react";
import {
  Award, BadgeAlert, BadgePercent, Banknote, Bike, BookOpen, Briefcase, Baby, Bus, Car, CarTaxiFront, Cat, CircleDashed, CirclePlus,
  Clapperboard, Coffee, CreditCard, Dog, Droplet, Dumbbell, FileText, Flame, Fuel, Gamepad2, Gem, Gift, GraduationCap, HandCoins,
  HeartPulse, House, KeyRound, Landmark, Laptop, Music, Percent, Phone, PiggyBank, Pill, Plane, Receipt, Repeat, Scissors, Shield,
  Shirt, ShoppingBag, ShoppingBasket, ShoppingCart, Smartphone, Sofa, Sparkles, SquareParking, Stethoscope, Store, TrainFront,
  TrendingUp, Tv, Users, Utensils, UtensilsCrossed, Wallet, Wifi, Wrench, Zap, Baby as BabyIcon, Wine, Pizza, Book, Hammer,
  Hotel, Ticket, Package, Leaf, Heart, Building2, Circle, type LucideIcon,
} from "lucide-react";

/** Curated icon set for categories/accounts (keeps the bundle small vs importing every icon). */
export const ICONS: Record<string, LucideIcon> = {
  award: Award, "badge-alert": BadgeAlert, "badge-percent": BadgePercent, banknote: Banknote, bike: Bike, "book-open": BookOpen,
  book: Book, briefcase: Briefcase, baby: Baby, bus: Bus, car: Car, "car-taxi-front": CarTaxiFront, cat: Cat, "circle-dashed": CircleDashed,
  "circle-plus": CirclePlus, clapperboard: Clapperboard, coffee: Coffee, "credit-card": CreditCard, dog: Dog, droplet: Droplet,
  dumbbell: Dumbbell, "file-text": FileText, flame: Flame, fuel: Fuel, gamepad: Gamepad2, gem: Gem, gift: Gift,
  "graduation-cap": GraduationCap, "hand-coins": HandCoins, "heart-pulse": HeartPulse, heart: Heart, house: House, "key-round": KeyRound,
  landmark: Landmark, laptop: Laptop, music: Music, percent: Percent, phone: Phone, "piggy-bank": PiggyBank, pill: Pill, plane: Plane,
  receipt: Receipt, repeat: Repeat, scissors: Scissors, shield: Shield, shirt: Shirt, "shopping-bag": ShoppingBag,
  "shopping-basket": ShoppingBasket, "shopping-cart": ShoppingCart, smartphone: Smartphone, sofa: Sofa, sparkles: Sparkles,
  "square-parking": SquareParking, stethoscope: Stethoscope, store: Store, "train-front": TrainFront, "trending-up": TrendingUp,
  tv: Tv, users: Users, utensils: Utensils, "utensils-crossed": UtensilsCrossed, wallet: Wallet, wifi: Wifi, wrench: Wrench, zap: Zap,
  wine: Wine, pizza: Pizza, hammer: Hammer, hotel: Hotel, ticket: Ticket, package: Package, leaf: Leaf, building: Building2,
  circle: Circle, infant: BabyIcon,
};
export const ICON_NAMES = Object.keys(ICONS).filter((k) => k !== "infant");

export function Icon({ name, className, ...props }: { name?: string | null; className?: string } & React.SVGProps<SVGSVGElement>) {
  const C = (name && ICONS[name]) || Circle;
  return <C className={className} aria-hidden {...(props as object)} />;
}

/** Coloured round badge used for categories throughout the app. */
export function CategoryBadge({ icon, color, size = "md", className }: { icon?: string | null; color?: string | null; size?: "sm" | "md" | "lg"; className?: string }) {
  const s = { sm: "size-6 [&_svg]:size-3.5", md: "size-8 [&_svg]:size-4", lg: "size-10 [&_svg]:size-5" }[size];
  const c = color ?? "#78716c";
  return (
    <span
      className={`inline-grid shrink-0 place-items-center rounded-full ${s} ${className ?? ""}`}
      style={{ backgroundColor: `color-mix(in oklab, ${c} 16%, transparent)`, color: c }}
    >
      <Icon name={icon ?? "circle"} />
    </span>
  );
}

export const CATEGORY_COLORS = [
  "#ef4444", "#f97316", "#f59e0b", "#eab308", "#84cc16", "#22c55e", "#10b981", "#14b8a6", "#06b6d4", "#0ea5e9",
  "#3b82f6", "#6366f1", "#8b5cf6", "#a855f7", "#d946ef", "#ec4899", "#f43f5e", "#78716c", "#64748b", "#0f766e",
];
