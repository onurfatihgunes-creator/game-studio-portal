import type { Metadata } from "next";
import { PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/supabase/server";
import { SystemCheck } from "./SystemCheck";

export const metadata: Metadata = { title: "System check" };

export default async function SystemPage() {
  await requireUser();
  return (
    <>
      <PageHeader title="System check" subtitle="Verifies the database schema, configuration and every page with your own session." />
      <SystemCheck defaultRepo={process.env.SELFTEST_REPO ?? ""} canExercise={process.env.NODE_ENV !== "production"} />
    </>
  );
}
