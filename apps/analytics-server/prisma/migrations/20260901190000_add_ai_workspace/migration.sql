-- DeepSeek Harness Workspace、模板版本和同步审计。
CREATE TABLE `aiworkspace` (
    `id` VARCHAR(191) NOT NULL,
    `user_id` VARCHAR(191) NOT NULL,
    `project_name` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(191) NOT NULL,
    `display_name` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'creating',
    `initialized_from` VARCHAR(191) NOT NULL DEFAULT 'template',
    `applied_template_version` INTEGER NULL,
    `last_access_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expires_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `AiWorkspace_user_id_project_name_kind_display_name_key`(`user_id`, `project_name`, `kind`, `display_name`),
    INDEX `AiWorkspace_project_name_user_id_idx`(`project_name`, `user_id`),
    INDEX `AiWorkspace_status_expires_at_idx`(`status`, `expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `aiworkspacetemplateversion` (
    `version` INTEGER NOT NULL AUTO_INCREMENT,
    `state` VARCHAR(191) NOT NULL DEFAULT 'published',
    `manifest_json` JSON NOT NULL,
    `content_digest` VARCHAR(191) NOT NULL,
    `published_by` VARCHAR(191) NOT NULL,
    `published_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AiWorkspaceTemplateVersion_state_published_at_idx`(`state`, `published_at`),
    PRIMARY KEY (`version`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `aiworkspacesyncjob` (
    `id` VARCHAR(191) NOT NULL,
    `template_version` INTEGER NOT NULL,
    `scope_json` JSON NOT NULL,
    `state` VARCHAR(191) NOT NULL DEFAULT 'planned',
    `requested_by` VARCHAR(191) NOT NULL,
    `planned_count` INTEGER NOT NULL DEFAULT 0,
    `success_count` INTEGER NOT NULL DEFAULT 0,
    `failed_count` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finished_at` DATETIME(3) NULL,

    INDEX `AiWorkspaceSyncJob_state_created_at_idx`(`state`, `created_at`),
    INDEX `AiWorkspaceSyncJob_template_version_idx`(`template_version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `aiworkspacesyncitem` (
    `id` VARCHAR(191) NOT NULL,
    `job_id` VARCHAR(191) NOT NULL,
    `workspace_id` VARCHAR(191) NOT NULL,
    `state` VARCHAR(191) NOT NULL DEFAULT 'planned',
    `diff_json` JSON NULL,
    `recovery_path` VARCHAR(191) NULL,
    `error_code` VARCHAR(191) NULL,
    `started_at` DATETIME(3) NULL,
    `finished_at` DATETIME(3) NULL,

    UNIQUE INDEX `AiWorkspaceSyncItem_job_id_workspace_id_key`(`job_id`, `workspace_id`),
    INDEX `AiWorkspaceSyncItem_workspace_id_state_idx`(`workspace_id`, `state`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `aiworkspace` ADD CONSTRAINT `AiWorkspace_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `sauser`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `aiworkspacetemplateversion` ADD CONSTRAINT `AiWorkspaceTemplateVersion_published_by_fkey` FOREIGN KEY (`published_by`) REFERENCES `sauser`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `aiworkspacesyncjob` ADD CONSTRAINT `AiWorkspaceSyncJob_template_version_fkey` FOREIGN KEY (`template_version`) REFERENCES `aiworkspacetemplateversion`(`version`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `aiworkspacesyncjob` ADD CONSTRAINT `AiWorkspaceSyncJob_requested_by_fkey` FOREIGN KEY (`requested_by`) REFERENCES `sauser`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `aiworkspacesyncitem` ADD CONSTRAINT `AiWorkspaceSyncItem_job_id_fkey` FOREIGN KEY (`job_id`) REFERENCES `aiworkspacesyncjob`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `aiworkspacesyncitem` ADD CONSTRAINT `AiWorkspaceSyncItem_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `aiworkspace`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
