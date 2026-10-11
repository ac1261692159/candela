-- 告警通道扩展（phase: clklog-analytics-alert-channels-v1）
-- 1) 联系人增加通道专属选项列
ALTER TABLE `alertcontact` ADD COLUMN `options_json` TEXT NULL;

-- 2) 通道平台级配置表（凭证加密存储）
CREATE TABLE `alertchannelconfig` (
    `id`            VARCHAR(191) NOT NULL,
    `channel`       VARCHAR(191) NOT NULL,
    `enabled`       BOOLEAN      NOT NULL DEFAULT false,
    `config_json`   TEXT         NOT NULL,
    `secret_cipher` TEXT         NULL,
    `updated_by`    VARCHAR(191) NOT NULL,
    `updated_at`    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE INDEX `alertchannelconfig_channel_key` (`channel`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 3) 通知模板通道收敛为「通道组」：飞书 → chat（email / sms 不变）
UPDATE `alerttemplate` SET `channel` = 'chat' WHERE `channel` = 'feishu_webhook';
