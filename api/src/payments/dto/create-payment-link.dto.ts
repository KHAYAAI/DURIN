import { IsObject, IsOptional, IsString, Matches } from 'class-validator';

export class CreatePaymentLinkDto {
  @IsOptional()
  @IsString()
  @Matches(/^\d+(\.\d+)?$/)
  amount?: string;

  @IsOptional()
  @IsString()
  assetCode?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
