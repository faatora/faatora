import { Module } from '@nestjs/common';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';

@Module({
  controllers: [ProductsController, SalesController],
  providers: [ProductsService, SalesService],
  exports: [ProductsService, SalesService],
})
export class PosModule {}
