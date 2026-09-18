// Only explicit effective_model evidence is accepted. A general `model` may name
// the planning LLM, and preferences/tool names/assistant prose are not execution proof.
const modelName = value => typeof value === 'string' && value.trim().length > 0 &&
  value.trim().length <= 200 && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : null;

export function readResultModel(result, mediaUrl) {
  if (!result || !mediaUrl) return null;
  const artifacts = (Array.isArray(result.items) ? result.items : []).flatMap(item =>
    Array.isArray(item?.artifacts) ? item.artifacts : []);
  const matches = artifacts.filter(artifact => artifact?.content === mediaUrl);
  if (!matches.length) return null;
  const values = matches.flatMap(artifact => [artifact.effective_model, artifact.metadata?.effective_model]);
  // A thread can hold many assets from different models. Thread-wide metadata is
  // usable only when the returned artifact set identifies exactly this one asset.
  const urls = new Set(artifacts.map(artifact => artifact?.content).filter(value => typeof value === 'string'));
  if (urls.size === 1) values.push(result.effective_model);
  const names = [...new Set(values.map(modelName).filter(Boolean))];
  return names.length === 1 ? names[0] : null;
}

export function createResultModelEnricher(store) {
  return data => {
    if (!data.presentation_json) return data;
    const p = JSON.parse(data.presentation_json);
    if (p.effective_model || p.source === 'test_fixture') return data;
    if (!store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='lovart_result_cards'").get()) return data;
    const record = store.db.prepare(`SELECT s.thread_id,s.result_json FROM lovart_result_cards c
      JOIN lovart_submissions s ON s.id=c.submission_id WHERE c.card_id=?`).get(data.probe_id);
    if (!record?.result_json || record.thread_id !== p.thread_id) return data;
    const result = JSON.parse(record.result_json);
    if (result.thread_id && result.thread_id !== p.thread_id) return data;
    const model = readResultModel(result,(p.video ?? p.image)?.source_url);
    // Keep the saved original inputs immutable; enrich the view from the linked result.
    return model ? {...data,presentation_json:JSON.stringify({...p,effective_model:model})} : data;
  };
}
