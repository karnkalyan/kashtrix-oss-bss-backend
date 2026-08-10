-- AlterTable
ALTER TABLE `audit_logs` ADD COLUMN `branchId` INTEGER NULL,
    ADD COLUMN `ispId` INTEGER NULL;

-- AlterTable
ALTER TABLE `customer` ADD COLUMN `resellerId` INTEGER NULL;

-- AlterTable
ALTER TABLE `lead` ADD COLUMN `resellerId` INTEGER NULL;

-- AlterTable
ALTER TABLE `olt` ADD COLUMN `resellerId` INTEGER NULL;

-- AlterTable
ALTER TABLE `tr069_devices` ADD COLUMN `lanSnapshot` JSON NULL,
    ADD COLUMN `lanSnapshotAt` DATETIME(3) NULL,
    ADD COLUMN `wanSnapshot` JSON NULL,
    ADD COLUMN `wanSnapshotAt` DATETIME(3) NULL,
    ADD COLUMN `wifiSnapshot` JSON NULL,
    ADD COLUMN `wifiSnapshotAt` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `user` ADD COLUMN `resellerId` INTEGER NULL;

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
    `zipCode` VARCHAR(30) NULL,
    `country` VARCHAR(100) NULL,
    `website` VARCHAR(191) NULL,
    `legalName` VARCHAR(191) NULL,
    `registrationNo` VARCHAR(100) NULL,
    `panNo` VARCHAR(100) NULL,
    `notes` TEXT NULL,
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
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

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
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `package_plan_resellers` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `packagePlanId` INTEGER NOT NULL,
    `resellerId` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `package_plan_resellers_resellerId_idx`(`resellerId`),
    INDEX `package_plan_resellers_packagePlanId_idx`(`packagePlanId`),
    UNIQUE INDEX `package_plan_resellers_packagePlanId_resellerId_key`(`packagePlanId`, `resellerId`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `calendar_date_values` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `ispId` INTEGER NOT NULL,
    `branchId` INTEGER NULL,
    `entityType` VARCHAR(50) NOT NULL,
    `entityId` VARCHAR(50) NOT NULL,
    `fieldName` VARCHAR(50) NOT NULL,
    `adDate` DATETIME(3) NOT NULL,
    `bsDate` VARCHAR(32) NOT NULL,
    `sourceCalendar` VARCHAR(8) NOT NULL DEFAULT 'AD',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `calendar_date_values_ispId_adDate_idx`(`ispId`, `adDate`),
    UNIQUE INDEX `calendar_date_values_ispId_entityType_entityId_fieldName_key`(`ispId`, `entityType`, `entityId`, `fieldName`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_agents` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `ispId` INTEGER NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `slug` VARCHAR(160) NOT NULL,
    `avatar` VARCHAR(500) NULL,
    `role` VARCHAR(160) NOT NULL,
    `department` VARCHAR(160) NOT NULL,
    `description` TEXT NULL,
    `instructions` LONGTEXT NULL,
    `systemPrompt` LONGTEXT NULL,
    `status` VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
    `modelProvider` VARCHAR(80) NOT NULL DEFAULT 'openai-compatible',
    `modelName` VARCHAR(120) NOT NULL DEFAULT 'default',
    `temperature` DOUBLE NOT NULL DEFAULT 0.2,
    `maxTokens` INTEGER NOT NULL DEFAULT 4096,
    `language` VARCHAR(16) NOT NULL DEFAULT 'en',
    `version` INTEGER NOT NULL DEFAULT 1,
    `isPublished` BOOLEAN NOT NULL DEFAULT true,
    `isDefault` BOOLEAN NOT NULL DEFAULT false,
    `createdBy` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ai_agents_ispId_status_idx`(`ispId`, `status`),
    INDEX `ai_agents_createdAt_idx`(`createdAt`),
    UNIQUE INDEX `ai_agents_ispId_slug_key`(`ispId`, `slug`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_agent_permissions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `agentId` INTEGER NOT NULL,
    `module` VARCHAR(120) NOT NULL,
    `resource` VARCHAR(160) NULL,
    `canRead` BOOLEAN NOT NULL DEFAULT true,
    `canCreate` BOOLEAN NOT NULL DEFAULT false,
    `canUpdate` BOOLEAN NOT NULL DEFAULT false,
    `canDelete` BOOLEAN NOT NULL DEFAULT false,
    `canExecute` BOOLEAN NOT NULL DEFAULT false,
    `requiresApproval` BOOLEAN NOT NULL DEFAULT false,

    INDEX `ai_agent_permissions_agentId_idx`(`agentId`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_agent_tools` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `agentId` INTEGER NOT NULL,
    `toolKey` VARCHAR(120) NOT NULL,
    `toolName` VARCHAR(160) NOT NULL,
    `description` TEXT NULL,
    `configuration` JSON NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `requiresApproval` BOOLEAN NOT NULL DEFAULT false,
    `riskLevel` VARCHAR(24) NOT NULL DEFAULT 'LOW',

    INDEX `ai_agent_tools_agentId_idx`(`agentId`),
    UNIQUE INDEX `ai_agent_tools_agentId_toolKey_key`(`agentId`, `toolKey`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_agent_knowledge_sources` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `agentId` INTEGER NOT NULL,
    `sourceType` VARCHAR(80) NOT NULL,
    `sourceId` VARCHAR(191) NULL,
    `title` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,

    INDEX `ai_agent_knowledge_sources_agentId_idx`(`agentId`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_agent_conversations` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `ispId` INTEGER NOT NULL,
    `agentId` INTEGER NOT NULL,
    `userId` INTEGER NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `status` VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
    `summary` TEXT NULL,
    `pinned` BOOLEAN NOT NULL DEFAULT false,
    `archived` BOOLEAN NOT NULL DEFAULT false,
    `lastMessageAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ai_agent_conversations_ispId_userId_idx`(`ispId`, `userId`),
    INDEX `ai_agent_conversations_agentId_idx`(`agentId`),
    INDEX `ai_agent_conversations_lastMessageAt_idx`(`lastMessageAt`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_agent_messages` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `conversationId` INTEGER NOT NULL,
    `senderType` VARCHAR(32) NOT NULL,
    `senderId` INTEGER NULL,
    `role` VARCHAR(32) NOT NULL,
    `content` LONGTEXT NOT NULL,
    `structuredData` JSON NULL,
    `toolCalls` JSON NULL,
    `attachments` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ai_agent_messages_conversationId_createdAt_idx`(`conversationId`, `createdAt`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_agent_tasks` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `ispId` INTEGER NOT NULL,
    `agentId` INTEGER NOT NULL,
    `requestedBy` INTEGER NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `taskType` VARCHAR(80) NOT NULL,
    `priority` VARCHAR(24) NOT NULL DEFAULT 'MEDIUM',
    `status` VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    `input` JSON NULL,
    `output` JSON NULL,
    `error` TEXT NULL,
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ai_agent_tasks_ispId_status_idx`(`ispId`, `status`),
    INDEX `ai_agent_tasks_agentId_status_idx`(`agentId`, `status`),
    INDEX `ai_agent_tasks_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_agent_actions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `taskId` INTEGER NULL,
    `agentId` INTEGER NOT NULL,
    `actionType` VARCHAR(120) NOT NULL,
    `targetModule` VARCHAR(120) NOT NULL,
    `targetResource` VARCHAR(160) NULL,
    `targetId` VARCHAR(191) NULL,
    `input` JSON NULL,
    `output` JSON NULL,
    `riskLevel` VARCHAR(24) NOT NULL DEFAULT 'LOW',
    `approvalRequired` BOOLEAN NOT NULL DEFAULT false,
    `approvalStatus` VARCHAR(32) NOT NULL DEFAULT 'NOT_REQUIRED',
    `executedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ai_agent_actions_taskId_idx`(`taskId`),
    INDEX `ai_agent_actions_agentId_createdAt_idx`(`agentId`, `createdAt`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_agent_approvals` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `ispId` INTEGER NOT NULL,
    `agentId` INTEGER NOT NULL,
    `taskId` INTEGER NULL,
    `actionId` INTEGER NULL,
    `requestedBy` INTEGER NOT NULL,
    `assignedTo` INTEGER NULL,
    `approvalType` VARCHAR(80) NOT NULL,
    `status` VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    `reason` TEXT NULL,
    `approvedAt` DATETIME(3) NULL,
    `rejectedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ai_agent_approvals_ispId_status_idx`(`ispId`, `status`),
    INDEX `ai_agent_approvals_agentId_status_idx`(`agentId`, `status`),
    INDEX `ai_agent_approvals_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_agent_activity_logs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `ispId` INTEGER NOT NULL,
    `agentId` INTEGER NOT NULL,
    `userId` INTEGER NULL,
    `eventType` VARCHAR(100) NOT NULL,
    `description` TEXT NOT NULL,
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ai_agent_activity_logs_ispId_createdAt_idx`(`ispId`, `createdAt`),
    INDEX `ai_agent_activity_logs_agentId_createdAt_idx`(`agentId`, `createdAt`),
    INDEX `ai_agent_activity_logs_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_conversation_contexts` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `ispId` INTEGER NOT NULL,
    `conversationId` INTEGER NOT NULL,
    `userId` INTEGER NOT NULL,
    `chatId` VARCHAR(191) NOT NULL,
    `selectedAgentId` INTEGER NULL,
    `routedAgentId` INTEGER NULL,
    `currentIntent` VARCHAR(120) NULL,
    `previousIntent` VARCHAR(120) NULL,
    `currentModule` VARCHAR(120) NULL,
    `currentAction` VARCHAR(120) NULL,
    `currentEntityType` VARCHAR(80) NULL,
    `currentEntityId` VARCHAR(191) NULL,
    `selectedCustomerId` VARCHAR(191) NULL,
    `selectedDeviceId` VARCHAR(191) NULL,
    `selectedTicketId` VARCHAR(191) NULL,
    `selectedInvoiceId` VARCHAR(191) NULL,
    `selectedPaymentId` VARCHAR(191) NULL,
    `selectedNasId` VARCHAR(191) NULL,
    `pendingActionId` INTEGER NULL,
    `pendingApprovalId` INTEGER NULL,
    `pendingConfirmation` BOOLEAN NOT NULL DEFAULT false,
    `pendingClarification` JSON NULL,
    `lastToolCall` JSON NULL,
    `lastToolResult` JSON NULL,
    `lastSuccessfulToolResult` JSON NULL,
    `lastAssistantClaim` JSON NULL,
    `entityStack` JSON NULL,
    `conversationSummary` TEXT NULL,
    `debugTrace` JSON NULL,
    `expiresAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ai_conversation_contexts_conversationId_key`(`conversationId`),
    INDEX `ai_conversation_contexts_ispId_userId_idx`(`ispId`, `userId`),
    INDEX `ai_conversation_contexts_chatId_idx`(`chatId`),
    INDEX `ai_conversation_contexts_selectedCustomerId_idx`(`selectedCustomerId`),
    INDEX `ai_conversation_contexts_selectedDeviceId_idx`(`selectedDeviceId`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_pending_agent_actions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `ispId` INTEGER NOT NULL,
    `conversationId` INTEGER NOT NULL,
    `agentId` INTEGER NOT NULL,
    `requestedBy` INTEGER NOT NULL,
    `actionType` VARCHAR(120) NOT NULL,
    `toolName` VARCHAR(120) NULL,
    `module` VARCHAR(120) NOT NULL,
    `argumentsEncrypted` JSON NULL,
    `displayArguments` JSON NULL,
    `status` VARCHAR(40) NOT NULL DEFAULT 'AWAITING_CONFIRMATION',
    `requiresApproval` BOOLEAN NOT NULL DEFAULT true,
    `riskLevel` VARCHAR(20) NOT NULL DEFAULT 'HIGH',
    `idempotencyKey` VARCHAR(191) NULL,
    `approvalId` INTEGER NULL,
    `taskId` INTEGER NULL,
    `error` TEXT NULL,
    `expiresAt` DATETIME(3) NULL,
    `confirmationExpiresAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ai_pending_agent_actions_ispId_conversationId_status_idx`(`ispId`, `conversationId`, `status`),
    INDEX `ai_pending_agent_actions_agentId_status_idx`(`agentId`, `status`),
    INDEX `ai_pending_agent_actions_approvalId_idx`(`approvalId`),
    INDEX `ai_pending_agent_actions_taskId_idx`(`taskId`),
    INDEX `ai_pending_agent_actions_ispId_idempotencyKey_idx`(`ispId`, `idempotencyKey`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_tool_executions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `ispId` INTEGER NOT NULL,
    `conversationId` INTEGER NOT NULL,
    `pendingActionId` INTEGER NULL,
    `agentId` INTEGER NOT NULL,
    `userId` INTEGER NOT NULL,
    `toolName` VARCHAR(120) NOT NULL,
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `requestId` VARCHAR(191) NULL,
    `status` VARCHAR(40) NOT NULL DEFAULT 'PENDING',
    `inputMasked` JSON NULL,
    `result` JSON NULL,
    `errorCode` VARCHAR(100) NULL,
    `errorMessage` TEXT NULL,
    `durationMs` INTEGER NOT NULL DEFAULT 0,
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ai_tool_executions_conversationId_createdAt_idx`(`conversationId`, `createdAt`),
    INDEX `ai_tool_executions_agentId_status_idx`(`agentId`, `status`),
    INDEX `ai_tool_executions_pendingActionId_idx`(`pendingActionId`),
    UNIQUE INDEX `ai_tool_executions_ispId_idempotencyKey_key`(`ispId`, `idempotencyKey`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_agent_routes` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `ispId` INTEGER NOT NULL,
    `conversationId` INTEGER NOT NULL,
    `messageId` INTEGER NULL,
    `fromAgentId` INTEGER NULL,
    `toAgentId` INTEGER NOT NULL,
    `resolvedIntent` VARCHAR(120) NULL,
    `confidence` DOUBLE NOT NULL DEFAULT 0,
    `reason` TEXT NULL,
    `contextSnapshot` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ai_agent_routes_ispId_conversationId_createdAt_idx`(`ispId`, `conversationId`, `createdAt`),
    INDEX `ai_agent_routes_toAgentId_createdAt_idx`(`toAgentId`, `createdAt`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_entity_references` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `ispId` INTEGER NOT NULL,
    `conversationId` INTEGER NOT NULL,
    `messageId` INTEGER NULL,
    `entityType` VARCHAR(80) NOT NULL,
    `entityId` VARCHAR(160) NOT NULL,
    `displayLabel` VARCHAR(255) NULL,
    `source` VARCHAR(40) NOT NULL DEFAULT 'USER',
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ai_entity_refs_context_type_active_idx`(`ispId`, `conversationId`, `entityType`, `isActive`),
    INDEX `ai_entity_references_entityType_entityId_idx`(`entityType`, `entityId`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_conversation_corrections` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `ispId` INTEGER NOT NULL,
    `conversationId` INTEGER NOT NULL,
    `userMessageId` INTEGER NULL,
    `disputedMessageId` INTEGER NULL,
    `entityType` VARCHAR(80) NULL,
    `entityId` VARCHAR(160) NULL,
    `previousClaim` TEXT NULL,
    `correctedClaim` TEXT NULL,
    `verificationResult` JSON NULL,
    `status` VARCHAR(40) NOT NULL DEFAULT 'RESOLVED',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ai_conversation_corrections_ispId_conversationId_createdAt_idx`(`ispId`, `conversationId`, `createdAt`),
    INDEX `ai_conversation_corrections_entityType_entityId_idx`(`entityType`, `entityId`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_agent_usage` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `ispId` INTEGER NOT NULL,
    `agentId` INTEGER NOT NULL,
    `userId` INTEGER NOT NULL,
    `modelProvider` VARCHAR(80) NOT NULL,
    `modelName` VARCHAR(120) NOT NULL,
    `inputTokens` INTEGER NOT NULL DEFAULT 0,
    `outputTokens` INTEGER NOT NULL DEFAULT 0,
    `totalTokens` INTEGER NOT NULL DEFAULT 0,
    `estimatedCost` DOUBLE NOT NULL DEFAULT 0,
    `durationMs` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ai_agent_usage_ispId_createdAt_idx`(`ispId`, `createdAt`),
    INDEX `ai_agent_usage_agentId_createdAt_idx`(`agentId`, `createdAt`),
    INDEX `ai_agent_usage_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_agent_versions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `agentId` INTEGER NOT NULL,
    `version` INTEGER NOT NULL,
    `instructions` LONGTEXT NULL,
    `systemPrompt` LONGTEXT NULL,
    `tools` JSON NULL,
    `permissions` JSON NULL,
    `publishedBy` INTEGER NULL,
    `publishedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ai_agent_versions_agentId_idx`(`agentId`),
    UNIQUE INDEX `ai_agent_versions_agentId_version_key`(`agentId`, `version`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `app_themes` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `ispId` INTEGER NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `description` TEXT NULL,
    `tokens` JSON NOT NULL,
    `status` VARCHAR(32) NOT NULL DEFAULT 'DRAFT',
    `version` INTEGER NOT NULL DEFAULT 1,
    `isPreset` BOOLEAN NOT NULL DEFAULT false,
    `isDeleted` BOOLEAN NOT NULL DEFAULT false,
    `createdBy` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `app_themes_ispId_status_isDeleted_idx`(`ispId`, `status`, `isDeleted`),
    UNIQUE INDEX `app_themes_ispId_name_key`(`ispId`, `name`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `app_theme_versions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `themeId` INTEGER NOT NULL,
    `version` INTEGER NOT NULL,
    `tokens` JSON NOT NULL,
    `description` TEXT NULL,
    `createdBy` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `app_theme_versions_themeId_createdAt_idx`(`themeId`, `createdAt`),
    UNIQUE INDEX `app_theme_versions_themeId_version_key`(`themeId`, `version`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `app_theme_assignments` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `ispId` INTEGER NOT NULL,
    `themeId` INTEGER NOT NULL,
    `scope` VARCHAR(32) NOT NULL DEFAULT 'GLOBAL',
    `branchId` INTEGER NULL,
    `userId` INTEGER NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdBy` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `app_theme_assignments_ispId_scope_isActive_idx`(`ispId`, `scope`, `isActive`),
    INDEX `app_theme_assignments_themeId_idx`(`themeId`),
    INDEX `app_theme_assignments_branchId_idx`(`branchId`),
    INDEX `app_theme_assignments_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `managed_devices` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `uuid` VARCHAR(36) NOT NULL,
    `ispId` INTEGER NOT NULL,
    `branchId` INTEGER NULL,
    `resellerId` INTEGER NULL,
    `name` VARCHAR(160) NOT NULL,
    `slug` VARCHAR(191) NOT NULL,
    `deviceType` VARCHAR(64) NOT NULL,
    `vendor` VARCHAR(100) NOT NULL,
    `model` VARCHAR(160) NULL,
    `firmwareVersion` VARCHAR(160) NULL,
    `platform` VARCHAR(160) NULL,
    `operatingSystem` VARCHAR(160) NULL,
    `operatingSystemVersion` VARCHAR(160) NULL,
    `serialNumber` VARCHAR(191) NULL,
    `host` VARCHAR(255) NOT NULL,
    `endpointKey` VARCHAR(64) NOT NULL,
    `managementPort` INTEGER NOT NULL,
    `communicationMethod` VARCHAR(24) NOT NULL,
    `defaultCommunicationMethod` VARCHAR(24) NOT NULL,
    `apiBaseUrl` VARCHAR(500) NULL,
    `apiPort` INTEGER NULL,
    `tlsEnabled` BOOLEAN NOT NULL DEFAULT false,
    `verifyTls` BOOLEAN NOT NULL DEFAULT true,
    `site` VARCHAR(160) NULL,
    `location` VARCHAR(255) NULL,
    `description` TEXT NULL,
    `tags` JSON NULL,
    `status` VARCHAR(24) NOT NULL DEFAULT 'offline',
    `statusMessage` VARCHAR(1000) NULL,
    `failureReason` VARCHAR(1000) NULL,
    `maintenanceReason` VARCHAR(1000) NULL,
    `maintenanceStartedAt` DATETIME(3) NULL,
    `lastCheckedAt` DATETIME(3) NULL,
    `lastSeenAt` DATETIME(3) NULL,
    `lastSuccessfulConnectionAt` DATETIME(3) NULL,
    `lastFailureAt` DATETIME(3) NULL,
    `consecutiveFailureCount` INTEGER NOT NULL DEFAULT 0,
    `pollingEnabled` BOOLEAN NOT NULL DEFAULT true,
    `pollingInterval` INTEGER NOT NULL DEFAULT 300,
    `connectionTimeout` INTEGER NOT NULL DEFAULT 15000,
    `commandTimeout` INTEGER NOT NULL DEFAULT 15000,
    `retryCount` INTEGER NOT NULL DEFAULT 1,
    `sshProfile` VARCHAR(64) NOT NULL DEFAULT 'AUTO',
    `legacyCompatibilityEnabled` BOOLEAN NOT NULL DEFAULT false,
    `lastConnectionError` VARCHAR(1000) NULL,
    `lastConnectionDiagnostics` JSON NULL,
    `lastConfigurationBackupId` INTEGER NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `isDeleted` BOOLEAN NOT NULL DEFAULT false,
    `createdBy` INTEGER NULL,
    `updatedBy` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `managed_devices_uuid_key`(`uuid`),
    INDEX `managed_devices_ispId_deviceType_isDeleted_idx`(`ispId`, `deviceType`, `isDeleted`),
    INDEX `managed_devices_ispId_status_enabled_pollingEnabled_idx`(`ispId`, `status`, `enabled`, `pollingEnabled`),
    INDEX `managed_devices_branchId_idx`(`branchId`),
    INDEX `managed_devices_resellerId_idx`(`resellerId`),
    UNIQUE INDEX `managed_devices_ispId_slug_key`(`ispId`, `slug`),
    UNIQUE INDEX `managed_devices_ispId_deviceType_endpointKey_key`(`ispId`, `deviceType`, `endpointKey`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `managed_device_connection_profiles` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `ispId` INTEGER NOT NULL,
    `deviceId` INTEGER NOT NULL,
    `mode` VARCHAR(32) NOT NULL DEFAULT 'AUTO',
    `preferredProtocol` VARCHAR(32) NOT NULL DEFAULT 'AUTO',
    `fallbackProtocols` JSON NULL,
    `apiPort` INTEGER NULL,
    `apiTlsPort` INTEGER NULL,
    `restBaseUrl` VARCHAR(500) NULL,
    `restPort` INTEGER NULL,
    `sshPort` INTEGER NULL,
    `netconfPort` INTEGER NULL,
    `restconfBaseUrl` VARCHAR(500) NULL,
    `gnmiEndpoint` VARCHAR(500) NULL,
    `snmpPort` INTEGER NULL,
    `snmpVersion` VARCHAR(16) NULL,
    `tlsEnabled` BOOLEAN NOT NULL DEFAULT false,
    `verifyTls` BOOLEAN NOT NULL DEFAULT true,
    `trustedFingerprint` VARCHAR(255) NULL,
    `legacySshEnabled` BOOLEAN NOT NULL DEFAULT false,
    `sshAlgorithmProfile` VARCHAR(64) NOT NULL DEFAULT 'AUTO',
    `readyTimeoutMs` INTEGER NOT NULL DEFAULT 20000,
    `commandTimeoutMs` INTEGER NOT NULL DEFAULT 20000,
    `keepaliveIntervalMs` INTEGER NOT NULL DEFAULT 15000,
    `keepaliveCountMax` INTEGER NOT NULL DEFAULT 3,
    `reconnectEnabled` BOOLEAN NOT NULL DEFAULT true,
    `maxReconnectAttempts` INTEGER NOT NULL DEFAULT 3,
    `liveMonitoringEnabled` BOOLEAN NOT NULL DEFAULT true,
    `pollingProfile` JSON NULL,
    `lastSuccessfulProtocol` VARCHAR(32) NULL,
    `lastSuccessfulAt` DATETIME(3) NULL,
    `lastFailureCode` VARCHAR(100) NULL,
    `lastCapabilityDetectionAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `managed_device_connection_profiles_deviceId_key`(`deviceId`),
    INDEX `managed_device_connection_profiles_ispId_preferredProtocol_idx`(`ispId`, `preferredProtocol`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `managed_device_credentials` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `deviceId` INTEGER NOT NULL,
    `encryptedPayload` LONGTEXT NOT NULL,
    `encryptionVersion` INTEGER NOT NULL DEFAULT 1,
    `credentialKinds` JSON NULL,
    `lastRotatedAt` DATETIME(3) NULL,
    `requiresRotation` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `managed_device_credentials_deviceId_key`(`deviceId`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `managed_device_connections` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `deviceId` INTEGER NOT NULL,
    `userId` INTEGER NULL,
    `method` VARCHAR(24) NOT NULL,
    `success` BOOLEAN NOT NULL,
    `durationMs` INTEGER NULL,
    `failureType` VARCHAR(64) NULL,
    `message` VARCHAR(1000) NULL,
    `requestId` VARCHAR(64) NULL,
    `profile` VARCHAR(64) NULL,
    `profilesAttempted` JSON NULL,
    `errorCode` VARCHAR(100) NULL,
    `errorCategory` VARCHAR(100) NULL,
    `algorithmDirection` VARCHAR(40) NULL,
    `algorithmType` VARCHAR(40) NULL,
    `diagnostics` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `managed_device_connections_deviceId_createdAt_idx`(`deviceId`, `createdAt`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `managed_device_status_history` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `deviceId` INTEGER NOT NULL,
    `status` VARCHAR(24) NOT NULL,
    `message` VARCHAR(1000) NULL,
    `latencyMs` INTEGER NULL,
    `checkedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `managed_device_status_history_deviceId_checkedAt_idx`(`deviceId`, `checkedAt`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `managed_device_snapshots` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `deviceId` INTEGER NOT NULL,
    `module` VARCHAR(100) NOT NULL,
    `reason` VARCHAR(255) NULL,
    `content` LONGTEXT NOT NULL,
    `contentHash` VARCHAR(64) NOT NULL,
    `createdBy` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `managed_device_snapshots_deviceId_createdAt_idx`(`deviceId`, `createdAt`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `managed_device_backups` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `deviceId` INTEGER NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `format` VARCHAR(40) NOT NULL,
    `content` LONGTEXT NOT NULL,
    `contentHash` VARCHAR(64) NOT NULL,
    `sizeBytes` INTEGER NOT NULL,
    `createdBy` INTEGER NULL,
    `restoredAt` DATETIME(3) NULL,
    `restoredBy` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `managed_device_backups_deviceId_createdAt_idx`(`deviceId`, `createdAt`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `managed_device_audits` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `ispId` INTEGER NOT NULL,
    `deviceId` INTEGER NOT NULL,
    `userId` INTEGER NULL,
    `action` VARCHAR(100) NOT NULL,
    `module` VARCHAR(100) NULL,
    `success` BOOLEAN NOT NULL,
    `requestSummary` JSON NULL,
    `responseSummary` JSON NULL,
    `sourceIp` VARCHAR(64) NULL,
    `failureReason` VARCHAR(1000) NULL,
    `beforeData` JSON NULL,
    `afterData` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `managed_device_audits_ispId_createdAt_idx`(`ispId`, `createdAt`),
    INDEX `managed_device_audits_deviceId_createdAt_idx`(`deviceId`, `createdAt`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `managed_device_commands` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `deviceId` INTEGER NOT NULL,
    `userId` INTEGER NULL,
    `module` VARCHAR(100) NULL,
    `command` TEXT NOT NULL,
    `commandType` VARCHAR(24) NOT NULL,
    `success` BOOLEAN NOT NULL,
    `output` LONGTEXT NULL,
    `failureReason` VARCHAR(1000) NULL,
    `durationMs` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `managed_device_commands_deviceId_createdAt_idx`(`deviceId`, `createdAt`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `managed_device_capabilities` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `deviceId` INTEGER NOT NULL,
    `capability` VARCHAR(120) NOT NULL,
    `supported` BOOLEAN NOT NULL DEFAULT true,
    `readOnly` BOOLEAN NOT NULL DEFAULT false,
    `metadata` JSON NULL,
    `detectedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `managed_device_capabilities_deviceId_supported_idx`(`deviceId`, `supported`),
    UNIQUE INDEX `managed_device_capabilities_deviceId_capability_key`(`deviceId`, `capability`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `managed_device_configuration_tasks` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `uuid` VARCHAR(36) NOT NULL,
    `ispId` INTEGER NOT NULL,
    `deviceId` INTEGER NOT NULL,
    `capabilityKey` VARCHAR(160) NOT NULL,
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `requestedInput` JSON NULL,
    `encryptedInput` LONGTEXT NULL,
    `proposedCommands` JSON NOT NULL,
    `verificationCommands` JSON NULL,
    `rollbackCommands` JSON NULL,
    `riskLevel` VARCHAR(24) NOT NULL,
    `status` VARCHAR(40) NOT NULL DEFAULT 'DRAFT',
    `approvalId` INTEGER NULL,
    `backupId` INTEGER NULL,
    `requestedBy` INTEGER NULL,
    `approvedBy` INTEGER NULL,
    `result` JSON NULL,
    `verification` JSON NULL,
    `rollbackResult` JSON NULL,
    `failureReason` VARCHAR(1000) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `approvedAt` DATETIME(3) NULL,
    `executedAt` DATETIME(3) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `managed_device_configuration_tasks_uuid_key`(`uuid`),
    INDEX `managed_device_configuration_tasks_deviceId_createdAt_idx`(`deviceId`, `createdAt`),
    INDEX `managed_device_configuration_tasks_ispId_status_idx`(`ispId`, `status`),
    UNIQUE INDEX `managed_device_configuration_tasks_ispId_idempotencyKey_key`(`ispId`, `idempotencyKey`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `asterisk_ai_agents` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `ispId` INTEGER NOT NULL,
    `extension` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `provider` VARCHAR(191) NOT NULL DEFAULT 'gemini_live',
    `model` VARCHAR(191) NOT NULL,
    `voice` VARCHAR(191) NOT NULL,
    `languageMode` VARCHAR(191) NOT NULL DEFAULT 'automatic',
    `prompt` TEXT NOT NULL,
    `promptVersion` INTEGER NOT NULL DEFAULT 1,
    `audioSocketHost` VARCHAR(191) NOT NULL DEFAULT '127.0.0.1',
    `audioSocketPort` INTEGER NOT NULL,
    `serviceName` VARCHAR(191) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `runtimeStatus` VARCHAR(191) NOT NULL DEFAULT 'stopped',
    `dialplanStatus` VARCHAR(191) NOT NULL DEFAULT 'configured',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `extensionNumber` VARCHAR(191) NULL,
    `agentName` VARCHAR(191) NULL,
    `systemPrompt` TEXT NULL,
    `runtimeType` VARCHAR(191) NULL DEFAULT 'python',
    `runtimePath` VARCHAR(191) NULL,
    `promptFilePath` VARCHAR(191) NULL,
    `virtualEnvPath` VARCHAR(191) NULL,
    `systemdServiceName` VARCHAR(191) NULL,
    `dialplanContext` VARCHAR(191) NULL DEFAULT 'internal',
    `dialplanFile` TEXT NULL,
    `autoStart` BOOLEAN NOT NULL DEFAULT true,
    `managedByProvisioning` BOOLEAN NOT NULL DEFAULT true,

    UNIQUE INDEX `asterisk_ai_agents_ispId_extension_key`(`ispId`, `extension`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `asterisk_ai_agent_prompt_versions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `ispId` INTEGER NOT NULL,
    `agentId` INTEGER NOT NULL,
    `version` INTEGER NOT NULL,
    `prompt` TEXT NOT NULL,
    `changedBy` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `asterisk_ai_agent_prompt_versions_ispId_agentId_version_key`(`ispId`, `agentId`, `version`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `asterisk_inbound_routes` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `ispId` INTEGER NOT NULL,
    `routeName` VARCHAR(191) NOT NULL,
    `trunkId` VARCHAR(191) NULL,
    `didPattern` VARCHAR(191) NULL,
    `callerIdPattern` VARCHAR(191) NULL,
    `timeCondition` VARCHAR(191) NULL,
    `primaryDestination` VARCHAR(191) NOT NULL,
    `destinationType` VARCHAR(191) NOT NULL,
    `failoverDestination` VARCHAR(191) NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `asterisk_outbound_routes` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `ispId` INTEGER NOT NULL,
    `routeName` VARCHAR(191) NOT NULL,
    `dialPattern` VARCHAR(191) NOT NULL,
    `prefix` VARCHAR(191) NULL,
    `prepend` VARCHAR(191) NULL,
    `trunkOrder` JSON NOT NULL,
    `fallbackTrunks` JSON NULL,
    `callerId` VARCHAR(191) NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `asterisk_queues` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `ispId` INTEGER NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `number` VARCHAR(191) NOT NULL,
    `members` JSON NOT NULL,
    `strategy` VARCHAR(191) NOT NULL DEFAULT 'ringall',
    `timeout` INTEGER NOT NULL DEFAULT 15,
    `retry` INTEGER NOT NULL DEFAULT 5,
    `maxCallers` INTEGER NOT NULL DEFAULT 0,
    `musicOnHold` VARCHAR(191) NOT NULL DEFAULT 'default',
    `failoverDestination` VARCHAR(191) NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `asterisk_queues_ispId_number_key`(`ispId`, `number`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `asterisk_ring_groups` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `ispId` INTEGER NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `number` VARCHAR(191) NOT NULL,
    `members` JSON NOT NULL,
    `ringStrategy` VARCHAR(191) NOT NULL DEFAULT 'ringall',
    `ringTime` INTEGER NOT NULL DEFAULT 20,
    `failoverDestination` VARCHAR(191) NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `asterisk_ring_groups_ispId_number_key`(`ispId`, `number`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `asterisk_ivrs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `ispId` INTEGER NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `extension` VARCHAR(191) NOT NULL,
    `greeting` VARCHAR(191) NOT NULL,
    `timeout` INTEGER NOT NULL DEFAULT 10,
    `invalidDestination` VARCHAR(191) NULL,
    `timeoutDestination` VARCHAR(191) NULL,
    `menuMappings` JSON NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `asterisk_ivrs_ispId_extension_key`(`ispId`, `extension`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `asterisk_recordings` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `ispId` INTEGER NOT NULL,
    `fileName` VARCHAR(191) NOT NULL,
    `filePath` VARCHAR(191) NOT NULL,
    `callId` VARCHAR(191) NULL,
    `duration` INTEGER NULL,
    `fileSize` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `asterisk_provisioning_configs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `ispId` INTEGER NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `pbxHost` VARCHAR(191) NULL DEFAULT '10.3.2.16',
    `sipPort` INTEGER NULL DEFAULT 5060,
    `ariEnabled` BOOLEAN NOT NULL DEFAULT true,
    `ariHost` VARCHAR(191) NULL DEFAULT '10.3.2.16',
    `ariPort` INTEGER NULL DEFAULT 8088,
    `ariAppName` VARCHAR(191) NULL DEFAULT 'kisan',
    `ariUsername` VARCHAR(191) NULL DEFAULT 'kashtrix-api',
    `ariPassword` TEXT NULL,
    `amiEnabled` BOOLEAN NOT NULL DEFAULT true,
    `amiHost` VARCHAR(191) NULL DEFAULT '10.3.2.16',
    `amiPort` INTEGER NULL DEFAULT 5038,
    `amiUsername` VARCHAR(191) NULL DEFAULT 'kashtrix-ami',
    `amiPassword` TEXT NULL,
    `provisioningEnabled` BOOLEAN NOT NULL DEFAULT true,
    `provisioningMode` VARCHAR(191) NOT NULL DEFAULT 'local',
    `provisioningHost` VARCHAR(191) NULL DEFAULT '10.3.2.16',
    `provisioningPort` INTEGER NULL DEFAULT 22,
    `provisioningUsername` VARCHAR(191) NULL DEFAULT 'kashtrix-api',
    `sshPrivateKey` TEXT NULL,
    `asteriskConfigDirectory` VARCHAR(191) NULL DEFAULT '/etc/asterisk',
    `asteriskCliPath` VARCHAR(191) NULL DEFAULT '/usr/sbin/asterisk',
    `asteriskSystemdService` VARCHAR(191) NULL DEFAULT 'asterisk',
    `customDialplanFile` VARCHAR(191) NULL DEFAULT '/etc/asterisk/extensions_custom.conf',
    `audioSocketBindHost` VARCHAR(191) NULL DEFAULT '127.0.0.1',
    `cdrSourceType` VARCHAR(191) NULL DEFAULT 'internal_cache',
    `cdrConnectionSettings` TEXT NULL,
    `lastHealthStatus` TEXT NULL,
    `lastSuccessfulSync` DATETIME(3) NULL,
    `lastError` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `mode` VARCHAR(191) NOT NULL DEFAULT 'local',
    `host` VARCHAR(191) NULL,
    `port` INTEGER NULL DEFAULT 22,
    `username` VARCHAR(191) NULL,
    `credentialReference` VARCHAR(191) NULL,
    `pjsipConfigPath` VARCHAR(191) NULL,
    `dialplanConfigPath` VARCHAR(191) NULL,
    `managedDialplanContext` VARCHAR(191) NULL DEFAULT 'internal',
    `lastTestedAt` DATETIME(3) NULL,
    `configFiles` JSON NULL,
    `sshHost` VARCHAR(191) NULL,
    `sshPort` INTEGER NULL DEFAULT 22,
    `sshUsername` VARCHAR(191) NULL,
    `sshPassword` VARCHAR(191) NULL,
    `localConfigDir` VARCHAR(191) NULL,

    UNIQUE INDEX `asterisk_provisioning_configs_ispId_key`(`ispId`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `asterisk_tool_assignments` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `ispId` INTEGER NOT NULL,
    `agentId` INTEGER NOT NULL,
    `toolName` VARCHAR(191) NOT NULL,
    `riskLevel` VARCHAR(191) NOT NULL DEFAULT 'read',
    `requiresConfirmation` BOOLEAN NOT NULL DEFAULT false,
    `requiredPermission` VARCHAR(191) NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `asterisk_tool_assignments_ispId_agentId_toolName_key`(`ispId`, `agentId`, `toolName`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

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
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

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
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

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
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

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
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

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
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

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
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

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
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

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
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

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
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

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
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

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
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

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
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

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
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

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
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `audit_logs_ispId_timestamp_idx` ON `audit_logs`(`ispId`, `timestamp`);

-- CreateIndex
CREATE INDEX `audit_logs_branchId_timestamp_idx` ON `audit_logs`(`branchId`, `timestamp`);

-- CreateIndex
CREATE INDEX `lead_resellerId_idx` ON `lead`(`resellerId`);

-- CreateIndex
CREATE INDEX `OLT_resellerId_idx` ON `OLT`(`resellerId`);

-- CreateIndex
CREATE INDEX `User_resellerId_idx` ON `User`(`resellerId`);

-- AddForeignKey
ALTER TABLE `resellers` ADD CONSTRAINT `reseller_isp_fkey` FOREIGN KEY (`ispId`) REFERENCES `ISP`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `wallets` ADD CONSTRAINT `wallet_branch_fkey` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `wallets` ADD CONSTRAINT `wallet_reseller_fkey` FOREIGN KEY (`resellerId`) REFERENCES `resellers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `User` ADD CONSTRAINT `user_reseller_fkey` FOREIGN KEY (`resellerId`) REFERENCES `resellers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `lead` ADD CONSTRAINT `lead_reseller_fkey` FOREIGN KEY (`resellerId`) REFERENCES `resellers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Customer` ADD CONSTRAINT `customer_reseller_fkey` FOREIGN KEY (`resellerId`) REFERENCES `resellers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OLT` ADD CONSTRAINT `olt_reseller_fkey` FOREIGN KEY (`resellerId`) REFERENCES `resellers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `managed_devices` ADD CONSTRAINT `managed_devices_ispId_fkey` FOREIGN KEY (`ispId`) REFERENCES `ISP`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `managed_devices` ADD CONSTRAINT `managed_devices_branchId_fkey` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `managed_devices` ADD CONSTRAINT `managed_devices_resellerId_fkey` FOREIGN KEY (`resellerId`) REFERENCES `resellers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `managed_device_connection_profiles` ADD CONSTRAINT `managed_device_connection_profiles_deviceId_fkey` FOREIGN KEY (`deviceId`) REFERENCES `managed_devices`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `managed_device_credentials` ADD CONSTRAINT `managed_device_credentials_deviceId_fkey` FOREIGN KEY (`deviceId`) REFERENCES `managed_devices`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `managed_device_connections` ADD CONSTRAINT `managed_device_connections_deviceId_fkey` FOREIGN KEY (`deviceId`) REFERENCES `managed_devices`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `managed_device_status_history` ADD CONSTRAINT `managed_device_status_history_deviceId_fkey` FOREIGN KEY (`deviceId`) REFERENCES `managed_devices`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `managed_device_snapshots` ADD CONSTRAINT `managed_device_snapshots_deviceId_fkey` FOREIGN KEY (`deviceId`) REFERENCES `managed_devices`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `managed_device_backups` ADD CONSTRAINT `managed_device_backups_deviceId_fkey` FOREIGN KEY (`deviceId`) REFERENCES `managed_devices`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `managed_device_audits` ADD CONSTRAINT `managed_device_audits_deviceId_fkey` FOREIGN KEY (`deviceId`) REFERENCES `managed_devices`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `managed_device_commands` ADD CONSTRAINT `managed_device_commands_deviceId_fkey` FOREIGN KEY (`deviceId`) REFERENCES `managed_devices`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `managed_device_capabilities` ADD CONSTRAINT `managed_device_capabilities_deviceId_fkey` FOREIGN KEY (`deviceId`) REFERENCES `managed_devices`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `managed_device_configuration_tasks` ADD CONSTRAINT `managed_device_configuration_tasks_deviceId_fkey` FOREIGN KEY (`deviceId`) REFERENCES `managed_devices`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `asterisk_ai_agents` ADD CONSTRAINT `asterisk_ai_agent_isp_fkey` FOREIGN KEY (`ispId`) REFERENCES `ISP`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `asterisk_ai_agent_prompt_versions` ADD CONSTRAINT `asterisk_ai_agent_prompt_version_isp_fkey` FOREIGN KEY (`ispId`) REFERENCES `ISP`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `asterisk_inbound_routes` ADD CONSTRAINT `asterisk_inbound_route_isp_fkey` FOREIGN KEY (`ispId`) REFERENCES `ISP`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `asterisk_outbound_routes` ADD CONSTRAINT `asterisk_outbound_route_isp_fkey` FOREIGN KEY (`ispId`) REFERENCES `ISP`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `asterisk_queues` ADD CONSTRAINT `asterisk_queue_isp_fkey` FOREIGN KEY (`ispId`) REFERENCES `ISP`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `asterisk_ring_groups` ADD CONSTRAINT `asterisk_ring_group_isp_fkey` FOREIGN KEY (`ispId`) REFERENCES `ISP`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `asterisk_ivrs` ADD CONSTRAINT `asterisk_ivr_isp_fkey` FOREIGN KEY (`ispId`) REFERENCES `ISP`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `asterisk_recordings` ADD CONSTRAINT `asterisk_recording_isp_fkey` FOREIGN KEY (`ispId`) REFERENCES `ISP`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `asterisk_provisioning_configs` ADD CONSTRAINT `asterisk_provisioning_config_isp_fkey` FOREIGN KEY (`ispId`) REFERENCES `ISP`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

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

