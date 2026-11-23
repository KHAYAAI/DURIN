import { IsString, MinLength } from 'class-validator';

export class CreateConversionDto {
  @IsString()
  @MinLength(1)
  quoteId!: string;
}
