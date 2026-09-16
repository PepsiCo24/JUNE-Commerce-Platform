import { Module } from '@nestjs/common';

import { StorageModule } from '../storage/storage.module';
import { AssetsController } from './assets.controller';
import { AssetsService } from './assets.service';
import { AssetUrlService } from './asset-url.service';

@Module({
  imports: [StorageModule],
  controllers: [AssetsController],
  providers: [AssetsService, AssetUrlService],
  exports: [AssetsService, AssetUrlService],
})
export class AssetsModule {}
