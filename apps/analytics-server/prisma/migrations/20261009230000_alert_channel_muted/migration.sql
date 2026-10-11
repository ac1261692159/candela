-- 告警通道暂停投递（PRD alert-channels 增补 v1.1 / 设计 §7.3）：
-- 与 enabled 正交：enabled = 本通道自己的凭证是否启用；muted = 这个通道现在发不发（保留配置与密钥）。
-- SQL 由 `prisma migrate diff --from-schema-datamodel <旧> --to-schema-datamodel <新> --script` 生成，与 schema 必然一致。
ALTER TABLE `alertchannelconfig` ADD COLUMN `muted` BOOLEAN NOT NULL DEFAULT false;
