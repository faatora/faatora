import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
export class CreateSaleLineDto {
  @IsOptional() @IsUUID() productId?: string;
  @IsString() description!: string;
  @IsNumber() @IsPositive() quantity!: number;
  @IsNumber() @Min(0) unitPrice!: number;
  @IsOptional() @IsString() vatCategory?: string;
  @IsOptional() @IsNumber() @Min(0) vatRate?: number;
}
export class CreateSaleDto {
  @IsIn(['cash', 'card', 'mixed']) tenderMethod!: 'cash' | 'card' | 'mixed';
  @IsOptional() @IsNumber() @Min(0) tenderCash?: number;
  @IsOptional() @IsNumber() @Min(0) tenderCard?: number;
  @IsOptional() @IsNumber() @Min(0) changeGiven?: number;
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateSaleLineDto)
  lines!: CreateSaleLineDto[];
}
