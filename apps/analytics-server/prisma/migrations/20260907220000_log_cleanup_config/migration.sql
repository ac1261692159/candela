-- 数据管理 V1.1 日志治理（程序内实现，不依赖 cron/Puppet）
CREATE TABLE `ops_log_cleanup_config` (
    `id`                BIGINT       NOT NULL AUTO_INCREMENT,
    `path`              VARCHAR(255) NOT NULL,
    `label`             VARCHAR(191) NOT NULL,
    `retain_days`       INT          NOT NULL DEFAULT 3,
    `enabled`           BOOLEAN      NOT NULL DEFAULT true,
    `last_run_at`       DATETIME(3)  NULL,
    `last_freed_bytes`  BIGINT       NULL,
    `last_file_count`   INT          NULL,
    UNIQUE INDEX `ops_log_cleanup_config_path_key` (`path`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 种子：receiver 原始报文日志目录（默认保留 3 天，自动清理开启）
INSERT IGNORE INTO `ops_log_cleanup_config` (`path`, `label`, `retain_days`, `enabled`)
VALUES ('/data/clklog/clklog-docker-compose/clklog_dc_data/receiver', 'receiver 原始报文日志', 3, 1);
