-- 数据表写入租约 / pending 版本（§9）+ 绑定显式展示列（VM-02）
ALTER TABLE `datatable`
  ADD COLUMN `pending_version` INTEGER NULL,
  ADD COLUMN `import_owner` VARCHAR(191) NULL,
  ADD COLUMN `lease_until` DATETIME(3) NULL;

ALTER TABLE `datatablebinding`
  ADD COLUMN `label_field` VARCHAR(50) NULL;
