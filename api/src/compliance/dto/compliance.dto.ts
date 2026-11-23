import { IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

const DECIMAL = /^\d+(\.\d+)?$/;

export class StartVerificationDto {
  @IsIn(['organisation', 'user', 'customer'])
  subjectType!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  subjectId!: string;

  @IsOptional()
  @IsIn(['kyb_basic', 'kyb_enhanced', 'kyc_basic', 'kyc_enhanced'])
  level?: string;
}

export class ScreeningDto {
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  subjectType!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  subjectId!: string;

  @IsIn(['sanctions', 'wallet', 'pep'])
  screeningType!: string;
}

export class SetLimitDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  assetCode?: string;

  @IsOptional()
  @Matches(DECIMAL)
  dailyLimit?: string;

  @IsOptional()
  @Matches(DECIMAL)
  perTxLimit?: string;
}

export class RequestApprovalDto {
  @IsIn(['withdrawal', 'conversion', 'payout'])
  resourceType!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  resourceId!: string;

  @IsOptional()
  @Matches(DECIMAL)
  amount?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  assetCode?: string;
}

export class DecideApprovalDto {
  @IsIn(['approved', 'rejected'])
  decision!: 'approved' | 'rejected';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
