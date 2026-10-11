-- 模型供应商 v1.2（phase: clklog-ai-model-providers-v1）：
-- 逐模型记录连接测试结果。只有「配了密钥且测试通过」的模型才下发给 Harness 的模型列表，
-- 避免把选了必然失败的模型摆在用户面前。
ALTER TABLE `saaimodelprovider`
    ADD COLUMN `verified_json` TEXT NOT NULL DEFAULT ('[]'),
    ADD COLUMN `last_test_at` DATETIME(3) NULL,
    ADD COLUMN `last_test_by` VARCHAR(191) NULL;
