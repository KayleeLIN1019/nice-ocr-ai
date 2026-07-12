import { Suspense } from "react";
import { AppShell } from "@/components/app-shell/app-shell";
import { ResultsPage } from "@/components/results/results-page";

export default function Page() {
  return (
    <AppShell>
      <Suspense fallback={<div className="text-sm text-muted-foreground">加载结果...</div>}>
        <ResultsPage />
      </Suspense>
    </AppShell>
  );
}
