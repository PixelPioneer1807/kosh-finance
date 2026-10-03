"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ErrorState, PageHeader, Skeleton } from "@/components/ui/misc";

/** Route-level error UI for the insight pages. */
export function PageError({ title, what, error, retry }: { title: string; what: string; error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <>
      <PageHeader title={title} />
      <ErrorState
        message={`We couldn't load ${what}. Your data is safe — please try again.`}
        retry={
          <Button size="sm" variant="outline" onClick={() => retry()}>
            Try again
          </Button>
        }
      />
    </>
  );
}

/** Route-level loading skeleton: header, filter row, KPI row and chart cards. */
export function PageSkeleton({ kpis = 4, cards = 2, label }: { kpis?: number; cards?: number; label: string }) {
  return (
    <div aria-busy="true" aria-label={label}>
      <Skeleton className="h-7 w-40" />
      <Skeleton className="mt-2 mb-6 h-4 w-72 max-w-full" />
      <Skeleton className="mb-5 h-9 w-56" />
      <Card className="mb-5 grid grid-cols-2 gap-4 p-4 lg:grid-cols-4">
        {Array.from({ length: kpis }, (_, i) => (
          <div key={i} className="grid gap-2">
            <Skeleton className="h-3.5 w-20" />
            <Skeleton className="h-6 w-28" />
          </div>
        ))}
      </Card>
      <div className="grid gap-5 lg:grid-cols-2">
        {Array.from({ length: cards }, (_, i) => (
          <Card key={i} className="p-5">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="mt-4 h-48 w-full" />
          </Card>
        ))}
      </div>
    </div>
  );
}
