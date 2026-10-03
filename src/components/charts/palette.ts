/**
 * Chart colour roles (CSS variables defined in globals.css for light & dark).
 * Rules (dataviz skill): assign categorical slots in fixed order and never cycle; fold a 9th+
 * series into "Other"; one y-axis per chart; text uses text tokens, never series colours;
 * forecasts are dashed + the --forecast grey so they never read as actuals.
 */
export const SERIES = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => `var(--series-${i})`);
export const COLORS = {
  income: "var(--series-3)",
  spending: "var(--series-1)",
  savings: "var(--series-7)",
  forecast: "var(--forecast)",
  grid: "var(--chart-grid)",
  axis: "var(--muted-foreground)",
  text: "var(--foreground)",
  seqLight: "var(--seq-200)",
  seq: "var(--seq-400)",
  seqDark: "var(--seq-600)",
  positive: "var(--positive)",
  negative: "var(--negative)",
};
export const MAX_SERIES = 8;
