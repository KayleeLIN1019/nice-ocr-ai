import { AppShell } from "@/components/app-shell/app-shell";
import { SettingsPage } from "@/components/settings/settings-page";

export default function Page() {
  return (
    <AppShell>
      <SettingsPage />
    </AppShell>
  );
}
