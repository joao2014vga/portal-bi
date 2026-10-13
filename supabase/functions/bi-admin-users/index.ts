// =====================================================================
// Edge Function: bi-admin-users
// Operações que precisam da chave de serviço (service role) e por isso
// não podem rodar no navegador. Só administradores do portal podem chamar.
//
// O projeto Supabase pode ser compartilhado com outros sistemas, então:
//  - "criar" com um e-mail que JÁ tem login só libera o portal para ele
//    (ele entra com a senha que já usa, sem senha provisória);
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
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // 1) Quem está chamando?
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: caller, error: callerErr } = await admin.auth.getUser(token);
  if (callerErr || !caller?.user) return json({ error: "Not authenticated" }, 401);

  const { data: perfil } = await admin
    .from("bi_perfis").select("is_admin, ativo").eq("id", caller.user.id).maybeSingle();
  if (!perfil?.is_admin || !perfil?.ativo) return json({ error: "Access denied" }, 403);

  // 2) O que fazer?
  let body: Record<string, any>;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  try {
    switch (body.action) {
      // ---------------------------------------------------------------
      // Cria o login com uma senha provisória (sem e-mail). No primeiro
      // acesso o portal obriga a pessoa a trocar a senha (trocar_senha).
      case "criar": {
        const email = String(body.email ?? "").trim().toLowerCase();
        const nome = String(body.nome ?? "").trim();
        const senha = String(body.senha ?? "");
        if (!email || !nome) return json({ error: "Name and e-mail are required" }, 400);

        let userId: string;
        let jaTinhaLogin = false;
        const existente = await buscarPorEmail(admin, email);

        if (existente) {
          // login compartilhado com outros sistemas: só libera o portal, sem mexer na senha
          const { data: jaNoPortal } = await admin.from("bi_perfis").select("id").eq("id", existente.id).maybeSingle();
          if (jaNoPortal) return json({ error: "This e-mail already has access to the portal" }, 400);
          userId = existente.id;
          jaTinhaLogin = true;
        } else {
          if (senha.length < 8) return json({ error: "The temporary password must be at least 8 characters long" }, 400);
          const { data, error } = await admin.auth.admin.createUser({
            email, password: senha, email_confirm: true,
            user_metadata: { nome, trocar_senha: true },
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
      // Define uma nova senha provisória; a troca volta a ser obrigatória
      case "redefinir": {
        const senha = String(body.senha ?? "");
        if (senha.length < 8) return json({ error: "The temporary password must be at least 8 characters long" }, 400);
        const { data: u, error } = await admin.auth.admin.getUserById(body.user_id);
        if (error || !u?.user) return json({ error: "User not found" }, 404);
        const { error: e2 } = await admin.auth.admin.updateUserById(body.user_id, {
          password: senha,
          user_metadata: { ...(u.user.user_metadata ?? {}), trocar_senha: true },
        });
        if (e2) return json({ error: traduz(e2.message) }, 400);
        return json({ ok: true });
      }

      // ---------------------------------------------------------------
      case "excluir": {
        // remove só o acesso ao portal; o login continua valendo nos outros sistemas
        if (body.user_id === caller.user.id) return json({ error: "You cannot delete your own user" }, 400);
        const { error } = await admin.from("bi_perfis").delete().eq("id", body.user_id);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      // ---------------------------------------------------------------
      case "status": {
        // troca de senha pendente e último acesso, só dos usuários do portal
        const { data: perfis } = await admin.from("bi_perfis").select("id");
        const status: Record<string, { confirmado: boolean; trocar_senha: boolean; ultimo_acesso: string | null }> = {};
        await Promise.all((perfis ?? []).map(async ({ id }) => {
          const { data } = await admin.auth.admin.getUserById(id);
          if (data?.user) {
            status[id] = {
              confirmado: !!data.user.email_confirmed_at,
              trocar_senha: !!data.user.user_metadata?.trocar_senha,
              ultimo_acesso: data.user.last_sign_in_at ?? null,
            };
          }
        }));
        return json({ ok: true, status });
      }

      default:
        return json({ error: "Unknown action" }, 400);
    }
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});

function traduz(msg: string) {
  if (/already been registered|already registered/i.test(msg)) return "This e-mail is already registered";
  if (/Password should be at least/i.test(msg)) return "The password does not meet the minimum requirements";
  return msg;
}
