// Optional standalone entry, using the same local page and writer as the MCP tool.
import {writeFileSync} from 'node:fs';
import {createCredentialSetup} from '../src/credential-setup.js';
const setup=createCredentialSetup({unref:false});
const result=await setup.start();
const outputIndex=process.argv.indexOf('--output-file');
if(outputIndex!==-1)writeFileSync(process.argv[outputIndex+1],JSON.stringify(result));
else process.stdout.write(JSON.stringify(result)+'\n');
