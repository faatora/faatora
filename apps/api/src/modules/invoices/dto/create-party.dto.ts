import { IsIn, IsObject, IsOptional, IsString } from 'class-validator';
export class CreatePartyDto {
  @IsOptional() @IsIn(['self', 'customer', 'supplier']) kind?: string;
  @IsString() name!: string;
  @IsOptional() @IsString() vatin?: string;
  @IsOptional() @IsString() country?: string;
  @IsOptional() @IsString() peppolId?: string;
  @IsOptional() @IsObject() address?: Record<string, unknown>;
}
