"use client";

import { PageError } from "@/components/analytics/page-states";

export default function ErrorBoundary({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <PageError title="Monthly review" what="your monthly review" error={error} retry={retry} />;
}
