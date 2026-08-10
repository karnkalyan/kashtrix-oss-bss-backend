ALTER TABLE `resellers`
  ADD COLUMN `zipCode` VARCHAR(30) NULL,
  ADD COLUMN `country` VARCHAR(100) NULL,
  ADD COLUMN `website` VARCHAR(191) NULL,
  ADD COLUMN `legalName` VARCHAR(191) NULL,
  ADD COLUMN `registrationNo` VARCHAR(100) NULL,
  ADD COLUMN `panNo` VARCHAR(100) NULL,
  ADD COLUMN `notes` TEXT NULL;

ALTER TABLE `lead`
  ADD COLUMN `resellerId` INTEGER NULL,
  ADD INDEX `lead_resellerId_idx` (`resellerId`),
  ADD CONSTRAINT `lead_reseller_fkey`
    FOREIGN KEY (`resellerId`) REFERENCES `resellers`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `OLT`
  ADD COLUMN `resellerId` INTEGER NULL,
  ADD INDEX `OLT_resellerId_idx` (`resellerId`),
  ADD CONSTRAINT `olt_reseller_fkey`
    FOREIGN KEY (`resellerId`) REFERENCES `resellers`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE `package_plan_resellers` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `packagePlanId` INTEGER NOT NULL,
  `resellerId` INTEGER NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `package_plan_resellers_packagePlanId_resellerId_key` (`packagePlanId`, `resellerId`),
  INDEX `package_plan_resellers_resellerId_idx` (`resellerId`),
  INDEX `package_plan_resellers_packagePlanId_idx` (`packagePlanId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
