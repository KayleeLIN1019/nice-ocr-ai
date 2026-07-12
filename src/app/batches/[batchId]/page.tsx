import { AppShell } from "@/components/app-shell/app-shell";
import { BatchDetailPage } from "@/components/batches/batch-detail-page";

export default async function Page({ params }: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await params;
  return (
    <AppShell>
      <BatchDetailPage batchId={batchId} />
    </AppShell>
  );
}
