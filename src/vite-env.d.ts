/// <reference types="vite/client" />

// Only public values are ever read from the environment. The service-role key and every
// provider key live in Supabase secrets and are read by the Edge Function, never here.
interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
