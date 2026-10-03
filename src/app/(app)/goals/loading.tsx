import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/misc";

export default function GoalsLoading() {
  return (
    <div aria-busy="true" aria-label="Loading goals">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-2">
          <Skeleton className="h-7 w-28" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
        <Skeleton className="h-9 w-28" />
      </div>
      <Skeleton className="mb-4 h-9 w-72 max-w-full" />
      <Card className="divide-y">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex gap-4 px-5 py-4">
            <Skeleton className="size-[52px] rounded-full" />
            <div className="grid flex-1 gap-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-4 w-56 max-w-full" />
              <Skeleton className="h-3.5 w-64 max-w-full" />
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}
