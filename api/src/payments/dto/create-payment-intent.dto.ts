import { IsObject, IsOptional, IsString, MinLength, Matches } from 'class-validator';

export class CreatePaymentIntentDto {
  /** Decimal string, e.g. "100.00" */
  @IsString()
  @Matches(/^\d+(\.\d+)?$/)
  amount!: string;

  @IsString()
  @MinLength(1)
  assetCode!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  customerReference?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
