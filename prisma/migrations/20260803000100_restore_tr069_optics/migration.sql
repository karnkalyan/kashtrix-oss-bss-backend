-- These legacy columns exist in upgraded installations but were missing from
-- the checked-in Prisma model. Keep this migration idempotent for both paths.
SET @rx_power_sql = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE `tr069_devices` ADD COLUMN `rxPower` DOUBLE NULL',
    'SELECT 1')
  FROM `information_schema`.`COLUMNS`
  WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'tr069_devices' AND `COLUMN_NAME` = 'rxPower'
);
PREPARE rx_power_stmt FROM @rx_power_sql;
EXECUTE rx_power_stmt;
DEALLOCATE PREPARE rx_power_stmt;

SET @uptime_sql = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE `tr069_devices` ADD COLUMN `uptime` INT NULL',
    'SELECT 1')
  FROM `information_schema`.`COLUMNS`
  WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'tr069_devices' AND `COLUMN_NAME` = 'uptime'
);
PREPARE uptime_stmt FROM @uptime_sql;
EXECUTE uptime_stmt;
DEALLOCATE PREPARE uptime_stmt;
