/**
 * Idempotent provisioning of DURIN's WorkOS setup (organisation, permissions, roles) into ANY WorkOS
 * environment, driven by ops/provisioning/manifest.json. Used to move DURIN off the A-CARD WorkOS project into
 * its own. Dry-run by default: it only reports what it WOULD create.
 */
export interface WorkosManifest {
  organization: { name: string; externalId: string };
  permissions: string[];
  roles: Array<{ slug: string; name: string; description?: string; permissions: string[] }>;
  manualSteps: string[];
}

/** The slice of the WorkOS SDK used (so it can be faked). */
export interface WorkosProvisionClient {
  listPermissionSlugs(): Promise<string[]>;
  createPermission(slug: string, name: string): Promise<void>;
  listRoleSlugs(): Promise<string[]>;
  createRole(slug: string, name: string, description?: string): Promise<void>;
  setRolePermissions(slug: string, permissions: string[]): Promise<void>;
  findOrganisationByExternalId(externalId: string): Promise<string | null>;
  createOrganisation(name: string, externalId: string): Promise<string>;
}

export interface ProvisionReport { apply: boolean; actions: string[]; organisationId?: string; manualSteps: string[] }

const titleOf = (slug: string) => slug.replace(/[:_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export async function provisionWorkos(client: WorkosProvisionClient, m: WorkosManifest, opts: { apply: boolean }): Promise<ProvisionReport> {
  const actions: string[] = [];
  const perms = new Set(await client.listPermissionSlugs());
  for (const slug of m.permissions) {
    if (perms.has(slug)) continue;
    actions.push(`create permission ${slug}`);
    if (opts.apply) await client.createPermission(slug, titleOf(slug));
  }
  const roles = new Set(await client.listRoleSlugs());
  for (const r of m.roles) {
    for (const p of r.permissions) if (!m.permissions.includes(p) && !perms.has(p)) throw new Error(`Role ${r.slug} references unknown permission ${p}`);
    if (!roles.has(r.slug)) { actions.push(`create role ${r.slug}`); if (opts.apply) await client.createRole(r.slug, r.name, r.description); }
    // Always (re)assert a managed role's permission set so the environment matches the manifest.
    actions.push(`set permissions on role ${r.slug} (${r.permissions.length})`);
    if (opts.apply) await client.setRolePermissions(r.slug, r.permissions);
  }
  let organisationId = await client.findOrganisationByExternalId(m.organization.externalId);
  if (!organisationId) {
    actions.push(`create organisation ${m.organization.name}`);
    if (opts.apply) organisationId = await client.createOrganisation(m.organization.name, m.organization.externalId);
  }
  return { apply: opts.apply, actions, organisationId: organisationId ?? undefined, manualSteps: m.manualSteps };
}

/** Real client over @workos-inc/node. */
export async function realWorkosClient(apiKey: string): Promise<WorkosProvisionClient> {
  const { WorkOS } = await import('@workos-inc/node');
  const w = new WorkOS(apiKey);
  return {
    listPermissionSlugs: async () => (await w.authorization.listPermissions()).data.map((p) => p.slug),
    createPermission: async (slug, name) => { await w.authorization.createPermission({ slug, name }); },
    listRoleSlugs: async () => ((await w.authorization.listEnvironmentRoles()).data ?? []).map((r: { slug: string }) => r.slug),
    createRole: async (slug, name, description) => { await w.authorization.createEnvironmentRole({ slug, name, description }); },
    setRolePermissions: async (slug, permissions) => { await w.authorization.setEnvironmentRolePermissions(slug, { permissions }); },
    findOrganisationByExternalId: async (externalId) => { try { return (await w.organizations.getOrganizationByExternalId(externalId)).id; } catch { return null; } },
    createOrganisation: async (name, externalId) => (await w.organizations.createOrganization({ name, externalId })).id,
  };
}
