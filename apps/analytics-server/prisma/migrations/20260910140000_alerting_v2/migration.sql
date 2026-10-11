-- 分析指标告警 + 邮件/短信联系人（phase: clklog-analytics-alerting-v2）
ALTER TABLE `alertcontact`
    ADD COLUMN `address` VARCHAR(191) NOT NULL DEFAULT '',
    MODIFY `webhook_url` VARCHAR(512) NOT NULL DEFAULT '';

ALTER TABLE `alertrule`
    ADD COLUMN `source` VARCHAR(191) NOT NULL DEFAULT 'builtin',
    ADD COLUMN `card_id` VARCHAR(191) NULL,
    ADD COLUMN `metric_key` VARCHAR(191) NULL,
    ADD COLUMN `project_name` VARCHAR(64) NULL;

CREATE INDEX `alertrule_source_idx` ON `alertrule` (`source`);
