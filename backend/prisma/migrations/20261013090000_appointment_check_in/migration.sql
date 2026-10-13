ALTER TABLE "Appointment"
  ADD COLUMN "checkedInAt" TIMESTAMPTZ(3),
  ADD COLUMN "checkedInByUserId" UUID,
  ADD CONSTRAINT "Appointment_checkedInByUserId_fkey"
    FOREIGN KEY ("checkedInByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "Appointment_check_in_pair_check"
    CHECK (("checkedInAt" IS NULL) = ("checkedInByUserId" IS NULL));
