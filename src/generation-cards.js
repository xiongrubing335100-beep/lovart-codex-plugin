import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { canonical } from './run-drafts.js';
import { generationArgs, confirmArgs, resultArgs } from './lovart-cli.js';
import { readResultModel } from './result-metadata.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const artifactUrls = result => new Set((result.items ?? []).flatMap(item =>
  (item.artifacts ?? []).map(artifact => artifact.content).filter(url => typeof url === 'string')));

function localMedia(file, url, video = false) {
  const bytes = readFileSync(file);
  let mime;
  if (video && bytes.toString('ascii', 4, 8) === 'ftyp') mime = 'video/mp4';
  if (!video && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) mime = 'image/png';
  if (!video && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mime = 'image/jpeg';
  if (!video && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') mime = 'image/webp';
  if (!mime) throw new Error('UNSUPPORTED_CARD_MEDIA');
  const src = `data:${mime};base64,${bytes.toString('base64')}`;
  if (src.length > (video ? 32_000_000 : 12_000_000)) throw new Error('CARD_MEDIA_TOO_LARGE');
  return {name:path.basename(file).slice(0, 200), src, source_url:url};
}

// Owns the association between submitted inputs, provider threads and result cards.
// Card reads/refreshes never submit, and uncertain submissions are never retried here.
export class GenerationCards {
  constructor({store, drafts, execute, outputDir, stateDir}) {
    Object.assign(this, {store, drafts, execute, outputDir, stateDir});
    this.db = store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS lovart_submissions(
      id TEXT PRIMARY KEY,input_json TEXT NOT NULL,references_json TEXT NOT NULL,
      baseline_json TEXT NOT NULL,thread_id TEXT,status TEXT NOT NULL,result_json TEXT,
      created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lovart_uploads(url TEXT PRIMARY KEY,media_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lovart_result_cards(
      submission_id TEXT NOT NULL,url TEXT NOT NULL,card_id TEXT NOT NULL,
      PRIMARY KEY(submission_id,url));`);
  }
  rememberUpload(file, result) {
    if (typeof result.url !== 'string') return result;
    try {
      const media = localMedia(file, result.url);
      this.db.prepare('INSERT OR REPLACE INTO lovart_uploads VALUES(?,?)').run(result.url, JSON.stringify(media));
    } catch { /* Unsupported/large references still reach Lovart; do not fabricate thumbnails. */ }
    return result;
  }
  reference(url) {
    const uploaded = this.db.prepare('SELECT media_json FROM lovart_uploads WHERE url=?').get(url);
    if (uploaded) return JSON.parse(uploaded.media_json);
    const card = this.db.prepare("SELECT presentation_json FROM cards WHERE json_extract(presentation_json,'$.image.source_url')=? LIMIT 1").get(url);
    return card ? JSON.parse(card.presentation_json).image : null;
  }
  job(id) {
    const row = this.db.prepare('SELECT * FROM lovart_submissions WHERE id=?').get(id);
    return row && {...row,input:JSON.parse(row.input_json),references:JSON.parse(row.references_json),baseline:JSON.parse(row.baseline_json)};
  }
  async generate({request_id = randomUUID(), ...input}) {
    const previous = this.job(request_id);
    if (previous) {
      if (canonical(previous.input) !== canonical(input)) throw new Error('IDEMPOTENCY_CONFLICT');
      if (previous.result_json) return JSON.parse(previous.result_json);
      return {submission_id:request_id,thread_id:previous.thread_id,status:previous.status,
        warning:'Submission was already started. Do not resubmit; inspect the existing thread first.',cards:[]};
    }
    let baseline = [];
    if (input.thread_id) {
      const pending = this.db.prepare("SELECT id FROM lovart_submissions WHERE thread_id=? AND status NOT IN ('done','abort') LIMIT 1").get(input.thread_id);
      if (pending) throw new Error('THREAD_HAS_PENDING_SUBMISSION');
      // Fail before submitting if the baseline cannot be established.
      baseline = [...artifactUrls(await this.execute(['result','--thread-id',input.thread_id]))];
    }
    const references = (input.attachments ?? []).map(url => this.reference(url)).filter(Boolean);
    this.db.prepare('INSERT INTO lovart_submissions VALUES(?,?,?,?,?,?,NULL,?)').run(
      request_id,JSON.stringify(input),JSON.stringify(references),JSON.stringify(baseline),input.thread_id ?? null,'submitting',new Date().toISOString());
    try {
      const result = await this.execute(generationArgs(input, this.outputDir));
      return this.accept(request_id, result);
    } catch (error) {
      this.db.prepare("UPDATE lovart_submissions SET status='submission_unknown' WHERE id=?").run(request_id);
      throw new Error(`Lovart submission ${request_id} did not return a confirmed result. Do not resubmit automatically. ${error.message}`);
    }
  }
  async resume(threadId, confirm = false) {
    const job = this.db.prepare('SELECT id FROM lovart_submissions WHERE thread_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(threadId);
    const args = confirm ? confirmArgs(threadId,this.outputDir) : resultArgs(threadId,this.outputDir);
    const baseline = job ? this.job(job.id).baseline : [];
    if (baseline.length) args.push('--exclude-urls',...baseline);
    const result = await this.execute(args);
    if (job) return this.accept(job.id, {...result,thread_id:threadId});
    // Explicit retrieval of an older thread. Missing input/model stays unknown.
    const id = `legacy:${threadId}`;
    if (!this.job(id)) this.db.prepare('INSERT INTO lovart_submissions VALUES(?,?,?,?,?,?,NULL,?)').run(
      id,'{}','[]','[]',threadId,'retrieving',new Date().toISOString());
    return this.accept(id, {...result,thread_id:threadId});
  }
  accept(id, result) {
    const job = this.job(id);
    if (job.thread_id && result.thread_id && job.thread_id !== result.thread_id) throw new Error('RESULT_THREAD_MISMATCH');
    const thread = result.thread_id ?? job.thread_id;
    const status = result.final_status ?? result.status ?? 'unknown';
    const cards = [], errors = [];
    const resultUrls = artifactUrls(result), baseline = new Set(job.baseline);
    const current = (result.downloaded ?? []).filter(file => resultUrls.has(file.url) && !baseline.has(file.url));
    const eligible = thread && !result.pending_confirmation && !['pending_confirmation','abort'].includes(status) && result.generation_succeeded !== false;
    if (eligible) for (const file of current) {
      if (!['image','video'].includes(file.type) || !file.local_path) continue;
      try {
        const saved = this.db.prepare('SELECT card_id FROM lovart_result_cards WHERE submission_id=? AND url=?').get(id,file.url);
        if (saved) {cards.push({probe_id:saved.card_id,type:file.type,url:file.url});continue;}
        // A CLI-reported path alone is not enough: the file must belong to its output directory.
        const relative = path.relative(this.outputDir,path.resolve(file.local_path));
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('RESULT_OUTSIDE_OUTPUT_DIRECTORY');
        const isVideo = file.type === 'video', media = localMedia(file.local_path,file.url,isVideo);
        const input = job.input, kind = isVideo ? 'VIDEO' : 'IMAGE';
        const presentation = {version:'1',source:input.prompt?'saved_run':'legacy_result',thread_id:thread,
          prompt:input.prompt ?? null,requested_model:input.requested_model ?? (input.prefer_models?.[kind]?.length===1?input.prefer_models[kind][0]:null),
          effective_model:readResultModel(result,file.url),requested_resolution:null,references:job.references,
          image:isVideo?(job.references[0] ?? null):media,...(isVideo?{video:media}:{})};
        const card = this.store.importPresentation(`lovart-${digest(id+'\n'+file.url)}`,presentation);
        const project = input.project_id ?? result.project_id;
        if (input.prompt && project) {
          // Deterministic UUID derived from the provider artifact makes repeated polls idempotent.
          const bytes = Buffer.from(digest(id+'\n'+file.url).slice(0,32),'hex'); bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
          const hex=bytes.toString('hex'), uuid=`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
          const draft = this.drafts.save(uuid,{prompt:input.prompt,project_id:project,media_type:isVideo?'video':'image',
            requested_model:input.requested_model ?? null,reasoning_mode:input.reasoning_mode ?? null,
            ...(input.execution_instructions?{execution_instructions:input.execution_instructions}:{}),
            prefer_models:input.prefer_models ?? {},include_tools:input.include_tools ?? [],attachment_urls:input.attachments ?? [],
            references:job.references.map((ref,index)=>({asset_id:digest(ref.source_url),order:index,role:'reference',src:ref.src}))});
          const link = this.db.prepare('SELECT run_id FROM card_runs WHERE card_id=?').get(card.probe_id);
          if (!link) this.drafts.linkVerifiedResult(card.probe_id,draft.run_id);
        }
        this.db.prepare('INSERT INTO lovart_result_cards VALUES(?,?,?)').run(id,file.url,card.probe_id);
        cards.push({probe_id:card.probe_id,type:file.type,url:file.url});
      } catch (error) { errors.push({url:file.url,error:error.message}); }
    }
    const response = {...result,downloaded:current,submission_id:id,cards,
      ...(cards.length?{next_action:'Call lovart_display for every returned probe_id to show the saved result cards.'}:{}),
      ...(errors.length?{card_errors:errors}:{})};
    this.db.prepare('UPDATE lovart_submissions SET thread_id=?,status=?,result_json=? WHERE id=?').run(thread,status,JSON.stringify(response),id);
    return response;
  }
  async executeDraft(runId) {
    const draft = this.drafts.get(runId), input = draft.input;
    const existing = this.job(runId);
    if (existing) return existing.result_json ? JSON.parse(existing.result_json) : {
      submission_id:runId,thread_id:existing.thread_id,status:existing.status,cards:[],warning:'Already submitted; inspect status before any further action.'};
    let attachments = input.attachment_urls ?? [];
    if (!attachments.length && input.references.length) {
      attachments = [];
      const directory = path.join(this.stateDir,'references');mkdirSync(directory,{recursive:true});
      for (const ref of input.references) {
        const [header,data]=ref.src.split(','), ext=header.includes('jpeg')?'jpg':header.includes('webp')?'webp':'png';
        const file=path.join(directory,`${digest(data)}.${ext}`);writeFileSync(file,Buffer.from(data,'base64'));
        const upload=await this.execute(['upload','--file',file]);this.rememberUpload(file,upload);
        if (!upload.url) throw new Error('REFERENCE_UPLOAD_FAILED');attachments.push(upload.url);
      }
    }
    // Friendly model names/versions are instructions, never tool-routing aliases.
    const models = input.prefer_models;
    return this.generate({request_id:runId,prompt:input.prompt,project_id:input.project_id,
      ...(input.requested_model?{requested_model:input.requested_model}:{}),
      ...(input.execution_instructions?{execution_instructions:input.execution_instructions}:{}),
      ...(attachments.length?{attachments}:{}),...(input.reasoning_mode?{reasoning_mode:input.reasoning_mode}:{}),
      ...(Object.keys(models).length?{prefer_models:models}:{}),
      ...(input.include_tools.length?{include_tools:input.include_tools}:{})});
  }
}
