import {randomBytes} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
try { await writeFile(new URL('../.dev.vars',import.meta.url),'SETUP_TOKEN='+randomBytes(32).toString('hex')+'\n',{flag:'wx',mode:0o600}); console.log('Created .dev.vars with a unique installation key. Enter its SETUP_TOKEN value in the setup wizard.'); } catch(error) { if(error.code==='EEXIST')console.log('.dev.vars already exists; the existing installation key is preserved.');else throw error; }
