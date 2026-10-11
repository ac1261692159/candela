-- 数据质量 × 数据运维 闭环（phase: clklog-data-quality-ops-v1）
-- ① 对拍配置（单行）② 快照扩展 ③ 保留策略登记 ④ 清理登记

CREATE TABLE `ops_reconcile_config` (
    `id`                INT NOT NULL AUTO_INCREMENT,
    `enabled`           BOOLEAN NOT NULL DEFAULT true,
    `run_at`            VARCHAR(5) NOT NULL DEFAULT '03:30',
    `threshold_pct`     DOUBLE NOT NULL DEFAULT 10,
    `ignore_events`     JSON NULL,
    `skip_empty_event`  BOOLEAN NOT NULL DEFAULT true,
    `stale_warn_hours`  INT NOT NULL DEFAULT 24,
    `stale_error_hours` INT NOT NULL DEFAULT 72,
    `updated_by`        VARCHAR(191) NOT NULL,
    `updated_at`        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `ops_reconcile_snapshot`
    ADD COLUMN `events` JSON NULL,
    ADD COLUMN `skipped` JSON NULL,
    ADD COLUMN `threshold_pct` DOUBLE NULL,
    ADD COLUMN `report_path` VARCHAR(255) NULL,
    ADD COLUMN `trigger` VARCHAR(16) NOT NULL DEFAULT 'manual',
    ADD COLUMN `discovery_count` INT NOT NULL DEFAULT 0;

CREATE TABLE `ops_retention_policy` (
    `id`           INT NOT NULL AUTO_INCREMENT,
    `target_db`    VARCHAR(64) NOT NULL,
    `target_table` VARCHAR(128) NOT NULL,
    `keep_days`    INT NOT NULL,
    `mode`         VARCHAR(16) NOT NULL DEFAULT 'ttl',
    `enabled`      BOOLEAN NOT NULL DEFAULT true,
    `remark`       VARCHAR(255) NULL,
    `updated_by`   VARCHAR(191) NOT NULL,
    `updated_at`   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE INDEX `ops_retention_policy_db_table_key` (`target_db`, `target_table`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ops_cleanup_ledger` (
    `id`           BIGINT NOT NULL AUTO_INCREMENT,
    `target_db`    VARCHAR(64) NOT NULL,
    `target_table` VARCHAR(128) NOT NULL,
    `scope_type`   VARCHAR(16) NOT NULL,
    `range_from`   VARCHAR(10) NOT NULL,
    `range_to`     VARCHAR(10) NOT NULL,
    `action`       VARCHAR(32) NOT NULL,
    `detail`       JSON NULL,
    `snapshot_id`  BIGINT NULL,
    `operator`     VARCHAR(191) NOT NULL,
    `executed_at`  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX `ops_cleanup_ledger_table_range_idx` (`target_table`, `range_from`, `range_to`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
