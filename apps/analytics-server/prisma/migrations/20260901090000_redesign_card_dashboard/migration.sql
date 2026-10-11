-- 卡片体系重设计：卡片成为全局资产，看板通过关联表引用
-- 1) card 表补全局字段；2) 布局字段迁入新表 dashboardcard；3) sqlreport 迁入 card 后弃用
--
-- ⚠️ 生产环境实际执行记录（2026-09-01）：本迁移在「第 7 条 INSERT sqlreport→card」处失败
-- （card.db_id 当时仍 NOT NULL 且 FK 存在），已通过 repair.sql（同目录）+ `migrate resolve --applied`
-- 人工完成。本文件已按实际最终状态修正（FK 大写名 Card_db_id_fkey、db_id 占位 + 会话级 FK 检查关闭），
-- 供全新环境一次性执行。

SET FOREIGN_KEY_CHECKS = 0;

-- 1. card 补列
ALTER TABLE `card` ADD COLUMN `project_name` VARCHAR(191) NOT NULL DEFAULT 'clklogapp';
ALTER TABLE `card` ADD COLUMN `owner` VARCHAR(191) NOT NULL DEFAULT 'migrated';
ALTER TABLE `card` ADD COLUMN `name` VARCHAR(191) NOT NULL DEFAULT '未命名卡片';

-- 用 dashboard.project_name / owner 回填真实值
UPDATE `card` c JOIN `dashboard` d ON c.db_id = d.db_id
  SET c.project_name = d.project_name, c.owner = d.owner;

-- 2. 布局迁入关联表
CREATE TABLE `dashboardcard` (
    `id` VARCHAR(191) NOT NULL,
    `db_id` VARCHAR(191) NOT NULL,
    `card_id` VARCHAR(191) NOT NULL,
    `position_x` INTEGER NOT NULL DEFAULT 0,
    `position_y` INTEGER NOT NULL DEFAULT 0,
    `width` INTEGER NOT NULL DEFAULT 6,
    `height` INTEGER NOT NULL DEFAULT 4,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `dashboardcard_db_id_card_id_key`(`db_id`, `card_id`),
    INDEX `dashboardcard_card_id_idx`(`card_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `dashboardcard` (`id`, `db_id`, `card_id`, `position_x`, `position_y`, `width`, `height`)
SELECT UUID(), `db_id`, `card_id`, `position_x`, `position_y`, `width`, `height` FROM `card`;

-- 3. sqlreport 迁入 card（type='sql'；db_id 占位满足旧约束，第 4 步整列删除）
INSERT INTO `card` (`card_id`, `db_id`, `project_name`, `owner`, `name`, `type`, `dsl_json`, `chart_type`, `refresh_policy`, `created_at`, `updated_at`)
SELECT
  CONCAT('card_sql_', REPLACE(LOWER(CAST(`id` AS CHAR)), '-', '')),
  '__deprecated__',
  `project_name`,
  `owner`,
  `name`,
  'sql',
  JSON_OBJECT('sql_text', IFNULL(`sql_text`, ''), 'field_map', `field_map_json`, 'chart_config', `chart_config`),
  CASE WHEN IFNULL(`chart_config`, '{}') LIKE '%bar%' THEN 'bar' ELSE 'line' END,
  'manual',
  `created_at`,
  `updated_at`
FROM `sqlreport`;

SET FOREIGN_KEY_CHECKS = 1;

-- 4. card 摘掉旧外键与布局列（FK/索引为 Prisma 大写命名）
ALTER TABLE `card` DROP FOREIGN KEY `Card_db_id_fkey`;
ALTER TABLE `card` DROP INDEX `Card_db_id_idx`;
ALTER TABLE `card`
  DROP COLUMN `db_id`,
  DROP COLUMN `position_x`,
  DROP COLUMN `position_y`,
  DROP COLUMN `width`,
  DROP COLUMN `height`;

-- 5. 索引
CREATE INDEX `card_project_name_type_idx` ON `card` (`project_name`, `type`);
CREATE INDEX `card_owner_idx` ON `card` (`owner`);

-- 6. sqlreport 弃用（数据已迁；表保留作备份，观察期后可 DROP）
RENAME TABLE `sqlreport` TO `sqlreport_deprecated_20260901`;
