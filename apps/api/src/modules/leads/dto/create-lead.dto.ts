import { IsBoolean, IsEmail, IsIn, IsOptional, IsString, Matches } from 'class-validator';
export class CreateLeadDto {
  @IsEmail() email!: string;
  @IsString() fullName!: string;
  @IsString() companyName!: string;
  @IsString()
  @Matches(/^\+?968?\s?\d{4}\s?\d{4}$/)
  phone!: string;
  @IsIn(['<=100k', '100k-500k', '500k-1M', '1M-5M', '>5M'])
  revenueBand!: '<=100k' | '100k-500k' | '500k-1M' | '1M-5M' | '>5M';
  @IsString() currentTool!: string;
  @IsIn(['<100', '100-500', '500-2000', '>2000'])
  invoiceVolumeBand!: '<100' | '100-500' | '500-2000' | '>2000';
  @IsIn(['0', '<25', '25-50', '>50'])
  b2cShare!: '0' | '<25' | '25-50' | '>50';
  @IsOptional() @IsString() erp?: string;
  @IsBoolean() vatRegistered!: boolean;
}
