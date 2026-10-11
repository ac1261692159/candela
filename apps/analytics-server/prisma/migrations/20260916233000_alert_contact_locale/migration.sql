-- 告警联系人界面语言（i18n v1）：通知按收件人语言渲染（见 docs/architecture/clklog-analytics-design-i18n-v1.md §7.1）
ALTER TABLE `alertcontact` ADD COLUMN `locale` VARCHAR(16) NULL;
