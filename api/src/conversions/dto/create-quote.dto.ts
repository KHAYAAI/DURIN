import { IsIn, IsOptional, IsString, Matches, MinLength } from 'class-validator';

export class CreateQuoteDto {
  @IsIn(['ZAR', 'USDC', 'USDT'])
  sourceAsset!: string;

  @IsIn(['ZAR', 'USDC', 'USDT'])
  targetAsset!: string;

  /** Amount of source asset to convert */
  @IsString()
  @Matches(/^\d+(\.\d+)?$/)
  sourceAmount!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  side?: string; // reserved for future buy/sell semantics
}
