import { redirect } from "next/navigation";

// The Inbox merged into the unified Matching workspace. Preserve deep links:
// /inbox?tab=deviations|overdue → the Inbox lens; everything else → Inbox.
export default async function InboxRedirect({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  const done = tab === "done";
  redirect(`/matching?tab=${done ? "done" : "inbox"}`);
}
