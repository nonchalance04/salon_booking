-- Verified provider captures are issued by the system, without inventing a staff actor.
-- Existing staff-issued receipts and their immutable snapshots are preserved.
ALTER TABLE "Receipt" ALTER COLUMN "issuedByUserId" DROP NOT NULL;
