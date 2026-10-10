"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/", label: "Overview", icon: "M3 12l9-9 9 9M5 10v10h5v-6h4v6h5V10" },
  { href: "/games", label: "Games", icon: "M6 12h4M8 10v4M15 13h.01M18 11h.01M17.3 5H6.7a4 4 0 00-3.9 3.1l-1.5 6.6A2.5 2.5 0 005.8 17.5L7 16h10l1.2 1.5a2.5 2.5 0 004.5-2.8l-1.5-6.6A4 4 0 0017.3 5z" },
  { href: "/releases", label: "Releases", icon: "M12 2l3 7h7l-5.5 4.5L18.5 21 12 16.8 5.5 21l2-7.5L2 9h7z" },
  { href: "/revenue", label: "Revenue", icon: "M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" },
];

function Icon({ d }: { d: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

export function NavLinks({ variant }: { variant: "side" | "bottom" }) {
  const path = usePathname();
  const active = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));

  if (variant === "bottom") {
    return (
      <>
        {ITEMS.map((i) => (
          <Link key={i.href} href={i.href} aria-current={active(i.href) ? "page" : undefined}
            className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] ${active(i.href) ? "text-accent" : "text-muted"}`}>
            <Icon d={i.icon} />
            {i.label}
          </Link>
        ))}
      </>
    );
  }
  return (
    <>
      {ITEMS.map((i) => (
        <Link key={i.href} href={i.href} aria-current={active(i.href) ? "page" : undefined}
          className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium ${active(i.href) ? "bg-surface-2 text-fg" : "text-muted hover:bg-surface-2 hover:text-fg"}`}>
          <Icon d={i.icon} />
          {i.label}
        </Link>
      ))}
    </>
  );
}
