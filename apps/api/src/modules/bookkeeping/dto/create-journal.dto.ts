import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
export class CreateJournalLineDto {
  @IsUUID() accountId!: string;
  @IsNumber() @Min(0) debit!: number;
  @IsNumber() @Min(0) credit!: number;
  @IsOptional() @IsString() description?: string;
}
export class CreateJournalDto {
  @IsISO8601() entryDate!: string;
  @IsOptional() @IsString() memo?: string;
  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => CreateJournalLineDto)
  lines!: CreateJournalLineDto[];
}
