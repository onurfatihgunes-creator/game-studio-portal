import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = { title: { default: "Game Studio Portal", template: "%s · Game Studio Portal" }, description: "Portfolio dashboard for Unity mobile games" };
export const viewport: Viewport = { width: "device-width", initialScale: 1 };

// Sets the theme class before first paint to avoid a flash. Falls back to the OS preference.
const themeScript = `try{var t=localStorage.getItem('theme');if(t==='dark'||(!t&&matchMedia('(prefers-color-scheme: dark)').matches))document.documentElement.classList.add('dark')}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
