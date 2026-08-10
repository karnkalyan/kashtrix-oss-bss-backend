ALTER TABLE `tr069_devices`
  ADD COLUMN `wanSnapshot` JSON NULL,
  ADD COLUMN `wanSnapshotAt` DATETIME(3) NULL;
