import { IsBoolean, IsNumber, IsOptional, IsString, Min } from 'class-validator';
export class CreateProductDto {
  @IsString() sku!: string;
  @IsString() nameEn!: string;
  @IsOptional() @IsString() nameAr?: string;
  @IsNumber() @Min(0) unitPrice!: number;
  @IsOptional() @IsString() vatCategory?: string;
  @IsOptional() @IsNumber() @Min(0) vatRate?: number;
  @IsOptional() @IsString() barcode?: string;
  @IsOptional() @IsBoolean() archived?: boolean;
}
