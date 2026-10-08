// Cloudflare Pages Function: POST /api/checkout
// Turns the website cart into one Square checkout: every product at the right price, and
// each custom 20-pack with the customer's colors attached to it (like a T-shirt size).
// Body: { items: [ { product: "pack3" | "kit" | "pack20", qty: 1, colors: { "Red": 12, ... } } ] }
//
// Set these in Cloudflare: Workers & Pages > your project > Settings > Variables and Secrets
//   SQUARE_ACCESS_TOKEN  (type: Secret)  your Square production access token
//   SQUARE_LOCATION_ID   (type: Text)    your Square location ID
//   SQUARE_ENV           (optional)      "sandbox" while testing; leave unset for real orders
//   SHIPPING_CENTS       (optional)      flat shipping charge in cents, e.g. 500 for $5.00
//   SITE_URL             (optional)      defaults to https://magicfluxes.com
//
// Optional: link each product to its item in your Square Item Library, so sales show up
// under that item (reports, inventory). Paste the ID from the end of the item's dashboard URL,
// e.g. app.squareup.com/dashboard/items/library/765APCJYPRAGDNFHAKJHI6O2 -> 765APCJYPRAGDNFHAKJHI6O2
//   SQUARE_ITEM_PACK3    (Text)  item ID for the 3-Pack
//   SQUARE_ITEM_KIT      (Text)  item ID for the Beginner Magic Kit
//   SQUARE_ITEM_PACK20   (Text)  item ID for the 20-Pack
// When an item ID is set, Square uses that item's name and price. Without one, the
// name and price below are used.

// Prices live here (not in the page) so nobody can change them in their browser.
const PRODUCTS = {
  pack3:  { name: "Magic Fluxes 3-Pack",            cents: 500,  itemVar: "SQUARE_ITEM_PACK3" },
  kit:    { name: "Magic Fluxes Beginner Magic Kit", cents: 1000, itemVar: "SQUARE_ITEM_KIT" },
  pack20: { name: "Custom 20-Pack of Magic Fluxes",  cents: 2000, itemVar: "SQUARE_ITEM_PACK20", size: 20 },
};
const COLORS = [
  "Red", "Orange", "Yellow", "Green", "Light Blue", "Dark Blue", "Purple", "Pink",
  "Grey", "White", "Black", "Crystal", "Heat Color Changing", "Glow in the Dark", "UV Blacklight",
];

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

const MAX_LINES = 30, MAX_QTY = 50;

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Bad request" }, 400); }
  if (!env.SQUARE_ACCESS_TOKEN || !env.SQUARE_LOCATION_ID) return json({ error: "Checkout is not set up yet" }, 503);

  // Accept a cart, or a single product (older version of the page)
  const items = Array.isArray(body?.items) ? body.items : body?.product ? [{ product: body.product, qty: 1, colors: body.colors }] : [];
  if (!items.length || items.length > MAX_LINES) return json({ error: "Your cart is empty" }, 400);

  const host = env.SQUARE_ENV === "sandbox" ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com";
  const headers = {
    "Authorization": `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
    "Square-Version": "2026-09-16",
    "Content-Type": "application/json",
  };

  // Look up linked Square items once per product
  const variationFor = {};
  async function variation(key) {
    if (key in variationFor) return variationFor[key];
    const itemId = (env[PRODUCTS[key].itemVar] || "").trim();
    if (!itemId) return (variationFor[key] = null);
    const r = await fetch(`${host}/v2/catalog/object/${encodeURIComponent(itemId)}`, { headers });
    const d = await r.json().catch(() => ({}));
    const obj = d?.object;
    const id = obj?.type === "ITEM_VARIATION" ? obj.id : obj?.item_data?.variations?.[0]?.id;
    if (!r.ok || !id) {
      console.log("Square item lookup failed", itemId, r.status, JSON.stringify(d?.errors || d));
      throw new Error("Square item not found");
    }
    return (variationFor[key] = id);
  }

  const line_items = [];
  const notes = [];
  try {
    for (const it of items) {
      const product = PRODUCTS[it?.product];
      if (!product) return json({ error: "Unknown product" }, 400);
      const qty = Number(it.qty ?? 1);
      if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) return json({ error: "Invalid quantity" }, 400);

      const varId = await variation(it.product);
      const line = varId
        ? { catalog_object_id: varId, quantity: String(qty) }
        : { name: product.name, quantity: String(qty), base_price_money: { amount: product.cents, currency: "USD" } };

      if (product.size) {
        const picked = it.colors && typeof it.colors === "object" ? it.colors : {};
        if (Object.keys(picked).some((k) => !COLORS.includes(k))) return json({ error: "Unknown color" }, 400);
        let total = 0;
        const parts = [];
        for (const name of COLORS) {
          const n = Number(picked[name] || 0);
          if (!Number.isInteger(n) || n < 0 || n > product.size) return json({ error: "Invalid colors" }, 400);
          if (n) { total += n; parts.push(`${name} x${n}`); }
        }
        if (total !== product.size) return json({ error: `Pick exactly ${product.size} Fluxes` }, 400);
        line.note = "Colors: " + parts.join(", "); // shows on the order in Square, under this item
        notes.push(`20-Pack${qty > 1 ? ` (x${qty})` : ""}: ${parts.join(", ")}`);
      }
      line_items.push(line);
    }
  } catch (e) {
    return json({ error: e.message || "Square item not found" }, 502);
  }

  const site = env.SITE_URL || "https://magicfluxes.com";
  const checkout_options = {
    ask_for_shipping_address: true,
    redirect_url: `${site}/?order=thanks`,
  };
  const shipping = Number(env.SHIPPING_CENTS || 0);
  if (shipping > 0) checkout_options.shipping_fee = { name: "Shipping", charge: { amount: shipping, currency: "USD" } };

  const payload = {
    idempotency_key: crypto.randomUUID(),
    order: { location_id: env.SQUARE_LOCATION_ID, line_items },
    checkout_options,
  };
  if (notes.length) payload.payment_note = notes.join(" | ").slice(0, 500); // also on the payment record

  const res = await fetch(`${host}/v2/online-checkout/payment-links`, { method: "POST", headers, body: JSON.stringify(payload) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.payment_link?.url) {
    console.log("Square error", res.status, JSON.stringify(data?.errors || data));
    return json({ error: "Square checkout failed" }, 502);
  }
  return json({ url: data.payment_link.url });
}

export const onRequest = () => json({ error: "Use POST" }, 405);
