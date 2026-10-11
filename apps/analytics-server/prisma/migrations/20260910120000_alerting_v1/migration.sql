-- 运维告警工作台（phase: clklog-analytics-alerting-v1）
CREATE TABLE `alertcontact` (
    `id`          BIGINT       NOT NULL AUTO_INCREMENT,
    `name`        VARCHAR(191) NOT NULL,
    `kind`        VARCHAR(191) NOT NULL DEFAULT 'feishu_webhook',
    `webhook_url` VARCHAR(512) NOT NULL,
    `is_default`  BOOLEAN      NOT NULL DEFAULT false,
    `created_at`  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `alertrule`
    ADD COLUMN `severity`          VARCHAR(191) NOT NULL DEFAULT 'warning',
    ADD COLUMN `comparator`        VARCHAR(191) NOT NULL DEFAULT 'gt',
    ADD COLUMN `unit`              VARCHAR(191) NOT NULL DEFAULT '',
    ADD COLUMN `window_minutes`    INT          NOT NULL DEFAULT 1,
    ADD COLUMN `for_windows`       INT          NOT NULL DEFAULT 1,
    ADD COLUMN `repeat_minutes`    INT          NOT NULL DEFAULT 60,
    ADD COLUMN `notify_on_resolve` BOOLEAN      NOT NULL DEFAULT true,
    ADD COLUMN `contact_id`        BIGINT       NULL;

ALTER TABLE `alertrule`
    ADD CONSTRAINT `alertrule_contact_id_fkey`
        FOREIGN KEY (`contact_id`) REFERENCES `alertcontact` (`id`) ON DELETE SET NULL ON UPDATE CASCADE;

UPDATE `alertrule` SET `comparator` = 'lt', `unit` = '%' WHERE `code` = 'disk_space_low';
UPDATE `alertrule` SET `comparator` = 'gt', `unit` = '分钟' WHERE `code` = 'data_link_stale';
UPDATE `alertrule` SET `comparator` = 'gte', `unit` = '次' WHERE `code` = 'clickhouse_down';
UPDATE `alertrule` SET `comparator` = 'gt', `unit` = '次' WHERE `code` = 'slow_query_spike';
UPDATE `alertrule` SET `comparator` = 'gt', `unit` = '%' WHERE `code` = 'query_fail_rate';
UPDATE `alertrule` SET `comparator` = 'gte', `unit` = '次' WHERE `code` = 'card_cache_fail';

CREATE TABLE `alertmute` (
    `id`         BIGINT       NOT NULL AUTO_INCREMENT,
    `rule_code`  VARCHAR(191) NULL,
    `starts_at`  DATETIME(3)  NOT NULL,
    `ends_at`    DATETIME(3)  NOT NULL,
    `reason`     VARCHAR(191) NOT NULL DEFAULT '',
    `created_at` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX `alertmute_ends_at_idx` (`ends_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `alertnotification` (
    `id`         BIGINT       NOT NULL AUTO_INCREMENT,
    `rule_code`  VARCHAR(191) NOT NULL,
    `event_id`   BIGINT       NULL,
    `kind`       VARCHAR(191) NOT NULL,
    `status`     VARCHAR(191) NOT NULL,
    `error`      VARCHAR(512) NULL,
    `created_at` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX `alertnotification_created_at_idx` (`created_at`),
    INDEX `alertnotification_rule_code_created_at_idx` (`rule_code`, `created_at`),
    PRIMARY KEY (`id`),
    CONSTRAINT `alertnotification_event_id_fkey`
        FOREIGN KEY (`event_id`) REFERENCES `alertevent` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
