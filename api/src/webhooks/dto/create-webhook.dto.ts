import { ArrayMaxSize, ArrayUnique, IsArray, IsString, MaxLength } from 'class-validator';

export class CreateWebhookDto {
  /** Must be https and resolve to a public address; validated in WebhooksService. */
  @IsString()
  @MaxLength(2048)
  url!: string;

  /** Event types, or ["*"] / [] for all. */
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  events!: string[];
}
