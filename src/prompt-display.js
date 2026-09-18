// Presentation only. Never use this text to submit or recreate a generation.
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const ratio = '(?:\\d{1,3}\\s*[:：]\\s*\\d{1,3})';
const common = ['16:9','9:16','1:1','4:3','3:4','3:2','2:3','21:9','9:21','5:4','4:5','2:1','1:2','16:10','10:16'];
// Quoted scene text and URLs are creative content, even when they contain a ratio/model.
const literals = /("(?:\\.|[^"\\])*"|“[^”]*”|‘[^’]*’|(?<!\w)'(?:\\.|[^'\\])*'|`[^`]*`|https?:\/\/[^\s]+)/g;

export function cardPrompt(presentation) {
  const original=presentation.display_prompt ?? presentation.prompt;
  if(original==null) return null;
  const pieces=original.split(literals);
  const ratios=new Set(common);
  for(let i=0;i<pieces.length;i+=2) {
    for(const match of pieces[i].matchAll(new RegExp(`--(?:ar|aspect)\\s+(${ratio})`,'gi'))) {
      ratios.add(match[1].replace(/\s/g,'').replace('：',':'));
    }
  }
  const model=presentation.requested_model??presentation.effective_model;
  const modelPattern=model?escape(model).replace(/\s+/g,'\\s*'):null;
  const ratioPattern=[...ratios].map(value=>value.split(':').join('\\s*[:：]\\s*')).join('|');
  const cleaned=pieces.map((part,index)=>{
    if(index%2) return part;
    let text=part.replace(new RegExp(`--(?:ar|aspect)\\s+${ratio}(?![\\d:：])`,'gi'),'');
    if(modelPattern) {
      text=text.replace(new RegExp(`(?:^|\\n)\\s*(?:模型|Model)\\s*[:：]\\s*${modelPattern}(?:\\s*模型)?(?=\\s*[,，;；.。\\n]|$)[\\s,，;；.。]*`,'gi'),'');
      text=text.replace(new RegExp(`^\\s*(?:使用|采用|Use\\s+)\\s*${modelPattern}(?:\\s*模型)?(?:\\s*(?:生成图片|生成|生图))?\\s*[,，;；:：.。]\\s*`,'i'),'');
      text=text.replace(new RegExp(`--model\\s+${modelPattern}(?=\\s|$)`,'gi'),'');
      const mj=/^(?:MJ|Midjourney)\s*v?(\d+(?:\.\d+)?)$/i.exec(model);
      if(mj) text=text.replace(new RegExp(`--(?:v|version)\\s+${escape(mj[1])}(?![\\w.])`,'gi'),'');
    }
    // Remove aspect-setting labels as well as the matching ratio in natural prose.
    text=text.replace(new RegExp(`(?:宽高比|画幅比例|画幅|比例|aspect\\s+ratio)\\s*[:：=]?\\s*(?:${ratioPattern})(?![\\d:：])(?:\\s*[,，;；])?`,'gi'),'');
    return text.replace(new RegExp(`(?<![\\d:：])(?:${ratioPattern})(?![\\d:：])`,'g'),'')
      .replace(/[ \t]{2,}/g,' ').replace(/[ \t]+([,.;，。；])/g,'$1')
      .replace(/^[ \t]*[,;，；][ \t]*/gm,'').replace(/[ \t]+$/gm,'');
  }).join('');
  return cleaned.trim() || '未提供画面描述';
}

export function promptView(data) {
  if(!data.presentation_json) return data;
  const p=JSON.parse(data.presentation_json),text=cardPrompt(p);
  if(text===null) return data;
  return {...data,prompt:text,presentation_json:JSON.stringify({...p,display_prompt:text})};
}
