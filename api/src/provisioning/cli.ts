import { readFileSync } from 'fs';
import { join } from 'path';
import { provisionWorkos, realWorkosClient, type WorkosManifest } from './workos-provision';

/**
 *   WORKOS_API_KEY=sk_test_... node dist/provisioning/cli.js [--apply] [--manifest path] [--allow-live-key]
 * Dry-run unless --apply. Refuses a live (sk_live_) key unless --allow-live-key is also given.
 */
async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const mi = args.indexOf('--manifest');
  const path = mi >= 0 ? args[mi + 1]! : join(__dirname, '..', '..', '..', 'ops', 'provisioning', 'manifest.json');
  const key = process.env.WORKOS_API_KEY;
  if (!key) { console.error('Set WORKOS_API_KEY (the NEW WorkOS environment\'s key).'); process.exit(2); }
  if (key.startsWith('sk_live_') && !args.includes('--allow-live-key')) { console.error('Refusing a live key without --allow-live-key. Provision staging first.'); process.exit(2); }
  const manifest = (JSON.parse(readFileSync(path, 'utf8')) as { workos: WorkosManifest }).workos;
  const report = await provisionWorkos(await realWorkosClient(key), manifest, { apply });
  console.log(report.apply ? 'APPLIED:' : 'DRY RUN (no changes made):');
  for (const a of report.actions) console.log(`  - ${a}`);
  if (!report.actions.length) console.log('  (nothing to do: environment already matches the manifest)');
  if (report.organisationId) console.log(`WorkOS organisation id: ${report.organisationId}`);
  console.log('\nManual steps:'); for (const s of report.manualSteps) console.log(`  * ${s}`);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
