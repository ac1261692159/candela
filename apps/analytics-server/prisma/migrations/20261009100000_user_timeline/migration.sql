-- 单用户行为序列（phase: clklog-analytics-user-timeline-v1）
-- 记录表泛化为两种 kind：debug（既有）/ user_timeline；时间线规格与汇总入 spec_json/summary_json，window 对时间线为空

-- AlterTable
ALTER TABLE `MetaDebugRecord` ADD COLUMN `kind` VARCHAR(191) NOT NULL DEFAULT 'debug',
    ADD COLUMN `spec_json` TEXT NULL,
    ADD COLUMN `summary_json` TEXT NULL,
    MODIFY `window` VARCHAR(191) NULL;

