'use strict';

/*
 * List and import Cursor conversations between workspaces.
 *
 *   node scripts/import-history.js --list-workspaces
 *   node scripts/import-history.js --list --workspace vidzen
 *   node scripts/import-history.js --id <composerId> --to anycursor
 *   node scripts/import-history.js --latest 3 --workspace vidzen --to anycursor
 *   node scripts/import-history.js --id <composerId> --to anycursor --move
 *
 * Copy is the default: it duplicates the conversation and leaves the original
 * untouched. Move only changes workspace metadata. Backups are written next to
 * the Cursor state database. Quit Cursor before running (or pass --force).
 */

const {
  listWorkspaces,
  resolveWorkspace,
  listHistory,
  importConversations,
  isCursorRunning,
} = require('../src/history/import');

const argv = process.argv.slice(2);
function has(flag) { return argv.includes(flag); }
function value(name, fallback) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
function values(name) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--' + name && argv[i + 1]) out.push(argv[i + 1]);
  }
  return out;
}

function formatDate(ms) {
  if (!ms) return '—';
  const date = new Date(Number(ms));
  return Number.isNaN(date.getTime()) ? '—' : date.toISOString().replace('T', ' ').slice(0, 16);
}

function printWorkspaces() {
  const workspaces = listWorkspaces();
  if (!workspaces.length) {
    console.log('No Cursor workspaces found.');
    return;
  }
  for (const workspace of workspaces) {
    console.log(`${workspace.id}  ${String(workspace.conversations).padStart(3)} chats  ${workspace.folder || '(no folder)'}`);
  }
}

function printHistory() {
  const workspace = value('workspace');
  const rows = listHistory({ workspace, includeEmpty: has('--include-empty') });
  if (!rows.length) {
    console.log('No conversations found.');
    return;
  }
  for (const row of rows) {
    console.log([
      row.id,
      formatDate(row.updatedAt),
      row.workspace || '(global)',
      row.title || '(untitled)',
    ].join('  '));
  }
}

async function main() {
  if (has('--list-workspaces')) {
    printWorkspaces();
    return;
  }
  if (has('--list')) {
    printHistory();
    return;
  }

  const to = value('to', '');
  if (!to) {
    console.error('Missing --to <workspace id|name>. Use --list-workspaces to see targets.');
    process.exit(1);
  }

  let ids = values('id').flatMap((id) => id.split(',')).map((id) => id.trim()).filter(Boolean);
  const latest = Number(value('latest', '0'));
  if (!ids.length && latest > 0) {
    const rows = listHistory({
      workspace: value('workspace', ''),
      includeEmpty: false,
    });
    ids = rows.slice(0, latest).map((row) => row.id);
  }
  if (!ids.length) {
    console.error('Choose conversations with --id <composerId> or --latest N --workspace <name>.');
    process.exit(1);
  }

  const target = resolveWorkspace(to);
  if (!target) {
    console.error(`Target workspace not found: ${to}`);
    process.exit(1);
  }

  if (isCursorRunning() && !has('--force') && !has('--dry-run')) {
    console.error('Cursor is running. Quit Cursor before importing, or pass --force.');
    process.exit(1);
  }

  const result = importConversations({
    ids,
    target,
    move: has('--move'),
    force: has('--force'),
    dryRun: has('--dry-run'),
  });

  if (result.dryRun) {
    console.log(`Dry run: ${result.mode} ${result.conversations} conversation(s), ${result.related} related composer(s).`);
    console.log(`Target: ${result.target.id} ${result.target.folder}`);
    return;
  }

  console.log(`Imported ${result.conversations} conversation(s), ${result.related} related composer(s), ${result.keys} key(s).`);
  console.log(`Mode:   ${result.mode}`);
  console.log(`Target: ${result.target.id} ${result.target.folder}`);
  console.log(`Backup: ${result.backup}`);
  for (const item of result.ids) {
    if (item.from !== item.to) console.log(`  ${item.from} -> ${item.to}`);
  }
  console.log('Restart Cursor to see the imported conversations in the target workspace.');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
