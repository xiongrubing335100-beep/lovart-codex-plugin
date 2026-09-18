import {
  constants, closeSync, fchmodSync, fstatSync, fsyncSync,
  lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync,
  writeFileSync, chmodSync,
} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export function validateCredentials(input) {
  if(!input||Array.isArray(input)||typeof input!=='object'||Object.keys(input).sort().join(',')!=='access_key,secret_key') throw new Error('INVALID_KEYS');
  const keys={};
  for(const name of ['access_key','secret_key']) {
    if(typeof input[name]!=='string') throw new Error('INVALID_KEYS');
    const value=input[name].trim();
    if(!value||value.length>2048||/[\u0000-\u0020\u007f]/.test(value)) throw new Error('INVALID_KEYS');
    keys[name]=value;
  }
  return keys;
}

export function macCredentialsDirectory(home=homedir()) {
  return path.join(home,'Library','Application Support','Lovart','credentials');
}

// The store is outside the plugin cache, so updates and restarts retain the pair.
// A pair is replaced atomically; a reader never combines keys from two saves.
function checkOwned(stat) {
  if(typeof process.getuid==='function'&&stat.uid!==process.getuid()) throw new Error('UNSAFE_OWNER');
}
function checkPrivate(stat) {
  checkOwned(stat);
  if(typeof process.getuid==='function'&&(stat.mode&0o077)!==0) throw new Error('UNSAFE_PERMISSIONS');
}
function checkDirectory(directory,{create=false}={}) {
  if(create)mkdirSync(directory,{recursive:true,mode:0o700});
  const stat=lstatSync(directory);
  if(!stat.isDirectory()||stat.isSymbolicLink()) throw new Error('UNSAFE_DIRECTORY');
  checkOwned(stat);
  if(create)chmodSync(directory,0o700);
  else checkPrivate(stat);
}

export function saveMacCredentials(input,{directory=macCredentialsDirectory()}={}) {
  const keys=validateCredentials(input);
  let temporary=null,fd;
  try {
    checkDirectory(directory,{create:true});
    const target=path.join(directory,'keys.json');
    // Never follow a link supplied in place of the credential file.
    try {
      const current=lstatSync(target);
      if(!current.isFile()||current.isSymbolicLink())throw new Error('UNSAFE_FILE');
      checkOwned(current);
    }catch(error){if(error.code!=='ENOENT')throw error;}
    temporary=path.join(directory,`.keys-${randomUUID()}.tmp`);
    fd=openSync(temporary,'wx',0o600);
    fchmodSync(fd,0o600);
    writeFileSync(fd,JSON.stringify(keys),'utf8');
    fsyncSync(fd);
    closeSync(fd);fd=undefined;
    renameSync(temporary,target);temporary=null;
  }catch{
    throw new Error('CREDENTIAL_SAVE_FAILED');
  }finally{
    if(fd!==undefined)try{closeSync(fd);}catch{}
    if(temporary)try{unlinkSync(temporary);}catch{}
  }
}

export function readMacCredentials({directory=macCredentialsDirectory()}={}) {
  let fd;
  try {
    checkDirectory(directory);
    const target=path.join(directory,'keys.json');
    const entry=lstatSync(target);
    if(!entry.isFile()||entry.isSymbolicLink())throw new Error('UNSAFE_FILE');
    checkPrivate(entry);
    fd=openSync(target,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
    const stat=fstatSync(fd);
    if(!stat.isFile()||stat.size>32768)throw new Error('INVALID_FILE');
    checkPrivate(stat);
    return validateCredentials(JSON.parse(readFileSync(fd,'utf8')));
  }catch(error){
    if(error.code==='ENOENT')return null;
    // Do not silently reuse stale environment keys when a saved store is broken.
    throw new Error('无法读取本机 Lovart 密钥，请在 Codex 中说“配置lovart的密钥”重新保存。');
  }finally{
    if(fd!==undefined)try{closeSync(fd);}catch{}
  }
}
