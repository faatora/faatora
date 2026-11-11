import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * One line on a credit or debit note. The caller provides amounts as
 * positive values; the service layer derives the sign from the
 * document kind (credit = reduction, debit = increase) when computing
 * what to show against the original invoice. UBL itself emits positive
 * values and carries the nature in the document type code (381 / 383).
 */
export class CreateTaxDocumentLineDto {
  @IsString()
  description!: string;

  @IsNumber()
  @IsPositive()
  quantity!: number;

  @IsOptional()
  @IsString()
  unitCode?: string;

  @IsNumber()
  @Min(0)
  unitPrice!: number;

  @IsOptional()
  @IsString()
  vatCategory?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  vatRate?: number;

  /**
   * Optional back-reference to the invoice_lines row this document
   * line is correcting. The service checks that the line id belongs
   * to the original invoice.
   */
  @IsOptional()
  @IsUUID()
  originalInvoiceLineId?: string;
}

/**
 * Create-credit-note / create-debit-note body.
 *
 * `originalInvoiceId` is required and must reference an invoice in
 * the same tenant whose status is CLEARED (per Oman VAT law — a
 * document can only be issued against a cleared invoice).
 */
export class CreateTaxDocumentDto {
  @IsString()
  number!: string;

  @IsISO8601()
  issueDate!: string;

  @IsUUID()
  originalInvoiceId!: string;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateTaxDocumentLineDto)
  lines!: CreateTaxDocumentLineDto[];
}
