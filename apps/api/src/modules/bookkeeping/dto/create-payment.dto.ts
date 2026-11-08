import {
  IsIn,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
} from 'class-validator';
export class CreatePaymentDto {
  @IsIn(['in', 'out']) direction!: 'in' | 'out';
  @IsISO8601() date!: string;
  @IsNumber() @IsPositive() amount!: number;
  @IsIn(['cash', 'card', 'bank', 'cheque', 'other']) method!: string;
  @IsUUID() partyId!: string;
  @IsOptional() @IsUUID() invoiceId?: string;
  @IsOptional() @IsUUID() billId?: string;
  @IsOptional() @IsString() memo?: string;
}
