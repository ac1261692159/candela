-- 账号生命周期 v1（phase: clklog-analytics-account-lifecycle-v1）
-- SaUser：邮箱 / 创建人 / 强制改密 / 登录锁定 / 最近登录。全部可空或带默认，存量行无感。
ALTER TABLE `sauser`
    ADD COLUMN `email` VARCHAR(191) NULL,
    ADD COLUMN `created_by` VARCHAR(64) NULL,
    ADD COLUMN `must_change_password` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `failed_login_count` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `locked_until` DATETIME(3) NULL,
    ADD COLUMN `last_login_at` DATETIME(3) NULL,
    ADD UNIQUE INDEX `SaUser_email_key`(`email`);
