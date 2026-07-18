import { redirect } from "next/navigation";

// Purchase Orders merged into the unified Matching workspace (All POs lens).
export default function PurchaseOrdersRedirect() {
  redirect("/matching?tab=orders");
}
