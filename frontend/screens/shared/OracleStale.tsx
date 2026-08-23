"use client";
/**
 * OracleStaleBadge — the one rendering of the one stale state. Every surface that shows a TWAP-derived
 * number (swap impact on our venue, the engine range bar and batch heartbeat, the queue clock, the
 * deposit flows) renders THIS when `OracleHealth.stale` is true, so the copy is identical everywhere
 * by construction: it comes from ORACLE_STALE_COPY and is not spelled out in any screen.
 *
 * Style is self-contained (inline) so the badge reads the same inside the Burrow card system and the
 * pixel-art pools page; a consumer may pass `className` for placement only.
 */
import { ORACLE_STALE_COPY, oracleAgeLabel } from "@/lib/mole/oracle";

export function OracleStaleBadge({ ageSec, className }: { ageSec: number; className?: string }) {
  const age = oracleAgeLabel(ageSec);
  return (
    <span
      data-testid="oracle-stale"
      className={className}
      title={`No oracle observation for ${age}. The TWAP is the last tick, extended — not an average.`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontSize: 11,
        fontWeight: 800,
        letterSpacing: ".08em",
        textTransform: "uppercase",
        lineHeight: 1,
        padding: "4px 8px",
        borderRadius: 7,
        background: "rgba(191, 58, 40, .16)",
        color: "#d9584a",
        border: "1px solid rgba(191, 58, 40, .45)",
        whiteSpace: "nowrap",
      }}
    >
      ⚠ {ORACLE_STALE_COPY}
      <span style={{ fontWeight: 600, opacity: 0.8 }}>{age}</span>
    </span>
  );
}
