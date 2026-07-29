-- Issue #101 — one-time backfill + safe repair for the project cracked-set.
--
-- Two operations, both idempotent and SAFE (no legitimate data is destroyed).
--
-- (1) REPAIR the detectable cross-mode/cross-project mis-fills the pre-existing
--     value-only, mode-blind `propagateCrack` created (KTD3 / AE1). A crack the
--     agent path recorded carries attribution (campaign/attack/task/agent); a
--     `propagateCrack` fill carries NONE. Where a NO-attribution cracked row's
--     `(project, resolved-mode, value)` DOES have an authoritative
--     attribution-backed crack with a DIFFERENT plaintext, the fill contradicts
--     the real crack and is corrected to it. This is provably safe — it aligns a
--     fill to the authoritative crack of the exact same `(project, mode, value)`,
--     never nulls anything, and never touches a row that has no attributed
--     backing (whose correctness cannot be determined from the data — a hash
--     cannot be re-verified in SQL). The forward mode guard on `propagateCrack`
--     prevents any NEW such mis-fill; those undetectable legacy fills without an
--     attributed backing are the residual the guard closes going forward.
--
-- (2) BACKFILL the project cracked-set from every already-cracked `hash_items`
--     row with a resolved mode, so pre-existing cracks are zapped project-wide
--     (U3) without waiting for a per-member add (U12). KTD2: the keyset
--     `cracked_at` is stamped at migration time (current, never the historical
--     crack) so a backfilled row can never sort behind a live agent zap cursor;
--     the true first-crack time is preserved in `original_cracked_at`. Prefers an
--     attribution-backed row per `(project, mode, value)`, else the earliest.
--     ON CONFLICT DO NOTHING makes it idempotent and safe to re-run.

-- (1) Repair contradicted no-attribution fills.
UPDATE "hash_items" AS fill
SET "plaintext" = legit."plaintext"
FROM "hash_lists" AS fhl,
     "hash_items" AS legit,
     "hash_lists" AS lhl
WHERE fill."hash_list_id" = fhl."id"
  AND legit."hash_list_id" = lhl."id"
  AND lhl."project_id" = fhl."project_id"
  AND legit."hash_value" = fill."hash_value"
  AND legit."detected_hashcat_mode" IS NOT DISTINCT FROM fill."detected_hashcat_mode"
  AND fill."cracked_at" IS NOT NULL
  AND fill."plaintext" IS NOT NULL
  AND fill."campaign_id" IS NULL
  AND fill."attack_id" IS NULL
  AND fill."task_id" IS NULL
  AND fill."agent_id" IS NULL
  AND legit."cracked_at" IS NOT NULL
  AND legit."plaintext" IS NOT NULL
  AND (
    legit."campaign_id" IS NOT NULL
    OR legit."attack_id" IS NOT NULL
    OR legit."task_id" IS NOT NULL
    OR legit."agent_id" IS NOT NULL
  )
  AND legit."plaintext" IS DISTINCT FROM fill."plaintext";
--> statement-breakpoint

-- (2) Backfill the cracked-set from existing cracked rows (resolved mode only).
INSERT INTO "project_cracked_hashes"
  ("project_id", "hashcat_mode", "hash_value", "plaintext", "cracked_at", "original_cracked_at", "source_hash_list_id")
SELECT DISTINCT ON (hl."project_id", hi."detected_hashcat_mode", hi."hash_value")
  hl."project_id",
  hi."detected_hashcat_mode",
  hi."hash_value",
  hi."plaintext",
  now(),
  hi."cracked_at",
  hi."hash_list_id"
FROM "hash_items" AS hi
JOIN "hash_lists" AS hl ON hl."id" = hi."hash_list_id"
WHERE hi."cracked_at" IS NOT NULL
  AND hi."detected_hashcat_mode" IS NOT NULL
  AND hi."plaintext" IS NOT NULL
ORDER BY
  hl."project_id",
  hi."detected_hashcat_mode",
  hi."hash_value",
  (hi."campaign_id" IS NOT NULL OR hi."attack_id" IS NOT NULL OR hi."task_id" IS NOT NULL OR hi."agent_id" IS NOT NULL) DESC,
  hi."cracked_at" ASC
ON CONFLICT ("project_id", "hashcat_mode", "hash_value") DO NOTHING;
