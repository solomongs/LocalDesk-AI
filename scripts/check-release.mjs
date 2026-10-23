import fs from 'node:fs';
import assert from 'node:assert/strict';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const config = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const cargo = fs.readFileSync('src-tauri/Cargo.toml', 'utf8');
const packageSection = cargo.split(/^\[package\]\s*$/m)[1]?.split(/^\[/m)[0] || '';
const rustVersion = packageSection.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'Use a semantic release version.');
assert.equal(config.version, pkg.version, 'Tauri and package.json versions must match.');
assert.equal(rustVersion, pkg.version, 'Cargo and package.json versions must match.');
assert.equal(config.identifier, 'com.multilancer.localdesk', 'Preserve the application identity for updates.');
assert.ok(config.plugins?.updater?.pubkey?.length > 50, 'Set the stable updater public key before releasing.');
assert.deepEqual(config.plugins.updater.endpoints, ['https://github.com/solomongs/LocalDesk-AI/releases/latest/download/latest.json']);
assert.notEqual(config.plugins.updater.dangerousInsecureTransportProtocol, true, 'Updater transport must remain HTTPS.');
assert.equal(pkg.dependencies['@mlc-ai/web-llm'], '0.2.86', 'Review model compatibility before changing the WebLLM runtime.');
console.log(`Release configuration verified: LocalDesk AI ${pkg.version}`);
if (process.argv.includes('--github-output')) {
  assert.ok(process.env.GITHUB_OUTPUT, 'GITHUB_OUTPUT is required.');
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${pkg.version}\n`);
}
