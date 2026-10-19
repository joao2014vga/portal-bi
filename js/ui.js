// Utilidades de interface: escape, ícones, toast, modal, formatação.

import { LOCALE } from "./i18n.js";

export const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------------------------------------------------------------- ícones
const P = {
  chart: '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  back: '<path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/>',
  expand: '<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  alert: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>',
  x: '<path d="M18 6L6 18"/><path d="M6 6l12 12"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>',
  megaphone: '<path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.9"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3L21 2"/><path d="M16 7l3 3"/><path d="M19 4l2 2"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6"/><path d="M9 17h6"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/>',
};
export const icon = (name, cls = "") =>
  `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] ?? ""}</svg>`;

// ---------------------------------------------------------------- toast
export function toast(msg, tipo = "ok") {
  let box = $("#toasts");
  if (!box) {
    box = document.createElement("div");
    box.id = "toasts";
    document.body.appendChild(box);
  }
  const el = document.createElement("div");
  el.className = `toast toast-${tipo}`;
  el.setAttribute("role", "status");
  el.innerHTML = `${icon({ erro: "alert", notif: "bell" }[tipo] ?? "check")}<span>${esc(msg)}</span>`;
  box.appendChild(el);
  const dura = tipo === "notif" ? 8000 : 3600; // notificação fica mais tempo na tela
  setTimeout(() => el.classList.add("out"), dura);
  setTimeout(() => el.remove(), dura + 400);
}

// ---------------------------------------------------------------- modal
// abre um modal; `onSubmit(form)` pode lançar erro (mostrado no rodapé)
export function modal({ titulo, corpo, botao = "Save", largura = "", onSubmit, onOpen }) {
  const wrap = document.createElement("div");
  wrap.className = "modal-bg";
  wrap.innerHTML = `
    <form class="modal ${largura}" novalidate>
      <header class="modal-h">
        <h2>${esc(titulo)}</h2>
        <button type="button" class="btn-icon" data-close aria-label="Close">${icon("x")}</button>
      </header>
      <div class="modal-b">${corpo}</div>
      <footer class="modal-f">
        <p class="form-erro" aria-live="polite"></p>
        <button type="button" class="btn btn-ghost" data-close>Cancel</button>
        ${onSubmit ? `<button type="submit" class="btn btn-primary">${esc(botao)}</button>` : ""}
      </footer>
    </form>`;
  document.body.appendChild(wrap);
  document.body.classList.add("no-scroll");
  const form = $("form", wrap);
  const fechar = () => {
    wrap.remove();
    document.body.classList.remove("no-scroll");
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => e.key === "Escape" && fechar();
  document.addEventListener("keydown", onKey);
  $$("[data-close]", wrap).forEach((b) => b.addEventListener("click", fechar));
  wrap.addEventListener("mousedown", (e) => e.target === wrap && fechar());
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const erro = $(".form-erro", form);
    const btn = $('button[type="submit"]', form);
    erro.textContent = "";
    btn.disabled = true;
    btn.classList.add("loading");
    try {
      await onSubmit(form);
      fechar();
    } catch (err) {
      erro.textContent = err?.message ?? String(err);
    } finally {
      btn.disabled = false;
      btn.classList.remove("loading");
    }
  });
  onOpen?.(form);
  setTimeout(() => $("input:not([type=hidden]):not([disabled]),select,textarea", form)?.focus(), 30);
  return { fechar, form };
}

export function confirmar(titulo, texto, botao = "Delete") {
  return new Promise((resolve) => {
    let ok = false;
    const m = modal({
      titulo,
      corpo: `<p>${texto}</p>`,
      botao,
      onSubmit: async () => { ok = true; },
    });
    $('button[type="submit"]', m.form).classList.replace("btn-primary", "btn-danger");
    const obs = new MutationObserver(() => {
      if (!document.body.contains(m.form)) { obs.disconnect(); resolve(ok); }
    });
    obs.observe(document.body, { childList: true });
  });
}

// ---------------------------------------------------------------- formatação
export function tempoRelativo(iso) {
  if (!iso) return "";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  const m = Math.floor(diff / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return "yesterday";
  if (d < 30) return `${d} days ago`;
  return dataBR(iso);
}

export const dataBR = (iso) =>
  iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" }) : "";

export const dataHoraBR = (iso) =>
  iso ? new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "";

// valor para <input type="datetime-local">
export function toLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 16);
}
export const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);

// status de atualização do dashboard conforme frequência esperada
const LIMITE_H = { horaria: 2, diaria: 26, semanal: 24 * 8, mensal: 24 * 32 };
export const FREQ_LABEL = { horaria: "Hourly", diaria: "Daily", semanal: "Weekly", mensal: "Monthly", manual: "Manual" };

export function statusAtualizacao(d) {
  if (!d.atualizado_em) return { cls: "neutro", texto: "Refresh date not provided" };
  const horas = (Date.now() - new Date(d.atualizado_em).getTime()) / 36e5;
  const limite = LIMITE_H[d.frequencia];
  const rel = tempoRelativo(d.atualizado_em);
  if (limite && horas > limite) return { cls: "atrasado", texto: `Refresh overdue · ${rel}` };
  return { cls: "ok", texto: `Refreshed ${rel}` };
}

export function tamanhoArquivo(bytes) {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toLocaleString(LOCALE, { maximumFractionDigits: 1 })} MB`;
}

export const NIVEL_ICON ={ info: "info", alerta: "alert", critico: "alert" };

export const iniciais = (nome = "") =>
  nome.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join("") || "?";

export function saudacao() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export const storage = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* sem storage */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* sem storage */ } },
};
