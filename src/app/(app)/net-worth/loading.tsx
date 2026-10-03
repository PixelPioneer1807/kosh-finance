import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/misc";

export default function NetWorthLoading() {
  return (
    <div aria-busy="true" aria-label="Loading net worth">
      <div className="mb-6 grid gap-2">
        <Skeleton className="h-7 w-36" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <Card className="mb-6 grid gap-6 p-5 lg:grid-cols-[1fr_1.4fr]">
        <div className="grid content-start gap-3">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-12 w-56" />
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-44" />
        </div>
        <Skeleton className="h-64 sm:h-72" />
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        {[0, 1].map((i) => (
          <Card key={i} className="grid gap-3 p-5">
            <Skeleton className="h-4 w-28" />
            {[0, 1, 2].map((j) => (
              <Skeleton key={j} className="h-8" />
            ))}
          </Card>
        ))}
      </div>
    </div>
  );
}
