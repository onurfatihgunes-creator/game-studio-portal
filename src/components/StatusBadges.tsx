import { AGGREGATE_LABEL, AGGREGATE_TONE, conclusionLabel, runState, type Aggregate, type MonetizationSummary } from "@/lib/status";
import type { WorkflowRow } from "@/lib/types";
import { Badge } from "./ui";

export function AggregateBadge({ value, title }: { value: Aggregate; title?: string }) {
  return <Badge tone={AGGREGATE_TONE[value]} title={title}>{AGGREGATE_LABEL[value]}</Badge>;
}

export function RunBadge({ w }: { w: WorkflowRow }) {
  const s = runState(w);
  const tone = s === "passing" ? "good" : s === "failing" ? "bad" : s === "running" ? "info" : s === "other" ? "warn" : "muted";
  return <Badge tone={tone}>{conclusionLabel(w)}</Badge>;
}

export function MonetizationBadge({ m }: { m: MonetizationSummary }) {
  if (m.state === "unknown") return <Badge tone="muted" title="Packages/manifest.json could not be read">Not configured</Badge>;
  if (m.state === "not_configured") return <Badge tone="muted" title="No ad or IAP SDK found in Packages/manifest.json">Not configured</Badge>;
  return <Badge tone="info" title="SDK present in Packages/manifest.json — does not prove ads are live">{m.items.join(" + ")} detected</Badge>;
}
