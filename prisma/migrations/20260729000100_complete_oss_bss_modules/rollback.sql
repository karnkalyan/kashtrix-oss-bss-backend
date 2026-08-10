-- Manual rollback for 20260729000100_complete_oss_bss_modules.
-- Back up/export financial, wallet, GPS, reseller, and API-token records before running.
SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS `accounting_ledger_entries`;
DROP TABLE IF EXISTS `account_transfers`;
DROP TABLE IF EXISTS `expense_items`;
DROP TABLE IF EXISTS `expenses`;
DROP TABLE IF EXISTS `purchase_items`;
DROP TABLE IF EXISTS `purchases`;
DROP TABLE IF EXISTS `sale_items`;
DROP TABLE IF EXISTS `sales`;
DROP TABLE IF EXISTS `accounting_items`;
DROP TABLE IF EXISTS `accounting_categories`;
DROP TABLE IF EXISTS `billing_accounts_acct`;
DROP TABLE IF EXISTS `user_gps_locations`;
DROP TABLE IF EXISTS `wallet_transactions`;
DROP TABLE IF EXISTS `wallets`;
DROP TABLE IF EXISTS `api_tokens`;

ALTER TABLE `managed_devices` DROP FOREIGN KEY `managed_devices_resellerId_fkey`;
ALTER TABLE `managed_devices` DROP COLUMN `resellerId`;
ALTER TABLE `Customer` DROP FOREIGN KEY `customer_reseller_fkey`;
ALTER TABLE `Customer` DROP COLUMN `resellerId`;
ALTER TABLE `User` DROP FOREIGN KEY `user_reseller_fkey`;
ALTER TABLE `User` DROP COLUMN `resellerId`;
DROP TABLE IF EXISTS `resellers`;

SET FOREIGN_KEY_CHECKS = 1;
