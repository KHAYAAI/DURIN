import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ApiKeysService } from '../api-keys/api-keys.service';
import { DEFAULT_SCOPES, SANDBOX_BOOTSTRAP_SCOPES } from '../common/scopes';
import { isSandboxMode } from '../common/sandbox';

@Injectable()
export class OrganisationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly apiKeys: ApiKeysService,
  ) {}

  /**
   * Bootstrap: create organisation + optional owner user + first API key.
   * Returns the organisation and the one-time API key secret.
   */
  async create(name: string, ownerEmail?: string, ownerName?: string, adminKey?: boolean, house?: boolean) {
    return this.prisma.$transaction(async (tx) => {
      const org = await tx.organisation.create({
        data: { name, isHouse: house === true },
      });

      if (ownerEmail) {
        let user = await tx.user.findUnique({ where: { email: ownerEmail.toLowerCase() } });
        if (!user) {
          user = await tx.user.create({
            data: {
              email: ownerEmail.toLowerCase(),
              name: ownerName ?? null,
            },
          });
        }
        await tx.organisationMember.create({
          data: {
            organisationId: org.id,
            userId: user.id,
            role: 'owner',
          },
        });
      }

      // Create first API key outside the nested call to keep logic simple —
      // we still return a usable key for immediate use.
      return { organisation: org };
    }).then(async ({ organisation }) => {
      const withAdmin = adminKey === true || isSandboxMode();
      const key = await this.apiKeys.create(organisation.id, 'Default key', [...(withAdmin ? SANDBOX_BOOTSTRAP_SCOPES : DEFAULT_SCOPES)]);
      return {
        organisation: {
          id: organisation.id,
          name: organisation.name,
          status: organisation.status,
          createdAt: organisation.createdAt,
        },
        apiKey: {
          id: key.id,
          name: key.name,
          keyPrefix: key.keyPrefix,
          scopes: key.scopes,
          secret: key.secret,
          createdAt: key.createdAt,
        },
        note: 'Store the apiKey.secret now — it will not be shown again.',
      };
    });
  }

  async getMe(organisationId: string) {
    const org = await this.prisma.organisation.findUniqueOrThrow({
      where: { id: organisationId },
      select: {
        id: true,
        name: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return org;
  }
}
