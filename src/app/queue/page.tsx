import { Suspense } from "react";
import { AppShell } from "@/components/app-shell/app-shell";
import { QueuePage } from "@/components/queue/queue-page";

export default function Page() {
  return (
    <AppShell>
      <Suspense fallback={<div className="text-sm text-muted-foreground">加载队列...</div>}>
        <QueuePage />
      </Suspense>
    </AppShell>
  );
}
