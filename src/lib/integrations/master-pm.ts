import type { GameRow } from "../types";

/**
 * Integration boundary for the existing Master Game PM.
 *
 * Rules for this boundary:
 *  - The portal never modifies, replaces or deletes anything in Master Game PM.
 *  - The only data that crosses is an opaque `pm_ref` string stored on our `games` row
 *    and, optionally, a deep link built from MASTER_PM_BASE_URL.
 *  - To integrate further, implement MasterGamePm below in this file; no other file
 *    in the portal should talk to the PM project.
 */
export interface MasterGamePm {
  /** URL of the game's page in Master Game PM, or null if it cannot be determined. */
  linkFor(game: Pick<GameRow, "pm_ref" | "name">): string | null;
}

class LinkOnlyMasterGamePm implements MasterGamePm {
  constructor(private readonly baseUrl: string | null) {}
  linkFor(game: Pick<GameRow, "pm_ref">): string | null {
    if (!this.baseUrl || !game.pm_ref) return null;
    return `${this.baseUrl.replace(/\/$/, "")}/${encodeURIComponent(game.pm_ref)}`;
  }
}

export const masterGamePm: MasterGamePm = new LinkOnlyMasterGamePm(process.env.MASTER_PM_BASE_URL?.trim() || null);
