"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Monitor, Moon, RotateCcw, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardFooter } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Switch } from "@/components/ui/controls";
import { RANGE_PRESETS } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { updateAppearanceAction } from "../actions";
import { SettingsSection } from "../section";

type Theme = "light" | "dark" | "system";
type Widget = { id: string; visible: boolean };

const THEMES: { value: Theme; label: string; icon: typeof Sun; description: string }[] = [
  { value: "light", label: "Light", icon: Sun, description: "Bright and crisp" },
  { value: "dark", label: "Dark", icon: Moon, description: "Easy on the eyes" },
  { value: "system", label: "System", icon: Monitor, description: "Match this device" },
];

export function AppearanceForm({
  theme: savedTheme,
  widgets: savedWidgets,
  catalog,
  defaultDateRange,
}: {
  theme: Theme;
  widgets: Widget[];
  catalog: { id: string; label: string; description: string }[];
  defaultDateRange: string;
}) {
  const { setTheme } = useTheme();
  const [theme, setLocalTheme] = React.useState<Theme>(savedTheme);
  const [widgets, setWidgets] = React.useState<Widget[]>(savedWidgets);
  const [range, setRange] = React.useState(defaultDateRange);
  const [pending, start] = React.useTransition();
  const [announce, setAnnounce] = React.useState("");
  const rowRefs = React.useRef(new Map<string, HTMLButtonElement | null>());
  const meta = new Map(catalog.map((c) => [c.id, c]));
  const dirty = theme !== savedTheme || range !== defaultDateRange || JSON.stringify(widgets) !== JSON.stringify(savedWidgets);

  function save(next?: { theme?: Theme }) {
    const payload = { theme: next?.theme ?? theme, dashboardWidgets: widgets, defaultDateRange: range };
    start(async () => {
      const r = await updateAppearanceAction(payload);
      if (r.ok) {
        try {
          localStorage.setItem("kosh-theme-synced", payload.theme);
        } catch {
          /* storage unavailable */
        }
        toast.success("Appearance saved");
      } else toast.error(r.error);
    });
  }

  function move(index: number, dir: -1 | 1) {
    const j = index + dir;
    if (j < 0 || j >= widgets.length) return;
    const next = [...widgets];
    [next[index], next[j]] = [next[j], next[index]];
    setWidgets(next);
    const label = meta.get(next[j].id)?.label ?? next[j].id;
    setAnnounce(`${label} moved to position ${j + 1} of ${next.length}`);
    // Keep focus on the same control after the row moves.
    requestAnimationFrame(() => rowRefs.current.get(`${next[j].id}:${dir}`)?.focus());
  }

  return (
    <div>
      <SettingsSection id="theme" title="Theme" description="Saved to your profile, so it follows you to other devices.">
        <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-2 sm:gap-3">
          {THEMES.map(({ value, label, icon: I, description }) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={theme === value}
              onClick={() => {
                setLocalTheme(value);
                setTheme(value);
                save({ theme: value });
              }}
              className={cn(
                "flex flex-col items-start gap-3 rounded-xl border bg-card p-3 text-left shadow-xs transition-colors hover:border-border-strong sm:p-4",
                theme === value && "border-foreground/60 ring-1 ring-foreground/20",
              )}
            >
              <span className="grid size-9 place-items-center rounded-lg bg-muted text-foreground">
                <I className="size-4" aria-hidden />
              </span>
              <span>
                <span className="block text-sm font-medium">{label}</span>
                <span className="hidden text-[12.5px] text-muted-foreground sm:block">{description}</span>
              </span>
            </button>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection
        id="widgets"
        title="Dashboard widgets"
        description="Choose what appears on your dashboard and in what order."
        actions={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setWidgets(catalog.map((c) => ({ id: c.id, visible: true })));
              setAnnounce("Widgets reset to the default layout");
            }}
          >
            <RotateCcw /> Reset to default
          </Button>
        }
      >
        <Card>
          <ol className="divide-y" aria-label="Dashboard widget order">
            {widgets.map((w, i) => {
              const m = meta.get(w.id);
              const switchId = `widget-${w.id}`;
              return (
                <li key={w.id} className={cn("flex items-center gap-3 px-4 py-3 sm:px-5", !w.visible && "bg-subtle")}>
                  <span className="num w-5 shrink-0 text-center text-[12px] text-muted-foreground" aria-hidden>
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <label htmlFor={switchId} className={cn("text-sm font-medium", !w.visible && "text-muted-foreground")}>
                      {m?.label ?? w.id}
                    </label>
                    {m?.description && <p className="truncate text-[12.5px] text-muted-foreground">{m.description}</p>}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      ref={(el) => {
                        rowRefs.current.set(`${w.id}:-1`, el);
                      }}
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-10 sm:size-8"
                      disabled={i === 0}
                      onClick={() => move(i, -1)}
                      aria-label={`Move ${m?.label ?? w.id} up`}
                    >
                      <ArrowUp />
                    </Button>
                    <Button
                      ref={(el) => {
                        rowRefs.current.set(`${w.id}:1`, el);
                      }}
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-10 sm:size-8"
                      disabled={i === widgets.length - 1}
                      onClick={() => move(i, 1)}
                      aria-label={`Move ${m?.label ?? w.id} down`}
                    >
                      <ArrowDown />
                    </Button>
                    <Switch id={switchId} className="ml-2" checked={w.visible} onCheckedChange={(on) => setWidgets((ws) => ws.map((x) => (x.id === w.id ? { ...x, visible: on } : x)))} aria-label={`Show ${m?.label ?? w.id}`} />
                  </div>
                </li>
              );
            })}
          </ol>
          <div className="border-t p-5">
            <Field label="Default dashboard period" htmlFor="defaultDateRange">
              <NativeSelect id="defaultDateRange" value={range} onChange={(e) => setRange(e.target.value)} className="sm:max-w-xs">
                {RANGE_PRESETS.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <CardFooter className="justify-between gap-3">
            <p className="text-[13px] text-muted-foreground">{dirty ? "You have unsaved changes." : "All changes saved."}</p>
            <Button type="button" onClick={() => save()} loading={pending} disabled={!dirty}>
              Save layout
            </Button>
          </CardFooter>
        </Card>
        <p className="sr-only" aria-live="polite">
          {announce}
        </p>
      </SettingsSection>
    </div>
  );
}
