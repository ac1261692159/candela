-- 外部 AI 只读查询 API Key
CREATE TABLE `saapikey` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `key_hash` VARCHAR(191) NOT NULL,
    `project_name` VARCHAR(191) NOT NULL DEFAULT 'clklogapp',
    `status` VARCHAR(191) NOT NULL DEFAULT 'active',
    `expires_at` DATETIME(3) NULL,
    `last_used_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `SaApiKey_key_hash_key`(`key_hash`),
    INDEX `SaApiKey_project_name_idx`(`project_name`),
    INDEX `SaApiKey_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
