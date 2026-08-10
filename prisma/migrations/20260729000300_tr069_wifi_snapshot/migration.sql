ALTER TABLE `tr069_devices`
  ADD COLUMN `wifiSnapshot` JSON NULL,
  ADD COLUMN `wifiSnapshotAt` DATETIME(3) NULL;
