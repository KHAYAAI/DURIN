import { IsBoolean, IsIn, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateAccountDto {
  @IsString()
  @MinLength(1)
  code!: string;

  @IsString()
  @MinLength(1)
  name!: string;

  @IsIn(['asset', 'liability', 'equity', 'revenue', 'expense', 'system'])
  accountType!: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense' | 'system';

  @IsString()
  @MinLength(1)
  assetCode!: string;

  @IsOptional()
  @IsBoolean()
  allowNegative?: boolean;
}
