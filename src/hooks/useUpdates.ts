import {useState} from 'react';
import {isNativeDesktop} from '../core';
export function useUpdates(notify:(s:string)=>void){const[available,setAvailable]=useState<any>(null),[busy,setBusy]=useState(false),[progress,setProgress]=useState(0);
async function check(silent=false){if(!isNativeDesktop())return;setBusy(true);try{const updater=await import('@tauri-apps/plugin-updater');const update=await updater.check();setAvailable(update);if(!silent)notify(update?'Version '+update.version+' is ready to install.':'You are using the latest published version.');}catch(e){if(!silent)notify('Update check: '+String(e));}finally{setBusy(false)}}
async function install(){if(!available)return;setBusy(true);try{let total=0,received=0;await available.downloadAndInstall((e:any)=>{if(e.event==='Started')total=e.data.contentLength||0;if(e.event==='Progress'){received+=e.data.chunkLength;setProgress(total?Math.round(received/total*100):0)}});const{relaunch}=await import('@tauri-apps/plugin-process');await relaunch()}catch(e){notify('Update could not be installed: '+String(e));setBusy(false)}}
return{available,busy,progress,check,install};}
