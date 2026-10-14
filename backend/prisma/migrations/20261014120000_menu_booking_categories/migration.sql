-- Split the legacy broad categories using the approved salon menu labels.
-- Preserve custom administrator classifications and all booking snapshots.
UPDATE "Service"
SET "category" = "description"
WHERE
  (lower(trim("category")) = 'hair' AND "description" IN (
    'Hair Services', 'Hair Color & Styling', 'Hair Treatments'
  ))
  OR (lower(trim("category")) = 'nails' AND "description" = 'Nail Services');
