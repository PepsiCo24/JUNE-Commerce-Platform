import { Module } from '@nestjs/common';

import { AssetsModule } from '../assets/assets.module';
import { StorageModule } from '../storage/storage.module';
import { CredentialsController } from './credentials.controller';
import { CredentialsService } from './credentials.service';
import { ProductImportController } from './product-import.controller';
import { ProductImportService } from './product-import.service';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { ShopsController } from './shops.controller';
import { ShopsService } from './shops.service';

/**
 * 店铺 / 凭据 / 商品模块。
 *
 * 依赖说明:
 *  - AssetsModule:商品图片的归属校验与引用计数(生图结果复用同一 Asset);
 *  - StorageModule:CSV 导入需要从对象存储读取已上传的文件。
 *  - PrismaModule / CryptoModule / AuditModule / QueueModule 都是全局模块,无需在此重复导入。
 *
 * 控制器注册顺序:先注册 products/import,再注册 products,
 * 让路由匹配顺序更直观(两者路径段数不同,本身不冲突)。
 */
@Module({
  imports: [AssetsModule, StorageModule],
  controllers: [
    ShopsController,
    CredentialsController,
    ProductImportController,
    ProductsController,
  ],
  providers: [ShopsService, CredentialsService, ProductsService, ProductImportService],
  exports: [ShopsService, CredentialsService, ProductsService, ProductImportService],
})
export class CommerceModule {}
