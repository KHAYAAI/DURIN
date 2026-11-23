import { IsOptional, IsString } from 'class-validator';

export class CreateWalletDto {
  @IsOptional()
  @IsString()
  label?: string;
}
