-- 账号生命周期 v2 增补 v1.1：账号域 SMTP 网页配置（单行）
CREATE TABLE `saauthmailconfig` (
    `id` VARCHAR(191) NOT NULL DEFAULT 'singleton',
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `host` VARCHAR(191) NOT NULL DEFAULT '',
    `port` INTEGER NOT NULL DEFAULT 465,
    `secure` BOOLEAN NOT NULL DEFAULT true,
    `user` VARCHAR(191) NOT NULL DEFAULT '',
    `mail_from` VARCHAR(191) NOT NULL DEFAULT '',
    `secret_cipher` TEXT NULL,
    `updated_by` VARCHAR(191) NOT NULL DEFAULT '',
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
