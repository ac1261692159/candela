-- 看板工作室：刷新间隔 / 缓存 TTL / 网格列数 + 卡片独立缓存表
ALTER TABLE `Dashboard`
  ADD COLUMN `refresh_interval_sec` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `cache_ttl_sec` INTEGER NOT NULL DEFAULT 300,
  ADD COLUMN `grid_columns` INTEGER NOT NULL DEFAULT 24;

CREATE TABLE `cardcache` (
    `card_id` VARCHAR(191) NOT NULL,
    `result_json` LONGTEXT NULL,
    `error` TEXT NULL,
    `row_count` INTEGER NOT NULL DEFAULT 0,
    `refreshed_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`card_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `cardcache` ADD CONSTRAINT `cardcache_card_id_fkey` FOREIGN KEY (`card_id`) REFERENCES `Card`(`card_id`) ON DELETE CASCADE ON UPDATE CASCADE;
