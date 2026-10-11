import Link from "next/link";
import { NavLinks } from "@/components/NavLinks";
import { ThemeToggle } from "@/components/ThemeToggle";
import { requireUser } from "@/lib/supabase/server";

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const { user } = await requireUser();

  const signOut = (
    <form action="/auth/signout" method="post">
      <button className="btn" type="submit">Sign out</button>
    </form>
  );

  return (
    <div className="min-h-screen md:grid md:grid-cols-[220px_1fr]">
      <aside className="sticky top-0 hidden h-screen flex-col border-r border-line bg-surface p-4 md:flex">
        <div className="mb-6 px-2 text-sm font-semibold tracking-tight">Game Studio Portal</div>
        <nav className="flex flex-col gap-1"><NavLinks variant="side" /></nav>
        <div className="mt-auto flex flex-col gap-2">
          <Link href="/system" className="px-1 text-xs text-muted hover:underline">System check</Link>
          <p className="truncate px-1 text-xs text-muted" title={user.email ?? ""}>{user.email}</p>
          <div className="flex gap-2"><ThemeToggle />{signOut}</div>
        </div>
      </aside>

      <header className="flex items-center justify-between border-b border-line bg-surface px-4 py-2.5 md:hidden">
        <span className="text-sm font-semibold">Game Studio Portal</span>
        <div className="flex gap-2"><ThemeToggle />{signOut}</div>
      </header>

      <main className="mx-auto w-full min-w-0 max-w-6xl px-4 pb-24 pt-6 md:px-8 md:pb-10 md:pt-8">{children}</main>

      <nav className="fixed inset-x-0 bottom-0 z-10 flex border-t border-line bg-surface md:hidden" aria-label="Primary">
        <NavLinks variant="bottom" />
      </nav>
    </div>
  );
}
