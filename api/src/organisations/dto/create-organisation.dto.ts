import { IsBoolean, IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateOrganisationDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsEmail()
  ownerEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  ownerName?: string;

  /** Operator-only: issue the first key with the `admin` scope (always on in sandbox). */
  @IsOptional()
  @IsBoolean()
  adminKey?: boolean;

  /** Operator-only: create DURIN's own house organisation (at most one; the database enforces it). */
  @IsOptional()
  @IsBoolean()
  house?: boolean;
}
