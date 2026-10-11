import type { Metadata } from "next";
import Link from "next/link";
import { MigrationNotice } from "@/components/MigrationNotice";
import { PageHeader } from "@/components/ui";
import { phase2Ready } from "@/lib/phase2";
import { requireUser } from "@/lib/supabase/server";
import { ImportIds } from "./ImportIds";

export const metadata: Metadata = { title: "Import AdMob IDs" };

export default async function AdsImportPage() {
  const { supabase } = await requireUser();
  if (!(await phase2Ready(supabase))) return <><PageHeader title="Import AdMob IDs" /><MigrationNotice what="Advertising configuration" /></>;
  return (
    <>
      <PageHeader title="Import AdMob IDs" subtitle="Paste the IDs from AdMob. Nothing is applied until you review the preview. Imported configurations stay disabled and in test mode." />
      <ImportIds />
      <p className="mt-6 text-sm"><Link href="/revenue" className="text-muted hover:underline">← Revenue</Link></p>
    </>
  );
}
