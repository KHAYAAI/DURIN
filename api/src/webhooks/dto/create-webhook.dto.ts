import { IsArray, IsString, IsUrl, ArrayUnique, MinLength } from 'class-validator';

export class CreateWebhookDto {
  @IsUrl({ require_tld: false })
  url!: string;

  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  events!: string[];
}
