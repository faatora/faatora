import { IsISO8601, IsOptional } from 'class-validator';
export class BatchDto {
  @IsOptional() @IsISO8601() cutoffAt?: string;
}
