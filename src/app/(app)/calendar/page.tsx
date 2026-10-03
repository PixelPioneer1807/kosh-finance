import type { Metadata } from "next";
import { requireUserPage } from "@/server/auth/current";
import { getPreferences } from "@/server/services/preferences";
import { calendarMonth } from "@/server/services/calendar";
import { isISODate } from "@/lib/dates";
import { CalendarView } from "./calendar-view";

export const metadata: Metadata = { title: "Calendar" };

export default async function CalendarPage({ searchParams }: PageProps<"/calendar">) {
  const { user } = await requireUserPage();
  const sp = await searchParams;
  const prefs = await getPreferences(user.id);
  const raw = typeof sp.month === "string" ? sp.month : "";
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(raw) && raw >= "1970-01" && raw <= "2999-12" ? raw : prefs.today.slice(0, 7);
  const data = await calendarMonth(user.id, month);
  const day = typeof sp.day === "string" && isISODate(sp.day) && sp.day >= data.grid.from && sp.day <= data.grid.to ? sp.day : null;
  return <CalendarView key={month} data={data} initialDay={day} />;
}
