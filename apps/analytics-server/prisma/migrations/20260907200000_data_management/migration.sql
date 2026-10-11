-- 数据管理 V1.0（phase: clklog-analytics-data-management-v1）
-- 纯新增表，不触碰任何现有表（红线 6）

-- 对拍快照：reconcile 完成后落库，数据管理页读快照
-- （完整对拍 ~59s，不适合每次进页面都跑；设计文档 §3.3）
CREATE TABLE `ops_reconcile_snapshot` (
    `id`           BIGINT       NOT NULL AUTO_INCREMENT,
    `project_name` VARCHAR(191) NOT NULL,
    `ran_at`       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `range_from`   VARCHAR(191) NOT NULL,
    `range_to`     VARCHAR(191) NOT NULL,
    `summary`      JSON         NOT NULL,
    `daily`        JSON         NULL,
    `crc`          JSON         NULL,
    INDEX `ops_reconcile_snapshot_project_ran_at_idx` (`project_name`, `ran_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
