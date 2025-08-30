// server.js
console.log("Nodemon is watching this file! 🚀");

require("dotenv").config();
const path = require("path");
const express = require("express");

// Masked log so you can see the key loaded without exposing it
const mask = (k) => (k ? `${k.slice(0, 7)}…${k.slice(-4)}` : "missing");
console.log("[env] OPENAI_API_KEY:", mask(process.env.OPENAI_API_KEY));

const fetch = (...args) => global.fetch(...args); // Node 18+

const app = express();

/* --------------------------------- Basics -------------------------------- */
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.get("/healthz", (_req, res) => res.json({ ok: true }));

/* ------------------------ Shopify Storefront setup ----------------------- */
const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN; // your-store.myshopify.com
const SHOPIFY_STOREFRONT_TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN;

app.get("/shopify/ping", (_req, res) => {
  res.json({
    domain: SHOPIFY_DOMAIN || null,
    token: SHOPIFY_STOREFRONT_TOKEN ? "present ✅" : "missing ❌",
  });
});

async function shopifyFetch(query, variables = {}) {
  if (!SHOPIFY_DOMAIN || !SHOPIFY_STOREFRONT_TOKEN) {
    throw new Error("Shopify env missing. Set SHOPIFY_DOMAIN and SHOPIFY_STOREFRONT_TOKEN in .env");
  }
  const r = await fetch(`https://${SHOPIFY_DOMAIN}/api/2025-01/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Storefront-Access-Token": SHOPIFY_STOREFRONT_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errors) {
    const msg = JSON.stringify(j.errors || j, null, 2);
    throw new Error(`Shopify error: ${msg}`);
  }
  return j.data;
}

/* ---------------------------- Storefront routes ------------------------- */

// List recent products (?limit=10)
app.get("/shopify/products", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "10", 10), 50);
    const data = await shopifyFetch(
      `
      query ListProducts($n:Int!) {
        products(first: $n, sortKey: CREATED_AT, reverse: true) {
          edges {
            node {
              id
              title
              handle
              onlineStoreUrl
              images(first: 1) { edges { node { url altText } } }
              priceRange {
                minVariantPrice { amount currencyCode }
                maxVariantPrice { amount currencyCode }
              }
              variants(first: 1) {
                nodes {
                  id
                  title
                  availableForSale
                  price { amount currencyCode }
                  compareAtPrice { amount currencyCode }
                }
              }
            }
          }
        }
      }
    `,
      { n: limit }
    );

    const items =
      data.products?.edges?.map(({ node }) => {
        const img = node.images?.edges?.[0]?.node || {};
        const v0 = node.variants?.nodes?.[0] || null;
        const priceMoney = v0?.price || node.priceRange?.minVariantPrice || null;
        const price = priceMoney ? `${priceMoney.amount} ${priceMoney.currencyCode}` : null;
        const compareAt = v0?.compareAtPrice ? `${v0.compareAtPrice.amount} ${v0.compareAtPrice.currencyCode}` : null;
        return {
          id: node.id,
          title: node.title,
          handle: node.handle,
          url: node.onlineStoreUrl,
          image: img.url || null,
          price,
          compareAt,
          priceRange: node.priceRange || null,
        };
      }) || [];

    res.json({ count: items.length, items });
  } catch (err) {
    console.error("GET /shopify/products error:", err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Product by handle
app.get("/shopify/product/:handle", async (req, res) => {
  try {
    const handle = String(req.params.handle || "").trim();
    if (!handle) return res.status(400).json({ error: "Missing handle" });

    const data = await shopifyFetch(
      `
      query ProductByHandle($h:String!) {
        product(handle:$h) {
          id title handle description onlineStoreUrl
          images(first: 5) { edges { node { url altText } } }
          priceRange {
            minVariantPrice { amount currencyCode }
            maxVariantPrice { amount currencyCode }
          }
          variants(first: 20) {
            nodes {
              id title availableForSale
              price { amount currencyCode }
              compareAtPrice { amount currencyCode }
            }
          }
        }
      }
    `,
      { h: handle }
    );

    const p = data?.product;
    if (!p) return res.status(404).json({ error: "Not found" });

    const images = (p.images?.edges || []).map(e => e.node);
    const variants = (p.variants?.nodes || []).map(v => ({
      id: v.id,
      title: v.title,
      availableForSale: !!v.availableForSale,
      price: v.price ? `${v.price.amount} ${v.price.currencyCode}` : null,
      compareAt: v.compareAtPrice ? `${v.compareAtPrice.amount} ${v.compareAtPrice.currencyCode}` : null,
    }));

    const primaryPrice =
      variants[0]?.price ||
      (p.priceRange?.minVariantPrice
        ? `${p.priceRange.minVariantPrice.amount} ${p.priceRange.minVariantPrice.currencyCode}`
        : null);

    res.json({
      product: {
        id: p.id,
        title: p.title,
        handle: p.handle,
        description: p.description,
        url: p.onlineStoreUrl,
        images,
        image: images[0]?.url || null,
        price: primaryPrice,
        compareAt: variants[0]?.compareAt || null,
        priceRange: p.priceRange || null,
        variants,
      },
    });
  } catch (err) {
    console.error("GET /shopify/product/:handle error:", err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Search by text (?query= or ?q=)
app.get("/shopify/search", async (req, res) => {
  try {
    const q = String(req.query.query || req.query.q || "").trim();
    if (!q) return res.status(400).json({ error: "Missing query (?query= or ?q=)" });

    const data = await shopifyFetch(
      `
      query SearchProducts($q:String!) {
        products(first: 10, query: $q) {
          edges {
            node {
              id title handle onlineStoreUrl
              images(first: 1) { edges { node { url altText } } }
              priceRange {
                minVariantPrice { amount currencyCode }
                maxVariantPrice { amount currencyCode }
              }
            }
          }
        }
      }
    `,
      { q }
    );

    const items =
      data.products?.edges?.map(e => ({
        id: e.node.id,
        title: e.node.title,
        handle: e.node.handle,
        url: e.node.onlineStoreUrl,
        image: e.node.images?.edges?.[0]?.node?.url || null,
        priceFrom: e.node.priceRange?.minVariantPrice || null,
        priceTo: e.node.priceRange?.maxVariantPrice || null,
      })) || [];

    res.json({ query: q, count: items.length, items });
  } catch (err) {
    console.error("GET /shopify/search error:", err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

/* ---------------------- Shopify Admin (orders) -------------------------- */
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const SHOPIFY_ADMIN_API_VERSION = process.env.SHOPIFY_ADMIN_API_VERSION || "2025-01";

app.get("/shopify-admin/ping", (_req, res) => {
  res.json({
    domain: SHOPIFY_DOMAIN || null,
    adminToken: SHOPIFY_ADMIN_TOKEN ? "present ✅" : "missing ❌",
    version: SHOPIFY_ADMIN_API_VERSION,
  });
});

async function shopifyAdminGraphQL(query, variables = {}) {
  if (!SHOPIFY_DOMAIN || !SHOPIFY_ADMIN_TOKEN) {
    throw new Error("Admin env missing. Set SHOPIFY_DOMAIN and SHOPIFY_ADMIN_TOKEN in .env");
  }
  const url = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/graphql.json`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errors) {
    const msg = JSON.stringify(j.errors || j, null, 2);
    throw new Error(`Shopify Admin error: ${msg}`);
  }
  return j.data;
}

async function findOrderByNameAndEmail(order_number, email) {
  const nameNumeric = String(order_number || "").replace(/^#/g, "");
  const q = `name:${nameNumeric} AND email:${String(email || "").trim().toLowerCase()}`;

  const query = /* GraphQL */ `
    query FindOrder($first:Int!, $q:String!) {
      orders(first: $first, query: $q, reverse: true) {
        nodes {
          id
          name
          email
          displayFinancialStatus
          displayFulfillmentStatus
          lineItems(first: 25) { nodes { name quantity } }
          fulfillments(first: 5) {
            status
            trackingInfo { number url company }
            trackingCompany
            trackingNumbers
            trackingUrls
          }
        }
      }
    }
  `;

  const data = await shopifyAdminGraphQL(query, { first: 1, q });
  const order = data?.orders?.nodes?.[0];
  if (!order) return { found: false };

  const tracking = [];
  for (const f of order.fulfillments || []) {
    if (Array.isArray(f.trackingInfo) && f.trackingInfo.length) {
      for (const t of f.trackingInfo) {
        tracking.push({
          company: t.company || f.trackingCompany || null,
          number: t.number || (f.trackingNumbers?.[0] ?? null),
          url: t.url || (f.trackingUrls?.[0] ?? null),
        });
      }
    } else {
      tracking.push({
        company: f.trackingCompany || null,
        number: f.trackingNumbers?.[0] ?? null,
        url: f.trackingUrls?.[0] ?? null,
      });
    }
  }

  return {
    found: true,
    name: order.name,
    email: order.email,
    financial_status: order.displayFinancialStatus,
    fulfillment_status: order.displayFulfillmentStatus,
    line_items: order.lineItems.nodes.map(n => ({ title: n.name, qty: n.quantity })),
    tracking,
  };
}

// Optional direct endpoint
app.post("/order-status", async (req, res) => {
  try {
    const order_number = String(req.body?.order_number || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!order_number || !email) {
      return res.status(400).json({ error: "Provide 'order_number' and 'email' in the body." });
    }
    const data = await findOrderByNameAndEmail(order_number, email);
    if (!data.found) {
      return res.json({ found: false, note: "No matching order. Check the order number and the exact email on the order." });
    }
    res.json(data);
  } catch (e) {
    console.error("POST /order-status error:", e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

/* ---------------------------- Chat endpoints ---------------------------- */
const OPENAI_MODEL = "gpt-4o-mini";

const BRAND_SYSTEM = `
You are the ecommerce assistant for TheGrantedSolutions.com (tech gadgets & gifts).
Tone: clear, punchy, conversion-focused. Avoid fluff. 1–2 lines max by default.
Return only the answer text (no preambles).
`;

const PRODUCT_KB = {
  printerC80: {
    name: "Portable Inkless A4 C80 Printer",
    url: "https://thegrantedsolutions.com/products/portable-inkless-thermal-a4-c80-printer-300dpi",
  },
  a4Paper: {
    name: "A4 Thermal Printer Paper – 20 Rolls (210×30mm)",
    url: "https://thegrantedsolutions.com/products/a4-thermal-printer-paper-20-rolls-210x30mm",
  },
};

const presets = {
  free: (msg) => [
    { role: "system", content: BRAND_SYSTEM },
    { role: "user", content: msg },
  ],
  bundleOffer: (msg, product = {}) => {
    const printerName = product.printerName || PRODUCT_KB.printerC80.name;
    const paperName   = product.paperName   || PRODUCT_KB.a4Paper.name;
    const printerUrl  = product.printerUrl  || PRODUCT_KB.printerC80.url;
    const paperUrl    = product.paperUrl    || PRODUCT_KB.a4Paper.url;

    const sys = BRAND_SYSTEM + `
Task: Create a concise bundle/upsell pitch (max 2 lines).
- Return HTML with two <a> links:
  • ${printerName} -> ${printerUrl}
  • ${paperName} -> ${paperUrl}
- Line 1: Benefit-led reason (inkless convenience, never run out, crisp 300DPI).
- Line 2: Clear CTA including both links (“Shop the set”).
- Keep it punchy. No emojis.
`;
    return [
      { role: "system", content: sys },
      { role: "user", content: msg || "Create a bundle offer for these two products." },
    ];
  },
};

const composeInput = (mode, message, product = {}) => {
  const fn = presets[mode] || presets.free;
  return mode === "bundleOffer" ? fn(message, product) : fn(message);
};

// Non-stream chat (Chat Completions) + quick echo test
app.post("/chat", async (req, res) => {
  try {
    const { message = "", mode = "free", product = {} } = req.body || {};
    const msg = String(message || "").trim();
    const key = process.env.OPENAI_API_KEY;

    // --- TEMP quick echo to prove round-trip works ---
    if (msg.toLowerCase().startsWith("test:")) {
      return res.json({ reply: `Echo ✅ ${msg.slice(5).trim()}` });
    }

    // Detect email + order number for Admin lookup
    const email = (msg.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i) || [])[0]?.toLowerCase() || null;
    const orderMatch = msg.match(/(?:order\s*(?:number|no\.|#)?\s*|#)\s*(\d{3,10})\b/i);
    const order_number = orderMatch ? orderMatch[1] : null;

    if (email && order_number && process.env.SHOPIFY_ADMIN_TOKEN) {
      try {
        const result = await findOrderByNameAndEmail(order_number, email);
        if (result.found) {
          const items = result.line_items.slice(0, 4).map(li => `${li.qty}× ${li.title}`).join(", ");
          const t = result.tracking?.[0] || null;
          const trackingText = t
            ? (t.url ? `Tracking: ${t.url}` : `Tracking: ${[t.company, t.number].filter(Boolean).join(" ")}`)
            : "No tracking yet.";
          const reply = `Order ${result.name} — ${result.fulfillment_status}. ${trackingText}${items ? ` Items: ${items}.` : ""}`;
          return res.json({ reply, order: { name: result.name, email: result.email, status: result.fulfillment_status, tracking: result.tracking } });
        } else {
          return res.json({ reply: `I couldn’t find order #${order_number} for ${email}. Double-check the order number and the exact email on the order.` });
        }
      } catch (e) {
        console.error("Lookup failed:", e);
        // continue to normal AI reply
      }
    }

    if ((order_number && !email) || (email && !order_number)) {
      const missing = !email ? "the email used on the order" : "the order number";
      return res.json({ reply: `Got it. Please provide ${missing} so I can look it up.` });
    }

    if (!key) return res.status(500).json({ error: "OPENAI_API_KEY missing in environment" });

    // --- Simple Chat Completions call ---
    const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: composeInput(mode, msg, product),
      }),
    });

    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      console.error("OpenAI non-200:", upstream.status, upstream.statusText, data);
    }

    const text =
      data?.choices?.[0]?.message?.content?.trim?.() ||
      "Sorry, I couldn’t parse a reply.";
    res.json({ reply: text });
  } catch (e) {
    console.error("POST /chat error:", e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

/* ------------------------------ Static index ---------------------------- */
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* --------------------------------- Start -------------------------------- */
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Simple agent listening on :${port}`));
