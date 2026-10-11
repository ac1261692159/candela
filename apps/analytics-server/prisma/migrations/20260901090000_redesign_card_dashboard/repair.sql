-- 迁移 20260901090000 手动修复：完成失败后剩余步骤（第 7 条起）
-- 前提：第 1-6 条已生效（card 新列已加、dashboardcard 已建）
-- 注意：FK 实际名为 Card_db_id_fkey（Prisma 大写命名），索引 Card_db_id_idx

-- 1. sqlreport → card（db_id 用占位值满足当前 NOT NULL，随后整列删除）
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

-- 2. 摘掉旧外键与索引（真实名称）
ALTER TABLE `card` DROP FOREIGN KEY `Card_db_id_fkey`;
ALTER TABLE `card` DROP INDEX `Card_db_id_idx`;

-- 3. 删除布局列与 db_id
ALTER TABLE `card`
  DROP COLUMN `db_id`,
  DROP COLUMN `position_x`,
  DROP COLUMN `position_y`,
  DROP COLUMN `width`,
  DROP COLUMN `height`;

-- 4. 新索引
CREATE INDEX `card_project_name_type_idx` ON `card` (`project_name`, `type`);
CREATE INDEX `card_owner_idx` ON `card` (`owner`);

-- 5. sqlreport 弃用（数据已迁入 card）
RENAME TABLE `sqlreport` TO `sqlreport_deprecated_20260901`;

-- 验证输出
SELECT card_id, name, type, project_name, owner FROM `card`;
SHOW CREATE TABLE `card`\G
