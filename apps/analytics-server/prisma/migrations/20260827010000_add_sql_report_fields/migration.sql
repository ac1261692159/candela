-- SqlReport 扩展：支持 mode/dsl/chart_config/schema_version，sql_text/field_map_json 改为可空
ALTER TABLE `sqlreport`
    ADD COLUMN `mode` VARCHAR(191) NOT NULL DEFAULT 'sql',
    ADD COLUMN `dsl_json` TEXT NULL,
    ADD COLUMN `chart_config` TEXT NULL,
    ADD COLUMN `schema_version` INTEGER NOT NULL DEFAULT 1,
    MODIFY `sql_text` TEXT NULL,
    MODIFY `field_map_json` TEXT NULL;
