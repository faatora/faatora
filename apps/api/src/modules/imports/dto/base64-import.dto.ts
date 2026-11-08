import { IsOptional, IsString } from 'class-validator';
export class Base64ImportDto {
  @IsOptional() @IsString() filename?: string;
  @IsString() base64!: string;
}
