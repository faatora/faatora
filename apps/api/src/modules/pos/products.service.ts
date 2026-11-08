import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DB, type Database } from '../../db/db.module';
import { withTenant } from '../../db/with-tenant';
import { products } from '../../db/schema/pos';
import type { CreateProductDto } from './dto/create-product.dto';
import type { UpdateProductDto } from './dto/update-product.dto';

@Injectable()
export class ProductsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  list(tenantId: string) {
    return withTenant(this.db, tenantId, (tx) =>
      tx.select().from(products).orderBy(desc(products.createdAt)),
    );
  }

  get(tenantId: string, id: string) {
    return withTenant(this.db, tenantId, async (tx) => {
      const [row] = await tx.select().from(products).where(eq(products.id, id)).limit(1);
      if (!row) throw new NotFoundException('Product not found');
      return row;
    });
  }

  findBySku(tenantId: string, sku: string) {
    return withTenant(this.db, tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(products)
        .where(and(eq(products.sku, sku), eq(products.archived, false)))
        .limit(1);
      return row ?? null;
    });
  }

  findByBarcode(tenantId: string, barcode: string) {
    return withTenant(this.db, tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(products)
        .where(and(eq(products.barcode, barcode), eq(products.archived, false)))
        .limit(1);
      return row ?? null;
    });
  }

  create(tenantId: string, dto: CreateProductDto) {
    if (!dto.sku || !dto.sku.trim()) throw new BadRequestException('sku is required');
    return withTenant(this.db, tenantId, async (tx) => {
      const [row] = await tx
        .insert(products)
        .values({
          tenantId,
          sku: dto.sku,
          nameEn: dto.nameEn,
          nameAr: dto.nameAr,
          unitPrice: dto.unitPrice.toFixed(3),
          vatCategory: dto.vatCategory ?? 'S',
          vatRate: (dto.vatRate ?? 5).toFixed(2),
          barcode: dto.barcode,
          archived: dto.archived ?? false,
        })
        .returning();
      return row;
    });
  }

  update(tenantId: string, id: string, dto: UpdateProductDto) {
    return withTenant(this.db, tenantId, async (tx) => {
      const [existing] = await tx.select().from(products).where(eq(products.id, id)).limit(1);
      if (!existing) throw new NotFoundException('Product not found');
      const patch: Record<string, unknown> = {};
      if (dto.sku !== undefined) patch.sku = dto.sku;
      if (dto.nameEn !== undefined) patch.nameEn = dto.nameEn;
      if (dto.nameAr !== undefined) patch.nameAr = dto.nameAr;
      if (dto.unitPrice !== undefined) patch.unitPrice = dto.unitPrice.toFixed(3);
      if (dto.vatCategory !== undefined) patch.vatCategory = dto.vatCategory;
      if (dto.vatRate !== undefined) patch.vatRate = dto.vatRate.toFixed(2);
      if (dto.barcode !== undefined) patch.barcode = dto.barcode;
      if (dto.archived !== undefined) patch.archived = dto.archived;
      const [row] = await tx.update(products).set(patch).where(eq(products.id, id)).returning();
      return row;
    });
  }

  archive(tenantId: string, id: string) {
    return withTenant(this.db, tenantId, async (tx) => {
      const [row] = await tx
        .update(products)
        .set({ archived: true })
        .where(eq(products.id, id))
        .returning();
      if (!row) throw new NotFoundException('Product not found');
      return row;
    });
  }
}
