-- 卡片与看板描述（phase: clklog-analytics-asset-description-v1）
ALTER TABLE `card` ADD COLUMN `description` VARCHAR(200) NULL;
ALTER TABLE `Dashboard` ADD COLUMN `description` VARCHAR(500) NULL;
