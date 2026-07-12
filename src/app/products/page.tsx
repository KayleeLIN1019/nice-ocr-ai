import { AppShell } from "@/components/app-shell/app-shell";
import { ProductsPage } from "@/components/products/products-page";

export default function Page() {
  return (
    <AppShell>
      <ProductsPage />
    </AppShell>
  );
}
