/**
 * Berry Vibes Studio · Restaurant Nutrition Proxy
 * Cloudflare Worker template for a static GitHub Pages frontend.
 *
 * Required Worker secrets:
 *   NUTRITIONIX_APP_ID
 *   NUTRITIONIX_APP_KEY
 *
 * Optional Worker variable:
 *   ALLOWED_ORIGIN=https://YOUR-GITHUB-USERNAME.github.io
 *
 * Frontend request:
 *   GET /?restaurant=Wendy%27s&item=Baconator
 *
 * Normalized response:
 *   {
 *     restaurant, name, servingQuantity, servingUnit,
 *     calories, carbs, protein, fat, fiber,
 *     source, verified
 *   }
 */

const NUTRITIONIX_BASE = "https://trackapi.nutritionix.com/v2";

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function corsHeaders(origin, env) {
  const configured = String(env.ALLOWED_ORIGIN || "*")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  const allowAny = configured.includes("*") || configured.length === 0;
  const allowedOrigin = allowAny
    ? "*"
    : configured.includes(origin)
      ? origin
      : "";

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function json(data, status, origin, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": status === 200 ? "public, max-age=300" : "no-store",
      ...corsHeaders(origin, env)
    }
  });
}

function authHeaders(env) {
  return {
    "x-app-id": env.NUTRITIONIX_APP_ID,
    "x-app-key": env.NUTRITIONIX_APP_KEY,
    "x-remote-user-id": "0",
    "Accept": "application/json"
  };
}

function pickRestaurantMatch(branded, restaurant) {
  const target = normalize(restaurant);
  if (!Array.isArray(branded) || branded.length === 0) return null;

  return (
    branded.find((x) => {
      const brand = normalize(x.brand_name);
      return brand.includes(target) || target.includes(brand);
    }) || branded[0]
  );
}

function numeric(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export default {
  async fetch(request, env) {
    const requestUrl = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);

    if (request.method === "OPTIONS") {
      if (!cors["Access-Control-Allow-Origin"]) {
        return new Response(null, { status: 403 });
      }
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== "GET") {
      return json({ ok: false, message: "GET requests only." }, 405, origin, env);
    }

    if (origin && !cors["Access-Control-Allow-Origin"]) {
      return new Response("Forbidden origin", { status: 403 });
    }

    if (requestUrl.pathname === "/health") {
      return json({ ok: true, service: "berry-restaurant-api" }, 200, origin, env);
    }

    if (!env.NUTRITIONIX_APP_ID || !env.NUTRITIONIX_APP_KEY) {
      return json(
        { ok: false, message: "Worker nutrition credentials are not configured." },
        500,
        origin,
        env
      );
    }

    const restaurant = (requestUrl.searchParams.get("restaurant") || "").trim();
    const item = (requestUrl.searchParams.get("item") || "").trim();

    if (!restaurant || !item) {
      return json(
        { ok: false, message: "Both restaurant and item are required." },
        400,
        origin,
        env
      );
    }

    if (restaurant.length > 120 || item.length > 160) {
      return json(
        { ok: false, message: "Search text is too long." },
        400,
        origin,
        env
      );
    }

    try {
      const query = `${item} ${restaurant}`;
      const instantUrl = new URL(`${NUTRITIONIX_BASE}/search/instant`);
      instantUrl.searchParams.set("query", query);
      instantUrl.searchParams.set("branded", "true");

      const instantResponse = await fetch(instantUrl, {
        headers: authHeaders(env)
      });

      if (!instantResponse.ok) {
        throw new Error(`Nutrition search failed (${instantResponse.status}).`);
      }

      const instantData = await instantResponse.json();
      const match = pickRestaurantMatch(instantData.branded, restaurant);

      if (!match?.nix_item_id) {
        return json(
          { ok: false, message: "No matching branded restaurant item was found." },
          404,
          origin,
          env
        );
      }

      const itemUrl = new URL(`${NUTRITIONIX_BASE}/search/item`);
      itemUrl.searchParams.set("nix_item_id", match.nix_item_id);

      const itemResponse = await fetch(itemUrl, {
        headers: authHeaders(env)
      });

      if (!itemResponse.ok) {
        throw new Error(`Nutrition detail lookup failed (${itemResponse.status}).`);
      }

      const itemData = await itemResponse.json();
      const food = Array.isArray(itemData.foods) ? itemData.foods[0] : null;

      if (!food) {
        return json(
          { ok: false, message: "The nutrition source returned no usable food record." },
          502,
          origin,
          env
        );
      }

      return json(
        {
          ok: true,
          restaurant: food.brand_name || match.brand_name || restaurant,
          name: food.food_name || match.food_name || item,
          servingQuantity: food.serving_qty ?? null,
          servingUnit: food.serving_unit || "",
          calories: numeric(food.nf_calories),
          carbs: numeric(food.nf_total_carbohydrate),
          protein: numeric(food.nf_protein),
          fat: numeric(food.nf_total_fat),
          fiber: numeric(food.nf_dietary_fiber),
          source: "Nutritionix branded restaurant database",
          verified: true
        },
        200,
        origin,
        env
      );
    } catch (error) {
      return json(
        {
          ok: false,
          message: error instanceof Error ? error.message : "Restaurant lookup failed."
        },
        502,
        origin,
        env
      );
    }
  }
};
