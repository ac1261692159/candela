-- 数据治理 · 敏感数据清洗审计表（phase: clklog-analytics-v1-data-governance §5.2）
-- 红线 6：任何删除/掩码前必须有备份与审计记录；本表即审计落点
CREATE TABLE `audit_cleanup` (
    `id`            BIGINT       NOT NULL AUTO_INCREMENT,
    `operator`      VARCHAR(128) NOT NULL,
    `action`        VARCHAR(16)  NOT NULL,
    `target_db`     VARCHAR(64)  NOT NULL,
    `target_table`  VARCHAR(128) NOT NULL,
    `rule_json`     JSON         NULL,
    `backup_table`  VARCHAR(255) NOT NULL DEFAULT '',
    `affected_rows` BIGINT       NOT NULL DEFAULT 0,
    `staged`        TINYINT      NOT NULL DEFAULT 0,
    `status`        VARCHAR(16)  NOT NULL DEFAULT 'running',
    `error`         TEXT         NULL,
    `created_at`    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX `audit_cleanup_created_at_idx` (`created_at`),
    INDEX `audit_cleanup_target_table_created_at_idx` (`target_table`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
