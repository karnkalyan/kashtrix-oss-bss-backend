ALTER TABLE `CustomerSubscribedService`
  ADD COLUMN `externalUsername` VARCHAR(191) NULL;

-- Preserve usernames from existing NETTV service payloads where possible.
UPDATE `CustomerSubscribedService` css
JOIN `Service` service ON service.id = css.serviceId AND service.code = 'NETTV'
SET css.externalUsername = COALESCE(
  NULLIF(JSON_UNQUOTE(JSON_EXTRACT(css.serviceData, '$.username')), ''),
  NULLIF(JSON_UNQUOTE(JSON_EXTRACT(css.serviceData, '$.subscriber.username')), '')
)
WHERE css.externalUsername IS NULL AND css.serviceData IS NOT NULL;

CREATE INDEX `CustomerSubscribedService_serviceId_externalUsername_idx`
  ON `CustomerSubscribedService`(`serviceId`, `externalUsername`);
