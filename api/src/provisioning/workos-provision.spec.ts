import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { provisionWorkos, type WorkosManifest, type WorkosProvisionClient } from './workos-provision';

const manifest = (JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'ops', 'provisioning', 'manifest.json'), 'utf8')) as { workos: WorkosManifest }).workos;

function fake(initial: { perms?: string[]; roles?: string[]; org?: string | null } = {}) {
  const log: string[] = [];
  const client: WorkosProvisionClient = {
    listPermissionSlugs: async () => initial.perms ?? [], createPermission: async (s) => { log.push(`perm:${s}`); },
    listRoleSlugs: async () => initial.roles ?? [], createRole: async (s) => { log.push(`role:${s}`); },
    setRolePermissions: async (s, p) => { log.push(`setperms:${s}:${p.length}`); },
    findOrganisationByExternalId: async () => initial.org ?? null, createOrganisation: async (n) => { log.push(`org:${n}`); return 'org_new'; },
  };
  return { client, log };
}

describe('WorkOS provisioning', () => {
  it('manifest is internally consistent: every role permission is declared', () => {
    for (const r of manifest.roles) for (const p of r.permissions) expect(manifest.permissions).toContain(p);
    expect(manifest.permissions.every((p) => /^[a-z_]+:(read|write)$/.test(p))).toBe(true);
  });
  it('dry run reports everything and changes nothing', async () => {
    const f = fake();
    const r = await provisionWorkos(f.client, manifest, { apply: false });
    expect(f.log).toEqual([]);
    expect(r.actions).toContain('create organisation DURIN');
    expect(r.actions.filter((a) => a.startsWith('create permission'))).toHaveLength(manifest.permissions.length);
  });
  it('apply creates the missing pieces; a second run is a no-op apart from re-asserting role permissions', async () => {
    const f = fake();
    const r = await provisionWorkos(f.client, manifest, { apply: true });
    expect(f.log.filter((l) => l.startsWith('perm:'))).toHaveLength(manifest.permissions.length);
    expect(f.log).toContain('role:durin-viewer'); expect(f.log).toContain('org:DURIN');
    expect(r.organisationId).toBe('org_new');
    const g = fake({ perms: manifest.permissions, roles: manifest.roles.map((x) => x.slug), org: 'org_existing' });
    const r2 = await provisionWorkos(g.client, manifest, { apply: true });
    expect(g.log.filter((l) => l.startsWith('perm:') || l.startsWith('role:') || l.startsWith('org:'))).toEqual([]);
    expect(r2.organisationId).toBe('org_existing');
    expect(g.log.filter((l) => l.startsWith('setperms:'))).toHaveLength(manifest.roles.length);
  });
  it('rejects a role that references an undeclared permission', async () => {
    const bad: WorkosManifest = { ...manifest, roles: [{ slug: 'x', name: 'X', permissions: ['nope:read'] }] };
    await expect(provisionWorkos(fake().client, bad, { apply: false })).rejects.toThrow(/unknown permission/);
  });
});
