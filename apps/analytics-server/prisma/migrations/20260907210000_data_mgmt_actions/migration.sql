-- 数据管理 V1.1（phase: clklog-analytics-data-management-v1）
-- 清理动作审计表：DROP PARTITION / TTL 设置留痕（红线6：危险动作必须可追溯）
CREATE TABLE `ops_action_log` (
    `id`               BIGINT       NOT NULL AUTO_INCREMENT,
    `action`           VARCHAR(50)  NOT NULL, -- drop_partition | set_ttl
    `target_table`     VARCHAR(191) NOT NULL,
    `detail`           JSON         NOT NULL,
    `dry_run_snapshot` JSON         NULL,
    `status`           VARCHAR(20)  NOT NULL DEFAULT 'done', -- done | failed | partial
    `error`            TEXT         NULL,
    `operator`         VARCHAR(191) NOT NULL,
    `created_at`       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX `ops_action_log_table_created_idx` (`target_table`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
