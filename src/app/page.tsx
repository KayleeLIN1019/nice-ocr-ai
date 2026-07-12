import { Suspense } from "react";
import { AppShell } from "@/components/app-shell/app-shell";
import { DashboardPage } from "@/components/dashboard/dashboard-page";

export default function Home() {
  return (
    <AppShell>
      <Suspense fallback={<div className="text-sm text-muted-foreground">加载仪表盘...</div>}>
        <DashboardPage />
      </Suspense>
    </AppShell>
  );
}
