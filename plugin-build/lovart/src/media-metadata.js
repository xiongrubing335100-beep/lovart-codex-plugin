import { Decoder } from 'cbor-x';
import { createHash } from 'node:crypto';

const decoder = new Decoder({mapsAsObjects:true});
const C2PA_UUID = 'd8fec3d61b0e483c92975828877ec481';
function boxes(bytes,start=0,end=bytes.length) {
  const result=[];
  for(let at=start;at+8<=end;) {
    const size=bytes.readUInt32BE(at),type=bytes.toString('ascii',at+4,at+8);
    if(size===0 && bytes.subarray(at,end).every(value=>value===0)) break;
    if(size<8 || at+size>end || result.length>=512) throw new Error('INVALID_BOX');
    result.push({type,start:at+8,end:at+size});at+=size;
  }
  return result;
}
function label(bytes,box) {
  const desc=boxes(bytes,box.start,box.end).find(b=>b.type==='jumd');
  if(!desc || desc.end-desc.start<18 || !(bytes[desc.start+16]&2)) return null;
  const start=desc.start+17,end=bytes.indexOf(0,start);
  return end>=start && end<desc.end ? bytes.toString('utf8',start,end) : null;
}

// A conservative metadata reader, NOT a C2PA signature/trust validator.
// Only supports one uncompressed manifest with one creation action.
export function readVideoMetadata(bytes) {
  try {
    const top=boxes(bytes);
    if(top[0]?.type!=='ftyp') return null;
    const manifests=top.filter(b=>b.type==='uuid' && bytes.toString('hex',b.start,b.start+16)===C2PA_UUID);
    if(manifests.length!==1) return null;
    const uuid=manifests[0];
    if(uuid.end-uuid.start>1024*1024 || bytes.readUInt32BE(uuid.start+16)!==0) return null;
    const purpose=uuid.start+20,terminator=bytes.indexOf(0,purpose);
    if(terminator<0 || terminator>=uuid.end || bytes.toString('ascii',purpose,terminator)!=='manifest') return null;
    const root=boxes(bytes,terminator+9,uuid.end).filter(b=>b.type==='jumb');
    if(root.length!==1 || label(bytes,root[0])!=='c2pa') return null;
    const manifest=boxes(bytes,root[0].start,root[0].end).filter(b=>b.type==='jumb');
    if(manifest.length!==1 || !label(bytes,manifest[0])?.startsWith('urn:c2pa:')) return null;
    const assertions=boxes(bytes,manifest[0].start,manifest[0].end).find(b=>b.type==='jumb' && label(bytes,b)==='c2pa.assertions');
    if(!assertions) return null;
    const actionBoxes=boxes(bytes,assertions.start,assertions.end).filter(b=>b.type==='jumb' && ['c2pa.actions','c2pa.actions.v2'].includes(label(bytes,b)));
    if(actionBoxes.length!==1) return null;
    const payload=boxes(bytes,actionBoxes[0].start,actionBoxes[0].end).filter(b=>b.type==='cbor');
    if(payload.length!==1 || payload[0].end-payload[0].start>65536) return null;
    const data=decoder.decode(bytes.subarray(payload[0].start,payload[0].end));
    const actions=data.actions?.filter(a=>a.action==='c2pa.created');
    if(actions?.length!==1) return null;
    const action=actions[0],model=action.parameters?.model_name;
    if(typeof model!=='string' || !/^[a-zA-Z0-9_. -]{1,200}$/.test(model)) return null;
    const software=action.softwareAgent?.name;
    return {source:'c2pa_file_record',model,software_agent:typeof software==='string'?software.slice(0,200):null,
      created_at:action.when instanceof Date && !Number.isNaN(action.when.getTime())?action.when.toISOString():typeof action.when==='string'?action.when.slice(0,100):null,
      media_sha256:createHash('sha256').update(bytes).digest('hex'),signature_verified:false};
  } catch { return null; }
}

export function createMetadataEnricher() {
  const cache=new Map();
  return data=>{
    if(!data.presentation_json) return data;
    const p=JSON.parse(data.presentation_json);
    if(!p.video) return data;
    // Stored cards are immutable, so their ID is a stable cache key.
    if(!cache.has(data.probe_id)) {
      if(cache.size>=32) cache.delete(cache.keys().next().value);
      cache.set(data.probe_id,readVideoMetadata(Buffer.from(p.video.src.split(',')[1],'base64')));
    }
    const metadata=cache.get(data.probe_id);
    if(metadata) data.media_metadata=metadata;
    return data;
  };
}
