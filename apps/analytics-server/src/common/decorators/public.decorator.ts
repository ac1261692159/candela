import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** 标记无需鉴权的接口（如登录） */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
