-- 方案 B（对齐数数）：关联属性显式记录 join 键列，并保存各列的派生属性（属性名/类型/显示名）
ALTER TABLE `datatablebinding`
  ADD COLUMN `key_column` VARCHAR(50) NOT NULL DEFAULT '',
  ADD COLUMN `field_mappings` JSON NULL;
