import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { ProbeStore } from './store.js';
import { Presentation } from './presentation.js';
import { RunDrafts, RunInput, RunView } from './run-drafts.js';
import { createMediaSaver } from './save-dialog.js';
import { createMetadataEnricher } from './media-metadata.js';
import { createResultModelEnricher } from './result-metadata.js';
import { promptView } from './prompt-display.js';

export const URI = 'ui://lovart/result-card-v1.html';
export const LEGACY_URIS = [...new Set([
  'ui://lovart-ui-probe/card.html',
  ...['20260916','20260917','20260918'].flatMap(date=>Array.from({length:18},(_,i)=>`ui://lovart-ui-probe/card-${date}-r${i+1}.html`)),
])];
const id = z.string().uuid();
const shape = {
  contract_version: z.literal('1'), probe_id: id, nonce: z.string(), prompt: z.string(),
  count: z.number().int().nonnegative(), revision: z.number().int().nonnegative(),
  mode: z.literal('diagnostic_no_generation'), correlation_id: z.string().uuid().optional(),
  presentation_json: z.string().nullable().optional(),
  presentation_pending: z.boolean().optional(),
  actions:z.object({version:z.literal(1),recreate:z.boolean(),mode:z.literal('draft_only')}).optional(),
  observations: z.array(z.object({ event: z.string(), observed_at: z.string() })).optional(),
  media_metadata:z.object({source:z.literal('c2pa_file_record'),model:z.string(),software_agent:z.string().nullable(),created_at:z.string().nullable(),media_sha256:z.string(),signature_verified:z.literal(false)}).optional(),
};
export function createProbeServer(directory, existingServer = null) {
  // Bind markup to this process version; deployment must not mix new UI with old tools.
  const cardHtml = readFileSync(new URL('../dist/card.html', import.meta.url), 'utf8');
  const store = new ProbeStore(directory);
  const drafts = new RunDrafts(store);
  const saveMedia = createMediaSaver(store);
  const enrichMetadata = createMetadataEnricher();
  const enrichResultModel = createResultModelEnricher(store);
  const server = existingServer ?? new McpServer({ name: 'lovart-ui-probe', version: '0.1.0' });
  const wrap = (handler, compact = false) => async (args) => {
    try {
      const data = promptView(enrichMetadata(enrichResultModel(handler(args))));
      if(data.presentation_json) data.actions=drafts.cardActions(data.probe_id);
      if (compact && data.presentation_json) {
        data.presentation_json = null;
        data.presentation_pending = true;
      }
      return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
  };
  const tool = (name, title, description, inputSchema, handler, readOnly, ui) =>
    (ui ? registerAppTool : (s, ...args) => s.registerTool(...args))(server, name, {
      title, description, inputSchema, outputSchema: shape,
      annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false },
      ...(ui ? { _meta: { ui, ...(ui.resourceUri ? { 'openai/outputTemplate': URI } : {}) } } : {}),
    }, wrap(handler, name === 'lovart_display'));
  tool('lovart_card_create', 'Prepare diagnostic card',
    'Create a local no-cost diagnostic record. No image generation. Then call lovart_display with the returned probe_id.',
    { nonce: z.string().min(1).max(128), prompt: z.string().min(1).max(20000) },
    ({ nonce, prompt }) => store.create(nonce, prompt), false);
  tool('lovart_display', 'Lovart media result',
    'Render a saved Lovart image or video card in the host. No image generation or external calls.',
    { probe_id: id }, ({ probe_id }) => store.get(probe_id), true, { resourceUri: URI });
  tool('lovart_card_import', 'Import saved media card',
    'Save a supplied image or video result and evidence-backed metadata locally without generating. Unknown metadata must be null. Use lovart_display with the returned probe_id.',
    { nonce: z.string().min(1).max(128), presentation: Presentation },
    ({ nonce, presentation }) => store.importPresentation(nonce, presentation), false);
  tool('lovart_card_get', 'Read diagnostic state', 'Read persisted diagnostic state and UI observations.',
    { probe_id: id }, ({ probe_id }) => store.evidence(probe_id), true);
  registerAppTool(server,'lovart_card_save_as',{
    description:'Open a Windows Save As dialog for this saved result. Writes only after the user chooses a destination; cancel writes nothing.',
    inputSchema:{probe_id:id},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},
    _meta:{ui:{visibility:['app']}},
  },async ({probe_id})=>{
    try {const result=await saveMedia(probe_id);return {content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result};}
    catch(error){return {isError:true,content:[{type:'text',text:error.message}]};}
  });
  tool('lovart_card_bump', 'Test callback', 'Increment a saved diagnostic counter exactly once per request_id. No generation or credits.',
    { probe_id: id, request_id: id }, ({ probe_id, request_id }) => store.bump(probe_id, request_id),
    false, { visibility: ['app'] });
  tool('lovart_card_observe', 'Record UI observation', 'Record a diagnostic UI event, not proof of independent human verification.',
    { probe_id: id, event: z.enum(['bridge_connected', 'media_loaded', 'media_error']) },
    ({ probe_id, event }) => store.observe(probe_id, event), false, { visibility: ['app'] });
  const draftTool=(name,description,schema,handler,readOnly=false,appOnly=false)=>(appOnly?registerAppTool:(s,...args)=>s.registerTool(...args))(server,name,{
    description,inputSchema:schema,outputSchema:z.object({contract_version:z.literal('1'),ok:z.literal(true),run:RunView}).strict(),
    annotations:{readOnlyHint:readOnly,destructiveHint:false,openWorldHint:false},
    ...(appOnly?{_meta:{ui:{visibility:['app']}}}:{}),
  },async args=>{
    try {const run=RunView.parse(handler(args));return {content:[{type:'text',text:JSON.stringify({run_id:run.run_id,status:run.status,generated:false})}],structuredContent:{contract_version:'1',ok:true,run}};}
    catch(error){return {isError:true,content:[{type:'text',text:error instanceof z.ZodError?'INVALID_INPUT':error.message}]};}
  });
  draftTool('lovart_run_save','Save complete generation inputs as a local draft only. Never submits or spends credits.',
    z.object({request_id:id,input:RunInput}).strict(),({request_id,input})=>drafts.save(request_id,input));
  draftTool('lovart_run_get','Read a saved draft without submitting or resuming generation.',
    z.object({run_id:id}).strict(),({run_id})=>drafts.view(run_id),true);
  draftTool('lovart_action_prepare','Save a Recreate/Edit/Animate draft from a server-owned image card. No generation.',
    z.object({request_id:id,probe_id:id,action:z.enum(['recreate','edit','animate']),
      prompt:z.string().min(1).max(20000).optional(),project_id:z.string().min(1).max(200).optional(),
      requested_model:z.string().min(1).max(200).nullable().optional()}).strict(),args=>drafts.prepare(args),false,true);
  for (const [index, resourceUri] of [URI,...LEGACY_URIS].entries()) registerAppResource(server, index===0?'lovart-result':`legacy-card-${index}`, resourceUri, {}, async () => ({ contents: [{
    uri: resourceUri, mimeType: RESOURCE_MIME_TYPE,
    text: cardHtml,
    _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: ['https://a.lovart.ai'] } },
      'openai/widgetPrefersBorder': false,
      'openai/widgetDescription': 'Saved Lovart image or video result, references, playback, Save As and Recreate.' },
  }] }));
  return { server, store, drafts };
}
