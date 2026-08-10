CREATE TABLE `WhatsAppConversation` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `ispId` INTEGER NOT NULL,
  `phone` VARCHAR(32) NOT NULL,
  `displayName` VARCHAR(191) NULL,
  `lastMessage` TEXT NULL,
  `lastMessageAt` DATETIME(3) NULL,
  `unreadCount` INTEGER NOT NULL DEFAULT 0,
  `status` VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `WhatsAppConversation_ispId_phone_key`(`ispId`, `phone`),
  INDEX `WhatsAppConversation_ispId_lastMessageAt_idx`(`ispId`, `lastMessageAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `WhatsAppChatMessage` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `ispId` INTEGER NOT NULL,
  `conversationId` INTEGER NOT NULL,
  `direction` VARCHAR(10) NOT NULL,
  `provider` VARCHAR(20) NOT NULL,
  `messageId` VARCHAR(191) NULL,
  `body` TEXT NOT NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'SENT',
  `automated` BOOLEAN NOT NULL DEFAULT false,
  `sentByUserId` INTEGER NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `WhatsAppChatMessage_ispId_messageId_key`(`ispId`, `messageId`),
  INDEX `WhatsAppChatMessage_ispId_conversationId_createdAt_idx`(`ispId`, `conversationId`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `WhatsAppAutomationRule` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `ispId` INTEGER NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `triggerType` VARCHAR(20) NOT NULL DEFAULT 'KEYWORD',
  `keywords` JSON NULL,
  `response` TEXT NOT NULL,
  `enabled` BOOLEAN NOT NULL DEFAULT true,
  `priority` INTEGER NOT NULL DEFAULT 100,
  `businessHoursOnly` BOOLEAN NOT NULL DEFAULT false,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `WhatsAppAutomationRule_ispId_enabled_priority_idx`(`ispId`, `enabled`, `priority`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `WhatsAppChatMessage` ADD CONSTRAINT `WhatsAppChatMessage_conversationId_fkey`
  FOREIGN KEY (`conversationId`) REFERENCES `WhatsAppConversation`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
