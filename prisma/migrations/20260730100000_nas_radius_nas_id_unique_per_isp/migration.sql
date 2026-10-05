-- Drop global unique constraint on radiusNasId and add composite unique constraint on (ispId, radiusNasId)
DROP INDEX `nas_radiusNasId_key` ON `nas`;
CREATE UNIQUE INDEX `nas_ispId_radiusNasId_key` ON `nas` (`ispId`, `radiusNasId`);
