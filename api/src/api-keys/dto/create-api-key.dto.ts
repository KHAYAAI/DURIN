import { IsArray, IsOptional, IsString, MinLength, ArrayUnique } from 'class-validator';

export class CreateApiKeyDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  scopes?: string[];
}
