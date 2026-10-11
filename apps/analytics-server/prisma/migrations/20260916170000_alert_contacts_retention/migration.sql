-- 告警通道扩展（第二批）：联系人启用/多联系人绑定 + 数据保留策略
-- phase: clklog-analytics-alert-channels-v1

-- 1) 联系人启用开关（取代「默认联系人」概念）
ALTER TABLE `alertcontact` ADD COLUMN `enabled` BOOLEAN NOT NULL DEFAULT true;

-- 2) 规则 ↔ 联系人多对多（一条规则可发到多个渠道）
CREATE TABLE `alertrulecontact` (
    `id`         BIGINT NOT NULL AUTO_INCREMENT,
    `rule_code`  VARCHAR(191) NOT NULL,
    `contact_id` BIGINT NOT NULL,
    UNIQUE INDEX `alertrulecontact_rule_code_contact_id_key` (`rule_code`, `contact_id`),
    INDEX `alertrulecontact_contact_id_idx` (`contact_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 外键与 Prisma 的 onDelete: Cascade 对齐：删规则/删联系人时绑定行自动清理，避免孤儿行
ALTER TABLE `alertrulecontact` ADD CONSTRAINT `alertrulecontact_rule_code_fkey`
  FOREIGN KEY (`rule_code`) REFERENCES `alertrule` (`code`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `alertrulecontact` ADD CONSTRAINT `alertrulecontact_contact_id_fkey`
  FOREIGN KEY (`contact_id`) REFERENCES `alertcontact` (`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- 把既有的单联系人绑定搬迁为多对多第一行
INSERT IGNORE INTO `alertrulecontact` (`rule_code`, `contact_id`)
SELECT `code`, `contact_id` FROM `alertrule`
WHERE `contact_id` IS NOT NULL;

-- 3) 数据保留策略（events/notifications 默认一年，audits 默认永久）
CREATE TABLE `alertretention` (
    `id`          VARCHAR(191) NOT NULL,
    `scope`       VARCHAR(191) NOT NULL,
    `retain_days` INT NULL,
    `updated_by`  VARCHAR(191) NOT NULL,
    `updated_at`  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE INDEX `alertretention_scope_key` (`scope`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT IGNORE INTO `alertretention` (`id`, `scope`, `retain_days`, `updated_by`) VALUES
  (UUID(), 'events', 365, 'system'),
  (UUID(), 'notifications', 365, 'system'),
  (UUID(), 'audits', NULL, 'system');
