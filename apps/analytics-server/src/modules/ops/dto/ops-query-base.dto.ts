import { Allow } from 'class-validator';

/**
 * axios 请求拦截器会给**所有**请求自动注入 `?project=...`（services/api.ts:34-43）。
 * 运维接口是平台级的，不按项目过滤，但 DTO 必须接收该参数，
 * 否则全局 forbidNonWhitelisted 判为未知属性直接 400：
 *
 *   property project should not exist
 *
 * 运维侧所有带 @Query() 的 DTO 一律继承本类（class-validator 会继承父类装饰器）。
 */
export class OpsProjectParamDto {
  @Allow()
  project?: string;
}
