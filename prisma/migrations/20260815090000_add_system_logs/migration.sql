CREATE TABLE `system_logs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `ispId` INTEGER NULL,
    `userId` INTEGER NULL,
    `level` VARCHAR(16) NOT NULL,
    `operation` VARCHAR(120) NOT NULL,
    `message` TEXT NOT NULL,
    `method` VARCHAR(10) NULL,
    `path` VARCHAR(500) NULL,
    `statusCode` INTEGER NULL,
    `ip` VARCHAR(191) NULL,
    `userAgent` VARCHAR(500) NULL,
    `durationMs` INTEGER NULL,
    `details` JSON NULL,
    `timestamp` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `system_logs_ispId_timestamp_idx`(`ispId`, `timestamp`),
    INDEX `system_logs_level_timestamp_idx`(`level`, `timestamp`),
    INDEX `system_logs_operation_timestamp_idx`(`operation`, `timestamp`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
