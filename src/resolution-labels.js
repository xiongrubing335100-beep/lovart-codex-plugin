// Only exact, recognized long-edge sizes get a K badge. Never estimate a tier.
const kSizes = new Map([[1024,'1K'],[2048,'2K'],[3840,'4K'],[4096,'4K']]);
const commonRatios = [[1,1],[4,3],[3,4],[3,2],[2,3],[16,9],[9,16],
  [21,9],[9,21],[5,4],[4,5],[2,1],[1,2],[16,10],[10,16]];
function aspectRatio(width,height) {
  let a=width,b=height;
  while(b) [a,b]=[b,a%b];
  const exact=`${width/a}:${height/a}`;
  const nearest=commonRatios.map(([w,h])=>({label:`${w}:${h}`,error:Math.abs(width/height/(w/h)-1),
    pixelError:Math.min(Math.abs(height-width*h/w),Math.abs(width-height*w/h))}))
    .sort((a,b)=>a.error-b.error)[0];
  // Allow only small pixel-alignment differences (e.g. 1456 × 816 for 16:9).
  const label=nearest.error<=0.005&&nearest.pixelError<=4?nearest.label:exact;
  return {aspect:label,aspectDescription:`实际尺寸 ${width} × ${height}；精确宽高比 ${exact}${label!==exact?`，按 ${label} 显示`:''}`};
}
export function resolutionLabels(width, height) {
  if (![width,height].every(value=>Number.isInteger(value)&&value>0)) return null;
  const long=Math.max(width,height),spec=kSizes.get(long)??null;
  return {size:`${width} × ${height}`,spec,...aspectRatio(width,height),
    description:spec?`图片或视频实际长边 ${long} 像素`:''};
}
