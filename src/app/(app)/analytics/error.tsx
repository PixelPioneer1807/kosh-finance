"use client";

import { PageError } from "@/components/analytics/page-states";

export default function ErrorBoundary({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <PageError title="Analytics" what="your analytics" error={error} retry={retry} />;
}
