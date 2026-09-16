/**
 * @june/shared:前后端共享的常量、校验契约与设计令牌。
 *
 * 该包不依赖任何运行时环境(不引入 Node/浏览器专有 API),
 * 因此可以同时被 NestJS(CJS)与 Next.js(打包)安全引用,
 * 保证"前端校验"与"后端校验"来自同一份定义。
 */

export * from './brand';
export * from './constants';
export * from './errors';
export * from './events';
export * from './model-capabilities';
export * from './queues';
export * from './schemas/admin';
export * from './schemas/asset';
export * from './schemas/auth';
export * from './schemas/commerce';
export * from './schemas/common';
export * from './schemas/community';
export * from './schemas/generation';
export * from './utils';
