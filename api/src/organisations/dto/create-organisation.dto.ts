import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateOrganisationDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsEmail()
  ownerEmail?: string;

  @IsOptional()
  @IsString()
  ownerName?: string;
}
