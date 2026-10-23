import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const output = path.resolve(process.argv[2] || 'src-tauri/binaries/THIRD-PARTY-NOTICES.txt');
const sections = ['LocalDesk AI — bundled third-party notices', 'Generated from the installed npm packages and locked Cargo metadata used by this build. Some listed build-time dependencies are not present at runtime. Model weights are downloaded separately and retain their upstream licenses.'];
const readLicenseFiles = directory => {
  const files=[];
  if(!fs.existsSync(directory))return files;
  for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
    if(!/^(licen[cs]e|copying|notice)/i.test(entry.name))continue;
    const filename=path.join(directory,entry.name);
    if(entry.isFile() && fs.statSync(filename).size <= 1024*1024)files.push({name:entry.name,text:fs.readFileSync(filename,'utf8')});
    else if(entry.isDirectory())for(const child of fs.readdirSync(filename,{withFileTypes:true})){
      const nested=path.join(filename,child.name);
      if(child.isFile()&&fs.statSync(nested).size<=1024*1024)files.push({name:entry.name+'/'+child.name,text:fs.readFileSync(nested,'utf8')});
    }
  }
  return files;
};
const add=(ecosystem,name,version,license,directory)=>{
  const texts=readLicenseFiles(directory);
  sections.push(`\n${'='.repeat(76)}\n${ecosystem}: ${name} ${version}\nDeclared license: ${typeof license==='string'?license:JSON.stringify(license||'not declared')}`);
  for(const file of texts)sections.push(`\n--- ${file.name} ---\n${file.text}`);
  if(!texts.length)sections.push('No separate license/notice file was included in the installed package; refer to its declared license and upstream package source.');
};
const app=JSON.parse(fs.readFileSync('package.json','utf8'));
add('Application',app.name,app.version,'MIT',process.cwd());
const lock=JSON.parse(fs.readFileSync('package-lock.json','utf8'));
for(const [relative,record] of Object.entries(lock.packages||{})){
  if(!relative.startsWith('node_modules/'))continue;
  const directory=path.resolve(relative);const manifest=path.join(directory,'package.json');
  if(!fs.existsSync(manifest))continue;
  const pkg=JSON.parse(fs.readFileSync(manifest,'utf8'));
  add('npm',pkg.name||relative,pkg.version||record.version,pkg.license||record.license,directory);
}
const metadata=spawnSync('cargo',['metadata','--locked','--format-version','1','--manifest-path','src-tauri/Cargo.toml'],{encoding:'utf8',maxBuffer:32*1024*1024});
if(metadata.status!==0)throw new Error('Could not collect locked Cargo license metadata.');
for(const pkg of JSON.parse(metadata.stdout).packages){
  const directory=path.dirname(pkg.manifest_path);
  add('Cargo',pkg.name,pkg.version,pkg.license,directory);
  if(pkg.license_file){const file=path.resolve(directory,pkg.license_file);if(fs.existsSync(file)&&fs.statSync(file).size<=1024*1024)sections.push(`\n--- declared license_file ---\n${fs.readFileSync(file,'utf8')}`);}
}
fs.mkdirSync(path.dirname(output),{recursive:true});
fs.writeFileSync(output,sections.join('\n\n')+'\n');
console.log(`Collected third-party notices: ${path.basename(output)} (${fs.statSync(output).size} bytes)`);
