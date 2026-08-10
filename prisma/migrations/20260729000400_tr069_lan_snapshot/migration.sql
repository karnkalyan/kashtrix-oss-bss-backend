ALTER TABLE `tr069_devices`
  ADD COLUMN `lanSnapshot` JSON NULL,
  ADD COLUMN `lanSnapshotAt` DATETIME(3) NULL;
