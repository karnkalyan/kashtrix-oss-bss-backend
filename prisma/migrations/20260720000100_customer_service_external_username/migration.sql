ALTER TABLE `CustomerSubscribedService`
  ADD COLUMN `externalUsername` VARCHAR(191) NULL;

CREATE INDEX `CustomerSubscribedService_serviceId_externalUsername_idx`
  ON `CustomerSubscribedService`(`serviceId`, `externalUsername`);

UPDATE `CustomerSubscribedService` css
JOIN `Service` service ON service.id = css.serviceId AND service.code = 'NETTV'
SET css.externalUsername = COALESCE(
  JSON_UNQUOTE(JSON_EXTRACT(css.serviceData, '$.username')),
  JSON_UNQUOTE(JSON_EXTRACT(css.serviceData, '$.subscriber.username'))
)
WHERE css.externalUsername IS NULL;
