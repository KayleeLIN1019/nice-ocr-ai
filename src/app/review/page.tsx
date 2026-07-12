import { Suspense } from "react";
import { AppShell } from "@/components/app-shell/app-shell";
import { ReviewPage } from "@/components/review/review-page";

export default function Page() {
  return (
    <AppShell>
      <Suspense fallback={<div className="text-sm text-muted-foreground">加载审核台...</div>}>
        <ReviewPage />
      </Suspense>
    </AppShell>
  );
}
