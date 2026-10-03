"use client";

import { PageError } from "@/components/analytics/page-states";

export default function ErrorBoundary({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <PageError title="Merchants" what="merchant analytics" error={error} retry={retry} />;
}
