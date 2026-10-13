ALTER TABLE "Service" ADD COLUMN "category" TEXT NOT NULL DEFAULT 'Other';

-- The existing approved menu uses these exact descriptions as group names.
-- Unknown descriptions remain Other for an administrator to classify.
UPDATE "Service" SET "category" = CASE
  WHEN "description" IN ('Hair Services', 'Hair Color & Styling', 'Hair Treatments') THEN 'Hair'
  WHEN "description" = 'Nail Services' THEN 'Nails'
  WHEN "description" = 'Spa & Relaxation' THEN 'Spa & Relaxation'
  ELSE 'Other'
END;
