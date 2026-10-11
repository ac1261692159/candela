-- Debug 重查询异步化（phase: clklog-analytics-debug-async-query-v1）
-- 复用留档表：加任务状态与错误码；历史行默认 done（语义不变，不回填）

-- AlterTable
ALTER TABLE `MetaDebugRecord` ADD COLUMN `error_code` VARCHAR(191) NULL,
    ADD COLUMN `finished_at` DATETIME(3) NULL,
    ADD COLUMN `started_at` DATETIME(3) NULL,
    ADD COLUMN `status` VARCHAR(191) NOT NULL DEFAULT 'done';

-- CreateIndex
CREATE INDEX `MetaDebugRecord_status_created_at_idx` ON `MetaDebugRecord`(`status`, `created_at`);

