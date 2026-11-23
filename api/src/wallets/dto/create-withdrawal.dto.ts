import { IsOptional, IsString, Matches, MinLength } from 'class-validator';

export class CreateWithdrawalDto {
  @IsString()
  @MinLength(1)
  walletId!: string;

  @IsString()
  @MinLength(1)
  assetCode!: string;

  @IsString()
  @Matches(/^\d+(\.\d+)?$/)
  amount!: string;

  @IsString()
  @MinLength(8)
  destination!: string;

  @IsOptional()
  @IsString()
  chain?: string;
}
