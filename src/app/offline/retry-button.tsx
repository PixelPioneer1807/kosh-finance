"use client";

import * as React from "react";
import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export function RetryButton() {
  React.useEffect(() => {
    // Come back automatically as soon as the connection returns.
    const onOnline = () => window.location.reload();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, []);
  return (
    <Button className="mt-6" onClick={() => window.location.reload()}>
      <RotateCw /> Try again
    </Button>
  );
}
