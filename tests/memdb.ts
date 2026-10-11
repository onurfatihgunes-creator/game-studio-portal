/** Tiny in-memory stand-in for the parts of supabase-js the portal uses (select/eq/in/order/limit/insert/update/upsert/delete). */
export type Row = Record<string, any>;
export function memdb(tables: Record<string, Row[]>) {
  let seq = 0;
  const from = (name: string) => {
    const rows = (tables[name] ??= []);
    const state: { filters: ((r: Row) => boolean)[]; op: string; payload?: any; onConflict?: string; order?: [string, boolean]; limit?: number; single?: boolean } = { filters: [], op: "select" };
    const run = () => {
      const match = rows.filter((r) => state.filters.every((f) => f(r)));
      if (state.op === "insert") {
        const list = Array.isArray(state.payload) ? state.payload : [state.payload];
        const uniq = (tables.__unique ?? []).find((u: Row) => u.table === name);
        for (const p of list) {
          if (uniq && rows.some((r) => uniq.cols.every((c: string) => r[c] === p[c]))) return { data: null, error: { code: "23505", message: "duplicate key" } };
          rows.push({ id: p.id ?? `id${++seq}`, ...p });
        }
        const out = list.map((p: Row) => rows.find((r) => r === rows[rows.length - list.length + list.indexOf(p)]));
        return { data: state.single ? out[0] : out, error: null };
      }
      if (state.op === "upsert") {
        const cols = String(state.onConflict ?? "id").split(",");
        for (const p of Array.isArray(state.payload) ? state.payload : [state.payload]) {
          const hit = rows.find((r) => cols.every((c) => r[c] === p[c]));
          if (hit) Object.assign(hit, p); else rows.push({ id: p.id ?? `id${++seq}`, ...p });
        }
        return { data: null, error: null };
      }
      if (state.op === "update") { match.forEach((r) => Object.assign(r, state.payload)); return { data: match, error: null }; }
      if (state.op === "delete") { for (const r of match) rows.splice(rows.indexOf(r), 1); return { data: match, error: null }; }
      let out = [...match];
      if (state.order) { const [k, asc] = state.order; out.sort((a, b) => (String(a[k] ?? "") < String(b[k] ?? "") ? -1 : 1) * (asc ? 1 : -1)); }
      if (state.limit) out = out.slice(0, state.limit);
      return { data: state.single ? out[0] ?? null : out, error: null };
    };
    const q: any = {
      select: () => q, eq: (c: string, v: any) => (state.filters.push((r) => r[c] === v), q), in: (c: string, v: any[]) => (state.filters.push((r) => v.includes(r[c])), q),
      order: (c: string, o?: { ascending?: boolean }) => ((state.order = [c, o?.ascending !== false]), q), limit: (n: number) => ((state.limit = n), q),
      insert: (p: any) => ((state.op = "insert"), (state.payload = p), q), update: (p: any) => ((state.op = "update"), (state.payload = p), q), delete: () => ((state.op = "delete"), q),
      upsert: (p: any, o?: { onConflict?: string }) => ((state.op = "upsert"), (state.payload = p), (state.onConflict = o?.onConflict), q),
      maybeSingle: () => ((state.single = true), Promise.resolve(run())), single: () => ((state.single = true), Promise.resolve(run())),
      then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
    };
    return q;
  };
  return { from } as any;
}
