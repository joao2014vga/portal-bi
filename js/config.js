// =====================================================================
// CONFIGURAÇÃO DO PORTAL
// Preencha com os dados do seu projeto Supabase
// (Supabase > Project Settings > API).
// Enquanto SUPABASE_URL estiver vazio, o portal roda em MODO DEMONSTRAÇÃO
// com dados fictícios salvos só no seu navegador.
// =====================================================================
export const CONFIG = {
  SUPABASE_URL: "https://cfrvnsnwdldnflowxqbs.supabase.co",       // ex.: "https://abcdefghijk.supabase.co"
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNmcnZuc253ZGxkbmZsb3d4cWJzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczMTUyOTgsImV4cCI6MjA5Mjg5MTI5OH0.E89BcKeiQtJHPFVU-IYTGgKee3ieV-LMZjCOzsWC2YQ",  // chave "anon public" (pode ficar no front-end)

  NOME_PORTAL: "BI Portal",
  NOME_EMPRESA: "Brascof",

  // Idioma das telas: "pt" (português) ou "en" (inglês). Ver js/i18n.js.
  IDIOMA: "pt",
};
