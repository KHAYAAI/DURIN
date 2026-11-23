import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateAddressDto {
  @IsString()
  @MinLength(1)
  assetCode!: string;

  @IsOptional()
  @IsString()
  chain?: string;
}
