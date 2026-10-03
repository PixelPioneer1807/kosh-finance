"use client";

import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/misc";

export default function AdminError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <ErrorState
      message="This admin page couldn't be loaded. The problem has been logged."
      retry={
        <Button variant="outline" size="sm" onClick={() => retry()}>
          Try again
        </Button>
      }
    />
  );
}
