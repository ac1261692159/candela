-- 用户界面语言偏好（i18n v1）
-- 可空：null 表示未设置，前端按浏览器语言解析（见 docs/architecture/clklog-analytics-design-i18n-v1.md §5.2）
ALTER TABLE `sauser` ADD COLUMN `locale` VARCHAR(16) NULL;
