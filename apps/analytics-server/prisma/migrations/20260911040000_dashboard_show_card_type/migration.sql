-- 看板是否显示卡片类型标签（phase: clklog-analytics-ux-polish-v1）
ALTER TABLE `Dashboard` ADD COLUMN `show_card_type` BOOLEAN NOT NULL DEFAULT false;
