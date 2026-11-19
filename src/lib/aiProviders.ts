// AI providers the assistant knows how to reach. Every one speaks the OpenAI
// chat-completions API, so they differ only in address, key and models.

export interface AiProviderPreset {
  id: string;
  label: string;
  /** One line under the name in the picker. */
  note: string;
  baseUrl: string;
  /** Model used until the person picks another. Empty: pick from the list. */
  model: string;
  needsKey: boolean;
  /** Where to get a key. */
  keyUrl?: string;
  keyHint?: string;
  /** Base URL can be edited. */
  editableUrl?: boolean;
}

export const AI_PROVIDERS: AiProviderPreset[] = [
  {
    id: 'aiproxy',
    label: 'AIProxy (local pool)',
    note: 'Your CLIProxyAPI pool on this PC. Address and key are detected automatically.',
    baseUrl: 'http://127.0.0.1:8317/v1',
    model: 'gpt-6-luna',
    needsKey: true,
    keyHint: 'Detected from AIProxy, or run `aiproxy key`',
    editableUrl: true,
  },
  {
    id: 'pollinations',
    label: 'Pollinations (free, no sign-up)',
    note: 'Works right away with no key, but allows about one reply every 45 seconds, so multi-step edits are slow (it waits and retries automatically). Use AIProxy or a free key for real work.',
    baseUrl: 'https://text.pollinations.ai/openai',
    model: 'openai',
    needsKey: false,
  },
  {
    id: 'nvidia',
    label: 'NVIDIA NIM (free key)',
    note: 'Free endpoints for big open models (Kimi, Mistral Large, Nemotron, GLM…).',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    model: 'moonshotai/kimi-k3.1-pro',
    needsKey: true,
    keyUrl: 'https://build.nvidia.com/settings/api-keys',
    keyHint: 'nvapi-…',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    note: 'Many models; the ones ending in ":free" cost nothing.',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: '',
    needsKey: true,
    keyUrl: 'https://openrouter.ai/keys',
    keyHint: 'sk-or-…',
  },
  {
    id: 'gemini',
    label: 'Google Gemini (free key)',
    note: 'Free tier from Google AI Studio.',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: '',
    needsKey: true,
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'groq',
    label: 'Groq (free key)',
    note: 'Very fast open models with a free tier.',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: '',
    needsKey: true,
    keyUrl: 'https://console.groq.com/keys',
    keyHint: 'gsk_…',
  },
  {
    id: 'ollama',
    label: 'Ollama (on this PC)',
    note: 'Models you run yourself. Pick one that supports tools to let it edit files.',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: '',
    needsKey: false,
    editableUrl: true,
  },
  {
    id: 'custom',
    label: 'Custom (OpenAI-compatible)',
    note: 'Any server with /v1/chat/completions: LM Studio, vLLM, a company gateway…',
    baseUrl: '',
    model: '',
    needsKey: false,
    editableUrl: true,
  },
];

export const providerPreset = (id: string) => AI_PROVIDERS.find((p) => p.id === id);

/** Models that cannot chat (embeddings, rerankers, image, speech, safety filters). */
const NON_CHAT = /(embed|rerank|safety|guard|parse|tts|whisper|speech|audio|image|dall-e|moderation|cosmos|pose|detector|noise|voice|translate|calibration|kumo|streampetr|sparsedrive|bevformer|proteina|paligemma)/i;

export function chatModels(models: string[]): string[] {
  const usable = models.filter((m) => !NON_CHAT.test(m));
  return usable.length ? usable : models;
}
