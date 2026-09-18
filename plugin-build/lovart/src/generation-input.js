// Lovart's Agent accepts one text message. Keep its execution instructions out of
// the saved creative prompt, and assemble the transport message only at submission.
export function agentRequest(input) {
  if (!input.requested_model && !input.execution_instructions) return input.prompt;
  return [
    'Execution settings for the Lovart Agent only. Do not prepend these settings to the image/video model prompt.',
    ...(input.requested_model ? [`Requested model: ${input.requested_model}`] : []),
    ...(input.execution_instructions ? [`Execution instructions: ${input.execution_instructions}`] : []),
    'Pass the following creative prompt to the selected model unchanged:',
    input.prompt,
  ].join('\n\n');
}
