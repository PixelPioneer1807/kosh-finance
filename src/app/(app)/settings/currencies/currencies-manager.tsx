"use client";

import * as React from "react";
import { toast } from "sonner";
import { AlertTriangle, Check, Coins, DownloadCloud, Pencil, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, NativeSelect } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/controls";
import { ConfirmDialog, Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/misc";
import { CURRENCIES } from "@/lib/money";
import { useAppData } from "@/components/app/user-context";
import { deleteExchangeRateAction, fetchLatestRatesAction, saveExchangeRatesAction, upsertExchangeRateAction } from "../actions";
import { SettingsSection } from "../section";

type Rate = { currency: string; rate: string; updatedAt: string };

const trimRate = (r: string) => (r.includes(".") ? r.replace(/0+$/, "").replace(/\.$/, "") : r);
const currencyName = (c: string) => CURRENCIES.find((x) => x.code === c)?.name ?? c;

export function CurrenciesManager({ base, locale, rates, usedCurrencies }: { base: string; locale: string; rates: Rate[]; usedCurrencies: string[] }) {
  const { prefs } = useAppData();
  const timezone = prefs.timezone;
  const [editing, setEditing] = React.useState<string | null>(null);
  const [editValue, setEditValue] = React.useState("");
  const [editError, setEditError] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [deleting, setDeleting] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const [fetching, setFetching] = React.useState(false);
  const [review, setReview] = React.useState<{ date: string | null; rows: { currency: string; current: string | null; next: string; selected: boolean }[]; missing: string[] } | null>(null);
  const missing = usedCurrencies.filter((c) => !rates.some((r) => r.currency === c));
  const dateFmt = React.useMemo(() => {
    try {
      return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: timezone });
    } catch {
      return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });
    }
  }, [locale, timezone]);

  function saveEdit(currency: string) {
    setEditError(null);
    start(async () => {
      const r = await upsertExchangeRateAction({ currency, rate: editValue.trim() });
      if (r.ok) {
        toast.success(`${currency} rate updated`);
        setEditing(null);
      } else setEditError(r.fieldErrors?.rate?.[0] ?? r.error);
    });
  }

  async function fetchLatest() {
    setFetching(true);
    const wanted = [...new Set([...rates.map((r) => r.currency), ...usedCurrencies])];
    const r = await fetchLatestRatesAction({ currencies: wanted });
    setFetching(false);
    if (!r.ok) {
      toast.error(r.error);
      return;
    }
    const rows = Object.entries(r.data.rates).map(([currency, next]) => ({ currency, current: rates.find((x) => x.currency === currency)?.rate ?? null, next, selected: true }));
    if (!rows.length) {
      toast(r.data.missing.length ? `No reference rates available for ${r.data.missing.join(", ")}.` : "Nothing to update.");
      return;
    }
    setReview({ date: r.data.date, rows, missing: r.data.missing });
  }

  return (
    <div>
      <SettingsSection
        id="rates"
        title="Exchange rates"
        description={
          <>
            How much 1 unit of each currency is worth in your base currency, <strong className="font-medium text-foreground">{base}</strong>. New transactions in that currency are converted at this rate;
            past transactions keep the rate they were recorded with.
          </>
        }
        actions={
          <>
            <Button variant="outline" onClick={fetchLatest} loading={fetching} disabled={!rates.length && !usedCurrencies.length}>
              <DownloadCloud /> Fetch latest rates
            </Button>
            <Button onClick={() => setAdding(true)}>
              <Plus /> Add rate
            </Button>
          </>
        }
      >
        {missing.length > 0 && (
          <div role="status" className="mb-3 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-soft px-4 py-3 text-[13px] text-warning">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p>
              You have accounts in {missing.join(", ")} without a rate. Transactions in {missing.length === 1 ? "that currency" : "those currencies"} can&apos;t be recorded until you add one.
            </p>
          </div>
        )}
        <Card>
          {rates.length === 0 ? (
            <EmptyState
              icon={<Coins />}
              title="No exchange rates"
              description={`Only needed if you have accounts in currencies other than ${base}.`}
              action={
                <Button variant="outline" onClick={() => setAdding(true)}>
                  <Plus /> Add rate
                </Button>
              }
            />
          ) : (
            <table className="w-full text-sm">
              <caption className="sr-only">Exchange rates to {base}</caption>
              <thead>
                <tr className="border-b text-left text-[12px] text-muted-foreground">
                  <th scope="col" className="px-5 py-2.5 font-medium">
                    Currency
                  </th>
                  <th scope="col" className="px-3 py-2.5 font-medium">
                    Rate to {base}
                  </th>
                  <th scope="col" className="hidden px-3 py-2.5 font-medium sm:table-cell">
                    Updated
                  </th>
                  <th scope="col" className="px-3 py-2.5">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rates.map((r) => (
                  <tr key={r.currency}>
                    <td className="px-5 py-3">
                      <p className="font-medium">{r.currency}</p>
                      <p className="text-[12px] text-muted-foreground">{currencyName(r.currency)}</p>
                    </td>
                    <td className="px-3 py-3">
                      {editing === r.currency ? (
                        <form
                          className="grid gap-1"
                          onSubmit={(e) => {
                            e.preventDefault();
                            saveEdit(r.currency);
                          }}
                        >
                          <div className="flex items-center gap-1">
                            <Input
                              autoFocus
                              inputMode="decimal"
                              aria-label={`Rate for ${r.currency}`}
                              className="num h-9 w-36"
                              value={editValue}
                              onChange={(e) => setEditValue(e.target.value)}
                              onKeyDown={(e) => e.key === "Escape" && setEditing(null)}
                              aria-invalid={editError ? true : undefined}
                            />
                            <Button type="submit" size="icon-sm" variant="ghost" aria-label="Save rate" loading={pending}>
                              {!pending && <Check />}
                            </Button>
                            <Button type="button" size="icon-sm" variant="ghost" aria-label="Cancel" onClick={() => setEditing(null)}>
                              <X />
                            </Button>
                          </div>
                          {editError && (
                            <p role="alert" className="text-[12.5px] text-negative">
                              {editError}
                            </p>
                          )}
                        </form>
                      ) : (
                        <p className="num">
                          1 {r.currency} = {trimRate(r.rate)} {base}
                        </p>
                      )}
                    </td>
                    <td className="hidden px-3 py-3 text-[13px] text-muted-foreground sm:table-cell">{dateFmt.format(new Date(r.updatedAt))}</td>
                    <td className="px-3 py-3 text-right whitespace-nowrap">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="size-10 sm:size-8"
                        aria-label={`Edit ${r.currency} rate`}
                        onClick={() => {
                          setEditing(r.currency);
                          setEditValue(trimRate(r.rate));
                          setEditError(null);
                        }}
                      >
                        <Pencil />
                      </Button>
                      <Button variant="ghost" size="icon-sm" className="size-10 sm:size-8" aria-label={`Delete ${r.currency} rate`} onClick={() => setDeleting(r.currency)}>
                        <Trash2 />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <p className="mt-3 text-[12.5px] text-muted-foreground">
          “Fetch latest rates” looks up European Central Bank reference rates (via Frankfurter) on our server. You review them before anything is saved.
        </p>
      </SettingsSection>

      {adding && <AddRateDialog base={base} existing={rates.map((r) => r.currency)} suggested={missing[0]} onClose={() => setAdding(false)} />}

      {deleting && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setDeleting(null)}
          title={`Delete the ${deleting} rate?`}
          description={`Existing transactions keep their recorded rate, but you won't be able to add new ${deleting} transactions until you add a rate again.`}
          confirmLabel="Delete rate"
          loading={pending}
          onConfirm={() =>
            start(async () => {
              const r = await deleteExchangeRateAction({ currency: deleting });
              if (r.ok) {
                toast.success(`${deleting} rate deleted`);
                setDeleting(null);
              } else toast.error(r.error);
            })
          }
        />
      )}

      {review && (
        <Dialog open onOpenChange={(o) => !o && setReview(null)}>
          <DialogContent title="Review latest rates" description={review.date ? `Reference rates published ${review.date}. Untick any you want to keep as they are.` : undefined} size="md">
            <ul className="divide-y rounded-lg border">
              {review.rows.map((row, i) => (
                <li key={row.currency} className="flex items-center gap-3 px-3 py-2.5">
                  <Checkbox
                    id={`fx-${row.currency}`}
                    checked={row.selected}
                    onCheckedChange={(c) => setReview((s) => s && { ...s, rows: s.rows.map((x, j) => (j === i ? { ...x, selected: c === true } : x)) })}
                  />
                  <label htmlFor={`fx-${row.currency}`} className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-3 text-sm">
                    <span className="font-medium">{row.currency}</span>
                    <span className="num text-[13px] text-muted-foreground">
                      {row.current ? <s className="mr-2">{trimRate(row.current)}</s> : <span className="mr-2">new</span>}
                      <span className="text-foreground">{trimRate(row.next)}</span> {base}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            {review.missing.length > 0 && <p className="mt-3 text-[13px] text-muted-foreground">No reference rate for {review.missing.join(", ")} — enter those manually.</p>}
            <DialogFooter>
              <Button variant="outline" onClick={() => setReview(null)}>
                Cancel
              </Button>
              <Button
                loading={pending}
                disabled={!review.rows.some((r) => r.selected)}
                onClick={() =>
                  start(async () => {
                    const list = review.rows.filter((r) => r.selected).map((r) => ({ currency: r.currency, rate: r.next }));
                    const r = await saveExchangeRatesAction(list);
                    if (r.ok) {
                      toast.success(`Updated ${list.length} rate${list.length === 1 ? "" : "s"}`);
                      setReview(null);
                    } else toast.error(r.error);
                  })
                }
              >
                Save selected
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function AddRateDialog({ base, existing, suggested, onClose }: { base: string; existing: string[]; suggested?: string; onClose: () => void }) {
  const options = CURRENCIES.filter((c) => c.code !== base && !existing.includes(c.code));
  const [currency, setCurrency] = React.useState(suggested && options.some((o) => o.code === suggested) ? suggested : (options[0]?.code ?? ""));
  const [rate, setRate] = React.useState("");
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});
  const [pending, start] = React.useTransition();
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Add exchange rate" size="sm">
        <form
          className="grid gap-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setErrors({});
            start(async () => {
              const r = await upsertExchangeRateAction({ currency, rate: rate.trim() });
              if (r.ok) {
                toast.success(`${currency} rate added`);
                onClose();
              } else setErrors(r.fieldErrors ?? { rate: [r.error] });
            });
          }}
        >
          <Field label="Currency" htmlFor="fx-currency" error={errors.currency}>
            <NativeSelect id="fx-currency" value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {options.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} — {c.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label={`1 ${currency || "unit"} equals (in ${base})`} htmlFor="fx-rate" error={errors.rate} hint="Up to 10 decimal places.">
            <Input id="fx-rate" inputMode="decimal" className="num" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="0.0000" autoFocus aria-invalid={errors.rate ? true : undefined} aria-describedby={errors.rate ? "fx-rate-error" : undefined} />
          </Field>
          <DialogFooter className="mt-1">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={pending} disabled={!currency || !rate.trim()}>
              Add rate
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
