import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

class JournalLineDto {
  @IsString()
  accountId!: string;

  @IsIn(['debit', 'credit'])
  direction!: 'debit' | 'credit';

  /** Decimal string, e.g. "100.50" */
  @IsString()
  @MinLength(1)
  amount!: string;

  @IsString()
  assetCode!: string;
}

export class PostJournalDto {
  @IsOptional()
  @IsString()
  reference?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => JournalLineDto)
  lines!: JournalLineDto[];
}
