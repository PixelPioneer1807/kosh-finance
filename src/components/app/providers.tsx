"use client";

import * as React from "react";
import { ThemeProvider } from "next-themes";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/menu";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <TooltipProvider>
        {children}
        <Toaster
          position="top-center"
          closeButton
          toastOptions={{
            classNames: {
              toast: "!rounded-lg !border !border-border !bg-popover !text-foreground !shadow-md !font-sans",
              description: "!text-muted-foreground",
              actionButton: "!bg-primary !text-primary-foreground",
            },
          }}
        />
      </TooltipProvider>
    </ThemeProvider>
  );
}
