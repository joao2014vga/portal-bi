// =====================================================================
// Edge Function: bi-admin-users
// Operações que precisam da chave de serviço (service role) e por isso
// não podem rodar no navegador. Só administradores do portal podem chamar.
//
// O projeto Supabase pode ser compartilhado com outros sistemas, então:
//  - "convidar" um e-mail que JÁ tem login só libera o portal para ele
//    (ele entra com a senha que já usa);
//  - "excluir" remove só o acesso ao portal, nunca o login (auth.users).
//
// Deploy:  supabase functions deploy bi-admin-users
// =====================================================================
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// procura um usuário do Auth pelo e-mail (paginando)
async function buscarPorEmail(admin: SupabaseClient, email: string) {
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const u = data.users.find((x) => x.email?.toLowerCase() === email);
    if (u) return u;
    if (data.users.length < 1000) return null;
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Método não permitido" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // 1) Quem está chamando?
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: caller, error: callerErr } = await admin.auth.getUser(token);
  if (callerErr || !caller?.user) return json({ error: "Não autenticado" }, 401);

  const { data: perfil } = await admin
    .from("bi_perfis").select("is_admin, ativo").eq("id", caller.user.id).maybeSingle();
  if (!perfil?.is_admin || !perfil?.ativo) return json({ error: "Acesso negado" }, 403);

  // 2) O que fazer?
  let body: Record<string, any>;
  try { body = await req.json(); } catch { return json({ error: "JSON inválido" }, 400); }

  try {
    switch (body.action) {
      // ---------------------------------------------------------------
      case "convidar": {
        const email = String(body.email ?? "").trim().toLowerCase();
        const nome = String(body.nome ?? "").trim();
        if (!email || !nome) return json({ error: "Nome e e-mail são obrigatórios" }, 400);

        let userId: string;
        let jaTinhaLogin = false;
        const existente = await buscarPorEmail(admin, email);

        if (existente) {
          const { data: jaNoPortal } = await admin.from("bi_perfis").select("id").eq("id", existente.id).maybeSingle();
          if (jaNoPortal) return json({ error: "Este e-mail já tem acesso ao portal" }, 400);
          userId = existente.id;
          jaTinhaLogin = true;
        } else {
          const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
            data: { nome },
            redirectTo: body.redirectTo,
          });
          if (error) return json({ error: traduz(error.message) }, 400);
          userId = data.user.id;
        }

        const { error: ePerfil } = await admin.from("bi_perfis").insert({
          id: userId, nome, email, is_admin: !!body.is_admin, ativo: true,
        });
        if (ePerfil) return json({ error: ePerfil.message }, 400);

        const dashboards: number[] = Array.isArray(body.dashboards) ? body.dashboards : [];
        if (dashboards.length) {
          await admin.from("bi_acessos").insert(dashboards.map((d) => ({ user_id: userId, dashboard_id: d })));
        }
        return json({ ok: true, id: userId, ja_tinha_login: jaTinhaLogin });
      }

      // ---------------------------------------------------------------
      case "reenviar": {
        const { data: u, error } = await admin.auth.admin.getUserById(body.user_id);
        if (error || !u?.user?.email) return json({ error: "Usuário não encontrado" }, 404);

        if (!u.user.email_confirmed_at) {
          const { error: e2 } = await admin.auth.admin.inviteUserByEmail(u.user.email, { redirectTo: body.redirectTo });
          if (e2) return json({ error: traduz(e2.message) }, 400);
          return json({ ok: true, tipo: "convite" });
        }
        const anon = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!);
        const { error: e3 } = await anon.auth.resetPasswordForEmail(u.user.email, { redirectTo: body.redirectTo });
        if (e3) return json({ error: traduz(e3.message) }, 400);
        return json({ ok: true, tipo: "senha" });
      }

      // ---------------------------------------------------------------
      case "excluir": {
        // remove só o acesso ao portal; o login continua valendo nos outros sistemas
        if (body.user_id === caller.user.id) return json({ error: "Você não pode excluir o próprio usuário" }, 400);
        const { error } = await admin.from("bi_perfis").delete().eq("id", body.user_id);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      // ---------------------------------------------------------------
      case "status": {
        // confirmação de convite e último acesso, só dos usuários do portal
        const { data: perfis } = await admin.from("bi_perfis").select("id");
        const status: Record<string, { confirmado: boolean; ultimo_acesso: string | null }> = {};
        await Promise.all((perfis ?? []).map(async ({ id }) => {
          const { data } = await admin.auth.admin.getUserById(id);
          if (data?.user) {
            status[id] = { confirmado: !!data.user.email_confirmed_at, ultimo_acesso: data.user.last_sign_in_at ?? null };
          }
        }));
        return json({ ok: true, status });
      }

      default:
        return json({ error: "Ação desconhecida" }, 400);
    }
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});

function traduz(msg: string) {
  if (/already been registered|already registered/i.test(msg)) return "Este e-mail já está cadastrado";
  if (/rate limit/i.test(msg)) return "Limite de e-mails atingido. Tente novamente em alguns minutos";
  return msg;
}
