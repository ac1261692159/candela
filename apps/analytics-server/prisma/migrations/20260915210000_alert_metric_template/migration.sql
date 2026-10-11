-- 告警 v4（phase: clklog-analytics-alerting-v4）
-- 1) 告警对象从「分析卡片」改为「数据管理指标」：新增 metric_id / window_days
-- 2) 旧卡片来源规则停用（生产 0 条；卡片路径本期下线，避免残留规则继续被检测）
-- 3) 新增可编辑通知模板表 alerttemplate（无记录时用代码内置默认模板）
-- 说明：card_id / metric_key 保留不删——破坏性删列不可逆，代码已不再读写。

ALTER TABLE `alertrule`
  ADD COLUMN `metric_id` VARCHAR(191) NULL,
  ADD COLUMN `window_days` INT NOT NULL DEFAULT 1;

CREATE INDEX `alertrule_metric_id_idx` ON `alertrule` (`metric_id`);

UPDATE `alertrule` SET `enabled` = 0 WHERE `source` = 'card';

CREATE TABLE `alerttemplate` (
    `id`           BIGINT       NOT NULL AUTO_INCREMENT,
    `project_name` VARCHAR(191) NOT NULL,
    `kind`         VARCHAR(191) NOT NULL,
    `channel`      VARCHAR(191) NOT NULL,
    `subject`      VARCHAR(191) NOT NULL DEFAULT '',
    `body`         TEXT         NOT NULL,
    `updated_by`   VARCHAR(191) NOT NULL,
    `updated_at`   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (`id`),
    UNIQUE INDEX `alerttemplate_project_name_kind_channel_key` (`project_name`, `kind`, `channel`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
