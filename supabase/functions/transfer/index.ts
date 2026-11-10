import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...corsHeaders, "Content-Type": "application/json" },
});

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function makeCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // excludes ambiguous I, O, 0, 1
  const random = crypto.getRandomValues(new Uint8Array(8));
  return [...random].map((b) => alphabet[b % alphabet.length]).join("");
}
function validPayload(p: any): boolean {
  return !!p && typeof p === "object" && !Array.isArray(p)
    && p.logs && typeof p.logs === "object"
    && p.reviews && typeof p.reviews === "object"
    && Array.isArray(p.metrics)
    && p.settings && typeof p.settings === "object"
    && JSON.stringify(p).length <= 1_500_000;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST 요청만 허용됩니다." }, 405);

  try {
    const { action, payload, code } = await req.json();
    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const db = createClient(url, serviceKey, { auth: { persistSession: false } });

    if (action === "create") {
      if (!validPayload(payload)) return json({ error: "전송할 데이터 형식이 올바르지 않거나 용량이 너무 큽니다." }, 400);
      // Remove expired leftovers whenever a new transfer is created.
      await db.from("growth_transfers").delete().lte("expires_at", new Date().toISOString());
      let plain = "", hash = "";
      for (let i = 0; i < 5; i++) {
        plain = makeCode(); hash = await sha256(plain);
        const { error } = await db.from("growth_transfers").insert({
          code_hash: hash,
          payload,
          expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        });
        if (!error) break;
        if (i === 4) throw error;
      }
      return json({ code: plain, expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString() });
    }

    if (action === "redeem") {
      if (typeof code !== "string" || !/^[A-HJ-NP-Z2-9]{8}$/.test(code)) return json({ error: "코드 형식이 올바르지 않습니다." }, 400);
      const hash = await sha256(code);
      // The SQL function atomically deletes and returns the record, so concurrent
      // attempts cannot redeem the same code twice.
      const { data, error } = await db.rpc("consume_growth_transfer", { p_code_hash: hash });
      if (error) throw error;
      if (!data) return json({ error: "코드가 만료됐거나 이미 사용됐습니다. 기존 기기에서 새 코드를 발급해 주세요." }, 404);
      return json({ payload: data });
    }

    return json({ error: "지원하지 않는 요청입니다." }, 400);
  } catch (e) {
    console.error("transfer function error", e);
    return json({ error: "전송 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요." }, 500);
  }
});
