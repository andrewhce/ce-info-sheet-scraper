'use strict';
// Builds the read-only copy and uploads it to Cloudflare Pages (direct upload).
//
//   node deploy/deploy-copy.js --project my-pages-project      first time (the name is remembered)
//   node deploy/deploy-copy.js                                  later runs
//   node deploy/deploy-copy.js --dry-run                        check only: builds and uploads nothing
//
// Options:
//   --url https://x.pages.dev    the address Cloudflare gave the project, if it is not <project>.pages.dev
//   --branch main                the project's production branch (default main)
//   --no-sheet                   leave out the workbook's school-tab text (then no login check is needed)
//
// Safety: the copy contains the workbook's school-tab text. The script will not upload until the
// project's address answers with a Cloudflare Access login redirect, and it checks again after upload.
const { spawnSync } = require('child_process');
const path = require('path');
const { PATHS, readJson, writeJson } = require('../src/lib/util');

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null; };
const has = (k) => args.includes(k);
const STATE = path.join(PATHS.data, 'deploy.json');
const saved = readJson(STATE, {});

const project = opt('--project') || saved.project;
const branch = opt('--branch') || saved.branch || 'main';
const noSheet = has('--no-sheet');
const dryRun = has('--dry-run');

if (!project || !/^[a-z0-9]([a-z0-9-]{0,56}[a-z0-9])?$/.test(project) || !/^[A-Za-z0-9._/-]{1,60}$/.test(branch)) {
  console.error('Give the Cloudflare Pages project name once:  node deploy/deploy-copy.js --project your-project-name\n' +
    '(lower-case letters, digits and hyphens). Create the project first; see docs/DEPLOY-GUIDE.md.');
  process.exit(1);
}
let home = opt('--url') || saved.url || `https://${project}.pages.dev/`;
if (!/^https?:\/\//i.test(home)) { console.error('--url must start with https://'); process.exit(1); }
if (!home.endsWith('/')) home += '/';

const { guarded } = require('../src/lib/access-check');

function run(cmd, cmdArgs, opts) {
  const r = spawnSync(cmd, cmdArgs, { cwd: PATHS.root, encoding: 'utf8', ...opts });
  return r;
}

(async () => {
  console.log(`Project: ${project}   address checked: ${home}   branch: ${branch}${noSheet ? '   (no workbook text)' : ''}`);

  if (noSheet) {
    console.log('Login check skipped: this copy has no workbook text.');
  } else {
    const g = await guarded(home);
    if (!g.ok) {
      console.error(`\nNot uploading. ${home} did not answer with a Cloudflare Access login (it said: ${g.seen}).\n` +
        'The copy contains the workbook\'s school-tab text, so it must not go up before the login is in place.\n' +
        'Set up Cloudflare Access for this address first (docs/DEPLOY-GUIDE.md, step 3), then run this again.\n' +
        'If Cloudflare gave the project a different address than <project>.pages.dev, pass it with --url.');
      process.exit(2);
    }
    console.log(`Login check passed: ${g.seen}.`);
  }
  if (dryRun) { console.log('Dry run: nothing was built or uploaded.'); return; }

  const b = run(process.execPath, [path.join('deploy', 'build-static.js'), ...(noSheet ? ['--no-sheet'] : [])], { stdio: 'inherit', encoding: undefined });
  if (b.status !== 0) { console.error('The export failed, so nothing was uploaded.'); process.exit(1); }

  console.log('\nUploading to Cloudflare Pages ...');
  const up = run('npx', ['--yes', 'wrangler', 'pages', 'deploy', 'deploy/site', '--project-name', project, '--branch', branch],
    { shell: true, stdio: ['inherit', 'pipe', 'inherit'] });
  const out = up.stdout || '';
  process.stdout.write(out);
  if (up.status !== 0) {
    console.error('\nThe upload did not finish. If it says you are not logged in, run:  npx wrangler login');
    process.exit(1);
  }

  // check the production address and every deployment address Cloudflare printed
  const urls = [...new Set([home, ...(out.match(/https:\/\/[a-z0-9.-]+\.pages\.dev/gi) || []).map((u) => u + '/')])];
  let exposed = 0;
  for (const u of urls) {
    const g = await guarded(u + 'data/overview.json');
    console.log(`  ${g.ok ? 'protected' : noSheet ? 'open, no login' : 'NOT PROTECTED'}  ${u}  (${g.seen})`);
    if (!g.ok && !noSheet) exposed++;
  }
  writeJson(STATE, { project, branch, url: home, lastDeployAt: new Date().toISOString() });
  if (exposed) {
    console.error(`\nWARNING: ${exposed} address(es) above answered without a login while the copy holds workbook text.\n` +
      'Open Cloudflare, Workers & Pages, this project, Deployments, and delete the newest deployment, then fix the Access application (docs/DEPLOY-GUIDE.md, step 3).');
    process.exit(3);
  }
  console.log(noSheet ? '\nDone. Open ' + home + ' (no workbook text in this copy; anyone with the link can open it unless you add a login).'
    : '\nDone. The team signs in at ' + home);
})();
