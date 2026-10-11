-- 通知记录标注投递目标（多联系人后同一事件会写多行，需能看出是哪条通道失败）
-- phase: clklog-analytics-alert-channels-v1
-- 只存快照，不加外键：联系人被删/改名后历史记录仍要保留当时的名字。
ALTER TABLE `alertnotification`
  ADD COLUMN `contact_id` BIGINT NULL,
  ADD COLUMN `contact_name` VARCHAR(191) NULL;
