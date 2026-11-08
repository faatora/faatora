import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
export class CreateInvoiceLineDto {
  @IsString() description!: string;
  @IsNumber() @IsPositive() quantity!: number;
  @IsOptional() @IsString() unitCode?: string;
  @IsNumber() @Min(0) unitPrice!: number;
  @IsOptional() @IsString() vatCategory?: string;
  @IsOptional() @IsNumber() @Min(0) vatRate?: number;
}
export class CreateInvoiceDto {
  @IsOptional() @IsIn(['invoice', 'credit_note', 'debit_note']) type?: string;
  @IsString() number!: string;
  @IsISO8601() issueDate!: string;
  @IsUUID() supplierPartyId!: string;
  @IsUUID() buyerPartyId!: string;
  @IsOptional() @IsString() currency?: string;
  @IsOptional() @IsString() notes?: string;
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateInvoiceLineDto)
  lines!: CreateInvoiceLineDto[];
}
