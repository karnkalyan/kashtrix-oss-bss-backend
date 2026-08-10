-- AlterTable
ALTER TABLE `User` ADD COLUMN `resellerId` INTEGER NULL;

-- AlterTable
ALTER TABLE `Customer` ADD COLUMN `resellerId` INTEGER NULL;

-- AlterTable
ALTER TABLE `calendar_date_values` MODIFY `entityType` VARCHAR(50) NOT NULL,
    MODIFY `entityId` VARCHAR(50) NOT NULL,
    MODIFY `fieldName` VARCHAR(50) NOT NULL;

-- AlterTable
ALTER TABLE `managed_devices` ADD COLUMN `resellerId` INTEGER NULL;

-- CreateTable
CREATE TABLE `resellers` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(100) NOT NULL,
    `code` VARCHAR(100) NOT NULL,
    `email` VARCHAR(191) NULL,
    `phoneNumber` VARCHAR(50) NULL,
    `address` VARCHAR(255) NULL,
    `city` VARCHAR(100) NULL,
    `state` VARCHAR(100) NULL,
    `contactPerson` VARCHAR(100) NULL,
    `logoUrl` VARCHAR(255) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `isDeleted` BOOLEAN NOT NULL DEFAULT false,
    `commissionType` VARCHAR(20) NULL DEFAULT 'PERCENTAGE',
    `commissionValue` DOUBLE NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `ispId` INTEGER NOT NULL,

    UNIQUE INDEX `resellers_code_key`(`code`),
    INDEX `resellers_ispId_idx`(`ispId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `wallets` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `balance` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `reservedBalance` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `lowBalanceThreshold` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `ispId` INTEGER NOT NULL,
    `branchId` INTEGER NULL,
    `resellerId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `wallets_branchId_key`(`branchId`),
    UNIQUE INDEX `wallets_resellerId_key`(`resellerId`),
    INDEX `wallets_ispId_idx`(`ispId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `wallet_transactions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `walletId` INTEGER NOT NULL,
    `type` VARCHAR(20) NOT NULL,
    `amount` DECIMAL(18, 2) NOT NULL,
    `balanceAfter` DECIMAL(18, 2) NOT NULL,
    `description` TEXT NULL,
    `reference` VARCHAR(191) NULL,
    `createdById` INTEGER NULL,
    `relatedCustomerId` INTEGER NULL,
    `relatedInvoiceId` VARCHAR(191) NULL,
    `idempotencyKey` VARCHAR(191) NULL,
    `reversalOfId` INTEGER NULL,
    `metadata` JSON NULL,
    `resellerId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `wallet_transactions_reversalOfId_key`(`reversalOfId`),
    INDEX `wallet_transactions_walletId_idx`(`walletId`),
    INDEX `wallet_transactions_resellerId_idx`(`resellerId`),
    INDEX `wallet_transactions_createdAt_idx`(`createdAt`),
    UNIQUE INDEX `wallet_transactions_walletId_idempotencyKey_key`(`walletId`, `idempotencyKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_gps_locations` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `latitude` DOUBLE NOT NULL,
    `longitude` DOUBLE NOT NULL,
    `accuracy` DOUBLE NULL,
    `altitude` DOUBLE NULL,
    `speed` DOUBLE NULL,
    `heading` DOUBLE NULL,
    `battery` DOUBLE NULL,
    `deviceTimestamp` DATETIME(3) NULL,
    `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `permissionStatus` VARCHAR(32) NOT NULL DEFAULT 'GRANTED',
    `timestamp` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `user_gps_locations_userId_timestamp_idx`(`userId`, `timestamp`),
    INDEX `user_gps_locations_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `billing_accounts_acct` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(100) NOT NULL,
    `type` VARCHAR(50) NOT NULL,
    `accountNo` VARCHAR(100) NULL,
    `openingBalance` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `balance` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `allowNegative` BOOLEAN NOT NULL DEFAULT false,
    `notes` TEXT NULL,
    `createdById` INTEGER NULL,
    `updatedById` INTEGER NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `ispId` INTEGER NOT NULL,
    `branchId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `billing_accounts_acct_ispId_idx`(`ispId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `accounting_categories` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(100) NOT NULL,
    `type` VARCHAR(20) NOT NULL,
    `description` TEXT NULL,
    `ispId` INTEGER NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `accounting_categories_ispId_name_type_key`(`ispId`, `name`, `type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `accounting_items` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(100) NOT NULL,
    `description` TEXT NULL,
    `unitPrice` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `defaultPurchasePrice` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `defaultSellingPrice` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `defaultTax` DECIMAL(7, 4) NOT NULL DEFAULT 0,
    `categoryId` INTEGER NULL,
    `trackInventory` BOOLEAN NOT NULL DEFAULT false,
    `unit` VARCHAR(50) NULL,
    `sku` VARCHAR(100) NULL,
    `ispId` INTEGER NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `accounting_items_ispId_idx`(`ispId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sales` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `invoiceNumber` VARCHAR(100) NULL,
    `customerId` INTEGER NULL,
    `customerName` VARCHAR(100) NULL,
    `categoryId` INTEGER NULL,
    `billingAccountId` INTEGER NULL,
    `subtotal` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `discountAmount` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `discountPercent` DECIMAL(7, 4) NULL,
    `taxAmount` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `taxPercent` DECIMAL(7, 4) NULL,
    `totalAmount` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `paidAmount` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `dueAmount` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `status` VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    `notes` TEXT NULL,
    `saleDate` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `dueDate` DATETIME(3) NULL,
    `ispId` INTEGER NOT NULL,
    `branchId` INTEGER NULL,
    `createdById` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `sales_ispId_idx`(`ispId`),
    INDEX `sales_customerId_idx`(`customerId`),
    INDEX `sales_status_idx`(`status`),
    INDEX `sales_saleDate_idx`(`saleDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sale_items` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `saleId` INTEGER NOT NULL,
    `itemId` INTEGER NULL,
    `description` VARCHAR(255) NULL,
    `quantity` DECIMAL(18, 4) NOT NULL DEFAULT 1,
    `unitPrice` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `discount` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `tax` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `total` DECIMAL(18, 2) NOT NULL DEFAULT 0,

    INDEX `sale_items_saleId_idx`(`saleId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `purchases` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `vendorId` INTEGER NULL,
    `vendorName` VARCHAR(100) NULL,
    `categoryId` INTEGER NULL,
    `billingAccountId` INTEGER NULL,
    `subtotal` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `taxAmount` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `totalAmount` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `paidAmount` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `dueAmount` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `status` VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    `notes` TEXT NULL,
    `purchaseDate` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `ispId` INTEGER NOT NULL,
    `branchId` INTEGER NULL,
    `createdById` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `purchases_ispId_idx`(`ispId`),
    INDEX `purchases_vendorId_idx`(`vendorId`),
    INDEX `purchases_purchaseDate_idx`(`purchaseDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `purchase_items` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `purchaseId` INTEGER NOT NULL,
    `itemId` INTEGER NULL,
    `description` VARCHAR(255) NULL,
    `quantity` DECIMAL(18, 4) NOT NULL DEFAULT 1,
    `unitPrice` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `total` DECIMAL(18, 2) NOT NULL DEFAULT 0,

    INDEX `purchase_items_purchaseId_idx`(`purchaseId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `expenses` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `categoryId` INTEGER NULL,
    `billingAccountId` INTEGER NULL,
    `vendorId` INTEGER NULL,
    `description` TEXT NULL,
    `amount` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `taxAmount` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `totalAmount` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `expenseDate` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `ispId` INTEGER NOT NULL,
    `branchId` INTEGER NULL,
    `createdById` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `expenses_ispId_idx`(`ispId`),
    INDEX `expenses_categoryId_idx`(`categoryId`),
    INDEX `expenses_expenseDate_idx`(`expenseDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `expense_items` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `expenseId` INTEGER NOT NULL,
    `itemId` INTEGER NULL,
    `description` VARCHAR(255) NULL,
    `quantity` DECIMAL(18, 4) NOT NULL DEFAULT 1,
    `unitPrice` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `total` DECIMAL(18, 2) NOT NULL DEFAULT 0,

    INDEX `expense_items_expenseId_idx`(`expenseId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `account_transfers` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `fromAccountId` INTEGER NOT NULL,
    `toAccountId` INTEGER NOT NULL,
    `amount` DECIMAL(18, 2) NOT NULL,
    `description` TEXT NULL,
    `reference` VARCHAR(191) NOT NULL,
    `transferDate` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `ispId` INTEGER NOT NULL,
    `createdById` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `account_transfers_ispId_idx`(`ispId`),
    INDEX `account_transfers_transferDate_idx`(`transferDate`),
    UNIQUE INDEX `account_transfers_ispId_reference_key`(`ispId`, `reference`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `accounting_ledger_entries` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `ispId` INTEGER NOT NULL,
    `billingAccountId` INTEGER NOT NULL,
    `direction` VARCHAR(10) NOT NULL,
    `amount` DECIMAL(18, 2) NOT NULL,
    `balanceAfter` DECIMAL(18, 2) NOT NULL,
    `sourceType` VARCHAR(32) NOT NULL,
    `sourceId` INTEGER NULL,
    `reference` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `createdById` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `accounting_ledger_entries_ispId_createdAt_idx`(`ispId`, `createdAt`),
    INDEX `accounting_ledger_entries_sourceType_sourceId_idx`(`sourceType`, `sourceId`),
    UNIQUE INDEX `accounting_ledger_entries_billingAccountId_reference_directi_key`(`billingAccountId`, `reference`, `direction`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `api_tokens` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `tokenHash` VARCHAR(64) NOT NULL,
    `tokenPrefix` VARCHAR(16) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `description` TEXT NULL,
    `scopes` TEXT NOT NULL,
    `ipRestrictions` TEXT NULL,
    `branchId` INTEGER NULL,
    `resellerId` INTEGER NULL,
    `createdById` INTEGER NOT NULL,
    `ispId` INTEGER NOT NULL,
    `lastUsedAt` DATETIME(3) NULL,
    `expiresAt` DATETIME(3) NULL,
    `isRevoked` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `api_tokens_tokenHash_key`(`tokenHash`),
    INDEX `api_tokens_ispId_idx`(`ispId`),
    INDEX `api_tokens_tokenHash_idx`(`tokenHash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `User_resellerId_idx` ON `User`(`resellerId`);

-- CreateIndex
CREATE INDEX `managed_devices_resellerId_idx` ON `managed_devices`(`resellerId`);

-- AddForeignKey
ALTER TABLE `resellers` ADD CONSTRAINT `reseller_isp_fkey` FOREIGN KEY (`ispId`) REFERENCES `ISP`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `wallets` ADD CONSTRAINT `wallet_branch_fkey` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `wallets` ADD CONSTRAINT `wallet_reseller_fkey` FOREIGN KEY (`resellerId`) REFERENCES `resellers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `User` ADD CONSTRAINT `user_reseller_fkey` FOREIGN KEY (`resellerId`) REFERENCES `resellers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Customer` ADD CONSTRAINT `customer_reseller_fkey` FOREIGN KEY (`resellerId`) REFERENCES `resellers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `managed_devices` ADD CONSTRAINT `managed_devices_resellerId_fkey` FOREIGN KEY (`resellerId`) REFERENCES `resellers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `wallet_transactions` ADD CONSTRAINT `wallet_txn_wallet_fkey` FOREIGN KEY (`walletId`) REFERENCES `wallets`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `wallet_transactions` ADD CONSTRAINT `wallet_txn_reversal_fkey` FOREIGN KEY (`reversalOfId`) REFERENCES `wallet_transactions`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `wallet_transactions` ADD CONSTRAINT `wallet_txn_reseller_fkey` FOREIGN KEY (`resellerId`) REFERENCES `resellers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_gps_locations` ADD CONSTRAINT `gps_user_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales` ADD CONSTRAINT `sale_category_fkey` FOREIGN KEY (`categoryId`) REFERENCES `accounting_categories`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales` ADD CONSTRAINT `sale_billing_fkey` FOREIGN KEY (`billingAccountId`) REFERENCES `billing_accounts_acct`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sale_items` ADD CONSTRAINT `sale_item_sale_fkey` FOREIGN KEY (`saleId`) REFERENCES `sales`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sale_items` ADD CONSTRAINT `sale_item_item_fkey` FOREIGN KEY (`itemId`) REFERENCES `accounting_items`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchases` ADD CONSTRAINT `purchase_category_fkey` FOREIGN KEY (`categoryId`) REFERENCES `accounting_categories`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchases` ADD CONSTRAINT `purchase_billing_fkey` FOREIGN KEY (`billingAccountId`) REFERENCES `billing_accounts_acct`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_items` ADD CONSTRAINT `purchase_item_purchase_fkey` FOREIGN KEY (`purchaseId`) REFERENCES `purchases`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_items` ADD CONSTRAINT `purchase_item_item_fkey` FOREIGN KEY (`itemId`) REFERENCES `accounting_items`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `expenses` ADD CONSTRAINT `expense_category_fkey` FOREIGN KEY (`categoryId`) REFERENCES `accounting_categories`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `expenses` ADD CONSTRAINT `expense_billing_fkey` FOREIGN KEY (`billingAccountId`) REFERENCES `billing_accounts_acct`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `expense_items` ADD CONSTRAINT `expense_item_expense_fkey` FOREIGN KEY (`expenseId`) REFERENCES `expenses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `expense_items` ADD CONSTRAINT `expense_item_item_fkey` FOREIGN KEY (`itemId`) REFERENCES `accounting_items`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `account_transfers` ADD CONSTRAINT `transfer_from_fkey` FOREIGN KEY (`fromAccountId`) REFERENCES `billing_accounts_acct`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `account_transfers` ADD CONSTRAINT `transfer_to_fkey` FOREIGN KEY (`toAccountId`) REFERENCES `billing_accounts_acct`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `accounting_ledger_entries` ADD CONSTRAINT `ledger_billing_account_fkey` FOREIGN KEY (`billingAccountId`) REFERENCES `billing_accounts_acct`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `api_tokens` ADD CONSTRAINT `api_token_isp_fkey` FOREIGN KEY (`ispId`) REFERENCES `ISP`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed module permissions without changing existing role assignments.
INSERT IGNORE INTO `Permission` (`name`, `menuName`, `createdAt`, `updatedAt`) VALUES
('accounting_view', 'Accounting', NOW(3), NOW(3)),
('accounting_manage', 'Accounting', NOW(3), NOW(3)),
('accounting_export', 'Accounting', NOW(3), NOW(3)),
('reseller_view', 'Reseller Management', NOW(3), NOW(3)),
('reseller_manage', 'Reseller Management', NOW(3), NOW(3)),
('reseller_device_assign', 'Reseller Management', NOW(3), NOW(3)),
('wallet_view', 'Wallet', NOW(3), NOW(3)),
('wallet_topup', 'Wallet', NOW(3), NOW(3)),
('wallet_adjust', 'Wallet', NOW(3), NOW(3)),
('wallet_debit', 'Wallet', NOW(3), NOW(3)),
('wallet_export', 'Wallet', NOW(3), NOW(3)),
('gps_submit_own', 'Field Staff GPS', NOW(3), NOW(3)),
('gps_view', 'Field Staff GPS', NOW(3), NOW(3)),
('api_tokens_manage', 'System Settings', NOW(3), NOW(3)),
('olt_mac_lookup', 'OLT Management', NOW(3), NOW(3)),
('olt_customer_link', 'OLT Management', NOW(3), NOW(3)),
('tr069_parameters_view', 'TR-069', NOW(3), NOW(3)),
('tr069_diagnostics_run', 'TR-069', NOW(3), NOW(3));
