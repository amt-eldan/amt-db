import { getOrderOptions, getSupplierInvoices } from "@/db/queries";
import { InvoicesView } from "@/components/invoices/invoices-view";

export const dynamic = "force-dynamic";

export default async function InvoicesPage() {
  const [invoices, orders] = await Promise.all([getSupplierInvoices(), getOrderOptions()]);

  return <InvoicesView invoices={invoices} orders={orders} />;
}
