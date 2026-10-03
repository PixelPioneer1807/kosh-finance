import "server-only";

/** Server-side date formatting in the viewing admin's locale and timezone. */
export function adminFormatters(locale: string, timeZone: string) {
  const safe = (opts: Intl.DateTimeFormatOptions) => {
    try {
      return new Intl.DateTimeFormat(locale, { timeZone, ...opts });
    } catch {
      return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...opts });
    }
  };
  const dt = safe({ dateStyle: "medium", timeStyle: "short" });
  const d = safe({ dateStyle: "medium" });
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  return {
    dateTime: (v: Date | null | undefined) => (v ? dt.format(v) : "—"),
    date: (v: Date | null | undefined) => (v ? d.format(v) : "—"),
    relative: (v: Date | null | undefined, now = Date.now()) => {
      if (!v) return "Never";
      const s = (v.getTime() - now) / 1000;
      const a = Math.abs(s);
      if (a < 60) return "Just now";
      if (a < 3600) return rtf.format(Math.round(s / 60), "minute");
      if (a < 86400) return rtf.format(Math.round(s / 3600), "hour");
      if (a < 30 * 86400) return rtf.format(Math.round(s / 86400), "day");
      return d.format(v);
    },
  };
}
