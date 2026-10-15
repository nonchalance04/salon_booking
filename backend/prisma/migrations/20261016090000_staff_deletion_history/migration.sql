BEGIN;

-- Keep the original staff UUID for historical grouping after the live row is removed.
ALTER TABLE "AppointmentService"
  ADD COLUMN "staffRecordId" UUID,
  ADD COLUMN "staffFirstNameSnapshot" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "staffLastNameSnapshot" TEXT NOT NULL DEFAULT '';
ALTER TABLE "CommissionRecord"
  ADD COLUMN "staffRecordId" UUID,
  ADD COLUMN "staffFirstNameSnapshot" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "staffLastNameSnapshot" TEXT NOT NULL DEFAULT '';

UPDATE "AppointmentService" line SET
  "staffRecordId" = staff.id,
  "staffFirstNameSnapshot" = staff."firstName",
  "staffLastNameSnapshot" = staff."lastName"
FROM "Staff" staff WHERE staff.id = line."staffId";
UPDATE "CommissionRecord" commission SET
  "staffRecordId" = line."staffRecordId",
  "staffFirstNameSnapshot" = line."staffFirstNameSnapshot",
  "staffLastNameSnapshot" = line."staffLastNameSnapshot"
FROM "AppointmentService" line WHERE line.id = commission."appointmentServiceId";

ALTER TABLE "AppointmentService" DROP CONSTRAINT "AppointmentService_staffId_fkey";
ALTER TABLE "CommissionRecord" DROP CONSTRAINT "CommissionRecord_staffId_fkey";
ALTER TABLE "AppointmentService" ADD CONSTRAINT "AppointmentService_staffRecordId_fkey"
  FOREIGN KEY ("staffRecordId") REFERENCES "Staff"(id) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CommissionRecord" ADD CONSTRAINT "CommissionRecord_staffRecordId_fkey"
  FOREIGN KEY ("staffRecordId") REFERENCES "Staff"(id) ON DELETE SET NULL ON UPDATE CASCADE;

-- Populate snapshots for every writer, including imports and direct Prisma inserts.
-- Reassignment refreshes the staff identity; a staff rename never rewrites history.
CREATE FUNCTION snapshot_appointment_staff() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW."staffId" IS DISTINCT FROM OLD."staffId" THEN
    SELECT id, "firstName", "lastName" INTO
      NEW."staffRecordId", NEW."staffFirstNameSnapshot", NEW."staffLastNameSnapshot"
    FROM "Staff" WHERE id = NEW."staffId" FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Assigned staff must exist' USING ERRCODE = '23503';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AppointmentService_staff_snapshot"
  BEFORE INSERT OR UPDATE OF "staffId" ON "AppointmentService"
  FOR EACH ROW EXECUTE FUNCTION snapshot_appointment_staff();

CREATE FUNCTION snapshot_commission_staff() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT "staffRecordId", "staffFirstNameSnapshot", "staffLastNameSnapshot" INTO
    NEW."staffRecordId", NEW."staffFirstNameSnapshot", NEW."staffLastNameSnapshot"
  FROM "AppointmentService" WHERE id = NEW."appointmentServiceId" AND "staffId" = NEW."staffId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Commission staff must match the appointment service' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "CommissionRecord_staff_snapshot"
  BEFORE INSERT ON "CommissionRecord"
  FOR EACH ROW EXECUTE FUNCTION snapshot_commission_staff();

COMMIT;
