import { z } from 'zod';

const image = z.object({
  name: z.string().min(1).max(200),
  src: z.string().max(12_000_000).regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/),
  source_url: z.string().url().nullable(),
}).strict();
export const Presentation = z.object({
  version: z.literal('1'),
  source: z.enum(['legacy_result', 'saved_run', 'test_fixture']),
  thread_id: z.string().min(1).max(200),
  prompt: z.string().min(1).max(20000).nullable(),
  display_prompt: z.string().min(1).max(20000).optional(),
  requested_model: z.string().min(1).max(200).nullable(),
  effective_model: z.string().min(1).max(200).nullable(),
  requested_resolution: z.string().min(1).max(100).nullable(),
  references: z.array(image).max(12).nullable(),
  image: image.nullable(), // Video without a reference does not invent a poster.
  video: z.object({
    name:z.string().min(1).max(200),
    src:z.string().max(32_000_000).regex(/^data:video\/mp4;base64,[A-Za-z0-9+/]+=*$/),
    source_url:z.string().url().nullable(),
  }).strict().optional(),
}).strict().refine(value => value.image || value.video, 'Image or video is required');

export function decodePresentation(value) {
  if (value == null) return null;
  return Presentation.parse(JSON.parse(value));
}
