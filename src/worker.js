const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const MAX_IMG = 15 * 1024 * 1024;

function bad(msg, status = 400) {
  return Response.json({ error: msg }, { status });
}

function parseTarget(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return null;
  if (h.includes(":")) return null;
  if (/^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return null;
  return u;
}

async function scan(target) {
  const res = await fetch(target.href, {
    headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,*/*" },
    redirect: "follow",
  });
  if (!res.ok) return bad("The page returned status " + res.status, 502);
  const base = res.url;
  const found = [];
  const add = (v) => {
    if (!v) return;
    try {
      const u = new URL(v.trim(), base);
      if (/^https?:$/.test(u.protocol) && !/\.(svg|gif|ico)(\?|$)/i.test(u.pathname)) found.push(u.href);
    } catch {}
  };
  const addSet = (s) => {
    if (!s) return;
    let best = null, bw = -1;
    for (const part of s.split(",")) {
      const [u, d] = part.trim().split(/\s+/);
      const w = parseFloat(d) || 0;
      if (u && w >= bw) { best = u; bw = w; }
    }
    add(best);
  };

  await new HTMLRewriter()
    .on("meta[property='og:image'], meta[name='twitter:image']", {
      element(e) { add(e.getAttribute("content")); },
    })
    .on("img", {
      element(e) {
        for (const a of ["data-large", "data-original", "data-src", "data-lazy-src", "src"]) add(e.getAttribute(a));
        addSet(e.getAttribute("srcset"));
        addSet(e.getAttribute("data-srcset"));
      },
    })
    .on("source", { element(e) { addSet(e.getAttribute("srcset")); } })
    .on("a", {
      element(e) {
        const h = e.getAttribute("href");
        if (h && /\.(jpe?g|png|webp)(\?|$)/i.test(h)) add(h);
      },
    })
    .transform(res)
    .text();

  return Response.json({ page: base, images: [...new Set(found)].slice(0, 80) });
}

async function image(target) {
  const res = await fetch(target.href, {
    headers: { "user-agent": UA, accept: "image/*", referer: target.origin + "/" },
  });
  if (!res.ok) return bad("The image returned status " + res.status, 502);
  const type = res.headers.get("content-type") || "";
  if (!type.startsWith("image/") || type.includes("svg")) return bad("Not a raster image", 415);
  if ((+res.headers.get("content-length") || 0) > MAX_IMG) return bad("Image is too large", 413);
  return new Response(res.body, {
    headers: { "content-type": type, "cache-control": "public, max-age=3600" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/scan" || url.pathname === "/api/img") {
      const target = parseTarget(url.searchParams.get("url") || "");
      if (!target) return bad("Invalid or blocked link");
      try {
        return url.pathname === "/api/scan" ? await scan(target) : await image(target);
      } catch (e) {
        return bad("Could not fetch: " + e.message, 502);
      }
    }
    return env.ASSETS.fetch(request);
  },
};
