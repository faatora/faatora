import { IsBoolean, IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
export class CreateAccountDto {
  @IsString() code!: string;
  @IsString() name!: string;
  @IsIn(['asset', 'liability', 'equity', 'income', 'expense']) type!: string;
  @IsOptional() @IsUUID() parentId?: string;
  @IsOptional() @IsBoolean() isVatOutput?: boolean;
  @IsOptional() @IsBoolean() isVatInput?: boolean;
}
