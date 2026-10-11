import type { MonetizationSummary } from "@/lib/status";
import { Badge } from "./ui";

export function MonetizationBadge({ m }: { m: MonetizationSummary }) {
  if (m.state === "unknown") return <Badge tone="muted" title="Packages/manifest.json could not be read">Not configured</Badge>;
  if (m.state === "not_configured") return <Badge tone="muted" title="No ad SDK found in Packages/manifest.json">Not configured</Badge>;
  return <Badge tone="info" title="Present in the repository; does not prove ads are live">{m.items.join(" + ")}</Badge>;
}
