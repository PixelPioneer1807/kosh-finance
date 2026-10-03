"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { ErrorState, PageHeader } from "@/components/ui/misc";

export default function GoalsError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <>
      <PageHeader title="Goals" />
      <ErrorState
        message="We couldn't load your goals. Your data is safe — please try again."
        retry={
          <Button size="sm" variant="outline" onClick={() => retry()}>
            Try again
          </Button>
        }
      />
    </>
  );
}
