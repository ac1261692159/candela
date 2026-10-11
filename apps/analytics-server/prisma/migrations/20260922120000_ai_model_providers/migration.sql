-- AI 模型供应商网页设置（phase: clklog-ai-model-providers-v1）
-- 供应商定义与密钥、默认模型从 config_server.yaml 迁入库；密钥只存 AES-256-GCM 密文。

CREATE TABLE `saaimodelprovider` (
    `id`             VARCHAR(191) NOT NULL,
    `provider_id`    VARCHAR(191) NOT NULL,
    `display_name`   VARCHAR(191) NOT NULL,
    `adapter`        VARCHAR(191) NOT NULL,
    `protocol`       VARCHAR(191) NOT NULL,
    `base_url`       VARCHAR(191) NOT NULL,
    `api_key_env`    VARCHAR(191) NOT NULL,
    `api_key_cipher` TEXT         NULL,
    `models_json`    TEXT         NOT NULL,
    `updated_by`     VARCHAR(191) NOT NULL,
    `updated_at`     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE INDEX `saaimodelprovider_provider_id_key` (`provider_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `saaimodelsettings` (
    `id`                       VARCHAR(191) NOT NULL DEFAULT 'singleton',
    `default_provider`         VARCHAR(191) NOT NULL,
    `default_model`            VARCHAR(191) NOT NULL,
    `default_reasoning_effort` VARCHAR(191) NOT NULL,
    `revision`                 INTEGER      NOT NULL DEFAULT 1,
    `updated_by`               VARCHAR(191) NOT NULL,
    `updated_at`               DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
