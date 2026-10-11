-- 账号生命周期 v2（phase: clklog-analytics-account-lifecycle-v2）
-- 一次性令牌 + 项目邀请
CREATE TABLE `saauthtoken` (
    `id` VARCHAR(191) NOT NULL,
    `user_id` VARCHAR(191) NULL,
    `email` VARCHAR(191) NULL,
    `purpose` VARCHAR(191) NOT NULL,
    `token_hash` VARCHAR(191) NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `used_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `SaAuthToken_token_hash_key`(`token_hash`),
    INDEX `SaAuthToken_email_purpose_created_at_idx`(`email`, `purpose`, `created_at`),
    INDEX `SaAuthToken_purpose_created_at_idx`(`purpose`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `saauthtoken` ADD CONSTRAINT `SaAuthToken_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `sauser`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE `sainvitation` (
    `id` VARCHAR(191) NOT NULL,
    `project_name` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `role_key` VARCHAR(191) NOT NULL,
    `token_hash` VARCHAR(191) NOT NULL,
    `invited_by` VARCHAR(191) NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `accepted_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `SaInvitation_token_hash_key`(`token_hash`),
    INDEX `SaInvitation_project_name_email_idx`(`project_name`, `email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
