-- Debug 查询留档（phase: clklog-analytics-debug-query-v1）
-- ① sa_project 增列 debug_archive_enabled（项目级留档开关，默认开）
-- ② 留档两表：条件 + 命中数 + 结果行快照；删除级联，删除动作另写 ops_action_log 审计

-- AlterTable
ALTER TABLE `SaProject` ADD COLUMN `debug_archive_enabled` BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE `MetaDebugRecord` (
    `id` VARCHAR(191) NOT NULL,
    `project_name` VARCHAR(191) NOT NULL,
    `created_by` VARCHAR(191) NOT NULL,
    `created_by_name` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `window` VARCHAR(191) NOT NULL,
    `cond_distinct_id` VARCHAR(191) NULL,
    `cond_user_key` VARCHAR(191) NULL,
    `cond_event` VARCHAR(191) NULL,
    `cond_limit` INTEGER NOT NULL,
    `matched_total` INTEGER NOT NULL,
    `row_count` INTEGER NOT NULL,
    `truncated` BOOLEAN NOT NULL DEFAULT false,
    `duration_ms` INTEGER NULL,

    INDEX `MetaDebugRecord_project_name_created_at_idx`(`project_name`, `created_at`),
    INDEX `MetaDebugRecord_created_by_idx`(`created_by`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MetaDebugRecordRow` (
    `id` VARCHAR(191) NOT NULL,
    `record_id` VARCHAR(191) NOT NULL,
    `seq` INTEGER NOT NULL,
    `log_time` VARCHAR(191) NOT NULL,
    `event` VARCHAR(191) NOT NULL,
    `distinct_id` VARCHAR(191) NOT NULL,
    `user_key` VARCHAR(191) NOT NULL,
    `properties` TEXT NOT NULL,
    `properties_truncated` BOOLEAN NOT NULL DEFAULT false,

    INDEX `MetaDebugRecordRow_record_id_seq_idx`(`record_id`, `seq`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `MetaDebugRecordRow` ADD CONSTRAINT `MetaDebugRecordRow_record_id_fkey` FOREIGN KEY (`record_id`) REFERENCES `MetaDebugRecord`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

