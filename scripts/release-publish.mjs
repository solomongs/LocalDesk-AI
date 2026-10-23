import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';

const repository = 'solomongs/LocalDesk-AI';
const apiRoot = `https://api.github.com/repos/${repository}`;
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const config = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const version = pkg.version;
const tag = `v${version}`;
const directory = path.resolve(process.argv[2] || 'release');
const filename = `LocalDesk-AI-Setup-${version}-x64.exe`;
const installer = path.join(directory, filename);
const token = process.env.GITHUB_TOKEN;
const broker = process.env.LOCALDESK_SIGNING_BROKER;
assert.equal(process.env.GITHUB_REPOSITORY, repository, 'Release repository mismatch.');
assert.equal(process.env.GITHUB_REF, 'refs/heads/main', 'Only main can release.');
assert.ok(['push','workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME), 'Unexpected release event.');
assert.ok(token && process.env.GITHUB_SHA, 'GitHub workflow credentials are required.');
assert.equal(broker, 'https://localdesk.ng.cyou/api/signing-key', 'Signing broker mismatch.');
assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
assert.equal(config.version, version);
assert.ok(config.plugins?.updater?.pubkey?.length > 50, 'Updater public key is missing.');
assert.ok(fs.statSync(installer).isFile(), 'Windows installer is missing.');
const header = Buffer.alloc(2);const descriptor = fs.openSync(installer, 'r');fs.readSync(descriptor, header, 0, 2, 0);fs.closeSync(descriptor);
assert.equal(header.toString('ascii'), 'MZ', 'The release asset is not a Windows executable.');

const headers = {Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'LocalDesk-Release'};
async function api(route, options = {}) {
  const response = await fetch(apiRoot + route, {...options, headers:{...headers,...options.headers}});
  if (!response.ok) throw new Error(`GitHub release API failed: HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
}
const existingResponse = await fetch(apiRoot + `/releases/tags/${tag}`, {headers});
let release;
if (existingResponse.ok) {
  release = await existingResponse.json();
  if (!release.draft) {
    console.log(`::notice::${tag} is already published. Existing release assets were not changed. Increment all three version fields for another release.`);
    process.exit(0);
  }
  assert.equal(release.target_commitish, process.env.GITHUB_SHA, 'Refusing to resume a draft from a different commit.');
} else if (existingResponse.status !== 404) throw new Error(`Release lookup failed: HTTP ${existingResponse.status}`);

// Request the short-lived GitHub OIDC identity only after dependencies and artifacts are ready.
const oidcUrl = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL || '');
oidcUrl.searchParams.set('audience','localdesk-release');
const oidcResponse = await fetch(oidcUrl,{headers:{Authorization:`Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`}});
if(!oidcResponse.ok)throw new Error(`OIDC request failed: HTTP ${oidcResponse.status}`);
const {value:identity} = await oidcResponse.json();
assert.ok(typeof identity === 'string' && identity.length > 50, 'Missing OIDC identity.');
console.log(`::add-mask::${identity}`);
const keyResponse = await fetch(broker,{method:'POST',headers:{Authorization:`Bearer ${identity}`,'Content-Type':'application/json'},body:'{}',redirect:'error'});
if(!keyResponse.ok)throw new Error(`Signing authorization failed: HTTP ${keyResponse.status}`);
const credential = await keyResponse.json();
assert.ok(typeof credential.key === 'string' && credential.key.length > 50, 'Signing broker returned no key.');
assert.equal(credential.publicKey, config.plugins.updater.pubkey, 'Signing broker public key does not match this application.');
const mask = value => String(value).replaceAll('%','%25').replaceAll('\r','%0D').replaceAll('\n','%0A');
console.log(`::add-mask::${mask(credential.key)}`);
if(credential.password)console.log(`::add-mask::${mask(credential.password)}`);
const cli = path.resolve('node_modules/@tauri-apps/cli/tauri.js');
const signed = spawnSync(process.execPath,[cli,'signer','sign','--app-version',version,installer],{
  env:{...process.env,TAURI_SIGNING_PRIVATE_KEY:credential.key,TAURI_SIGNING_PRIVATE_KEY_PASSWORD:credential.password || ''},
  encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:60_000
});
credential.key = '';credential.password = '';
if(signed.status !== 0)throw new Error('Tauri updater signing failed. No release was published.');
const signaturePath = installer+'.sig';
const signature = fs.readFileSync(signaturePath,'utf8').trim();
assert.ok(signature.length > 50 && signature.length < 8192, 'Invalid signature file.');
const installerHash = crypto.createHash('sha256').update(fs.readFileSync(installer)).digest('hex');
const notes = `LocalDesk AI ${version} — Tauri v2 desktop, local model management, and the mobile LocalLLM PWA. Developed by Solomon Gbeta. Powered by Multilancer LTD.`;
const manifest = {version,notes,pub_date:new Date().toISOString(),platforms:{'windows-x86_64':{signature,url:`https://github.com/${repository}/releases/download/${tag}/${filename}`}}};
fs.writeFileSync(path.join(directory,'latest.json'),JSON.stringify(manifest,null,2)+'\n');
fs.writeFileSync(path.join(directory,'SHA256SUMS.txt'),`${installerHash}  ${filename}\n`);
fs.writeFileSync(path.join(directory,'release-metadata.json'),JSON.stringify({version,commit:process.env.GITHUB_SHA,repository,workflow:process.env.GITHUB_WORKFLOW,runId:process.env.GITHUB_RUN_ID,runAttempt:process.env.GITHUB_RUN_ATTEMPT,filename,sha256:installerHash,updaterPublicKey:config.plugins.updater.pubkey},null,2)+'\n');
if(!release)release=await api('/releases',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tag_name:tag,target_commitish:process.env.GITHUB_SHA,name:`LocalDesk AI ${version}`,body:notes,draft:true,prerelease:false})});
const assetNames=[filename,filename+'.sig','latest.json','SHA256SUMS.txt','release-metadata.json'];
const oldAssets=await api(`/releases/${release.id}/assets`);
for(const old of oldAssets){if(assetNames.includes(old.name))await api(`/releases/assets/${old.id}`,{method:'DELETE'});}
for(const name of assetNames){
 const bytes=fs.readFileSync(path.join(directory,name));
 const upload=await fetch(`https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,{method:'POST',headers:{...headers,'Content-Type':name.endsWith('.json')?'application/json':'application/octet-stream','Content-Length':String(bytes.length)},body:bytes});
 if(!upload.ok)throw new Error(`Asset upload failed for ${name}: HTTP ${upload.status}. Draft retained for safe retry.`);
 console.log(`Uploaded ${name}`);
}
const published=await api(`/releases/${release.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({draft:false,make_latest:'true'})});
console.log(`Published ${published.html_url}`);
