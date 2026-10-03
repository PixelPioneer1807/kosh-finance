"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { ErrorState, PageHeader } from "@/components/ui/misc";

export default function NetWorthError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <>
      <PageHeader title="Net worth" />
      <ErrorState
        message="We couldn't calculate your net worth right now. Please try again."
        retry={
          <Button size="sm" variant="outline" onClick={() => retry()}>
            Try again
          </Button>
        }
      />
    </>
  );
}
