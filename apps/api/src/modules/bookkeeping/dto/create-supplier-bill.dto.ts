import { IsISO8601, IsNumber, IsOptional, IsString, IsUUID, Min } from 'class-validator';
export class CreateSupplierBillDto {
  @IsUUID() supplierPartyId!: string;
  @IsString() number!: string;
  @IsISO8601() issueDate!: string;
  @IsOptional() @IsISO8601() dueDate?: string;
  @IsOptional() @IsString() currency?: string;
  @IsOptional() @IsNumber() @Min(0) subtotal?: number;
  @IsOptional() @IsNumber() @Min(0) vatTotal?: number;
  @IsOptional() @IsNumber() @Min(0) grandTotal?: number;
}
